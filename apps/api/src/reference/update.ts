import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import {
  type MappingSet,
  readSyncReport,
  readSyncState,
  type SyncEntry,
  type SyncReport,
} from '@mmg/reference';
import { and, desc, eq, isNotNull, lt } from 'drizzle-orm';
import type { Database } from '../db/client';
import { referenceDataset, referenceUpdateRun } from '../db/schema';
import { ERRORS, importReferenceData, NEEDS_ATTENTION, type ImportLine } from './importer';

/**
 * Aggiornamento delle banche dati (D156): sync scarica dalle fonti solo ciò che è cambiato (A1),
 * poi l'importazione controlla e mette in uso le versioni nuove (A3, A5). Ogni giro resta nel
 * registro con l'esito, e alla fine dice per ogni serie in uso se la sua fonte è stata controllata
 * e se una versione più nuova aspetta qualcuno (A6, A8). Lo stesso giro per il comando sul server e
 * per l'avvio di ogni notte: le banche dati le aggiorna chi gestisce il servizio (D192).
 */

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const SYNC_SCRIPT = join(ROOT, 'sync', 'banche_dati.py');

/**
 * Come è partito un giro. «pulsante» sono i giri avviati dagli strumenti dello studio prima di D192:
 * restano nel registro con il loro nome, ma un giro nuovo parte solo dal comando sul server o
 * dall'orologio di ogni notte.
 */
export const UPDATE_TRIGGERS = ['comando', 'automatico', 'pulsante'] as const;
export type UpdateTrigger = (typeof UPDATE_TRIGGERS)[number];
/** Come può partire un giro nuovo (D192). */
export type StartTrigger = Exclude<UpdateTrigger, 'pulsante'>;
export type UpdateOutcome = 'ok' | 'da_verificare' | 'errore' | 'interrotto';

export interface SyncResult {
  code: number;
  output: string;
}
/** Lancia sync con la cartella dei dati indicata. */
export type SyncRunner = (dest: string, signal?: AbortSignal) => Promise<SyncResult>;

/** Tempo massimo di un giro di sync sulle fonti vere. */
const SYNC_TIMEOUT_MS = 3 * 60 * 60 * 1000;
/** Un giro ancora «in corso» dopo tanto tempo si è fermato a metà (servizio spento). */
const STALE_RUN_MS = 6 * 60 * 60 * 1000;
/** Quanta parte dell'output di sync si conserva. */
const OUTPUT_TAIL = 20_000;

function exitCode(err: Error | null): number {
  if (!err) return 0;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'number' ? code : 1;
}

/**
 * sync/banche_dati.py sulle fonti pubbliche di sync/fonti.json (o su un altro file di fonti). Solo
 * per l'installazione vera: le prove usano il sito d'esempio (regola 7).
 */
export function publicSourcesSync(
  opts: { sourcesFile?: string; contact?: string; timeoutMs?: number } = {},
): SyncRunner {
  return (dest, signal) =>
    new Promise((ok) => {
      execFile(
        'python3',
        [
          '-I',
          SYNC_SCRIPT,
          '--dest',
          dest,
          ...(opts.sourcesFile ? ['--fonti', opts.sourcesFile] : []),
          ...(opts.contact ? ['--contatto', opts.contact] : []),
        ],
        {
          maxBuffer: 32 * 1024 * 1024,
          timeout: opts.timeoutMs ?? SYNC_TIMEOUT_MS,
          ...(signal ? { signal } : {}),
        },
        (err, stdout, stderr) => ok({ code: exitCode(err), output: `${stdout}${stderr}` }),
      );
    });
}

export interface UpdateSetup {
  /** Cartella dei dati di sync (il suo --dest). */
  dataDir: string;
  /** Cartella delle trascrizioni dei PDF, se c'è. */
  transcriptionsDir?: string;
  mappings: MappingSet;
  sync: SyncRunner;
}

/** Stato di una serie in uso alla fine di un giro. */
export interface SeriesStatus {
  series: string;
  title: string;
  /** Fonte di sync della versione in uso (per le trascrizioni: quella del PDF trascritto). */
  source: string | null;
  /** Ultimo controllo riuscito di quel file alla fonte, secondo sync. */
  checkedAt: string | null;
  /** Il giro ha elaborato la fonte, ma quel file non è stato controllato. */
  checkFailed: boolean;
  /** Una versione più nuova c'è ma non è in uso: perché, in parole. */
  pending: string[];
}

/** Una cosa che una persona deve guardare dopo un giro. */
export interface UpdateIssue {
  /** «errore» se qualcosa non ha funzionato, «da_verificare» se serve una persona. */
  level: 'errore' | 'da_verificare';
  source: string;
  file: string;
  what: string;
  notes: string[];
}

export type UpdateRun = typeof referenceUpdateRun.$inferSelect;

export class UpdateInProgressError extends Error {
  constructor(public readonly runningSince: Date) {
    super('Un aggiornamento delle banche dati è già in corso');
  }
}

const IMPORT_LABELS: Record<ImportLine['outcome'], string> = {
  importato: 'importato',
  gia_importato: 'già importato',
  senza_mappatura: 'senza mappatura',
  mappatura_da_completare: 'mappatura da completare',
  serve_trascrizione: 'serve una trascrizione',
  in_attesa_in_sync: 'versione nuova in attesa di verifica',
  impronta_diversa: 'impronta diversa da quella registrata',
  colonne_mancanti: 'colonne mancanti',
  righe_non_valide: 'righe non valide',
  trascrizione_superata: 'trascrizione superata dal PDF nuovo',
  trascrizione_non_valida: 'trascrizione non valida',
  origine_non_trovata: 'PDF d’origine non trovato',
  base_mancante: 'manca la versione su cui l’atto è scritto',
  trascrizione_da_controllare: 'trascrizione da controllare: non ancora in uso',
};

/** Esito del giro, con le stesse regole del comando d'importazione e di sync. */
export function outcomeOf(
  syncCode: number,
  lines: readonly ImportLine[] | null,
  message: string | null,
): Exclude<UpdateOutcome, 'interrotto'> {
  if (message || (syncCode !== 0 && syncCode !== 2) || lines?.some((l) => ERRORS.has(l.outcome)))
    return 'errore';
  if (
    syncCode === 2 ||
    lines?.some((l) => NEEDS_ATTENTION.has(l.outcome) || (l.warnings?.length ?? 0) > 0)
  )
    return 'da_verificare';
  return 'ok';
}

/** Le cose da guardare dopo un giro: righe di sync con un problema e file da completare. */
export function issuesOf(run: Pick<UpdateRun, 'syncReport' | 'importReport'>): UpdateIssue[] {
  const report = run.syncReport as SyncReport | null;
  const lines = (run.importReport as ImportLine[] | null) ?? [];
  const out: UpdateIssue[] = [];
  for (const r of report?.righe ?? []) {
    if (r.esito !== 'errore' && r.esito !== 'da_verificare') continue;
    out.push({
      level: r.esito,
      source: r.fonte,
      file: r.nome,
      what: r.esito === 'errore' ? 'non scaricato' : 'da verificare in sync',
      notes: r.note,
    });
  }
  for (const l of lines) {
    const error = ERRORS.has(l.outcome);
    if (!error && !NEEDS_ATTENTION.has(l.outcome) && !l.warnings?.length) continue;
    // La versione in attesa è già una riga di sync: non si ripete.
    if (l.outcome === 'in_attesa_in_sync') continue;
    const [source, ...rest] = l.file.split('/');
    out.push({
      level: error ? 'errore' : 'da_verificare',
      source: rest.length ? source! : '',
      file: rest.length ? rest.join('/') : l.file,
      what: IMPORT_LABELS[l.outcome],
      notes: [...l.notes, ...(l.warnings ?? [])],
    });
  }
  return out;
}

const later = (a: string | undefined, b: string | undefined) =>
  !a ? b : !b ? a : Date.parse(a) >= Date.parse(b) ? a : b;

const day = (iso: string | undefined) =>
  iso ? new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome' }).format(new Date(iso)) : '';

/** Per ogni serie, la versione più recente e lo stato della sua fonte dopo il giro. */
async function seriesStatusOf(
  db: Database,
  state: SyncEntry[],
  report: SyncReport | null,
  lines: readonly ImportLine[],
): Promise<SeriesStatus[]> {
  const byKey = new Map(state.map((e) => [`${e.fonte}/${e.chiave}`, e]));
  const latest = await db
    .selectDistinctOn([referenceDataset.series])
    .from(referenceDataset)
    .orderBy(
      referenceDataset.series,
      desc(referenceDataset.validFrom),
      desc(referenceDataset.importedAt),
      desc(referenceDataset.id),
    );
  return latest.map((d) => {
    const key = d.source && d.fileKey ? `${d.source}/${d.fileKey}` : null;
    const entry = key ? byKey.get(key) : undefined;
    const processed = !!report && !!d.source && report.fonti.includes(d.source);
    const checkedNow = report?.righe.some(
      (r) => r.fonte === d.source && r.nome === d.fileKey && r.esito !== 'errore',
    );
    const pending: string[] = [];
    const waiting = entry?.in_attesa as { scaricato_il?: string; note?: string[] } | undefined;
    if (waiting) {
      pending.push(
        `una versione più nuova, scaricata il ${day(waiting.scaricato_il)}, aspetta la verifica${
          waiting.note?.length ? `: ${waiting.note.join('; ')}` : ''
        }`,
      );
    }
    if (d.origin === 'sync' && entry?.sha256 && entry.sha256 !== d.sha256) {
      const line = lines.find((l) => l.file === key);
      pending.push(
        `il file scaricato il ${day(entry.scaricato_il)} non è entrato in uso${
          line && line.outcome !== 'importato' ? `: ${IMPORT_LABELS[line.outcome]}` : ''
        }`,
      );
    }
    if (d.origin === 'trascrizione' && d.source) {
      if (entry?.sha256 && d.originSha256 && entry.sha256 !== d.originSha256) {
        pending.push('il PDF trascritto è cambiato alla fonte: va trascritta la versione nuova');
      }
      // Documenti della stessa fonte arrivati dopo il PDF trascritto e non ancora trascritti.
      const newer = lines
        .filter((l) => l.outcome === 'serve_trascrizione' && l.file.startsWith(`${d.source}/`))
        .map((l) => byKey.get(l.file))
        .filter(
          (e): e is SyncEntry =>
            !!e &&
            (!entry?.scaricato_il ||
              (!!e.scaricato_il && Date.parse(e.scaricato_il) > Date.parse(entry.scaricato_il))),
        );
      if (newer.length) {
        pending.push(
          `documenti nuovi della fonte da trascrivere: ${newer
            .map((e) => e.nome_originale ?? e.chiave)
            .join(', ')}`,
        );
      }
    }
    return {
      series: d.series,
      title: d.title,
      source: d.source,
      checkedAt:
        later(later(entry?.controllato_il, entry?.scaricato_il), waiting?.scaricato_il) ?? null,
      checkFailed: processed && !!key && !checkedNow,
      pending,
    };
  });
}

const tail = (text: string) => (text.length > OUTPUT_TAIL ? text.slice(-OUTPUT_TAIL) : text);

/** Il giro rimasto «in corso» da troppo si è fermato a metà: si chiude come interrotto. */
async function closeAbandoned(db: Database, now: Date) {
  await db
    .update(referenceUpdateRun)
    .set({
      running: null,
      finishedAt: now,
      outcome: 'interrotto',
      message: 'Aggiornamento rimasto a metà: il servizio si è fermato mentre girava',
    })
    .where(
      and(
        eq(referenceUpdateRun.running, true),
        lt(referenceUpdateRun.startedAt, new Date(now.getTime() - STALE_RUN_MS)),
      ),
    );
}

export interface BeginOptions {
  trigger: StartTrigger;
  requestedBy: string;
  now: () => Date;
  signal?: AbortSignal;
}

/**
 * Avvia un giro: lo registra come «in corso» (uno solo alla volta) e restituisce subito, con la
 * promessa del giro finito. Se un altro giro è in corso: UpdateInProgressError.
 */
export async function beginReferenceUpdate(
  db: Database,
  setup: UpdateSetup,
  opts: BeginOptions,
): Promise<{ id: string; done: Promise<UpdateRun> }> {
  const startedAt = opts.now();
  await closeAbandoned(db, startedAt);
  let id: string;
  try {
    [{ id }] = (await db
      .insert(referenceUpdateRun)
      .values({
        trigger: opts.trigger,
        requestedBy: opts.requestedBy,
        startedAt,
        running: true,
      })
      .returning({ id: referenceUpdateRun.id })) as [{ id: string }];
  } catch (err) {
    if (
      (err as { code?: string; cause?: { code?: string } }).code === '23505' ||
      (err as { cause?: { code?: string } }).cause?.code === '23505'
    ) {
      const [current] = await db
        .select({ startedAt: referenceUpdateRun.startedAt })
        .from(referenceUpdateRun)
        .where(eq(referenceUpdateRun.running, true));
      throw new UpdateInProgressError(current?.startedAt ?? startedAt);
    }
    throw err;
  }
  return { id, done: work(db, setup, opts, id) };
}

async function work(
  db: Database,
  setup: UpdateSetup,
  opts: BeginOptions,
  id: string,
): Promise<UpdateRun> {
  const finish = async (fields: Partial<typeof referenceUpdateRun.$inferInsert>) => {
    const [row] = await db
      .update(referenceUpdateRun)
      .set({ ...fields, running: null, finishedAt: opts.now() })
      .where(eq(referenceUpdateRun.id, id))
      .returning();
    return row!;
  };
  try {
    let before: string | null = null;
    try {
      before = readSyncReport(setup.dataDir)?.giro ?? null;
    } catch {
      // Un rapporto illeggibile del giro precedente non ferma il giro nuovo.
    }
    let sync: SyncResult;
    try {
      sync = await setup.sync(setup.dataDir, opts.signal);
    } catch (err) {
      return await finish({
        outcome: 'errore',
        message: `sync non è partito: ${(err as Error).message}`,
      });
    }
    if (opts.signal?.aborted) {
      return await finish({
        outcome: 'interrotto',
        syncExitCode: sync.code,
        output: tail(sync.output),
        message: 'Aggiornamento interrotto: il servizio si è fermato durante il download',
      });
    }
    let report: SyncReport | null = null;
    let message: string | null = null;
    try {
      const after = readSyncReport(setup.dataDir);
      // Solo il rapporto di questo giro: se sync si è fermato prima, resta quello vecchio.
      report = after && after.giro !== before ? after : null;
    } catch (err) {
      message = `rapporto di sync illeggibile: ${(err as Error).message}`;
    }
    let lines: ImportLine[] | null = null;
    let seriesStatus: SeriesStatus[] | null = null;
    try {
      lines = await importReferenceData({
        db,
        syncDir: setup.dataDir,
        transcriptionsDir: setup.transcriptionsDir,
        mappings: setup.mappings,
        importedBy: `aggiornamento ${opts.trigger} (${opts.requestedBy})`,
      });
      seriesStatus = await seriesStatusOf(db, readSyncState(setup.dataDir), report, lines);
    } catch (err) {
      message ??= `importazione non riuscita: ${(err as Error).message}`;
    }
    if (!report && !message) {
      message = 'sync non ha scritto il rapporto di questo giro: vedi l’output';
    }
    return await finish({
      outcome: outcomeOf(sync.code, lines, message),
      syncExitCode: sync.code,
      syncReport: report,
      importReport: lines,
      seriesStatus,
      message,
      output: tail(sync.output),
    });
  } catch (err) {
    await finish({ outcome: 'errore', message: (err as Error).message });
    throw err;
  }
}

/** Gli ultimi giri, dal più recente. */
export async function recentRuns(db: Database, limit = 10): Promise<UpdateRun[]> {
  return db
    .select()
    .from(referenceUpdateRun)
    .orderBy(desc(referenceUpdateRun.startedAt))
    .limit(limit);
}

/** L'ultimo giro finito. */
export async function lastFinishedRun(db: Database): Promise<UpdateRun | null> {
  const [row] = await db
    .select()
    .from(referenceUpdateRun)
    .where(isNotNull(referenceUpdateRun.finishedAt))
    .orderBy(desc(referenceUpdateRun.startedAt))
    .limit(1);
  return row ?? null;
}
