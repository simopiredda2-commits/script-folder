import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
};

/** Il codice del gestionale che assegna la Regione Piemonte, da APP_CODICE_GESTIONALE (D267). */
describe('APP_CODICE_GESTIONALE (D267, D301)', () => {
  const codeOf = (env: Record<string, string>) =>
    loadConfig({ ...base, ...env }).regionalSoftwareCodes?.piemonte;

  it('per difetto «SIMULATORE», che vale solo con i simulatori', () => {
    expect(codeOf({})).toBe('SIMULATORE');
    expect(codeOf({ APP_CODICE_GESTIONALE: '  ' })).toBe('SIMULATORE');
  });
  it('il codice che assegna la Regione: lettere, cifre, «-» e «_»', () => {
    expect(codeOf({ APP_CODICE_GESTIONALE: ' MIOAPPLICATIVO ' })).toBe('MIOAPPLICATIVO');
  });
  it('un codice con spazi o altri segni ferma l’avvio, con il motivo', () => {
    expect(() => loadConfig({ ...base, APP_CODICE_GESTIONALE: 'MIO APP' })).toThrow(
      /APP_CODICE_GESTIONALE=MIO APP: il codice del gestionale assegnato dalla Regione/,
    );
    expect(() => loadConfig({ ...base, APP_CODICE_GESTIONALE: 'GESTIONALE;301' })).toThrow(
      /APP_CODICE_GESTIONALE/,
    );
  });
});
