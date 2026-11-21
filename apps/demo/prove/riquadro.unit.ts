import { describe, expect, it } from 'vitest';
import { autoReduce } from '../src/panel-state';

/**
 * Quando il riquadro della dimostrazione si riduce da sé (D241): una volta per sessione, dopo
 * l'accesso, ma non se lo si è aperto a mano dopo l'inizio della sessione. Senza la dimostrazione
 * costruita e senza browser: i tempi sono numeri, non attese.
 */
describe('riquadro della dimostrazione: quando si riduce da sé', () => {
  const out = { loggedIn: false, sessionSince: null };
  const session = (since: number) => ({ loggedIn: true, sessionSince: since });

  it('senza accesso resta com’è', () => {
    expect(autoReduce(out, null, 0)).toEqual({ reduce: false, decidedFor: null });
  });

  it('dopo l’accesso si riduce, una volta sola per sessione', () => {
    const first = autoReduce(session(1_000), null, 0);
    expect(first).toEqual({ reduce: true, decidedFor: 1_000 });
    expect(autoReduce(session(1_000), first.decidedFor, 0)).toEqual({
      reduce: false,
      decidedFor: 1_000,
    });
  });

  it('aperto a mano dopo l’accesso, prima che il riquadro lo veda: resta aperto', () => {
    expect(autoReduce(session(1_000), null, 1_400)).toEqual({ reduce: false, decidedFor: 1_000 });
  });

  it('aperto a mano durante l’accesso, prima della sessione: si riduce come sempre', () => {
    expect(autoReduce(session(1_000), null, 600)).toEqual({ reduce: true, decidedFor: 1_000 });
  });

  it('dopo un’uscita, la sessione nuova lo riduce di nuovo', () => {
    const first = autoReduce(session(1_000), null, 0);
    const outside = autoReduce(out, first.decidedFor, 1_400);
    expect(outside.reduce).toBe(false);
    expect(autoReduce(session(5_000), outside.decidedFor, 1_400)).toEqual({
      reduce: true,
      decidedFor: 5_000,
    });
  });
});
