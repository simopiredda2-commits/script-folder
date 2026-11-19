import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { importOrigin, patient } from '../db/schema';
import type { Tx } from '../db/tx';
import {
  comparable,
  completePatient,
  entryHandlers,
  insertPatient,
  preparePatient,
  type Prepared,
  type PreparedPatient,
  type Values,
  type WriteContext,
} from './destinations';
import { MAX_REPORT_ROWS } from './limits';
import type { ResolvedPart } from './mapping';
import { convertValue } from './transforms';

/**
 * Motore dell'importazione (tappa 15): per ogni destinazione e ogni riga, trasformazioni,
 * controlli dell'inserimento a mano, abbinamento al paziente per codice fiscale nell'archivio del
 * titolare, doppioni (provenienza delle importazioni precedenti, dentro il file, dati già in
 * cartella), scrittura con la provenienza di ogni riga. Lo stesso codice serve la prova senza
 * scrivere (transazione annullata) e la scrittura: il rapporto è lo stesso.
 */

/**
 * Fuori dalla produzione si importano solo pazienti inventati, con la X in dodicesima posizione
 * del codice fiscale (regola 1, D12). L'ambiente lo dice APP_AMBIENTE (D170): per difetto «prova».
 */

export type Outcome = 'scritta' | 'completata' | 'gia_presente' | 'doppione' | 'scartata';

export interface ReportRow {
  /** Destinazione (indice nella mappatura). */
  parte: number;
  tabella: string;
  riga: number;
  destinazione: string;
  esito: Outcome;
  /** Motivi dello scarto, o che cosa è successo: senza valori del file. */
  motivi: string[];
  avvisi: string[];
  /** Voci scritte dalla riga (più d'una per i parametri in colonne). */
  voci?: number;
}

export interface Counts {
  righe: number;
  scritte: number;
  completate: number;
  giaPresenti: number;
  doppioni: number;
  scartate: number;
  conAvvisi: number;
  voci: number;
  pazientiNuovi: number;
  pazientiCompletati: number;
  /** Righe di fogli smistati per valore che non vanno in nessuna destinazione. */
  escluse: number;
}

export interface EngineResult {
  report: ReportRow[];
  /** Il rapporto ha più righe di quelle salvate (i conteggi restano completi). */
  truncated: boolean;
  counts: Counts;
  /** Pazienti già in cartella toccati o abbinati: il registro ne scrive una riga ciascuno. */
  existingPatients: Set<string>;
  /** Pazienti creati da questa importazione. */
  newPatients: Set<string>;
  /** Pazienti di un altro archivio dello studio con un codice fiscale del file: accesso negato. */
  foreignPatients: Set<string>;
  /** Impronta del piano: esito di ogni riga. La scrittura deve dare la stessa della prova. */
  planHash: string;
}

const emptyCounts = (): Counts => ({
  righe: 0,
  scritte: 0,
  completate: 0,
  giaPresenti: 0,
  doppioni: 0,
  scartate: 0,
  conAvvisi: 0,
  voci: 0,
  pazientiNuovi: 0,
  pazientiCompletati: 0,
  escluse: 0,
});

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Valore confrontabile per i doppioni: testo senza maiuscole e con gli spazi compattati. */
const normalizeKeyValue = comparable;

/**
 * Chiave d'origine di una riga scritta: l'identificativo del programma d'origine, se c'è, o
 * l'impronta dei campi che riconoscono la voce. Sempre un'impronta: nella provenienza non
 * restano codici fiscali né testi dei pazienti.
 */
export function sourceKey(
  destination: string,
  fiscalCode: string,
  originId: unknown,
  naturalKey: unknown[],
  item: number,
): string {
  if (comparable(originId) !== '')
    return `${destination}:id:${sha256(JSON.stringify([normalizeKeyValue(originId), item]))}`;
  return `${destination}:${sha256(JSON.stringify([fiscalCode, ...naturalKey.map(normalizeKeyValue)]))}`;
}

/** Fuori produzione: solo codici fiscali con la X in dodicesima posizione (D12, D170). */
export function fiscalCodeAllowed(cf: string, onlyFictitious: boolean): boolean {
  return !onlyFictitious || cf[11] === 'X';
}

export interface ConvertedRow {
  values: Values;
  errors: string[];
  warnings: string[];
}

/** Valori di una riga, trasformati campo per campo. */
export function convertRow(
  part: ResolvedPart,
  cells: string[],
  kinds: string | undefined,
  ctx: { date1904: boolean },
): ConvertedRow {
  const values: Values = {};
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const f of part.fields) {
    const raw = f.column !== null ? (cells[f.column] ?? '') : (f.constant ?? '');
    const kind = f.column !== null ? (kinds?.[f.column] ?? 't') : 't';
    const r = convertValue(f.field, raw, kind, f.transform, ctx);
    if (r.ok) {
      values[f.field.key] = r.value;
      if (r.warning) warnings.push(`«${f.field.label}»: ${r.warning}`);
    } else errors.push(`«${f.field.label}»: ${r.error}`);
  }
  return { values, errors, warnings };
}

/** La riga va in questa destinazione? (smistamento per valore di una colonna) */
export function rowMatches(part: ResolvedPart, cells: string[]): boolean {
  if (!part.filter) return true;
  return part.filter.values.has((cells[part.filter.column] ?? '').trim().toLowerCase());
}

/** Preparazione di una riga senza database: trasformazioni e controlli formali. */
export function prepareRow(
  part: ResolvedPart,
  converted: ConvertedRow,
  today: string,
  onlyFictitious: boolean,
  handlers: ReturnType<typeof entryHandlers>,
):
  | {
      ok: true;
      fiscalCode: string;
      patient?: PreparedPatient;
      prepared?: Prepared<unknown> & { ok: true };
      warnings: string[];
    }
  | { ok: false; errors: string[]; warnings: string[] } {
  const { values, warnings } = converted;
  const errors = [...converted.errors];
  // Un campo obbligatorio vuoto: lo dice per nome, prima dei controlli del modulo.
  for (const f of part.fields)
    if (
      f.field.required &&
      (values[f.field.key] ?? null) === null &&
      !errors.some((e) => e.startsWith(`«${f.field.label}»`))
    )
      errors.push(
        f.field.key === 'data'
          ? `«${f.field.label}»: manca. Una voce senza data non entra: non prende la data dell’importazione`
          : `«${f.field.label}»: manca`,
      );
  if (errors.length) return { ok: false, errors, warnings };
  const cf = typeof values.codiceFiscale === 'string' ? values.codiceFiscale : '';
  if (cf && !fiscalCodeAllowed(cf, onlyFictitious))
    return {
      ok: false,
      errors: [
        'Fuori dalla produzione si importano solo pazienti inventati: il codice fiscale deve avere la X in dodicesima posizione (D12)',
      ],
      warnings,
    };
  if (part.destination.key === 'pazienti') {
    const p = preparePatient(values, today);
    if (!p.ok) return { ok: false, errors: p.errors, warnings };
    return {
      ok: true,
      fiscalCode: p.patient.identity.codiceFiscale,
      patient: p.patient,
      warnings: [...warnings, ...p.patient.warnings],
    };
  }
  if (!cf) return { ok: false, errors: ['«Codice fiscale del paziente»: manca'], warnings };
  const handler = handlers[part.destination.key];
  const prepared = handler.prepare(values, today);
  if (!prepared.ok) return { ok: false, errors: prepared.errors, warnings };
  return { ok: true, fiscalCode: cf, prepared, warnings: [...warnings, ...prepared.warnings] };
}

export interface RunContext extends WriteContext {
  date1904: boolean;
  /** Solo pazienti inventati: fuori dalla produzione (D12, D170). */
  onlyFictitious: boolean;
  exemptionExists?: (code: string) => boolean | undefined;
}

/** Esegue l'importazione nella transazione data. La transazione la chiude chi chiama. */
export async function runImport(ctx: RunContext, parts: ResolvedPart[]): Promise<EngineResult> {
  const tx: Tx = ctx.tx;
  const handlers = entryHandlers(ctx.exemptionExists);
  const counts = emptyCounts();
  const report: ReportRow[] = [];
  let truncated = false;
  const existingPatients = new Set<string>();
  const foreignPatients = new Set<string>();
  const newPatients = new Set<string>();
  const seen = new Map<string, number>();
  const patients = new Map<string, typeof patient.$inferSelect | null>();

  const findPatient = async (cf: string) => {
    if (patients.has(cf)) return patients.get(cf)!;
    const [row] = await tx
      .select()
      .from(patient)
      .where(and(eq(patient.studioId, ctx.studioId), eq(patient.fiscalCode, cf)));
    patients.set(cf, row ?? null);
    return row ?? null;
  };
  const originExists = async (table: string, key: string) => {
    const [row] = await tx
      .select({ id: importOrigin.id })
      .from(importOrigin)
      .where(
        and(
          eq(importOrigin.archiveId, ctx.archiveId),
          eq(importOrigin.tableName, table),
          eq(importOrigin.sourceKey, key),
        ),
      );
    return !!row;
  };
  const recordOrigin = (table: string, rowId: string, key: string) =>
    tx.insert(importOrigin).values({
      batchId: ctx.batchId,
      archiveId: ctx.archiveId,
      tableName: table,
      rowId,
      sourceKey: key,
    });

  const push = (r: ReportRow) => {
    counts.righe++;
    if (r.avvisi.length) counts.conAvvisi++;
    const key = (
      {
        scritta: 'scritte',
        completata: 'completate',
        gia_presente: 'giaPresenti',
        doppione: 'doppioni',
        scartata: 'scartate',
      } as const
    )[r.esito];
    counts[key]++;
    if (report.length < MAX_REPORT_ROWS) report.push(r);
    else truncated = true;
  };

  // Prima i pazienti, poi i problemi, poi il resto: l'ordine del catalogo.
  const ordered = [...parts].sort(
    (a, b) => a.destination.order - b.destination.order || a.index - b.index,
  );
  for (const part of ordered) {
    const dest = part.destination.key;
    for (const record of part.rows) {
      if (!rowMatches(part, record.cells)) continue;
      const base = {
        parte: part.index,
        tabella: part.table.name,
        riga: record.line,
        destinazione: dest,
      };
      const converted = convertRow(part, record.cells, record.kinds, ctx);
      const prep = prepareRow(part, converted, ctx.today, ctx.onlyFictitious, handlers);
      if (!prep.ok) {
        push({ ...base, esito: 'scartata', motivi: prep.errors, avvisi: prep.warnings });
        continue;
      }
      const cf = prep.fiscalCode;
      const originId = converted.values.idOrigine ?? null;
      const found = await findPatient(cf);
      if (found && found.archiveId !== ctx.archiveId) {
        // Nessun dato dell'altro archivio nel rapporto: solo che qui non si importa. Il registro
        // del paziente lo dice al suo titolare, come ogni accesso negato.
        foreignPatients.add(found.id);
        push({
          ...base,
          esito: 'scartata',
          motivi: [
            'Il codice fiscale è già registrato nello studio, in un altro archivio: il paziente non si importa in questo',
          ],
          avvisi: prep.warnings,
        });
        continue;
      }

      if (prep.patient) {
        const key = sourceKey(dest, cf, originId, [cf], 0);
        const seenAt = seen.get(`patient|${key}`);
        if (seenAt !== undefined) {
          push({
            ...base,
            esito: 'doppione',
            motivi: [`Stesso paziente della riga ${seenAt} del file`],
            avvisi: prep.warnings,
          });
          continue;
        }
        seen.set(`patient|${key}`, record.line);
        if (!found) {
          const id = await insertPatient(ctx, prep.patient);
          await recordOrigin('patient', id, key);
          const row = (await tx.select().from(patient).where(eq(patient.id, id)))[0]!;
          patients.set(cf, row);
          newPatients.add(id);
          counts.pazientiNuovi++;
          counts.voci++;
          push({
            ...base,
            esito: 'scritta',
            motivi: ['Paziente nuovo'],
            avvisi: prep.warnings,
            voci: 1,
          });
          continue;
        }
        if (!newPatients.has(found.id)) existingPatients.add(found.id);
        const r = await completePatient(ctx, found, prep.patient);
        if (r.errors.length) {
          push({
            ...base,
            esito: 'scartata',
            motivi: r.errors,
            avvisi: [...prep.warnings, ...r.warnings],
          });
          continue;
        }
        if (r.completed.length) {
          await recordOrigin('patient', found.id, `${key}:completamento:${ctx.batchId}`);
          patients.set(cf, (await tx.select().from(patient).where(eq(patient.id, found.id)))[0]!);
          counts.pazientiCompletati++;
          push({
            ...base,
            esito: 'completata',
            motivi: [`Paziente già in cartella: completati ${r.completed.join(', ')}`],
            avvisi: [...prep.warnings, ...r.warnings],
          });
        } else
          push({
            ...base,
            esito: 'gia_presente',
            motivi: ['Paziente già in cartella: nessun campo vuoto da completare'],
            avvisi: [...prep.warnings, ...r.warnings],
          });
        continue;
      }

      if (!found) {
        push({
          ...base,
          esito: 'scartata',
          motivi: [
            'Nessun paziente con questo codice fiscale nell’archivio: importa prima i pazienti (anche nella stessa importazione)',
          ],
          avvisi: prep.warnings,
        });
        continue;
      }
      if (!newPatients.has(found.id)) existingPatients.add(found.id);
      const handler = handlers[dest as Exclude<typeof dest, 'pazienti'>];
      const items = prep.prepared!.items;
      let written = 0;
      let present = 0;
      let duplicates = 0;
      const firstSeen: number[] = [];
      for (const [i, item] of items.entries()) {
        const key = sourceKey(dest, cf, originId, item.naturalKey, i);
        const seenKey = `${handler.table}|${key}`;
        const seenAt = seen.get(seenKey);
        if (seenAt !== undefined) {
          duplicates++;
          firstSeen.push(seenAt);
          continue;
        }
        seen.set(seenKey, record.line);
        if (
          (await originExists(handler.table, key)) ||
          (handler.existing && (await handler.existing(tx, found.id, item.body)))
        ) {
          present++;
          continue;
        }
        const id = await handler.write(ctx, found.id, item.body);
        await recordOrigin(handler.table, id, key);
        written++;
      }
      counts.voci += written;
      if (written)
        push({
          ...base,
          esito: 'scritta',
          motivi: [
            items.length > 1 ? `${written} voci su ${items.length}` : 'Voce nuova',
            ...(present ? [`${present} già presenti`] : []),
            ...(duplicates ? [`${duplicates} già in righe precedenti del file`] : []),
          ],
          avvisi: prep.warnings,
          voci: written,
        });
      else if (present)
        push({
          ...base,
          esito: 'gia_presente',
          motivi: ['Già in cartella (importata prima o inserita a mano)'],
          avvisi: prep.warnings,
        });
      else
        push({
          ...base,
          esito: 'doppione',
          motivi: [`Stessa voce della riga ${firstSeen[0]} del file`],
          avvisi: prep.warnings,
        });
    }
  }

  // Fogli smistati per valore: righe che non vanno da nessuna parte.
  const byTable = new Map<string, ResolvedPart[]>();
  for (const p of parts) byTable.set(p.table.name, [...(byTable.get(p.table.name) ?? []), p]);
  for (const list of byTable.values()) {
    if (list.some((p) => !p.filter)) continue;
    const rows = list[0]!.rows;
    counts.escluse += rows.filter((r) => !list.some((p) => rowMatches(p, r.cells))).length;
  }

  const planHash = sha256(
    JSON.stringify(
      report
        .map((r) => [r.parte, r.riga, r.esito, r.motivi, r.avvisi])
        .concat([[JSON.stringify(counts)]]),
    ),
  );
  return { report, truncated, counts, existingPatients, newPatients, foreignPatients, planHash };
}
