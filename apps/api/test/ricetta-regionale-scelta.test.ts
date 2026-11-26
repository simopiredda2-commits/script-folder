import { ASL_LIST, type NreLotCode } from '@mmg/domain';
import {
  EXTERNAL_PRESCRIBER_MISSING,
  NO_REGIONAL_PRESCRIPTION,
  SimulatedGateway,
  type LotResult,
  type RegionalNreLots,
  type RegionalPrescription,
  type RegionalPrescriptionGateway,
  type SimulatedOutcome,
} from '@mmg/integrations';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  doctorProfile,
  externalSubmission,
  prescription,
  prescriptionDocument,
  studio,
} from '../src/db/schema';
import { studioRegionCode } from '../src/regions/region';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';
import { regionalCredentials } from './helpers/regional-gateway';

/**
 * La ricetta SSN scelta dalla regione dello studio (D300), con regioni inventate: la prova non
 * scrive il nome di nessuna regione e non usa il servizio di una regione vera.
 *
 * - una regione con parole sue, senza lotti né ricetta rossa in DPCM: l'NRE lo dà il servizio,
 *   senza esito si rimanda, nel promemoria niente codice regionale;
 * - una regione che dà i lotti di NRE: la cartella numera da sé, e i messaggi usano il suo nome;
 * - una regione che fa le ricette con il suo modulo: il programma lo dice e non manda niente;
 * - una regione senza pacchetto: la ricetta SSN non parte, la bianca sì.
 */

const noRules = () => Promise.resolve({ rulesVersion: null, issues: [] });

/** Le parole di una regione inventata, con articoli e preposizioni che non sono «il, al, dal». */
const TEXTS: RegionalPrescriptionGateway['texts'] = {
  service: {
    name: 'SRP',
    the: 'lo SRP',
    to: 'allo SRP',
    from: 'dallo SRP',
    of: 'dello SRP',
  },
  lotCredentials: 'le credenziali di prova della regione inventata',
  reportTo: 'all’ente inventato',
};

/** Il servizio delle ricette di una regione inventata: il simulatore nazionale, con i suoi esiti. */
function invented(options: { decide?: () => SimulatedOutcome; lots?: RegionalNreLots }): {
  gateway: SimulatedGateway;
  prescription: RegionalPrescriptionGateway;
} {
  const gateway = new SimulatedGateway('regional', { decide: options.decide });
  return {
    gateway,
    prescription: {
      route: 'gateway',
      gateway,
      ...(options.lots ? { nreLots: { service: options.lots, lotType: '7' } } : {}),
      reminderDoctorCode: false,
      // Le credenziali della regione degli studi delle prove, che lo scenario dà ai medici (D301).
      credentialService: regionalCredentials().slug,
      texts: TEXTS,
    },
  };
}

interface Setup {
  t: TestDatabase;
  s: Scenario;
  cookie: string;
  studioId: string;
}

async function setup(override: RegionalPrescription | undefined, gateway?: SimulatedGateway) {
  const t = await createTestDatabase();
  const s = await createScenario(
    t.db,
    {},
    {
      ...(override ? { prescription: override } : {}),
      ...(gateway ? { gateways: { regional: gateway } } : {}),
      preSendChecks: noRules,
      dpcm: { intervalMs: null },
    },
  );
  const cookie = await login(s, 'titolare');
  const [row] = await t.db.select({ id: studio.id }).from(studio);
  return { t, s, cookie, studioId: row!.id } satisfies Setup;
}

const post = (x: Setup, url: string, payload: object = {}) =>
  x.s.app.inject({ method: 'POST', url, payload, headers: { cookie: x.cookie } });

async function draft(x: Setup, kind: 'pharma_ssn' | 'white' = 'pharma_ssn') {
  const res = await post(x, `/api/pazienti/${x.s.richPatient}/ricette`, {
    kind,
    lines: [{ drugName: 'Farmaco di prova 5 mg', activeIngredient: 'principio', quantity: 1 }],
  });
  expect(res.statusCode, res.body).toBe(201);
  return res.json<{ id: string }>().id;
}

const sign = (x: Setup, id: string) => post(x, `/api/ricette/${id}/firma-e-invia`);

describe('ricetta SSN di una regione inventata, con parole sue e senza lotti (D300)', () => {
  let x: Setup;
  let next: SimulatedOutcome = 'accepted';
  const region = invented({ decide: () => next });

  beforeAll(async () => {
    x = await setup(region.prescription);
  });
  afterAll(async () => {
    await x?.s.app.close();
    await x?.t.drop();
  });

  it('va al servizio della regione, con l’NRE del servizio: nessun lotto chiesto', async () => {
    const id = await draft(x);
    const res = await sign(x, id);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ esito: 'accepted' });
    expect(region.gateway.received.at(-1)?.localId).toBe(id);
    // Senza lotti l'NRE non parte dalla cartella: lo dà il servizio.
    expect(region.gateway.received.at(-1)?.nre ?? null).toBeNull();
    const [p] = await x.t.db.select().from(prescription).where(eq(prescription.id, id));
    expect(p!.nre).toMatch(/^SIMR\d{12}$/);
    expect(p!.assignedNre).toBeNull();
    const calls = await x.t.db
      .select()
      .from(externalSubmission)
      .where(eq(externalSubmission.prescriptionId, id));
    expect(calls.map((c) => [c.system, c.operation])).toEqual([['regional', 'invio']]);
  });

  it('le pagine hanno il nome del servizio della regione, con l’articolo e le preposizioni', async () => {
    const res = await x.s.app.inject({
      method: 'GET',
      url: '/api/io',
      headers: { cookie: x.cookie },
    });
    expect(res.json<{ servizioRicette: unknown }>().servizioRicette).toEqual({
      via: 'servizio',
      nome: 'SRP',
      il: 'lo SRP',
      al: 'allo SRP',
      dal: 'dallo SRP',
      del: 'dello SRP',
      ricettaRossaDpcm: false,
    });
  });

  it('nel promemoria niente codice regionale davanti al nome: la regione non lo chiede', async () => {
    const [profile] = await x.t.db
      .select({ regionalCode: doctorProfile.regionalCode })
      .from(doctorProfile)
      .where(eq(doctorProfile.userId, x.s.users.titolare.id));
    expect(profile!.regionalCode).toBeTruthy();
    const id = await draft(x);
    expect((await sign(x, id)).json()).toMatchObject({ esito: 'accepted' });
    const [doc] = await x.t.db
      .select()
      .from(prescriptionDocument)
      .where(
        and(
          eq(prescriptionDocument.prescriptionId, id),
          eq(prescriptionDocument.kind, 'promemoria_dati'),
        ),
      );
    const data = JSON.parse(doc!.content) as { medico: { codiceRegionale: string | null } };
    expect(data.medico.codiceRegionale).toBeNull();
  });

  it('senza esito si rimanda: la regione non ha la ricetta rossa in DPCM', async () => {
    const id = await draft(x);
    next = 'unreachable';
    try {
      expect((await sign(x, id)).json()).toMatchObject({ esito: 'unreachable' });
    } finally {
      next = 'accepted';
    }
    const again = await sign(x, id);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json()).toMatchObject({ esito: 'accepted' });
  });
});

describe('ricetta SSN di una regione inventata che dà i lotti di NRE (D300)', () => {
  let x: Setup;
  let lotOutcome: 'assigned' | 'unreachable' = 'unreachable';
  const requests: { regionCode: string; lotType: string }[] = [];
  let lotCode = 0;
  const lots: RegionalNreLots = {
    requestLot: (input) => {
      requests.push({ regionCode: input.regionCode, lotType: input.lotType });
      if (lotOutcome === 'unreachable')
        return Promise.resolve<LotResult>({ outcome: 'unreachable', message: 'rete di prova giù' });
      lotCode += 1;
      const lot: NreLotCode = {
        regionCode: input.regionCode,
        groupCode: 'ZZ',
        lotType: '4',
        lotCode: String(lotCode).padStart(6, '0'),
      };
      return Promise.resolve<LotResult>({ outcome: 'assigned', lot, raw: lot });
    },
  };
  const region = invented({ lots });

  beforeAll(async () => {
    x = await setup(region.prescription);
  });
  afterAll(async () => {
    await x?.s.app.close();
    await x?.t.drop();
  });

  it('senza lotto la ricetta non parte, e il messaggio usa il nome del servizio della regione', async () => {
    const id = await draft(x);
    const res = await sign(x, id);
    expect(res.statusCode).toBe(502);
    expect(res.json().errore).toBe(
      'Non si è potuto avere il lotto di numeri di ricetta (NRE): lo SRP non è raggiungibile (rete di prova giù)',
    );
    // Il tipo di lotto è quello della regione, il codice della regione quello dello studio.
    expect(requests.at(-1)).toEqual({
      regionCode: (await studioRegionCode(x.t.db, x.studioId))!,
      lotType: '7',
    });
    expect(region.gateway.received).toHaveLength(0);
  });

  it('con il lotto la cartella numera da sé: l’NRE della ricetta è del lotto', async () => {
    lotOutcome = 'assigned';
    const id = await draft(x);
    const res = await sign(x, id);
    expect(res.statusCode, res.body).toBe(200);
    const nre = region.gateway.received.at(-1)!.nre!;
    expect(nre).toMatch(/^\d{3}ZZ4\d{9}$/);
    const [p] = await x.t.db.select().from(prescription).where(eq(prescription.id, id));
    expect(p!.assignedNre).toBe(nre);
  });
});

describe('ricetta SSN di una regione che la fa con il suo modulo (D300)', () => {
  let x: Setup;

  beforeAll(async () => {
    x = await setup({ route: 'external', texts: { service: TEXTS.service } });
  });
  afterAll(async () => {
    await x?.s.app.close();
    await x?.t.drop();
  });

  it('il programma dice che il prescrittore della regione non c’è ancora, e non manda niente', async () => {
    const id = await draft(x);
    const res = await sign(x, id);
    expect(res.statusCode).toBe(422);
    expect(res.json().errore).toBe(EXTERNAL_PRESCRIBER_MISSING(TEXTS.service));
    expect(res.json().errore).toMatch(/modulo regionale \(SRP\)/);
    const [p] = await x.t.db.select().from(prescription).where(eq(prescription.id, id));
    expect(p!.status).toBe('draft');
  });
});

describe('ricetta SSN in una regione senza pacchetto (D300)', () => {
  let x: Setup;
  let regionName: string;
  const gateway = new SimulatedGateway('regional');

  beforeAll(async () => {
    x = await setup(undefined, gateway);
    const [row] = await x.t.db.select({ regionName: studio.regionName }).from(studio);
    regionName = row!.regionName!;
  });
  afterAll(async () => {
    await x?.s.app.close();
    await x?.t.drop();
  });

  it('la ricetta SSN non parte e la pagina dice perché; la bianca va al Sistema TS', async () => {
    const own = await studioRegionCode(x.t.db, x.studioId);
    // Una regione dell'elenco nazionale che non ha un pacchetto nel programma.
    const other = ASL_LIST.find((a) => a.regionCode !== own)!;
    await x.t.db
      .update(studio)
      .set({ regionName: other.regionName })
      .where(eq(studio.id, x.studioId));
    try {
      const me = await x.s.app.inject({
        method: 'GET',
        url: '/api/io',
        headers: { cookie: x.cookie },
      });
      expect(me.json<{ servizioRicette: unknown }>().servizioRicette).toBeNull();
      const id = await draft(x);
      const res = await sign(x, id);
      expect(res.statusCode).toBe(422);
      expect(res.json().errore).toBe(NO_REGIONAL_PRESCRIPTION);
      expect(gateway.received).toHaveLength(0);
      const white = await draft(x, 'white');
      const ok = await sign(x, white);
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.json()).toMatchObject({ esito: 'accepted' });
    } finally {
      await x.t.db.update(studio).set({ regionName }).where(eq(studio.id, x.studioId));
    }
  });
});
