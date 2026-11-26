import { randomBytes } from 'node:crypto';
import type { RegionalCredentials } from '@mmg/integrations';
import type { RegionalPackage } from '@mmg/regions';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { loadConfig, regionalSoftwareCodesOf } from '../src/config';
import type { Database } from '../src/db/client';

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
  it('una rete /0 (tutti) ferma l’avvio con il motivo in italiano (terza revisione)', () => {
    for (const bad of ['0.0.0.0/0', '::/0', '10.0.0.0/8,1.2.3.4/0'])
      expect(() => loadConfig({ ...base, APP_PROXY_FIDATI: bad }), bad).toThrow(
        /APP_PROXY_FIDATI=.*fidarsi di qualunque mittente/,
      );
  });
  it('con i valori accettati il servizio si costruisce davvero', async () => {
    for (const ok of ['127.0.0.1', '10.0.0.0/8,::1', 'fd00::/8', '1.2.3.4/024']) {
      const config = loadConfig({ ...base, APP_PROXY_FIDATI: ok });
      // Il database non serve: si costruisce il servizio e lo si chiude, senza richieste.
      const app = buildApp({
        db: {} as Database,
        config: {
          encryptionKey: randomBytes(32),
          sessionMaxHours: 12,
          cookieSecure: false,
          trustedProxies: config.trustedProxies,
        },
      });
      await app.ready();
      await app.close();
    }
  });
});

/**
 * Il codice che una regione assegna al programma (D267, D301), dalla variabile che il pacchetto
 * della regione dice: qui con regioni inventate. La variabile della prima regione è nelle prove del
 * suo pacchetto.
 */
describe('codice del programma per ogni regione (D267, D301)', () => {
  const credentials = (variable: string): RegionalCredentials => ({
    key: `servizio_${variable.toLowerCase()}`,
    slug: `servizio-${variable.toLowerCase()}`,
    name: 'Servizio inventato',
    use: 'Prove',
    passwordValidityMonths: null,
    secondFactorUses: [],
    software: {
      variable,
      codeProblem: (code) => (/^[A-Z]+$/.test(code) ? null : 'solo lettere maiuscole (prova)'),
      identify: (code) => ({ ok: true, value: code }),
    },
  });
  const pkg = (key: string, variable?: string): RegionalPackage => ({
    key,
    regionCode: '999',
    name: key,
    parts: [],
    asl: [],
    terms: [],
    ...(variable ? { integrations: { credentials: credentials(variable) } } : {}),
  });
  const packages = [pkg('alfa', 'CODICE_ALFA'), pkg('beta', 'CODICE_BETA'), pkg('gamma')];

  it('per difetto «SIMULATORE», che vale solo con i simulatori; vuoto è come assente', () => {
    expect(regionalSoftwareCodesOf({ CODICE_ALFA: '  ' }, packages)).toEqual({
      alfa: 'SIMULATORE',
      beta: 'SIMULATORE',
    });
  });

  it('ogni regione dalla sua variabile; una regione che non lo chiede non c’è', () => {
    expect(
      regionalSoftwareCodesOf({ CODICE_ALFA: ' PROGRAMMA ', CODICE_BETA: 'ALTRO' }, packages),
    ).toEqual({ alfa: 'PROGRAMMA', beta: 'ALTRO' });
  });

  it('un codice che la regione non ammette ferma l’avvio, con la variabile e il motivo', () => {
    expect(() => regionalSoftwareCodesOf({ CODICE_BETA: 'no' }, packages)).toThrow(
      'CODICE_BETA=no: solo lettere maiuscole (prova)',
    );
  });

  it('la configurazione li legge per i pacchetti del programma, ognuno con la sua chiave', () => {
    const codes = loadConfig({ ...base }).regionalSoftwareCodes ?? {};
    for (const code of Object.values(codes)) expect(code).toBe('SIMULATORE');
  });
});
