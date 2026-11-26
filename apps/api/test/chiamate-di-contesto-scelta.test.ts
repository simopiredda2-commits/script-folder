import { REGIONAL_PACKAGES } from '@mmg/regions';
import type { ContextCallRequest, ContextCallResult, RegionalContextCall } from '@mmg/integrations';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { studio } from '../src/db/schema';
import { CONTEXT_CALL_RULES } from '../src/http/context-call-routes';
import { regionalChoice } from '../src/regions/integrations';
import { studioRegion } from '../src/regions/region';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';
import { regionalCredentials } from './helpers/regional-gateway';

interface Destination {
  tipo: string;
  parametri: { chiave: string; etichetta: string; tutti: string; valori: { codice: string }[] }[];
  simulato: boolean;
  attivo: boolean;
  testi: { introduzione: string; simulato: string; nonAttivo: string };
}

/**
 * Le chiamate di contesto scelte dalla regione dello studio (D220, D297): un meccanismo solo, con
 * le destinazioni del pacchetto della regione; per una regione senza pacchetto nessuna, con un
 * messaggio; date dalla configurazione, le stesse per ogni regione. La prova non scrive il nome di
 * nessuna regione.
 */
describe('chiamate di contesto scelte dalla regione dello studio (D297)', () => {
  let t: TestDatabase;
  let s: Scenario;
  let cookie: string;
  let studioId: string;
  let regionName: string;

  const setRegion = (name: string) =>
    t.db.update(studio).set({ regionName: name }).where(eq(studio.id, studioId));
  const info = async (app = s.app) =>
    (
      await app.inject({ method: 'GET', url: '/api/chiamate-di-contesto', headers: { cookie } })
    ).json<{ destinazioni: Destination[] }>();
  const open = (kind = 'fascicolo', payload: object = {}, app = s.app) =>
    app.inject({
      method: 'POST',
      url: `/api/pazienti/${s.richPatient}/chiamate-di-contesto/${kind}`,
      headers: { cookie },
      payload,
    });

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db);
    cookie = await login(s, 'titolare');
    const [row] = await t.db.select().from(studio);
    studioId = row!.id;
    regionName = row!.regionName!;
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  it('la regione dello studio con un pacchetto: le sue destinazioni, con parametri e parole', async () => {
    const region = await studioRegion(t.db, studioId);
    const pkg = REGIONAL_PACKAGES.find((p) => p.key === region)!;
    const expected = pkg.integrations!.contextCalls!({});
    const v = await info();
    expect(v.destinazioni.map((d) => d.tipo)).toEqual(expected.map((c) => c.kind));
    for (const [i, call] of expected.entries()) {
      const d = v.destinazioni[i]!;
      expect(d.simulato).toBe(call.environment === 'simulator');
      expect(d.attivo).toBe(true);
      expect(d.testi).toEqual({
        introduzione: call.texts.intro,
        simulato: call.texts.simulated,
        nonAttivo: call.texts.notActive,
      });
      expect(d.parametri.map((p) => [p.chiave, p.etichetta, p.tutti])).toEqual(
        call.parameters.map((p) => [p.key, p.label, p.anyLabel]),
      );
      expect(d.parametri.map((p) => p.valori.map((x) => x.codice))).toEqual(
        call.parameters.map((p) => Object.keys(p.options)),
      );
    }
  });

  it('una regione senza pacchetto: nessuna destinazione, e la richiesta non parte', async () => {
    await setRegion('Regione inventata');
    try {
      expect(await info()).toEqual({ destinazioni: [] });
      const res = await open();
      expect(res.statusCode).toBe(503);
      expect(res.json().errore).toBe(CONTEXT_CALL_RULES.fascicolo.missing);
    } finally {
      await setRegion(regionName);
    }
  });

  it('un tipo di destinazione che il nucleo non conosce non si apre', async () => {
    const res = await open('inventato');
    expect(res.statusCode).toBe(404);
  });

  it('date dalla configurazione, le stesse destinazioni valgono per ogni regione', async () => {
    const calls: ContextCallRequest[] = [];
    const given: RegionalContextCall = {
      kind: 'fascicolo',
      environment: 'test',
      parameters: [
        { key: 'tipo', label: 'Tipo di prova', anyLabel: 'Tutti', options: { PROVA: 'PROVA' } },
      ],
      texts: {
        intro: 'Introduzione (prova)',
        simulated: 'Simulato (prova)',
        notActive: 'Non attivo (prova)',
        credentials: 'Credenziali (prova)',
      },
      // Le credenziali della regione degli studi delle prove, che lo scenario dà ai medici (D301).
      credentialService: regionalCredentials().slug,
      open: (request): Promise<ContextCallResult> => {
        calls.push(request);
        return Promise.resolve({ outcome: 'success', url: 'https://ente.invalid/?token=1' });
      },
    };
    const app = buildApp({
      db: t.db,
      config: { encryptionKey: s.encryptionKey, sessionMaxHours: 12, cookieSecure: false },
      now: s.clock.now,
      secondFactor: s.secondFactor,
      contextCalls: [given],
    });
    await setRegion('Regione inventata');
    try {
      const v = await info(app);
      expect(v.destinazioni.map((d) => [d.tipo, d.parametri[0]!.valori])).toEqual([
        ['fascicolo', [{ codice: 'PROVA', nome: 'PROVA' }]],
      ]);
      expect(v.destinazioni[0]!.testi.introduzione).toBe('Introduzione (prova)');
      expect((await open('fascicolo', { parametri: { tipo: 'PROVA' } }, app)).json()).toEqual({
        indirizzo: 'https://ente.invalid/?token=1',
        simulato: false,
      });
      expect(calls.map((c) => c.parameters)).toEqual([{ tipo: 'PROVA' }]);
    } finally {
      await setRegion(regionName);
      await app.close();
    }
  });

  it('la scelta crea le integrazioni una volta per regione, e nessuna per una regione senza pacchetto', () => {
    let built = 0;
    const choice = regionalChoice((pkg) => ({ key: pkg.key, n: ++built }));
    const key = REGIONAL_PACKAGES[0]!.key;
    expect(choice.for(key)).toEqual({ key, n: 1 });
    expect(choice.for(key)).toEqual({ key, n: 1 });
    expect(choice.for('regione-inventata')).toBeNull();
    expect(choice.for(null)).toBeNull();
    expect(choice.created()).toEqual([{ key, n: 1 }]);
    const given = { key: 'data', n: 0 };
    const fixed = regionalChoice(() => ({ key: 'mai', n: -1 }), given);
    expect(fixed.for(null)).toBe(given);
    expect(fixed.created()).toEqual([given]);
  });
});
