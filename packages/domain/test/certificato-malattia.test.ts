import { describe, expect, it } from 'vitest';
import {
  addMonths,
  ageAt,
  canCancelSickLeave,
  canRectify,
  checkSickLeave,
  ICD9_DIAGNOSIS_PATTERN,
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
