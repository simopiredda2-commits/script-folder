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

/** Proxy inversi fidati, per l'indirizzo della richiesta nel registro (tappa 14). */
describe('APP_PROXY_FIDATI', () => {
  it('per difetto nessun proxy fidato', () => {
    expect(loadConfig({ ...base }).trustedProxies).toEqual([]);
    expect(loadConfig({ ...base, APP_PROXY_FIDATI: ' ' }).trustedProxies).toEqual([]);
  });
  it('indirizzi e reti CIDR, IPv4 e IPv6, separati da virgole', () => {
    expect(
      loadConfig({ ...base, APP_PROXY_FIDATI: '127.0.0.1, 10.0.0.0/8,::1 , fd00::/8' })
        .trustedProxies,
    ).toEqual(['127.0.0.1', '10.0.0.0/8', '::1', 'fd00::/8']);
  });
  it('un valore non valido ferma l’avvio, con il motivo', () => {
    for (const bad of ['proxy', '10.0.0.0/33', '10.0.0.1/8/1', '::1/129', '10.0.0.256', 'loopback'])
      expect(() => loadConfig({ ...base, APP_PROXY_FIDATI: bad }), bad).toThrow(
        /APP_PROXY_FIDATI=.*non è un indirizzo IP né una rete CIDR/,
      );
  });
});
