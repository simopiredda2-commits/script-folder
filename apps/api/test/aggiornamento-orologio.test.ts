import { describe, expect, it } from 'vitest';
import {
  nextRunAt,
  parseTime,
  previousRunAt,
  ReferenceUpdateScheduler,
} from '../src/reference/scheduler';

/**
 * L'orologio dell'aggiornamento di ogni notte (D156), nel fuso dello studio. I due cambi dell'ora
 * del 2026 e del 2027 in Italia: il 25/10/2026 alle 03:00 si torna alle 02:00 (ora solare), il
 * 28/3/2027 alle 02:00 si passa alle 03:00 (ora legale).
 */
const z = (iso: string) => new Date(iso);

describe('ora del prossimo aggiornamento, nel fuso dello studio', () => {
  it('di solito la stessa ora della notte dopo; prima dell’ora, la notte stessa', () => {
    // 18/11/2026 alle 10:00 in Italia (ora solare, UTC+1).
    expect(nextRunAt(z('2026-11-18T09:00:00Z'), '03:30')).toEqual(z('2026-11-19T02:30:00Z'));
    expect(nextRunAt(z('2026-11-18T00:00:00Z'), '03:30')).toEqual(z('2026-11-18T02:30:00Z'));
    // All'ora esatta, la notte dopo: un giro appena partito non si ripete.
    expect(nextRunAt(z('2026-11-18T02:30:00Z'), '03:30')).toEqual(z('2026-11-19T02:30:00Z'));
    // In estate (ora legale, UTC+2).
    expect(nextRunAt(z('2026-07-01T12:00:00Z'), '03:30')).toEqual(z('2026-07-02T01:30:00Z'));
  });

  it('quando si torna all’ora solare: le 03:30 ci sono una volta, le 02:30 si prendono la prima volta', () => {
    expect(nextRunAt(z('2026-10-24T12:00:00Z'), '03:30')).toEqual(z('2026-10-25T02:30:00Z'));
    expect(nextRunAt(z('2026-10-24T12:00:00Z'), '02:30')).toEqual(z('2026-10-25T00:30:00Z'));
    // Dopo la prima volta delle 02:30, la notte dopo: non si ripete un'ora dopo.
    expect(nextRunAt(z('2026-10-25T00:30:00Z'), '02:30')).toEqual(z('2026-10-26T01:30:00Z'));
  });

  it('quando si passa all’ora legale: le 02:30 non esistono e diventano le 03:30', () => {
    expect(nextRunAt(z('2027-03-27T12:00:00Z'), '02:30')).toEqual(z('2027-03-28T01:30:00Z'));
    expect(nextRunAt(z('2027-03-27T12:00:00Z'), '03:30')).toEqual(z('2027-03-28T01:30:00Z'));
    expect(nextRunAt(z('2027-03-28T01:30:00Z'), '03:30')).toEqual(z('2027-03-29T01:30:00Z'));
  });

  it('l’ultima ora prevista prima di adesso', () => {
    expect(previousRunAt(z('2026-11-18T09:00:00Z'), '03:30')).toEqual(z('2026-11-18T02:30:00Z'));
    expect(previousRunAt(z('2026-11-18T02:00:00Z'), '03:30')).toEqual(z('2026-11-17T02:30:00Z'));
    expect(previousRunAt(z('2026-11-18T02:30:00Z'), '03:30')).toEqual(z('2026-11-18T02:30:00Z'));
    expect(previousRunAt(z('2026-10-25T12:00:00Z'), '03:30')).toEqual(z('2026-10-25T02:30:00Z'));
  });

  it('un’ora scritta male ferma la configurazione', () => {
    expect(parseTime('03:30')).toEqual({ hour: 3, minute: 30 });
    for (const bad of ['3:30', '24:00', '03:60', 'notte', '']) {
      expect(() => parseTime(bad), bad).toThrow(/Ora non valida/);
    }
  });
});

/** Orologio finto: le attese si fanno scattare a mano, dopo aver spostato l'ora. */
function fakeClock(start: string) {
  let now = z(start);
  const timers: { fn: () => void; at: number; cleared: boolean }[] = [];
  return {
    now: () => now,
    set: (iso: string) => {
      now = z(iso);
    },
    setTimer: (fn: () => void, ms: number) => {
      const t = { fn, at: now.getTime() + ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h: unknown) => {
      (h as { cleared: boolean }).cleared = true;
    },
    pending: () => timers.filter((t) => !t.cleared),
    /** Porta l'ora alla prossima attesa e la fa scattare. */
    fire: async () => {
      const t = timers.filter((x) => !x.cleared).sort((a, b) => a.at - b.at)[0];
      if (!t) throw new Error('nessuna attesa');
      t.cleared = true;
      now = new Date(t.at);
      t.fn();
      // Lascia finire il giro (promesse già risolte nella prova).
      await new Promise((ok) => setTimeout(ok, 0));
    },
  };
}

describe('avvio automatico di ogni notte', () => {
  it('servizio avviato di giorno, giro di stanotte già fatto: il prossimo è la notte dopo', async () => {
    const clock = fakeClock('2026-11-18T09:00:00Z');
    const runs: Date[] = [];
    const s = new ReferenceUpdateScheduler({
      time: '03:30',
      now: clock.now,
      run: () => Promise.resolve(runs.push(clock.now())),
      lastStartedAt: () => Promise.resolve(z('2026-11-18T02:30:05Z')),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    await s.start();
    expect(s.next).toEqual(z('2026-11-19T02:30:00Z'));
    await clock.fire();
    expect(runs).toEqual([z('2026-11-19T02:30:00Z')]);
    // Dopo il giro, la notte dopo ancora: una sola attesa alla volta.
    expect(s.next).toEqual(z('2026-11-20T02:30:00Z'));
    expect(clock.pending()).toHaveLength(1);
    await s.stop();
    expect(clock.pending()).toHaveLength(0);
  });

  it('servizio spento all’ora prevista: il giro perso parte poco dopo l’avvio', async () => {
    const clock = fakeClock('2026-11-18T09:00:00Z');
    const runs: Date[] = [];
    const s = new ReferenceUpdateScheduler({
      time: '03:30',
      now: clock.now,
      run: () => Promise.resolve(runs.push(clock.now())),
      // L'ultimo giro è di ieri notte: quello di stanotte manca.
      lastStartedAt: () => Promise.resolve(z('2026-11-17T02:30:05Z')),
      catchUpDelayMs: 60_000,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    await s.start();
    expect(s.next).toEqual(z('2026-11-18T09:01:00Z'));
    await clock.fire();
    expect(runs).toEqual([z('2026-11-18T09:01:00Z')]);
    expect(s.next).toEqual(z('2026-11-19T02:30:00Z'));
    await s.stop();
  });

  it('mai nessun giro: si parte subito dopo l’avvio', async () => {
    const clock = fakeClock('2026-11-18T09:00:00Z');
    const s = new ReferenceUpdateScheduler({
      time: '03:30',
      now: clock.now,
      run: () => Promise.resolve(),
      lastStartedAt: () => Promise.resolve(null),
      catchUpDelayMs: 1000,
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    await s.start();
    expect(s.next).toEqual(z('2026-11-18T09:00:01Z'));
    await s.stop();
  });

  it('un giro non riuscito si registra e l’orologio continua', async () => {
    const clock = fakeClock('2026-11-18T09:00:00Z');
    const logged: string[] = [];
    const s = new ReferenceUpdateScheduler({
      time: '03:30',
      now: clock.now,
      run: () => Promise.reject(new Error('sito non raggiungibile')),
      lastStartedAt: () => Promise.resolve(z('2026-11-18T02:30:05Z')),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      log: (m, err) => logged.push(`${m}: ${(err as Error).message}`),
    });
    await s.start();
    await clock.fire();
    expect(logged).toEqual([
      'Aggiornamento automatico delle banche dati non riuscito: sito non raggiungibile',
    ]);
    expect(s.next).toEqual(z('2026-11-20T02:30:00Z'));
    await s.stop();
  });
});
