import { describe, expect, it } from 'vitest';
import {
  PRESCRIPTION_STATUSES,
  transition,
  type PrescriptionEvent,
  type PrescriptionStatus,
  type SendErrorKind,
} from '../src/prescription';

const EVENTS: PrescriptionEvent[] = [
  'submit_for_signing',
  'edit',
  'start_sending',
  'send_succeeded',
  'send_failed',
  'cancel',
  'print_paper',
];

/**
 * Tutte e sole le transizioni ammesse, scritte a mano dal ciclo dei requisiti.
 * Chiave: stato|evento|tipo dell'ultimo errore (vuoto se non conta).
 */
const ALLOWED: Record<string, PrescriptionStatus> = {
  'draft|submit_for_signing|': 'to_sign',
  'draft|edit|': 'draft',
  'to_sign|edit|': 'draft',
  'error|edit|rejected': 'draft',
  'draft|start_sending|': 'sending',
  'to_sign|start_sending|': 'sending',
  'error|start_sending|unreachable': 'sending',
  'error|start_sending|timeout': 'sending',
  'sending|send_succeeded|': 'sent',
  'sending|send_failed|': 'error',
  'draft|cancel|': 'cancelled',
  'to_sign|cancel|': 'cancelled',
  'error|cancel|': 'cancelled',
  'error|cancel|rejected': 'cancelled',
  'error|cancel|unreachable': 'cancelled',
  'error|cancel|timeout': 'cancelled',
  'sent|cancel|': 'cancelled',
  'error|print_paper|unreachable': 'paper',
};

describe('ciclo della ricetta', () => {
  const errorKinds: (SendErrorKind | '')[] = ['', 'rejected', 'unreachable', 'timeout'];
  const cases = PRESCRIPTION_STATUSES.flatMap((s) =>
    EVENTS.flatMap((e) => errorKinds.map((k) => [s, e, k] as const)),
  ).filter(([s, , k]) => k === '' || s === 'error');

  it.each(cases)('%s + %s (errore: %s)', (from, event, kind) => {
    const r = transition(from, event, { lastErrorKind: kind || null });
    const expected = ALLOWED[`${from}|${event}|${kind}`];
    if (expected) {
      expect(r).toEqual({ ok: true, to: expected });
    } else {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason.length).toBeGreaterThan(10);
    }
  });

  it('il percorso dei requisiti: bozza → da firmare → inviata', () => {
    let s: PrescriptionStatus = 'draft';
    for (const e of ['submit_for_signing', 'start_sending', 'send_succeeded'] as const) {
      const r = transition(s, e);
      expect(r.ok).toBe(true);
      if (r.ok) s = r.to;
    }
    expect(s).toBe('sent');
  });

  it('la ricetta rossa solo se il sistema non risponde, non se ha rifiutato o se l’esito è incerto', () => {
    expect(transition('error', 'print_paper', { lastErrorKind: 'unreachable' }).ok).toBe(true);
    expect(transition('error', 'print_paper', { lastErrorKind: 'rejected' }).ok).toBe(false);
    const uncertain = transition('error', 'print_paper', { lastErrorKind: 'timeout' });
    expect(uncertain.ok).toBe(false);
    if (!uncertain.ok) expect(uncertain.reason).toMatch(/incerto/);
  });

  it('un invio in corso non si ripete né si annulla', () => {
    expect(transition('sending', 'start_sending').ok).toBe(false);
    expect(transition('sending', 'cancel').ok).toBe(false);
  });
});
