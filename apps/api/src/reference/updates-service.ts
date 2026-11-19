import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadMappings, REGIONAL_TRANSCRIPTIONS } from '@mmg/reference';
import { desc } from 'drizzle-orm';
import type { ReferenceUpdateConfig } from '../config';
import type { Database } from '../db/client';
import { referenceUpdateRun } from '../db/schema';
import { EXAMPLE_TRANSCRIPTIONS, EXAMPLES_DIR, exampleSourcesSync } from './example-site';
import { nextRunAt, previousRunAt, ReferenceUpdateScheduler, STUDIO_TIME_ZONE } from './scheduler';
import {
  beginReferenceUpdate,
  publicSourcesSync,
  type UpdateRun,
  type UpdateSetup,
  type UpdateTrigger,
} from './update';

export interface UpdatesOptions {
  /** Ora dell'aggiornamento di ogni notte («HH:MM»); assente = nessun avvio automatico. */
  time?: string;
  /** Nome di ogni fonte (ente · titolo), dal file delle fonti in uso. */
  sourceNames?: Record<string, string>;
  timeZone?: string;
  now?: () => Date;
  catchUpDelayMs?: number;
  log?: (message: string, err?: unknown) => void;
}

/**
 * Gli aggiornamenti delle banche dati di questa installazione (D156). Senza `setup` non si
 * aggiorna nulla: è il caso dello sviluppo e delle prove, che non chiamano siti veri (regola 7).
 */
export class ReferenceUpdates {
  private scheduler: ReferenceUpdateScheduler | null = null;
  private controller: AbortController | null = null;
  private current: Promise<UpdateRun> | null = null;
  private readonly now: () => Date;

  constructor(
    private readonly db: Database,
    private readonly setup: UpdateSetup | null,
    private readonly opts: UpdatesOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  get configured(): boolean {
    return this.setup !== null;
  }

  /** Nome di ogni fonte, per le schermate; le fonti senza nome si mostrano con il loro id. */
  get sourceNames(): Record<string, string> {
    return this.opts.sourceNames ?? {};
  }

  /** Ora dell'aggiornamento automatico, se c'è. */
  get time(): string | null {
    return this.setup && this.opts.time ? this.opts.time : null;
  }

  /** Prossimo avvio automatico previsto. */
  nextRun(): Date | null {
    if (this.scheduler?.next) return this.scheduler.next;
    return this.time ? nextRunAt(this.now(), this.time, this.opts.timeZone) : null;
  }

  /** Da quando dovrebbe esserci un giro nuovo (l'ultima ora prevista); null senza orario. */
  expectedSince(at: Date): Date | null {
    return this.time ? previousRunAt(at, this.time, this.opts.timeZone ?? STUDIO_TIME_ZONE) : null;
  }

  /** Avvia un giro; restituisce subito, con la promessa del giro finito. */
  async start(trigger: UpdateTrigger, requestedBy: string) {
    if (!this.setup) throw new Error('Aggiornamento delle banche dati non configurato');
    const controller = new AbortController();
    const begun = await beginReferenceUpdate(this.db, this.setup, {
      trigger,
      requestedBy,
      now: this.now,
      signal: controller.signal,
    });
    this.controller = controller;
    const done = begun.done.finally(() => {
      if (this.current === done) {
        this.current = null;
        this.controller = null;
      }
    });
    this.current = done;
    return { id: begun.id, done };
  }

  /** Il giro in corso in questo processo, se c'è (per le prove e per la chiusura). */
  get inProgress(): Promise<UpdateRun> | null {
    return this.current;
  }

  /** Avvia l'orologio di ogni notte, se c'è un orario. */
  async startScheduler(): Promise<void> {
    if (!this.time) return;
    this.scheduler = new ReferenceUpdateScheduler({
      time: this.time,
      timeZone: this.opts.timeZone,
      now: this.now,
      catchUpDelayMs: this.opts.catchUpDelayMs,
      log: this.opts.log,
      run: async () => (await this.start('automatico', 'orologio del servizio')).done,
      lastStartedAt: async () => {
        const [row] = await this.db
          .select({ startedAt: referenceUpdateRun.startedAt })
          .from(referenceUpdateRun)
          .orderBy(desc(referenceUpdateRun.startedAt))
          .limit(1);
        return row?.startedAt ?? null;
      },
    });
    await this.scheduler.start();
  }

  /** Ferma l'orologio e il download in corso; aspetta che il giro si chiuda. */
  async stop(): Promise<void> {
    const scheduler = this.scheduler;
    this.scheduler = null;
    this.controller?.abort();
    await Promise.all([scheduler?.stop(), this.current?.catch(() => undefined)]);
  }
}

const ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');

/** Nome di ogni fonte di un file delle fonti di sync: «ente · titolo». */
export function sourceNamesOf(file: string): Record<string, string> {
  const raw = JSON.parse(readFileSync(file, 'utf-8')) as {
    fonti: { id: string; ente: string; titolo: string }[];
  };
  return Object.fromEntries(raw.fonti.map((f) => [f.id, `${f.ente} · ${f.titolo}`]));
}

/** Gli aggiornamenti come li vuole la configurazione del servizio. */
export function referenceUpdatesFromConfig(
  db: Database,
  config: ReferenceUpdateConfig | null,
  opts: Omit<UpdatesOptions, 'time'> = {},
): ReferenceUpdates {
  if (!config) return new ReferenceUpdates(db, null, opts);
  const example = config.sources === 'esempio';
  const setup: UpdateSetup = {
    dataDir: config.dataDir,
    mappings: loadMappings(),
    sync: example
      ? exampleSourcesSync()
      : publicSourcesSync(config.sources === 'pubbliche' ? {} : { sourcesFile: config.sources }),
  };
  // Per difetto le trascrizioni che il programma porta con sé (D159), o quelle d'esempio.
  setup.transcriptionsDir =
    config.transcriptionsDir ?? (example ? EXAMPLE_TRANSCRIPTIONS : REGIONAL_TRANSCRIPTIONS);
  const sourcesFile = example
    ? join(EXAMPLES_DIR, 'fonti-prova.json')
    : config.sources === 'pubbliche'
      ? join(ROOT, 'sync', 'fonti.json')
      : config.sources;
  return new ReferenceUpdates(db, setup, {
    ...opts,
    sourceNames: sourceNamesOf(sourcesFile),
    ...(config.time ? { time: config.time } : {}),
  });
}
