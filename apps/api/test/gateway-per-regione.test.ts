import { ASL_LIST } from '@mmg/domain';
import {
  SIMULATED_FSE_AUDIENCE,
  SimulatedDocumentSigner,
  SimulatedFseGateway,
  type FseCredentials,
  type FseHttpRequest,
  type RegionalFsePublication,
} from '@mmg/integrations';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { studio } from '../src/db/schema';
import { NO_GATEWAY_CREDENTIALS } from '../src/fse/gateways';
import { studioRegionCode } from '../src/regions/region';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

/**
 * Il Gateway del Fascicolo con i certificati della regione dello studio (D298): i certificati di
 * produzione li danno i referenti di ogni Regione, e il programma usa quelli della regione dello
 * studio del medico. Due regioni con certificati diversi, una senza. La prova non scrive il nome di
 * nessuna regione: le prende dall'elenco nazionale delle aziende sanitarie.
 */

/** Il Gateway simulato che guarda con quale certificato arriva ogni richiesta. */
class WatchedGateway extends SimulatedFseGateway {
  readonly certificates: Buffer[] = [];
  override send(req: FseHttpRequest) {
    this.certificates.push(req.clientCertificate);
    return super.send(req);
  }
}

/** Una pubblicazione data, per ogni regione: qui serve solo che ci sia. */
const publication: RegionalFsePublication = {
  environment: 'test',
  regimes: { SSN: 'Regime SSN' },
  clinicalActivity: 'ERP',
  policy: { quietUntilHour: null, minIntervalMs: 0, retries: 0, retryDelayMs: 0, fallbackDays: 1 },
  texts: { credentialsRefused: 'prova', credentialsMissing: 'prova', reportTo: 'a nessuno' },
  authorIssues: () => [],
  create: () => Promise.reject(new Error('non usata')),
  replace: () => Promise.reject(new Error('non usata')),
  update: () => Promise.reject(new Error('non usata')),
  remove: () => Promise.reject(new Error('non usata')),
  outcome: () => Promise.reject(new Error('non usata')),
  search: () => Promise.reject(new Error('non usata')),
};

interface Pss {
  id: string;
  stato: string;
}

describe('certificati del Gateway scelti dalla regione dello studio (D298)', () => {
  let t: TestDatabase;
  let s: Scenario;
  let doctor: string;
  let studioId: string;
  let regionName: string;
  const gateway = new WatchedGateway();
  const asked: string[] = [];
  const issued = new Map<string, FseCredentials>();
  /** La regione per cui il programma non ha certificati. */
  let withoutCertificates = '';

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(
      t.db,
      {},
      {
        fse: {
          audience: SIMULATED_FSE_AUDIENCE,
          signer: new SimulatedDocumentSigner(),
          simulator: gateway,
          regional: publication,
          credentialsFor: (code) => {
            asked.push(code);
            if (code === withoutCertificates) return null;
            if (!issued.has(code)) issued.set(code, gateway.issueCredentials(`Prova ${code}`));
            return issued.get(code)!;
          },
        },
        fseQueue: { intervalMs: null },
      },
    );
    doctor = await login(s, 'titolare');
    const [row] = await t.db.select().from(studio);
    studioId = row!.id;
    regionName = row!.regionName!;
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const base = () => `/api/pazienti/${s.richPatient}/profilo-sanitario`;
  const req = (method: 'GET' | 'POST', url: string, payload?: object) =>
    s.app.inject({ method, url, headers: { cookie: doctor }, ...(payload ? { payload } : {}) });
  const setRegion = (name: string) =>
    t.db.update(studio).set({ regionName: name }).where(eq(studio.id, studioId));
  /** Una bozza nuova, validata sul Gateway; poi scartata, per la prossima. */
  async function validateOnce() {
    const draft = (await req('POST', `${base()}/bozza`)).json<Pss>();
    const res = await req('POST', `${base()}/${draft.id}/valida`, { confermo: true });
    await req('POST', `${base()}/${draft.id}/scarta`);
    return res;
  }

  it('ogni regione con i suoi certificati: quelli della regione dello studio', async () => {
    const first = (await studioRegionCode(t.db, studioId))!;
    const other = ASL_LIST.find((a) => a.regionCode !== first)!;
    try {
      const a = await validateOnce();
      expect(a.statusCode, a.body).toBe(200);
      expect(gateway.certificates.at(-1)!.equals(issued.get(first)!.authentication.der)).toBe(true);
      await setRegion(other.regionName);
      const b = await validateOnce();
      expect(b.statusCode, b.body).toBe(200);
      expect(
        gateway.certificates.at(-1)!.equals(issued.get(other.regionCode)!.authentication.der),
      ).toBe(true);
      expect(
        issued
          .get(first)!
          .authentication.der.equals(issued.get(other.regionCode)!.authentication.der),
      ).toBe(false);
      // I certificati di ogni regione si chiedono una volta sola.
      await validateOnce();
      expect(asked.filter((c) => c === other.regionCode)).toHaveLength(1);
    } finally {
      await setRegion(regionName);
    }
  });

  it('una regione senza certificati: il Profilo non si valida, e la pagina dice perché', async () => {
    const third = ASL_LIST.find((a) => !issued.has(a.regionCode))!;
    withoutCertificates = third.regionCode;
    await setRegion(third.regionName);
    try {
      const o = (await req('GET', base())).json<{ mancano: string[] }>();
      expect(o.mancano).toContain(NO_GATEWAY_CREDENTIALS);
      const sent = gateway.certificates.length;
      const res = await validateOnce();
      expect(res.statusCode).toBe(422);
      expect(res.json<{ dettagli: { problemi: string[] } }>().dettagli.problemi).toContain(
        NO_GATEWAY_CREDENTIALS,
      );
      expect(gateway.certificates).toHaveLength(sent);
    } finally {
      await setRegion(regionName);
    }
  });
});
