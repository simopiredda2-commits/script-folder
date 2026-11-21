/**
 * Avvio automatico dell'aggiornamento delle banche dati ogni notte (A1, D156), all'ora dello studio
 * (Europe/Rome), anche nei due giorni del cambio dell'ora. Se il servizio era spento all'ora
 * prevista, il giro perso parte poco dopo l'avvio. Mai due giri insieme: il secondo trova il primo
 * in corso e salta.
 */

import { unrefTimer } from '../timers';

export const STUDIO_TIME_ZONE = 'Europe/Rome';

/** «HH:MM» → ore e minuti; errore se non è un'ora valida. */
export function parseTime(time: string): { hour: number; minute: number } {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time);
  if (!m) throw new Error(`Ora non valida: «${time}» (serve HH:MM, per esempio 03:30)`);
  return { hour: Number(m[1]), minute: Number(m[2]) };
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function localParts(at: Date, timeZone: string): LocalParts {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(at).map((x) => [x.type, x.value]));
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

/** Differenza fra l'ora locale e quella universale in quell'istante, in millisecondi. */
function offsetAt(at: Date, timeZone: string): number {
  const p = localParts(at, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * L'istante in cui nel fuso è quel giorno a quell'ora. Se l'ora c'è due volte (quando si torna
 * all'ora solare), la prima; se non c'è (quando si passa all'ora legale), la stessa ora dopo il
 * salto: le 02:30 diventano le 03:30.
 */
function instantOf(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const DAY = 24 * 60 * 60 * 1000;
  const before = offsetAt(new Date(wall - DAY), timeZone);
  const after = offsetAt(new Date(wall + DAY), timeZone);
  const matches = [...new Set([before, after])]
    .map((o) => wall - o)
    .filter((t) => {
      const p = localParts(new Date(t), timeZone);
      return p.year === year && p.month === month && p.day === day && p.hour === hour;
    })
    .sort((a, b) => a - b);
  return new Date(matches[0] ?? wall - before);
}

function dayShift(p: LocalParts, days: number) {
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Il primo istante dopo `after` in cui nel fuso sono le `time`. */
export function nextRunAt(after: Date, time: string, timeZone = STUDIO_TIME_ZONE): Date {
  const { hour, minute } = parseTime(time);
  const today = localParts(after, timeZone);
  for (let i = 0; i <= 2; i++) {
    const d = dayShift(today, i);
    const t = instantOf(d.year, d.month, d.day, hour, minute, timeZone);
    if (t.getTime() > after.getTime()) return t;
  }
  throw new Error('Nessuna ora successiva trovata');
}

/** L'ultimo istante non successivo ad `at` in cui nel fuso erano le `time`. */
export function previousRunAt(at: Date, time: string, timeZone = STUDIO_TIME_ZONE): Date {
  const { hour, minute } = parseTime(time);
  const today = localParts(at, timeZone);
  for (let i = 0; i <= 2; i++) {
    const d = dayShift(today, -i);
    const t = instantOf(d.year, d.month, d.day, hour, minute, timeZone);
    if (t.getTime() <= at.getTime()) return t;
  }
  throw new Error('Nessuna ora precedente trovata');
}

export interface SchedulerDeps {
  /** Ora dell'aggiornamento, «HH:MM» nel fuso dello studio. */
  time: string;
  timeZone?: string;
  now: () => Date;
  /** Avvia un giro e aspetta che finisca. Gli errori si registrano, non fermano l'orologio. */
  run: () => Promise<unknown>;
  /** Inizio dell'ultimo giro (anche non riuscito), per sapere se quello di stanotte manca. */
  lastStartedAt: () => Promise<Date | null>;
  /** Attesa prima di recuperare un giro perso, dopo l'avvio del servizio. */
  catchUpDelayMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  log?: (message: string, err?: unknown) => void;
}

export class ReferenceUpdateScheduler {
  private handle: unknown = null;
  private nextAt: Date | null = null;
  private running: Promise<unknown> | null = null;
  private stopped = false;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: SchedulerDeps) {
    parseTime(deps.time);
    this.setTimer = deps.setTimer ?? ((fn, ms) => unrefTimer(setTimeout(fn, ms)));
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout));
  }

  /** Prossimo avvio previsto. */
  get next(): Date | null {
    return this.nextAt;
  }

  async start(): Promise<void> {
    this.stopped = false;
    const now = this.deps.now();
    const expected = previousRunAt(now, this.deps.time, this.deps.timeZone);
    const last = await this.deps.lastStartedAt();
    if (!last || last.getTime() < expected.getTime()) {
      // Il giro di stanotte non c'è stato (servizio spento): parte tra poco.
      this.schedule(new Date(now.getTime() + (this.deps.catchUpDelayMs ?? 60_000)));
    } else {
      this.schedule(nextRunAt(now, this.deps.time, this.deps.timeZone));
    }
  }

  private schedule(at: Date) {
    if (this.stopped) return;
    if (this.handle !== null) this.clearTimer(this.handle);
    this.nextAt = at;
    const ms = Math.max(0, at.getTime() - this.deps.now().getTime());
    this.handle = this.setTimer(() => void this.fire(), ms);
  }

  private async fire() {
    this.handle = null;
    if (this.stopped) return;
    this.running = this.deps.run().catch((err: unknown) => {
      this.deps.log?.('Aggiornamento automatico delle banche dati non riuscito', err);
    });
    await this.running;
    this.running = null;
    this.schedule(nextRunAt(this.deps.now(), this.deps.time, this.deps.timeZone));
  }

  /** Ferma l'orologio e aspetta il giro in corso, se c'è. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.handle !== null) this.clearTimer(this.handle);
    this.handle = null;
    this.nextAt = null;
    await this.running;
  }
}
