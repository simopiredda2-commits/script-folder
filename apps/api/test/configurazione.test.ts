import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
};

/** Ambiente dell'installazione (D170). */
describe('APP_AMBIENTE', () => {
  it('per difetto è «prova»', () => {
    expect(loadConfig({ ...base }).environment).toBe('prova');
  });
  it('accetta «produzione» e «prova», anche in maiuscolo', () => {
    expect(loadConfig({ ...base, APP_AMBIENTE: 'produzione' }).environment).toBe('produzione');
    expect(loadConfig({ ...base, APP_AMBIENTE: 'PROVA' }).environment).toBe('prova');
  });
  it('rifiuta un valore sconosciuto, invece di indovinare', () => {
    expect(() => loadConfig({ ...base, APP_AMBIENTE: 'prod' })).toThrow(/produzione.*prova/);
  });
});
