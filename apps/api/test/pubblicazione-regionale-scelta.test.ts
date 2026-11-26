import {
  FSE_ADMINISTRATIVE_REQUESTS,
  FseGatewayClient,
  SIMULATED_FSE_AUDIENCE,
  SimulatedDocumentSigner,
  SimulatedFseGateway,
  type RegionalFsePublication,
  type RegionalPublicationPolicy,
} from '@mmg/integrations';
import { REGIONAL_PACKAGES } from '@mmg/regions';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fseRegionalSend, studio } from '../src/db/schema';
import { NO_REGIONAL_FSE_PUBLICATION } from '../src/fse/regional-queue';
import { studioRegion } from '../src/regions/region';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

/**
 * La pubblicazione del Profilo nel Fascicolo, scelta dalla regione dello studio (D297). Una regione
 * senza pacchetto: il Profilo non si valida e nulla parte; le impostazioni hanno i regimi del
 * Gateway. Una pubblicazione data dalla configurazione: la coda usa le sue politiche e le sue
 * parole, non quelle di una regione scritte nel nucleo. La prova non scrive il nome di nessuna
 * regione.
 */

const MINUTE = 60_000;
const DAY = 86_400_000;

interface Pss {
  id: string;
  stato: string;
  fascicolo: {
    stato: string;
    tentativi: number;
    fase: string;
    prossimoTentativo: string | null;
    ultimoErrore: string | null;
  } | null;
}

/** Un'ora e una pagina per le chiamate al servizio, con il cookie del medico. */
function client(s: Scenario, cookie: () => string) {
  const base = () => `/api/pazienti/${s.richPatient}/profilo-sanitario`;
  const req = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
    s.app.inject({ method, url, headers: { cookie: cookie() }, ...(payload ? { payload } : {}) });
  const ok = async <T>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => {
    const res = await req(method, url, payload);
    expect(res.statusCode, res.body).toBeLessThan(300);
    return res.json<T>();
  };
  return { base, req, ok };
}

describe('pubblicazione del Profilo scelta dalla regione dello studio (D297)', () => {
  let t: TestDatabase;
  let s: Scenario;
  let doctor: string;
  let regionName: string;
  let studioId: string;
  let c: ReturnType<typeof client>;

  beforeAll(async () => {
    t = await createTestDatabase();
    let clock = () => new Date();
    const now = () => clock();
    const simulator = new SimulatedFseGateway({ now });
    s = await createScenario(
      t.db,
      {},
      {
        fse: {
          gateway: new FseGatewayClient(simulator, simulator.issueCredentials('Prova'), now),
          audience: SIMULATED_FSE_AUDIENCE,
          signer: new SimulatedDocumentSigner({ now }),
          simulator,
        },
        fseQueue: { intervalMs: null, minIntervalMs: 0 },
      },
    );
    clock = () => s.clock.now();
    doctor = await login(s, 'titolare');
    c = client(s, () => doctor);
    const [row] = await t.db.select().from(studio);
    studioId = row!.id;
    regionName = row!.regionName!;
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const setRegion = (name: string) =>
    t.db.update(studio).set({ regionName: name }).where(eq(studio.id, studioId));

  it('con il pacchetto: politiche, regimi e attività clinica sono quelli della sua pubblicazione', async () => {
    const region = await studioRegion(t.db, studioId);
    const pkg = REGIONAL_PACKAGES.find((p) => p.key === region)!;
    const expected = pkg.integrations!.fsePublication!({
      gateway: new SimulatedFseGateway(),
      application: { id: 'PROVA', vendor: 'PROVA', version: '0' },
    });
    const v = await c.ok<{
      valori: { regime: { codice: string }[] };
      attivitaClinica: { codice: string; nome: string } | null;
      politiche: RegionalPublicationPolicy | null;
    }>('GET', '/api/studio/fascicolo');
    expect(v.politiche).toEqual(expected.policy);
    expect(v.valori.regime.map((r) => r.codice)).toEqual(Object.keys(expected.regimes));
    expect(v.attivitaClinica?.codice).toBe(expected.clinicalActivity);
  });

  it('una regione senza pacchetto: il Profilo non si valida, nulla parte, i regimi del Gateway', async () => {
    await setRegion('Regione inventata');
    try {
      const o = await c.ok<{ mancano: string[]; politiche: unknown }>('GET', c.base());
      expect(o.mancano).toContain(NO_REGIONAL_FSE_PUBLICATION);
      expect(o.politiche).toBeNull();
      const draft = await c.ok<Pss>('POST', `${c.base()}/bozza`);
      const res = await c.req('POST', `${c.base()}/${draft.id}/valida`, { confermo: true });
      expect(res.statusCode).toBe(422);
      expect(res.json<{ dettagli: { problemi: string[] } }>().dettagli.problemi).toContain(
        NO_REGIONAL_FSE_PUBLICATION,
      );
      const settings = await c.ok<{
        valori: { regime: { codice: string }[] };
        attivitaClinica: unknown;
        politiche: unknown;
      }>('GET', '/api/studio/fascicolo');
      expect(settings.valori.regime.map((r) => r.codice)).toEqual(
        Object.keys(FSE_ADMINISTRATIVE_REQUESTS),
      );
      expect(settings.attivitaClinica).toBeNull();
      expect(settings.politiche).toBeNull();
      expect(await t.db.select().from(fseRegionalSend)).toEqual([]);
      await c.ok('POST', `${c.base()}/${draft.id}/scarta`);
    } finally {
      await setRegion(regionName);
    }
  });
});

describe('la coda con le politiche e le parole della pubblicazione data (D297)', () => {
  let t: TestDatabase;
  let s: Scenario;
  let doctor: string;
  let c: ReturnType<typeof client>;
  let calls = 0;

  /** Una regione inventata: fermo fino alle 05, una ripetizione a 2 minuti, poi due giorni. */
  const policy: RegionalPublicationPolicy = {
    quietUntilHour: 5,
    minIntervalMs: 0,
    retries: 1,
    retryDelayMs: 2 * MINUTE,
    fallbackDays: 2,
  };
  const given: RegionalFsePublication = {
    environment: 'test',
    regimes: { SSN: 'Regime SSN' },
    clinicalActivity: 'PHR',
    policy,
    texts: {
      credentialsRefused: 'Credenziali di prova rifiutate',
      credentialsMissing: 'Servono le credenziali di prova',
      reportTo: 'all’ufficio di prova (prova@ente.invalid)',
    },
    authorIssues: () => [],
    create: () => {
      calls++;
      return Promise.resolve({
        sent: '<prova/>',
        received: null,
        outcome: 'unreachable',
        message: 'Servizio di prova non raggiungibile',
      });
    },
    replace: () => Promise.reject(new Error('non usata')),
    update: () => Promise.reject(new Error('non usata')),
    remove: () => Promise.reject(new Error('non usata')),
    outcome: () => Promise.reject(new Error('non usata')),
    search: () => Promise.reject(new Error('non usata')),
  };

  beforeAll(async () => {
    t = await createTestDatabase();
    let clock = () => new Date();
    const now = () => clock();
    const simulator = new SimulatedFseGateway({ now });
    s = await createScenario(
      t.db,
      {},
      {
        fse: {
          gateway: new FseGatewayClient(simulator, simulator.issueCredentials('Prova'), now),
          audience: SIMULATED_FSE_AUDIENCE,
          signer: new SimulatedDocumentSigner({ now }),
          regional: given,
        },
        fseQueue: { intervalMs: null },
        // Le 11 di Roma.
        clockAt: new Date('2026-11-18T10:00:00Z'),
      },
    );
    clock = () => s.clock.now();
    doctor = await login(s, 'titolare');
    c = client(s, () => doctor);
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  async function later(ms: number) {
    s.clock.advance(ms);
    doctor = await login(s, 'titolare');
  }
  async function validated() {
    const draft = await c.ok<Pss>('POST', `${c.base()}/bozza`);
    await c.ok('POST', `${c.base()}/${draft.id}/valida`, { confermo: true });
    return draft;
  }
  const queue = () => s.app.fseRegionalQueue.kick();

  it('le ripetizioni, i giorni e chi avvisare sono quelli della regione data', async () => {
    const v = await validated();
    const first = await c.ok<Pss>('POST', `${c.base()}/${v.id}/firma-e-pubblica`);
    expect(first.fascicolo).toMatchObject({ stato: 'queued', tentativi: 1, fase: 'ripetizione' });
    expect(first.fascicolo!.ultimoErrore).toBe('Servizio di prova non raggiungibile');
    expect(new Date(first.fascicolo!.prossimoTentativo!).getTime()).toBe(
      s.clock.now().getTime() + 2 * MINUTE,
    );
    expect(calls).toBe(1);
    // Una ripetizione sola a 2 minuti, poi un tentativo al giorno per due giorni.
    await later(2 * MINUTE);
    await queue();
    expect(calls).toBe(2);
    let [row] = await t.db
      .select()
      .from(fseRegionalSend)
      .where(eq(fseRegionalSend.documentId, v.id));
    expect(row).toMatchObject({ status: 'queued', phase: 'coda' });
    for (let day = 0; day < policy.fallbackDays; day++) {
      await later(DAY);
      await queue();
    }
    expect(calls).toBe(4);
    [row] = await t.db.select().from(fseRegionalSend).where(eq(fseRegionalSend.documentId, v.id));
    expect(row!.status).toBe('failed');
    expect(row!.lastError).toContain('Dopo 2 giorni di tentativi');
    expect(row!.lastError).toContain('all’ufficio di prova (prova@ente.invalid)');
    await c.ok('POST', `${c.base()}/${v.id}/scarta`);
  });

  it('il fermo notturno è quello della regione data: fino alle 05 di Roma', async () => {
    const v = await validated();
    // Le 04:30 di Roma del giorno dopo (in inverno Roma è un'ora avanti).
    const now = s.clock.now();
    const target = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 3, 30),
    );
    await later(target.getTime() - now.getTime());
    const before = calls;
    const queued = await c.ok<Pss>('POST', `${c.base()}/${v.id}/firma-e-pubblica`);
    expect(queued.fascicolo).toMatchObject({ stato: 'queued', tentativi: 0 });
    expect(new Date(queued.fascicolo!.prossimoTentativo!).getTime()).toBe(
      target.getTime() + 30 * MINUTE,
    );
    expect(calls).toBe(before);
    // Alle 05 parte.
    await later(30 * MINUTE);
    await queue();
    expect(calls).toBe(before + 1);
  });

  it('le impostazioni dicono le politiche e l’attività clinica della regione data', async () => {
    const v = await c.ok<{
      valori: { regime: { codice: string }[] };
      attivitaClinica: { codice: string; nome: string } | null;
      politiche: RegionalPublicationPolicy | null;
    }>('GET', '/api/studio/fascicolo');
    expect(v.politiche).toEqual(policy);
    expect(v.valori.regime.map((r) => r.codice)).toEqual(['SSN']);
    expect(v.attivitaClinica).toEqual({ codice: 'PHR', nome: 'Personal Health Record Update' });
  });
});
