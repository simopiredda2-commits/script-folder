import { readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { serviceGroup } from '@mmg/domain';
import { FICTITIOUS_PLACE_LETTER } from '@mmg/fixtures';
import {
  applyChanges,
  type DataRecord,
  KINDS,
  type Mapping,
  type MappingSet,
  extractRecords,
  parseChanges,
  findTranscriptions,
  mappingForSyncFile,
  mappingForTranscription,
  missingFields,
  readSyncState,
  readTable,
  sameScope,
  scopeText,
  sha256,
  structureProblems,
  type DatasetScope,
  type Transcription,
} from '@mmg/reference';
import { and, desc, eq, lt } from 'drizzle-orm';
import type { Database } from '../db/client';
import { REFERENCE_TABLES, referenceDataset } from '../db/schema';

/** Esito di un file nel rapporto d'importazione. */
export type ImportOutcome =
  | 'importato'
  | 'gia_importato'
  | 'senza_mappatura'
  | 'mappatura_da_completare'
  | 'serve_trascrizione'
  | 'in_attesa_in_sync'
  | 'impronta_diversa'
  | 'colonne_mancanti'
  | 'righe_non_valide'
  | 'trascrizione_superata'
  | 'trascrizione_non_valida'
  | 'origine_non_trovata'
  | 'base_mancante'
  | 'ambito_diverso'
  | 'trascrizione_da_controllare';

export interface ImportLine {
  /** fonte/chiave per i file di sync; percorso della scheda per le trascrizioni. */
  file: string;
  outcome: ImportOutcome;
  notes: string[];
  rows?: number;
  /** Avvisi su dati importati (per esempio un comune reale con la lettera dei luoghi inventati). */
  warnings?: string[];
}

export interface ImportOptions {
  db: Database;
  /** Cartella dei dati di sync (quella di --dest). */
  syncDir: string;
  /** Cartella delle trascrizioni dei PDF, se c'è. */
  transcriptionsDir?: string;
  mappings: MappingSet;
  /** Importa le righe valide anche se alcune sono state scartate (come --accetta di sync). */
  acceptDiscarded?: boolean;
  importedBy: string;
}

/** Esiti che chiedono l'intervento di una persona. */
export const NEEDS_ATTENTION: ReadonlySet<ImportOutcome> = new Set([
  'mappatura_da_completare',
  'serve_trascrizione',
  'in_attesa_in_sync',
  'righe_non_valide',
  'colonne_mancanti',
  'trascrizione_superata',
  'base_mancante',
  'ambito_diverso',
  'trascrizione_da_controllare',
]);
/** Esiti che sono errori veri e propri. */
export const ERRORS: ReadonlySet<ImportOutcome> = new Set([
  'impronta_diversa',
  'trascrizione_non_valida',
  'origine_non_trovata',
]);

const MAX_LISTED_PROBLEMS = 10;
const INSERT_BATCH = 1000;

interface DatasetMeta {
  kind: Mapping['tipo'];
  series: string;
  title: string;
  origin: 'sync' | 'trascrizione';
  source: string | null;
  fileKey: string | null;
  originalName: string | null;
  url: string | null;
  sha256: string;
  bytes: number;
  originSha256: string | null;
  downloadedAt: Date | null;
  validFrom: string;
  validFromBasis: 'scaricamento' | 'atto';
  /** Regione e ASL dove la versione vale, se non in tutta Italia (D232). */
  scopeRegion?: string | null;
  scopeAsl?: string | null;
  act: string | null;
  transcribedBy: string | null;
  transcribedOn: string | null;
  checkedBy: string | null;
}

/**
 * La stessa tabella già importata nella serie, con lo stesso ambito. Con un ambito diverso non è un
 * doppione: è la correzione dell'ambito (D239), che scopeFor ha già controllato.
 */
async function alreadyImported(db: Database, meta: DatasetMeta) {
  const rows = await db
    .select({
      importedAt: referenceDataset.importedAt,
      scopeRegion: referenceDataset.scopeRegion,
      scopeAsl: referenceDataset.scopeAsl,
    })
    .from(referenceDataset)
    .where(and(eq(referenceDataset.series, meta.series), eq(referenceDataset.sha256, meta.sha256)));
  const scope = { region: meta.scopeRegion ?? null, asl: meta.scopeAsl ?? null };
  return rows.find((r) => sameScope({ region: r.scopeRegion, asl: r.scopeAsl }, scope));
}

/**
 * Una serie vale in un solo ambito (D239): una versione nuova dice lo stesso ambito delle versioni
 * di prima, altrimenti per un'altra regione o ASL la serie sparirebbe (vale una versione per serie)
 * o un atto locale varrebbe ovunque. Un atto che modifica la serie, se non ripete l'ambito, lo
 * eredita dalla versione su cui è scritto. Lo stesso CSV alla stessa data con un ambito diverso
 * corregge la versione importata con l'ambito sbagliato: la nuova la sostituisce (vale l'ultima
 * importata), la vecchia resta nello storico.
 */
async function scopeFor(
  db: Database,
  series: string,
  sheet: Transcription,
  hash: string,
): Promise<(DatasetScope & { notes: string[] }) | { problem: string }> {
  const versions = await db
    .select({
      validFrom: referenceDataset.validFrom,
      importedAt: referenceDataset.importedAt,
      sha256: referenceDataset.sha256,
      scopeRegion: referenceDataset.scopeRegion,
      scopeAsl: referenceDataset.scopeAsl,
    })
    .from(referenceDataset)
    .where(eq(referenceDataset.series, series))
    .orderBy(
      desc(referenceDataset.validFrom),
      desc(referenceDataset.importedAt),
      desc(referenceDataset.id),
    );
  const of = (v: (typeof versions)[number]): DatasetScope => ({
    region: v.scopeRegion,
    asl: v.scopeAsl,
  });
  const notes: string[] = [];
  let scope: DatasetScope = {
    region: sheet.ambito?.regione ?? null,
    asl: sheet.ambito?.asl ?? null,
  };
  if (sheet.solo_modifiche && !sheet.ambito) {
    const base = versions.find((v) => v.validFrom < sheet.in_vigore_dal);
    if (base) {
      scope = of(base);
      if (scope.region || scope.asl)
        notes.push(`ambito della versione che l’atto modifica: ${scopeText(scope)}`);
    }
  }
  // Già importata con questo ambito: l'importazione lo dirà («già importato»).
  if (versions.some((v) => v.sha256 === hash && sameScope(of(v), scope)))
    return { ...scope, notes };
  const wrong = versions.find((v) => v.sha256 === hash && v.validFrom === sheet.in_vigore_dal);
  if (wrong) {
    notes.push(
      `corregge l’ambito della versione del ${wrong.validFrom} importata il ${wrong.importedAt.toISOString()}: era ${scopeText(of(wrong))}, ora ${scopeText(scope)}`,
    );
    return { ...scope, notes };
  }
  const latest = versions[0];
  if (latest && !sameScope(of(latest), scope))
    return {
      problem: `la serie ${series} vale in ${scopeText(of(latest))} e la scheda dice ${scopeText(scope)}: una serie vale in un solo ambito. L’atto di un’altra regione o di un’ASL va in una serie sua (campo «serie» della scheda); una versione importata con l’ambito sbagliato si corregge reimportando lo stesso CSV, alla stessa data, con l’ambito giusto`,
    };
  return { ...scope, notes };
}

/** Controlli sui dati, oltre alla forma dei campi. */
function warningsFor(kind: string, records: DataRecord[]): string[] {
  if (kind !== 'comuni') return [];
  // D12: i pazienti inventati nascono in luoghi con la lettera X, che nessun comune reale usa.
  const clashing = records.filter((r) =>
    String(r.cadastralCode).startsWith(FICTITIOUS_PLACE_LETTER),
  );
  return clashing.length
    ? [
        `${clashing.length} comuni hanno un codice catastale che inizia con ${FICTITIOUS_PLACE_LETTER}, la lettera riservata ai luoghi di nascita inventati: da rivedere`,
      ]
    : [];
}

async function store(
  opts: ImportOptions,
  meta: DatasetMeta,
  records: DataRecord[],
  discarded: number,
): Promise<void> {
  const table = REFERENCE_TABLES[meta.kind];
  await opts.db.transaction(async (tx) => {
    const [ds] = await tx
      .insert(referenceDataset)
      .values({
        ...meta,
        mappingVersion: opts.mappings.version,
        rows: records.length,
        discardedRows: discarded,
        importedBy: opts.importedBy,
      })
      .returning({ id: referenceDataset.id });
    for (let i = 0; i < records.length; i += INSERT_BATCH) {
      const batch = records.slice(i, i + INSERT_BATCH).map((r) => {
        const row: Record<string, unknown> = { datasetId: ds!.id };
        for (const [k, v] of Object.entries(r)) row[k] = typeof v === 'number' ? String(v) : v;
        return row;
      });
      // Il tipo dei valori lo garantiscono le definizioni dei campi (packages/reference, KINDS).
      await tx.insert(table).values(batch as never);
    }
  });
}

/**
 * D152: a ogni catalogo nuovo si ripete la prova della regola delle visite sull'elenco intero.
 * Il rapporto dice quante voci sono visite e quali nominano la visita senza esserlo (interventi
 * che la comprendono, note), perché una persona le controlli.
 */
function visitNotes(records: DataRecord[]): string[] {
  const text = (r: DataRecord) => (typeof r.description === 'string' ? r.description : '');
  const visits = records.filter((r) => serviceGroup(text(r)) === 'visita').length;
  const named = records.filter((r) => /VISIT/i.test(text(r)) && serviceGroup(text(r)) !== 'visita');
  const listed = named.slice(0, MAX_LISTED_PROBLEMS).map((r) => String(r.regionalCode));
  return [
    `visite secondo la regola di D152: ${visits} su ${records.length} voci`,
    ...(named.length
      ? [
          `${named.length} voci nominano la visita senza essere visite, da controllare: ${listed.join(', ')}${named.length > listed.length ? ', …' : ''}`,
        ]
      : []),
  ];
}

/** Estrae, controlla e salva: la parte comune a file di sync e trascrizioni. */
async function importRecords(
  opts: ImportOptions,
  line: ImportLine,
  mapping: Mapping,
  bytes: Uint8Array,
  fileName: string,
  meta: DatasetMeta,
): Promise<ImportLine> {
  const previous = await alreadyImported(opts.db, meta);
  if (previous) {
    return {
      ...line,
      outcome: 'gia_importato',
      notes: [
        ...line.notes,
        `stessa impronta già importata il ${previous.importedAt.toISOString()}`,
      ],
    };
  }
  const out = extractRecords(mapping, readTable(bytes, fileName));
  if (out.missingColumns.length) {
    return {
      ...line,
      outcome: 'colonne_mancanti',
      notes: [...line.notes, `colonne non trovate: ${out.missingColumns.join('; ')}`],
    };
  }
  // Controlli sull'elenco intero (le diagnosi: codici ripetuti, padri che mancano).
  const structure = structureProblems(meta.kind, out.records);
  const problems = [
    ...out.problems.map((p) => `riga ${p.line}, ${p.field}: ${p.problem}`),
    ...structure.map((p) => `voce ${p.problem}`),
  ];
  if (problems.length && !opts.acceptDiscarded) {
    return {
      ...line,
      outcome: 'righe_non_valide',
      notes: [
        ...line.notes,
        `${problems.length} problemi; il file non è stato importato. Dopo il controllo si può importare con --accetta-scarti`,
        ...problems.slice(0, MAX_LISTED_PROBLEMS),
      ],
    };
  }
  const dropped = new Set(structure.map((p) => p.index));
  const records = out.records.filter((_, i) => !dropped.has(i));
  const discarded = new Set(out.problems.map((p) => p.line)).size + dropped.size;
  await store(opts, meta, records, discarded);
  const warnings = warningsFor(meta.kind, records);
  const visits = meta.kind === 'prestazioni' ? visitNotes(records) : [];
  const noValue = Object.entries(out.noValue).map(
    ([field, n]) => `${field}: ${n} celle senza valore secondo la mappatura ${mapping.id}`,
  );
  const padded = Object.entries(out.padded).map(
    ([field, n]) => `${field}: ${n} valori con gli zeri davanti secondo la mappatura ${mapping.id}`,
  );
  const skipped = out.skipped
    ? [
        `${out.skipped} righe saltate perché senza ${mapping.saltaRigheSenza.join(', ')} secondo la mappatura ${mapping.id}`,
      ]
    : [];
  return {
    ...line,
    outcome: 'importato',
    rows: records.length,
    notes: [
      ...line.notes,
      ...noValue,
      ...padded,
      ...skipped,
      ...visits,
      ...(discarded ? [`${discarded} righe scartate e accettate`] : []),
    ],
    ...(warnings.length ? { warnings } : {}),
  };
}

/**
 * Un atto che modifica una tabella (D157): dalla versione della serie in vigore il giorno prima
 * si tolgono le voci tolte e si aggiungono quelle nuove; il risultato è una versione intera,
 * immutabile come le altre, che vale dalla data dell'atto.
 */
async function importChanges(
  opts: ImportOptions,
  line: ImportLine,
  mapping: Mapping,
  bytes: Uint8Array,
  fileName: string,
  meta: DatasetMeta,
): Promise<ImportLine> {
  const previous = await alreadyImported(opts.db, meta);
  if (previous) {
    return {
      ...line,
      outcome: 'gia_importato',
      notes: [
        ...line.notes,
        `stessa impronta già importata il ${previous.importedAt.toISOString()}`,
      ],
    };
  }
  const parsed = parseChanges(mapping, readTable(bytes, fileName));
  if (parsed.missingColumns.length) {
    return {
      ...line,
      outcome: 'colonne_mancanti',
      notes: [...line.notes, `colonne non trovate: ${parsed.missingColumns.join('; ')}`],
    };
  }
  const [base] = await opts.db
    .select()
    .from(referenceDataset)
    .where(
      and(eq(referenceDataset.series, meta.series), lt(referenceDataset.validFrom, meta.validFrom)),
    )
    .orderBy(
      desc(referenceDataset.validFrom),
      desc(referenceDataset.importedAt),
      desc(referenceDataset.id),
    )
    .limit(1);
  if (!base) {
    return {
      ...line,
      outcome: 'base_mancante',
      notes: [
        ...line.notes,
        `nessuna versione della serie ${meta.series} in vigore prima del ${meta.validFrom}: serve prima la versione intera su cui l'atto è scritto`,
      ],
    };
  }
  const table = REFERENCE_TABLES[meta.kind] as (typeof REFERENCE_TABLES)['prestazioni'];
  const fields = Object.keys(KINDS[meta.kind].fields);
  const baseRecords = (await opts.db.select().from(table).where(eq(table.datasetId, base.id))).map(
    (r) =>
      Object.fromEntries(
        fields.map((f) => [f, (r as Record<string, unknown>)[f] ?? null]),
      ) as DataRecord,
  );
  const applied = applyChanges(meta.kind, baseRecords, parsed.changes);
  const problems = [...parsed.problems, ...applied.problems];
  // L'elenco che risulta dall'atto si controlla come una versione intera.
  const structure = structureProblems(meta.kind, applied.records);
  const listed = [
    ...problems.map((p) => `riga ${p.line}, ${p.field}: ${p.problem}`),
    ...structure.map((p) => `voce ${p.problem}`),
  ];
  if (listed.length && !opts.acceptDiscarded) {
    return {
      ...line,
      outcome: 'righe_non_valide',
      notes: [
        ...line.notes,
        `${listed.length} problemi; l'atto non è stato applicato. Dopo il controllo si può applicare con --accetta-scarti`,
        ...listed.slice(0, MAX_LISTED_PROBLEMS),
      ],
    };
  }
  const dropped = new Set(structure.map((p) => p.index));
  const records = applied.records.filter((_, i) => !dropped.has(i));
  await store(opts, meta, records, new Set(problems.map((p) => p.line)).size + dropped.size);
  const visits = meta.kind === 'prestazioni' ? visitNotes(records) : [];
  return {
    ...line,
    outcome: 'importato',
    rows: records.length,
    notes: [
      ...line.notes,
      `modifiche alla versione del ${base.validFrom} (${base.act ?? base.title}): ${applied.added} voci aggiunte, ${applied.replaced} sostituite, ${applied.removed} tolte; ${records.length} voci in tutto`,
      ...visits,
    ],
  };
}

/**
 * Importa nel database i file in uso di sync (correnti/) e le trascrizioni dei PDF.
 * Non cambia nulla di ciò che è già importato: ogni file nuovo diventa una versione.
 */
export async function importReferenceData(opts: ImportOptions): Promise<ImportLine[]> {
  const report: ImportLine[] = [];
  const entries = readSyncState(opts.syncDir);
  const transcriptions = opts.transcriptionsDir
    ? findTranscriptions(opts.transcriptionsDir)
    : { found: [], invalid: [] };
  const transcribed = new Set(
    transcriptions.found
      .filter((t) => t.sheet.fonte && t.sheet.chiave)
      .map((t) => `${t.sheet.fonte}/${t.sheet.chiave}`),
  );

  for (const e of entries.sort((a, b) =>
    `${a.fonte}/${a.chiave}`.localeCompare(`${b.fonte}/${b.chiave}`),
  )) {
    const name = `${e.fonte}/${e.chiave}`;
    const line: ImportLine = { file: name, outcome: 'importato', notes: [] };
    const pending = e.in_attesa
      ? ['una versione più nuova aspetta la verifica in sync (--accetta)']
      : [];
    if (!e.corrente || !e.sha256) {
      if (e.in_attesa) report.push({ ...line, outcome: 'in_attesa_in_sync', notes: pending });
      continue;
    }
    if (extname(e.chiave).toLowerCase() === '.pdf') {
      if (!transcribed.has(name)) {
        report.push({
          ...line,
          outcome: 'serve_trascrizione',
          notes: ['PDF: i dati si importano da una trascrizione controllata (A8)', ...pending],
        });
      }
      continue;
    }
    const mapping = mappingForSyncFile(opts.mappings, e.fonte, e.chiave);
    if (!mapping) {
      report.push({ ...line, outcome: 'senza_mappatura', notes: pending });
      continue;
    }
    const missing = missingFields(mapping);
    if (missing.length) {
      report.push({
        ...line,
        outcome: 'mappatura_da_completare',
        notes: [
          `mappatura ${mapping.id}: mancano le colonne per ${missing.join(', ')}`,
          ...(e.intestazione ? [`intestazione del file: ${e.intestazione.join(' | ')}`] : []),
          ...pending,
        ],
      });
      continue;
    }
    const bytes = new Uint8Array(readFileSync(join(opts.syncDir, e.corrente)));
    const hash = sha256(bytes);
    if (hash !== e.sha256) {
      report.push({
        ...line,
        outcome: 'impronta_diversa',
        notes: [
          `il file in uso non ha l'impronta registrata da sync (${e.sha256}): non si importa`,
        ],
      });
      continue;
    }
    report.push(
      await importRecords(opts, { ...line, notes: pending }, mapping, bytes, e.chiave, {
        kind: mapping.tipo,
        series: mapping.id,
        title: mapping.titolo,
        origin: 'sync',
        source: e.fonte,
        fileKey: e.chiave,
        originalName: e.nome_originale ?? null,
        url: e.url ?? null,
        sha256: hash,
        bytes: bytes.length,
        originSha256: null,
        downloadedAt: e.scaricato_il ? new Date(e.scaricato_il) : null,
        // Il giorno del download, nell'ora locale con cui sync lo ha scritto.
        validFrom: (e.scaricato_il ?? '').slice(0, 10),
        validFromBasis: 'scaricamento',
        act: null,
        transcribedBy: null,
        transcribedOn: null,
        checkedBy: null,
      }),
    );
  }

  for (const bad of transcriptions.invalid) {
    report.push({ file: bad.path, outcome: 'trascrizione_non_valida', notes: [bad.problem] });
  }
  const bySync = new Map(entries.map((e) => [`${e.fonte}/${e.chiave}`, e]));
  // Prima le versioni intere, poi gli atti che le modificano, in ordine di data (D157).
  const ordered = [
    ...transcriptions.found.filter((t) => !t.sheet.solo_modifiche),
    ...transcriptions.found
      .filter((t) => t.sheet.solo_modifiche)
      .sort(
        (a, b) =>
          a.sheet.in_vigore_dal.localeCompare(b.sheet.in_vigore_dal) ||
          a.path.localeCompare(b.path),
      ),
  ];
  for (const t of ordered) {
    const s = t.sheet;
    const line: ImportLine = { file: t.path, outcome: 'importato', notes: [] };
    const mapping = mappingForTranscription(opts.mappings, s.tipo);
    if (!mapping) {
      report.push({ ...line, outcome: 'senza_mappatura' });
      continue;
    }
    // A8: una trascrizione entra in uso solo dopo il controllo di una persona (D159).
    if (s.controllato_da === null) {
      report.push({
        ...line,
        outcome: 'trascrizione_da_controllare',
        notes: [
          `${s.atto}: nessuno l'ha ancora controllata. Entra in uso quando la scheda dice chi l'ha controllata (controllato_da)`,
        ],
      });
      continue;
    }
    let origin: string | null = null;
    if (s.fonte && s.chiave) {
      const entry = bySync.get(`${s.fonte}/${s.chiave}`);
      if (!entry?.sha256) {
        report.push({
          ...line,
          outcome: 'origine_non_trovata',
          notes: [`il PDF ${s.fonte}/${s.chiave} non è nello stato di sync`],
        });
        continue;
      }
      if (entry.sha256 !== s.sha256_origine) {
        report.push({
          ...line,
          outcome: 'trascrizione_superata',
          notes: [
            `il PDF in uso è cambiato dopo la trascrizione (impronta ${entry.sha256}): va trascritta la versione nuova`,
          ],
        });
        continue;
      }
      origin = entry.sha256;
    } else {
      line.notes.push(
        `atto non scaricato da sync: origine non verificabile con un'impronta (${s.atto})`,
      );
    }
    const bytes = new Uint8Array(readFileSync(t.csvPath));
    const series = s.serie ?? mapping.id;
    const scope = await scopeFor(opts.db, series, s, sha256(bytes));
    if ('problem' in scope) {
      report.push({ ...line, outcome: 'ambito_diverso', notes: [...line.notes, scope.problem] });
      continue;
    }
    line.notes.push(...scope.notes);
    const load = s.solo_modifiche ? importChanges : importRecords;
    report.push(
      await load(opts, line, mapping, bytes, t.csvPath, {
        kind: s.tipo,
        series,
        title: mapping.titolo,
        origin: 'trascrizione',
        source: s.fonte,
        fileKey: s.chiave,
        originalName: null,
        url: s.fonte && s.chiave ? (bySync.get(`${s.fonte}/${s.chiave}`)?.url ?? null) : null,
        sha256: sha256(bytes),
        bytes: bytes.length,
        originSha256: origin,
        downloadedAt: null,
        validFrom: s.in_vigore_dal,
        validFromBasis: 'atto',
        scopeRegion: scope.region,
        scopeAsl: scope.asl,
        act: s.atto,
        transcribedBy: s.trascritto_da,
        transcribedOn: s.trascritto_il,
        checkedBy: s.controllato_da,
      }),
    );
  }
  return report;
}
