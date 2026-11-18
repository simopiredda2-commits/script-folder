import { describe, expect, it } from 'vitest';
import {
  ANAMNESIS_KIND,
  CONTACT_KIND,
  ENTRY_KIND,
  ENTRY_TYPES,
  MEASURES,
  checkProblemDates,
  entryTypeOf,
  keyOf,
  measureByKey,
  parseMeasureValue,
} from '../src/clinical';

describe('voci cliniche: tipi e controlli formali', () => {
  it('ogni tipo dell’interfaccia ha il suo tipo nel database, e ritorno', () => {
    for (const t of ENTRY_TYPES) expect(entryTypeOf(ENTRY_KIND[t])).toBe(t);
    expect(entryTypeOf('lab_result')).toBeUndefined();
    expect(keyOf(CONTACT_KIND, 'televisit')).toBe('televisita');
    expect(keyOf(ANAMNESIS_KIND, 'remote_pathological')).toBe('patologica_remota');
  });

  it('i parametri dei requisiti, con la loro unità', () => {
    expect(MEASURES.map((m) => m.label)).toEqual([
      'Pressione sistolica',
      'Pressione diastolica',
      'Peso',
      'Altezza',
      'BMI',
      'Glicemia',
      'Saturazione',
    ]);
    expect(measureByKey('saturazione')).toMatchObject({ unit: '%', max: 100 });
  });

  it('il valore di un parametro: numero positivo, virgola o punto, due decimali', () => {
    const peso = measureByKey('peso')!;
    expect(parseMeasureValue('72,5', peso)).toEqual({ value: '72.5' });
    expect(parseMeasureValue(' 80 ', peso)).toEqual({ value: '80' });
    expect(parseMeasureValue('72.50', peso)).toEqual({ value: '72.5' });
    for (const bad of ['', 'abc', '72,555', '-3', '1e3', '72,5 kg', '12345'])
      expect(parseMeasureValue(bad, peso), bad).toHaveProperty('error');
    expect(parseMeasureValue('0', peso)).toEqual({
      error: 'Peso: il valore dev’essere maggiore di zero',
    });
    const sat = measureByKey('saturazione')!;
    expect(parseMeasureValue('100', sat)).toEqual({ value: '100' });
    expect(parseMeasureValue('100,1', sat)).toHaveProperty('error');
  });

  it('le date di un problema', () => {
    const today = '2026-11-18';
    expect(checkProblemDates({ state: 'attivo', onsetOn: '2026-01-01' }, today)).toEqual([]);
    expect(
      checkProblemDates(
        { state: 'risolto', onsetOn: '2026-01-01', resolvedOn: '2026-02-01' },
        today,
      ),
    ).toEqual([]);
    expect(checkProblemDates({ state: 'risolto' }, today)).toEqual([
      'Problema risolto: manca la data di risoluzione',
    ]);
    expect(checkProblemDates({ state: 'attivo', resolvedOn: '2026-02-01' }, today)).toEqual([
      'Problema attivo: la data di risoluzione va solo sui problemi risolti',
    ]);
    expect(checkProblemDates({ state: 'attivo', onsetOn: '2026-11-19' }, today)).toEqual([
      'Inizio del problema: la data è nel futuro',
    ]);
    expect(
      checkProblemDates(
        { state: 'risolto', onsetOn: '2026-03-01', resolvedOn: '2026-02-01' },
        today,
      ),
    ).toEqual(['La risoluzione non può venire prima dell’inizio']);
  });
});
