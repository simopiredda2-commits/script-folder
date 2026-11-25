import { describe, expect, it } from 'vitest';
import { ministerialPad } from '../src/reference/lookup';

/**
 * Sezione A della tabella dei medicinali dal regime di fornitura dell'anagrafica AIFA (R23, D272):
 * le parole sono quelle della colonna «FORNITURA» di «confezioni_fornitura.csv».
 */
describe('regime AIFA a ricalco (R23)', () => {
  it('«Ricetta Ministeriale a Ricalco» è la sezione A; gli altri regimi no', () => {
    expect(
      ministerialPad(
        'Medicinali soggetti a prescrizione medica speciale con Ricetta Ministeriale a Ricalco',
      ),
    ).toBe(true);
    expect(
      ministerialPad('Medicinali soggetti a prescrizione medica da rinnovare volta per volta'),
    ).toBe(false);
    expect(ministerialPad('Medicinali soggetti a prescrizione medica')).toBe(false);
    expect(ministerialPad(null)).toBe(false);
    expect(ministerialPad(undefined)).toBe(false);
  });
});
