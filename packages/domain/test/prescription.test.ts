import { describe, expect, it } from 'vitest';
import {
  cancellableState,
  DISPENSING_STATE_LABELS,
  DISPENSING_STATES,
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
  'settle_arrived',
  'settle_not_arrived',
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
  // Credenziali o secondo fattore rifiutati (D102): si rimanda o si corregge, niente ricetta rossa.
  'error|edit|auth': 'draft',
  'error|start_sending|auth': 'sending',
  'error|cancel|auth': 'cancelled',
  // Invio rimasto senza risposta, esito chiesto all'ente (D233).
  'sending|settle_arrived|': 'sent',
  'sending|settle_not_arrived|': 'error',
};

describe('ciclo della ricetta', () => {
  const errorKinds: (SendErrorKind | '')[] = ['', 'rejected', 'unreachable', 'timeout', 'auth'];
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

  it('ricetta SSN al SAR senza esito: si stampa la ricetta rossa, non si rimanda (V06, 4.3.1; D270)', () => {
    const region = { regionFlow: true } as const;
    for (const lastErrorKind of ['unreachable', 'timeout'] as const) {
      expect(transition('error', 'print_paper', { ...region, lastErrorKind }).ok).toBe(true);
      const again = transition('error', 'start_sending', { ...region, lastErrorKind });
      expect(again.ok, lastErrorKind).toBe(false);
      if (!again.ok) expect(again.reason).toMatch(/ricetta rossa.*DPCM/);
    }
    // Rifiuto e credenziali: si corregge e si rimanda, come prima.
    expect(transition('error', 'print_paper', { ...region, lastErrorKind: 'rejected' }).ok).toBe(
      false,
    );
    expect(transition('error', 'start_sending', { ...region, lastErrorKind: 'auth' }).ok).toBe(
      true,
    );
    // Invio interrotto: la ricetta rossa anche da «in invio», ma solo dopo l'attesa.
    expect(transition('sending', 'print_paper', { ...region, interrupted: true }).ok).toBe(true);
    expect(transition('sending', 'print_paper', { ...region, interrupted: false }).ok).toBe(false);
    expect(transition('sending', 'print_paper', { interrupted: true }).ok).toBe(false);
  });

  it('un invio in corso non si ripete né si annulla', () => {
    expect(transition('sending', 'start_sending').ok).toBe(false);
    expect(transition('sending', 'cancel').ok).toBe(false);
  });

  it('l’esito di un invio senza risposta si segna solo per una ricetta «in invio» (D233)', () => {
    for (const s of PRESCRIPTION_STATUSES.filter((x) => x !== 'sending'))
      for (const e of ['settle_arrived', 'settle_not_arrived'] as const)
        expect(transition(s, e).ok, `${s} + ${e}`).toBe(false);
  });
});

describe('annullamento secondo lo stato di erogazione (D70)', () => {
  it('si annulla solo una ricetta che l’ente non ha ancora lavorato', () => {
    expect(cancellableState('non_erogata')).toEqual({ ok: true });
    for (const s of ['presa_in_carico', 'erogata_in_parte', 'erogata', 'annullata'] as const) {
      const r = cancellableState(s);
      expect(r.ok, s).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/Resta nello storico/);
    }
    expect(DISPENSING_STATES.every((s) => DISPENSING_STATE_LABELS[s])).toBe(true);
  });
});
