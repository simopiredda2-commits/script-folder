import { describe, expect, it } from 'vitest';
import {
  addMonths,
  ageAt,
  canCancelSickLeave,
  canRectify,
  CERTIFICATE_STATUSES,
  certificateTransition,
  AVAILABILITY_NAME_PATTERN,
  checkSickLeave,
  checkSickLeaveAddress,
  ICD9_DIAGNOSIS_PATTERN,
  NO_HOUSE_NUMBER,
  nextDay,
  prognosisDays,
  type SickLeaveInput,
} from '../src/sick-leave';

const today = '2026-11-18';
const ok: SickLeaveInput = {
  type: 'I',
  visit: 'A',
  releaseDate: today,
  startDate: today,
  endDate: '2026-11-20',
  diagnosisCode: '487.1',
  diagnosisNotes: 'Sindrome influenzale di prova',
};
const ctx = { today, workerBirthDate: '1980-05-10' };
const codes = (c: Partial<SickLeaveInput>, x = ctx) =>
  checkSickLeave({ ...ok, ...c }, x).map((i) => i.code);

describe('certificato di malattia: controlli formali dell’INPS ripetuti prima (tappa 8)', () => {
  it('un certificato in regola non ha problemi', () => {
    expect(checkSickLeave(ok, ctx)).toEqual([]);
  });

  it('26: rilascio oggi o ieri, non prima né dopo', () => {
    expect(codes({ releaseDate: '2026-11-17', startDate: '2026-11-17' })).toEqual([]);
    expect(codes({ releaseDate: '2026-11-16', startDate: '2026-11-16' })).toContain('26');
    expect(codes({ releaseDate: '2026-11-19', startDate: '2026-11-19' })).toContain('26');
  });

  it('23 e 24: inizio non dopo il rilascio, fine non prima', () => {
    expect(codes({ startDate: '2026-11-19' })).toContain('23');
    expect(codes({ startDate: '2026-11-15' })).toEqual([]);
    expect(codes({ endDate: '2026-11-17' })).toContain('24');
    expect(codes({ endDate: today })).toEqual([]);
  });

  it('25: al più tre mesi solari dopo il rilascio', () => {
    expect(addMonths('2026-11-18', 3)).toBe('2027-02-18');
    expect(addMonths('2026-11-30', 3)).toBe('2027-02-28');
    expect(codes({ endDate: '2027-02-18' })).toEqual([]);
    expect(codes({ endDate: '2027-02-19' })).toContain('25');
  });

  it('1003 e 1004: giornata lavorata, inizio il giorno della visita e fine dopo', () => {
    expect(codes({ workedDay: true })).toEqual([]);
    expect(codes({ workedDay: true, startDate: '2026-11-17' })).toContain('1003');
    expect(codes({ workedDay: true, endDate: today })).toContain('1004');
    expect(codes({ workedDay: false, startDate: '2026-11-17', endDate: today })).toEqual([]);
  });

  it('1007: lavoratore di almeno 16 anni', () => {
    expect(ageAt('2010-11-18', today)).toBe(16);
    expect(ageAt('2010-11-19', today)).toBe(15);
    expect(codes({}, { today, workerBirthDate: '2010-11-19' })).toContain('1007');
    expect(codes({}, { today, workerBirthDate: '2010-11-18' })).toEqual([]);
  });

  it('diagnosi: codice ICD-9-CM nel formato dello schema, oppure la descrizione', () => {
    for (const c of ['487', '487.1', '44', 'V17.34', 'E850.1'])
      expect(ICD9_DIAGNOSIS_PATTERN.test(c), c).toBe(true);
    for (const c of ['4', 'A12', '487.123', '487,1'])
      expect(ICD9_DIAGNOSIS_PATTERN.test(c), c).toBe(false);
    expect(codes({ diagnosisCode: null, diagnosisNotes: null })).toContain('diagnosi');
    expect(codes({ diagnosisCode: null })).toEqual([]);
    expect(codes({ diagnosisCode: 'X1' })).toContain('43');
    expect(codes({ diagnosisNotes: 'x'.repeat(201) })).toContain('diagnosi');
  });

  it('rettifica: solo per anticipare la fine, entro la fine della prognosi', () => {
    expect(canRectify({ endDate: '2026-11-25' }, '2026-11-22', today)).toEqual({ ok: true });
    expect(canRectify({ endDate: '2026-11-25' }, '2026-11-25', today).ok).toBe(false);
    expect(canRectify({ endDate: '2026-11-17' }, '2026-11-16', today).ok).toBe(false);
  });

  it('annullamento: entro il giorno dopo il rilascio', () => {
    expect(canCancelSickLeave({ releaseDate: '2026-11-17' }, today)).toEqual({ ok: true });
    expect(canCancelSickLeave({ releaseDate: '2026-11-16' }, today).ok).toBe(false);
  });
});

describe('ciclo del certificato', () => {
  const kinds = ['', 'rejected', 'unreachable', 'timeout', 'auth'] as const;
  const events = [
    'edit',
    'start_sending',
    'send_succeeded',
    'send_failed',
    'cancel',
    'rectify',
  ] as const;
  // Le sole transizioni ammesse: tutte le altre sono rifiutate con un motivo.
  const ALLOWED: Record<string, string> = {
    'draft|edit|': 'draft',
    'draft|start_sending|': 'sending',
    'draft|cancel|': 'cancelled',
    'sending|send_succeeded|': 'sent',
    'sending|send_failed|': 'error',
    'sent|cancel|': 'cancelled',
    'sent|rectify|': 'rectified',
    'error|edit|rejected': 'draft',
    'error|edit|auth': 'draft',
    'error|start_sending|unreachable': 'sending',
    'error|start_sending|timeout': 'sending',
    'error|start_sending|auth': 'sending',
    'error|cancel|': 'cancelled',
    'error|cancel|rejected': 'cancelled',
    'error|cancel|unreachable': 'cancelled',
    'error|cancel|timeout': 'cancelled',
    'error|cancel|auth': 'cancelled',
  };
  const cases = CERTIFICATE_STATUSES.flatMap((s) =>
    events.flatMap((e) => kinds.map((k) => [s, e, k] as const)),
  ).filter(([s, , k]) => k === '' || s === 'error');

  it.each(cases)('%s + %s (errore: %s)', (from, event, kind) => {
    const r = certificateTransition(from, event, { lastErrorKind: kind || null });
    const expected = ALLOWED[`${from}|${event}|${kind}`];
    if (expected) expect(r).toEqual({ ok: true, to: expected });
    else {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason.length).toBeGreaterThan(10);
    }
  });

  it('continuazione dal giorno dopo; giorni di prognosi con gli estremi', () => {
    expect(nextDay('2026-11-30')).toBe('2026-12-01');
    expect(prognosisDays('2026-11-18', '2026-11-20')).toBe(3);
    expect(prognosisDays('2026-11-18', '2026-11-18')).toBe(1);
  });
});

describe('indirizzo del certificato (schema XSD 3.2)', () => {
  const good = {
    street: 'Via di Prova',
    number: '',
    postalCode: '10100',
    town: 'Torino',
    province: 'TO',
  };
  it('un indirizzo completo passa; senza civico vale SNC', () => {
    expect(checkSickLeaveAddress(good, 'residenza')).toEqual([]);
    expect(NO_HOUSE_NUMBER).toBe('SNC');
  });
  it('codici della residenza e della reperibilità', () => {
    const bad = { street: 'V', postalCode: '1010', town: '', province: 'TOR' };
    expect(checkSickLeaveAddress(bad, 'residenza').map((i) => i.code)).toEqual([
      '421',
      '433',
      '436',
      '437',
    ]);
    expect(checkSickLeaveAddress(bad, 'reperibilita').map((i) => i.code)).toEqual([
      '461',
      '473',
      '476',
      '477',
    ]);
    expect(
      checkSickLeaveAddress(
        { ...good, town: '', province: '', cadastralCode: 'L219' },
        'residenza',
      ),
    ).toEqual([]);
    expect(checkSickLeaveAddress({ ...good, cadastralCode: '219L' }, 'residenza')[0]!.code).toBe(
      '434',
    );
  });
  it('nominativo presso l’abitazione: lettere, spazi e apostrofo, da 2 a 24', () => {
    expect(AVAILABILITY_NAME_PATTERN.test("D'Amico Rossi")).toBe(true);
    expect(AVAILABILITY_NAME_PATTERN.test('Nicolò')).toBe(false);
    expect(AVAILABILITY_NAME_PATTERN.test('X')).toBe(false);
  });
});
