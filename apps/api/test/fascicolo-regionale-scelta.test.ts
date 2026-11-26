import { REGIONAL_PACKAGES } from '@mmg/regions';
import type { FseAccessResult, RegionalFseAccess } from '@mmg/integrations';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { studio } from '../src/db/schema';
import { NO_REGIONAL_FSE_ACCESS } from '../src/http/fse-access-routes';
import { regionalChoice } from '../src/regions/integrations';
import { studioRegion } from '../src/regions/region';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

/**
 * L'apertura del Fascicolo regionale scelta dalla regione dello studio (D297): quella del pacchetto
 * della regione; per una regione senza pacchetto nessuna, con un messaggio; data dalla
 * configurazione, la stessa per ogni regione. La prova non scrive il nome di nessuna regione.
 */
describe('apertura del Fascicolo scelta dalla regione dello studio (D297)', () => {
  let t: TestDatabase;
  let s: Scenario;
  let cookie: string;
  let studioId: string;
  let regionName: string;

  const setRegion = (name: string) =>
    t.db.update(studio).set({ regionName: name }).where(eq(studio.id, studioId));
  const info = async (app = s.app) =>
    (
      await app.inject({ method: 'GET', url: '/api/fascicolo-regionale', headers: { cookie } })
    ).json<{
      tipiDocumento: { codice: string }[];
      simulato: boolean;
      attivo: boolean;
      testi?: { introduzione: string; simulato: string; nonAttivo: string };
      nota?: string;
    }>();
  const open = (app = s.app) =>
    app.inject({
      method: 'POST',
      url: `/api/pazienti/${s.richPatient}/fascicolo-regionale`,
      headers: { cookie },
      payload: {},
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

  it('la regione dello studio con un pacchetto: i tipi di documento del suo simulatore', async () => {
    const region = await studioRegion(t.db, studioId);
    const pkg = REGIONAL_PACKAGES.find((p) => p.key === region)!;
    const expected = pkg.integrations!.fseAccess!({});
    const v = await info();
    expect(v.simulato).toBe(true);
    expect(v.attivo).toBe(true);
    expect(v.tipiDocumento.map((x) => x.codice)).toEqual(Object.keys(expected.documentTypes));
    expect(v.testi).toEqual({
      introduzione: expected.texts.intro,
      simulato: expected.texts.simulated,
      nonAttivo: expected.texts.notActive,
    });
    expect(v.nota).toBeUndefined();
  });

  it('una regione senza pacchetto: nessun tipo, il messaggio, e la richiesta non parte', async () => {
    await setRegion('Regione inventata');
    try {
      expect(await info()).toEqual({
        tipiDocumento: [],
        simulato: false,
        attivo: false,
        nota: NO_REGIONAL_FSE_ACCESS,
      });
      const res = await open();
      expect(res.statusCode).toBe(503);
      expect(res.json().errore).toBe(NO_REGIONAL_FSE_ACCESS);
    } finally {
      await setRegion(regionName);
    }
  });

  it('data dalla configurazione, la stessa apertura vale per ogni regione', async () => {
    const calls: string[] = [];
    const given: RegionalFseAccess = {
      environment: 'test',
      documentTypes: { PROVA: 'DOCUMENTO DI PROVA' },
      texts: {
        intro: 'Introduzione (prova)',
        simulated: 'Simulato (prova)',
        notActive: 'Non attivo (prova)',
        credentials: 'Credenziali (prova)',
      },
      credentialService: 'prova',
      authenticate: (request): Promise<FseAccessResult> => {
        calls.push(request.patientFiscalCode);
        return Promise.resolve({ outcome: 'success', url: 'https://ente.invalid/?token=1' });
      },
    };
    const app = buildApp({
      db: t.db,
      config: { encryptionKey: s.encryptionKey, sessionMaxHours: 12, cookieSecure: false },
      now: s.clock.now,
      secondFactor: s.secondFactor,
      fseAccess: given,
    });
    await setRegion('Regione inventata');
    try {
      const v = await info(app);
      expect(v.tipiDocumento).toEqual([{ codice: 'PROVA', nome: 'DOCUMENTO DI PROVA' }]);
      expect(v.testi?.introduzione).toBe('Introduzione (prova)');
      expect((await open(app)).json()).toEqual({
        indirizzo: 'https://ente.invalid/?token=1',
        simulato: false,
      });
      expect(calls).toHaveLength(1);
    } finally {
      await setRegion(regionName);
      await app.close();
    }
  });

  it('la scelta crea l’integrazione una volta per regione, e nessuna per una regione senza pacchetto', () => {
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
