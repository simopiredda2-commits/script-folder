import { z } from 'zod';
import { type DataRecord, type DatasetKind, KINDS, convertCell, type FieldSpec } from './kinds';
import { normalizeHeader } from './text';

/**
 * Mappatura: collega le colonne di un file d'origine ai campi di un tipo di banca dati.
 * Le mappature sono dati (data/mappature.json), non codice: quando una fonte cambia le colonne si
 * aggiorna il file, con una nuova versione.
 */
const mappingSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  titolo: z.string().min(1),
  tipo: z.enum(Object.keys(KINDS) as [DatasetKind, ...DatasetKind[]]),
  /** «sync»: un file in correnti/ di sync. «trascrizione»: un CSV trascritto a mano da un PDF. */
  origine: z.enum(['sync', 'trascrizione']),
  /** Per «sync»: fonte e chiave del file in correnti/<fonte>/<chiave>; «*» vale qualsiasi testo. */
  fonte: z.string().optional(),
  chiave: z.string().optional(),
  /** Campo → intestazione della colonna; null = da completare. */
  colonne: z.record(z.string(), z.string().nullable()),
  /** Campo → valore uguale per tutto il file (per esempio la classe di un elenco). */
  costanti: z.record(z.string(), z.string()).default({}),
  /**
   * Campo → espressioni regolari (su tutta la cella) dei valori che nel file vogliono dire
   * «nessun valore»: per esempio «-» al posto di un prezzo. Solo quelli visti nei file veri,
   * con il motivo nella nota della mappatura.
   */
  nessunValore: z.record(z.string(), z.array(z.string().min(1))).default({}),
  /** Oltre quanti giorni la versione in uso è più vecchia del previsto (A6); null = da completare. */
  vecchiaDopoGiorni: z.number().int().positive().nullable(),
  nota: z.string().optional(),
});

const mappingFileSchema = z.object({
  versione: z.string().min(1),
  mappature: z.array(mappingSchema),
});

export type Mapping = z.infer<typeof mappingSchema>;
export interface MappingSet {
  version: string;
  mappings: Mapping[];
}

/** Controlla un file di mappature: campi esistenti, origine coerente, id unici. */
export function parseMappings(data: unknown): MappingSet {
  const parsed = mappingFileSchema.parse(data);
  const ids = new Set<string>();
  for (const m of parsed.mappature) {
    if (ids.has(m.id)) throw new Error(`Mappatura ripetuta: ${m.id}`);
    ids.add(m.id);
    const fields = KINDS[m.tipo].fields as Record<string, FieldSpec>;
    for (const f of [
      ...Object.keys(m.colonne),
      ...Object.keys(m.costanti),
      ...Object.keys(m.nessunValore),
    ]) {
      if (!(f in fields))
        throw new Error(`Mappatura ${m.id}: il tipo ${m.tipo} non ha il campo ${f}`);
    }
    for (const [f, patterns] of Object.entries(m.nessunValore)) {
      if (fields[f]!.required)
        throw new Error(`Mappatura ${m.id}: il campo ${f} è obbligatorio, non può mancare`);
      for (const p of patterns) {
        try {
          new RegExp(p, 'u');
        } catch {
          throw new Error(`Mappatura ${m.id}: espressione non valida per ${f}: ${p}`);
        }
      }
    }
    if (m.origine === 'sync' && (!m.fonte || !m.chiave)) {
      throw new Error(`Mappatura ${m.id}: per un file di sync servono fonte e chiave`);
    }
  }
  return { version: parsed.versione, mappings: parsed.mappature };
}

/** Unisce due insiemi: le mappature del secondo sostituiscono quelle con lo stesso id. */
export function overrideMappings(base: MappingSet, extra: MappingSet): MappingSet {
  const byId = new Map(base.mappings.map((m) => [m.id, m]));
  for (const m of extra.mappings) byId.set(m.id, m);
  return { version: `${base.version}+${extra.version}`, mappings: [...byId.values()] };
}

function keyMatches(pattern: string, key: string): boolean {
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${pattern.split('*').map(escape).join('.*')}$`).test(key);
}

/** La mappatura di un file di sync, se c'è. */
export function mappingForSyncFile(
  set: MappingSet,
  source: string,
  key: string,
): Mapping | undefined {
  return set.mappings.find(
    (m) => m.origine === 'sync' && m.fonte === source && keyMatches(m.chiave!, key),
  );
}

/** La mappatura delle trascrizioni di un tipo. */
export function mappingForTranscription(set: MappingSet, kind: string): Mapping | undefined {
  return set.mappings.find((m) => m.origine === 'trascrizione' && m.tipo === kind);
}

/** Campi obbligatori senza colonna né costante: finché ci sono, il file non si importa. */
export function missingFields(m: Mapping): string[] {
  const fields = KINDS[m.tipo].fields as Record<string, FieldSpec>;
  return Object.entries(fields)
    .filter(([f, spec]) => spec.required && !m.colonne[f] && m.costanti[f] === undefined)
    .map(([f]) => f);
}

/** Campi mappati con colonna ancora da completare (anche facoltativi). */
export function pendingColumns(m: Mapping): string[] {
  return Object.entries(m.colonne)
    .filter(([, header]) => header === null)
    .map(([f]) => f);
}

export interface RowProblem {
  /** Numero della riga nel file, da 1. */
  line: number;
  field: string;
  problem: string;
}

export interface Extraction {
  records: DataRecord[];
  problems: RowProblem[];
  /** Intestazioni attese che il file non ha. */
  missingColumns: string[];
  /** Riga dell'intestazione nel file, da 1. */
  headerLine: number | null;
  /** Per campo, quante celle valevano «nessun valore» secondo la mappatura. */
  noValue: Record<string, number>;
}

/** Quante righe guardare per trovare l'intestazione (titoli sopra la tabella). */
const HEADER_SEARCH_ROWS = 20;

/** Estrae i record di un file già letto in righe, secondo la mappatura. */
export function extractRecords(m: Mapping, rows: string[][]): Extraction {
  const fields = KINDS[m.tipo].fields as Record<string, FieldSpec>;
  const wanted = Object.entries(m.colonne).filter((e): e is [string, string] => e[1] !== null);
  let best = { line: -1, found: new Map<string, number>() };
  for (let i = 0; i < Math.min(rows.length, HEADER_SEARCH_ROWS); i++) {
    const normalized = rows[i]!.map(normalizeHeader);
    const found = new Map<string, number>();
    for (const [field, header] of wanted) {
      const idx = normalized.indexOf(normalizeHeader(header));
      if (idx >= 0) found.set(field, idx);
    }
    if (found.size > best.found.size) best = { line: i, found };
    if (found.size === wanted.length) break;
  }
  if (best.found.size < wanted.length) {
    return {
      records: [],
      problems: [],
      missingColumns: wanted.filter(([f]) => !best.found.has(f)).map(([, h]) => h),
      headerLine: best.line >= 0 ? best.line + 1 : null,
      noValue: {},
    };
  }
  const empty = Object.fromEntries(
    Object.entries(m.nessunValore).map(([f, ps]) => [
      f,
      ps.map((p) => new RegExp(`^(?:${p})$`, 'u')),
    ]),
  );
  const noValue: Record<string, number> = {};
  const records: DataRecord[] = [];
  const problems: RowProblem[] = [];
  for (let i = best.line + 1; i < rows.length; i++) {
    const row = rows[i]!;
    if (!row.some((c) => c.trim() !== '')) continue;
    const record: DataRecord = {};
    let ok = true;
    for (const [field, spec] of Object.entries(fields)) {
      const idx = best.found.get(field);
      let raw = idx !== undefined ? (row[idx] ?? '') : (m.costanti[field] ?? '');
      if (empty[field]?.some((re) => re.test(raw.trim()))) {
        noValue[field] = (noValue[field] ?? 0) + 1;
        raw = '';
      }
      const converted = convertCell(spec, raw);
      if ('problem' in converted) {
        problems.push({ line: i + 1, field, problem: converted.problem });
        ok = false;
      } else record[field] = converted.value;
    }
    if (ok) records.push(record);
  }
  return { records, problems, missingColumns: [], headerLine: best.line + 1, noValue };
}
