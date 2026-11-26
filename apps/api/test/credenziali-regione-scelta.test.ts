import { createHash } from 'node:crypto';
import { ASL_LIST } from '@mmg/domain';
import {
  SimulatedSecondFactor,
  type AuthorizeRequest,
  type RegionalAuthorizationGateway,
  type RegionalCredentials,
  type RevokeResult,
  type SimulatedAuthorizationPage,
  type TokenCheck,
  type TokenResult,
} from '@mmg/integrations';
import { regionalPackageKey } from '@mmg/regions';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  doctorProfile,
  regionalAuthorizationRequest,
  serviceCredential,
  serviceSession,
  studio,
} from '../src/db/schema';
import { createCredentialService, storeCredentials } from '../src/credentials/service';
import { studioRegion } from '../src/regions/region';
import { createScenario, login, SCENARIO_REGION, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

/**
 * Le credenziali del servizio della regione dello studio (D301), con una regione inventata: la
 * prova non scrive il nome di nessuna regione e non usa il servizio di una regione vera. La regione
 * inventata dà alla regione degli studi delle prove le sue credenziali, con parole sue, il suo
 * secondo fattore, il suo codice del programma e il suo accesso con SPID o CIE.
 */

const noRules = () => Promise.resolve({ rulesVersion: null, issues: [] });

/** Il secondo fattore della regione inventata: vuole il codice del programma, come «PROG». */
const second = new SimulatedSecondFactor('srp_inventata', {
  label: 'SRP Regione inventata',
  softwareProblem: (s) => (s?.startsWith('SIMULATORE-') ? null : 'programma non riconosciuto'),
  softwareCode: 'PROG',
});

/** L'accesso con SPID o CIE della regione inventata: un simulatore minimo, con la sua pagina. */
class InventedAccess implements RegionalAuthorizationGateway, SimulatedAuthorizationPage {
  readonly environment = 'simulator' as const;
  readonly revoked: { clientId: string; accessToken: string }[] = [];
  private readonly codes = new Map<string, { clientId: string; fiscalCode: string }>();
  authorizeUrl(r: AuthorizeRequest): string {
    const q = new URLSearchParams({
      client_id: r.clientId,
      response_type: 'code',
      redirect_uri: r.redirectUri,
      scope: r.scope.join(' '),
      state: r.state,
      code_challenge: r.codeChallenge,
      code_challenge_method: 'S256',
      ...(r.loginHint ? { login_hint: r.loginHint } : {}),
    });
    return `/api/simulatore/accesso-regionale?${q.toString()}`;
  }
  approve(input: { clientId: string; fiscalCode: string }): string {
    const code = `codice-${this.codes.size + 1}`;
    this.codes.set(code, { clientId: input.clientId, fiscalCode: input.fiscalCode });
    return code;
  }
  exchange(input: { code: string; clientId: string }): Promise<TokenResult> {
    const c = this.codes.get(input.code);
    if (!c) return Promise.resolve({ outcome: 'rejected', error: 'x', description: null, raw: {} });
    return Promise.resolve({
      outcome: 'ok',
      accessToken: `token-inventato-${input.code}`,
      scope: ['ricette'],
      validUntil: new Date(Date.now() + 3_600_000).toISOString(),
      fiscalCode: c.fiscalCode,
      sessionId: 's1',
      clientId: c.clientId,
      raw: {},
    });
  }
  verify(): Promise<TokenCheck> {
    return Promise.resolve({ outcome: 'valid', validUntil: new Date().toISOString() });
  }
  revoke(input: { clientId: string; accessToken: string }): Promise<RevokeResult> {
    this.revoked.push({ clientId: input.clientId, accessToken: input.accessToken });
    return Promise.resolve({ outcome: 'revoked' });
  }
}
const access = new InventedAccess();

const INVENTED: RegionalCredentials = {
  key: 'srp_inventata',
  slug: 'srp',
  name: 'SRP Regione inventata',
  use: 'Ricette SSN della regione inventata',
  passwordValidityMonths: 6,
  // Il lotto di NRE chiede il secondo fattore in questa regione; il Fascicolo no.
  secondFactorUses: ['lotto_nre'],
  secondFactor: () => second,
  software: {
    variable: 'CODICE_INVENTATO',
    codeProblem: () => null,
    identify: (code, asl) =>
      asl
        ? { ok: true, value: `${code}-${asl}` }
        : { ok: false, code: 'ASL', message: 'Manca il codice ASL (regione inventata)' },
  },
  strongAccess: {
    scope: ['ricette'],
    note: 'Servono però per la ricetta rossa della regione inventata.',
    gateway: () => access,
  },
};

interface Status {
  servizi: {
    servizio: string;
    nome: string;
    uso: string;
    inUso: boolean;
    impostate: boolean;
    scadenzaPassword: string | null;
    secondoFattore: boolean;
    accessoRegionale: boolean;
    notaAccessoRegionale: string | null;
    sessione: { attiva: boolean; modalita: string | null };
  }[];
}

describe('credenziali del servizio di una regione inventata (D301)', () => {
  let t: TestDatabase;
  let s: Scenario;
  let cookie: string;
  const region = regionalPackageKey(SCENARIO_REGION)!;

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(
      t.db,
      {},
      {
        regionalCredentials: { [region]: INVENTED },
        // Il secondo fattore della regione inventata al posto di quello della regione di prova.
        secondFactor: { sistema_ts: new SimulatedSecondFactor('sistema_ts'), regional: second },
      },
    );
    cookie = await login(s, 'titolare');
    // La titolare parte senza credenziali né sessioni della regione: le inserisce dalle rotte.
    await t.db.delete(serviceSession).where(eq(serviceSession.userId, s.users.titolare.id));
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const req = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    s.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  const status = async () => (await req('GET', '/api/profilo/credenziali')).json<Status>();

  it('la pagina ha il Sistema TS e il servizio della regione dello studio, con le parole della regione', async () => {
    expect(await studioRegion(t.db, s.studioId)).toBe(region);
    const st = await status();
    expect(st.servizi.map((x) => x.servizio)).toEqual(['sistema-ts', 'srp']);
    expect(st.servizi[1]).toMatchObject({
      nome: 'SRP Regione inventata',
      uso: 'Ricette SSN della regione inventata',
      inUso: true,
      secondoFattore: true,
      accessoRegionale: true,
      notaAccessoRegionale: 'Servono però per la ricetta rossa della regione inventata.',
    });
  });

  it('le rotte usano il nome corto della regione; un nome che nessun pacchetto dà non esiste', async () => {
    const put = await req('PUT', '/api/profilo/credenziali/srp', {
      utente: 'UTENTE-INVENTATO',
      password: 'parola-di-prova',
      pin: '1234',
      passwordCambiataIl: '2026-01-15',
    });
    expect(put.statusCode, put.body).toBe(200);
    // Sei mesi, come dice la regione inventata.
    expect((await status()).servizi[1]!.scadenzaPassword).toBe('2026-07-15');
    const [row] = await t.db
      .select()
      .from(serviceCredential)
      .where(
        and(
          eq(serviceCredential.userId, s.users.titolare.id),
          eq(serviceCredential.service, 'srp_inventata'),
        ),
      );
    expect(row).toBeTruthy();
    expect(
      (await req('PUT', '/api/profilo/credenziali/inesistente', { pin: '1' })).statusCode,
    ).toBe(404);
  });

  it('il secondo fattore della regione, con il codice del programma che dice la regione', async () => {
    const r = await req('POST', '/api/profilo/credenziali/srp/sessione/richiesta');
    expect(r.statusCode, r.body).toBe(200);
    // Il codice della configurazione (per difetto «SIMULATORE») con il codice ASL del medico.
    expect(second.receivedSoftware.at(-1)).toMatch(/^SIMULATORE-\d{3}$/);
    const code = r.json<{ codiceDiProva: string }>().codiceDiProva;
    const ok = await req('POST', '/api/profilo/credenziali/srp/sessione', { codice: code });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await status()).servizi[1]!.sessione).toMatchObject({
      attiva: true,
      modalita: 'email',
    });
  });

  it('l’accesso con SPID o CIE della regione: client_id della regione, permessi, sessione e revoca', async () => {
    const start = await req('POST', '/api/profilo/credenziali/srp/accesso-regionale');
    expect(start.statusCode, start.body).toBe(200);
    const url = new URL(start.json<{ indirizzo: string }>().indirizzo, 'http://programma.invalid');
    expect(url.searchParams.get('client_id')).toMatch(/^SIMULATORE-\d{3}$/);
    expect(url.searchParams.get('scope')).toBe('ricette');
    expect(url.searchParams.get('redirect_uri')).toBe(
      '/api/profilo/credenziali/srp/accesso-regionale/ritorno',
    );
    const [request] = await t.db
      .select()
      .from(regionalAuthorizationRequest)
      .where(eq(regionalAuthorizationRequest.userId, s.users.titolare.id));
    expect(request!.service).toBe('srp_inventata');
    // La pagina simulata, poi il ritorno.
    const page = new URLSearchParams(url.search);
    page.delete('response_type');
    page.delete('code_challenge_method');
    page.set('azione', 'spid');
    const esito = await s.app.inject({
      method: 'GET',
      url: `/api/simulatore/accesso-regionale/esito?${page.toString()}`,
    });
    expect(esito.statusCode).toBe(302);
    const back = new URL(esito.headers.location as string, 'http://programma.invalid');
    const ritorno = await s.app.inject({
      method: 'GET',
      url: back.pathname + back.search,
      headers: { cookie },
    });
    expect(ritorno.headers.location).toBe('/profilo/credenziali?accesso=ok');
    const [session] = await t.db
      .select()
      .from(serviceSession)
      .where(
        and(
          eq(serviceSession.userId, s.users.titolare.id),
          eq(serviceSession.service, 'srp_inventata'),
        ),
      );
    expect(session).toMatchObject({
      mode: 'spid_cie',
      clientId: url.searchParams.get('client_id'),
    });
    // La revoca ripete il client_id scritto con la sessione.
    expect((await req('DELETE', '/api/profilo/credenziali/srp/sessione')).statusCode).toBe(200);
    expect(access.revoked.at(-1)?.clientId).toBe(url.searchParams.get('client_id'));
  });

  it('il ritorno dalla pagina della regione vale solo per la richiesta del suo servizio', async () => {
    // Una richiesta aperta di un altro servizio, con uno state noto: sul ritorno di questo servizio
    // non si riconosce.
    const state = 'state-di-un-altro-servizio';
    await t.db.insert(regionalAuthorizationRequest).values({
      userId: s.users.titolare.id,
      service: 'altro_servizio',
      stateHash: createHash('sha256').update(state).digest('hex'),
      verifierEnc: Buffer.from('cifrato-di-prova'),
      redirectUri: '/api/profilo/credenziali/srp/accesso-regionale/ritorno',
      clientId: 'SIMULATORE-301',
      expiresAt: new Date(s.clock.now().getTime() + 600_000),
    });
    const back = await s.app.inject({
      method: 'GET',
      url: `/api/profilo/credenziali/srp/accesso-regionale/ritorno?${new URLSearchParams({
        state,
        code: 'codice-1',
      }).toString()}`,
      headers: { cookie },
    });
    expect(back.headers.location).toBe(
      '/profilo/credenziali?accesso=errore&motivo=non-riconosciuta',
    );
  });

  it('nel database la chiave del servizio ha la forma di una chiave', async () => {
    await expect(
      t.db.insert(serviceCredential).values({
        userId: s.users.titolare.id,
        service: 'Non una chiave',
        secretEnc: Buffer.from('x'),
        usernameHint: '…x',
        passwordChangedOn: '2026-11-01',
      }),
    ).rejects.toThrow();
  });

  it('le credenziali di una regione che non è più quella dello studio: non si usano, si cancellano', async () => {
    const [row] = await t.db.select({ regionName: studio.regionName }).from(studio);
    const own = ASL_LIST.find((a) => a.regionName === row!.regionName)!.regionCode;
    // Una regione dell'elenco nazionale che non ha un pacchetto nel programma.
    const other = ASL_LIST.find((a) => a.regionCode !== own)!;
    await t.db
      .update(studio)
      .set({ regionName: other.regionName })
      .where(eq(studio.id, s.studioId));
    try {
      const st = await status();
      expect(st.servizi.map((x) => [x.servizio, x.inUso])).toEqual([
        ['sistema-ts', true],
        ['srp', false],
      ]);
      expect(st.servizi[1]).toMatchObject({ secondoFattore: false, accessoRegionale: false });
      // Non si salvano, non si chiede il codice, non si entra con SPID o CIE.
      expect((await req('PUT', '/api/profilo/credenziali/srp', { pin: '9' })).statusCode).toBe(422);
      expect(
        (await req('POST', '/api/profilo/credenziali/srp/sessione/richiesta')).statusCode,
      ).toBe(422);
      expect((await req('POST', '/api/profilo/credenziali/srp/accesso-regionale')).statusCode).toBe(
        404,
      );
      // Si cancellano: poi la pagina ha solo il Sistema TS.
      expect((await req('DELETE', '/api/profilo/credenziali/srp')).statusCode).toBe(200);
      expect((await status()).servizi.map((x) => x.servizio)).toEqual(['sistema-ts']);
    } finally {
      await t.db
        .update(studio)
        .set({ regionName: row!.regionName })
        .where(eq(studio.id, s.studioId));
    }
  });
});

describe('credenziali degli invii della regione inventata (D301)', () => {
  let t: TestDatabase;
  let s: Scenario;
  const region = regionalPackageKey(SCENARIO_REGION)!;

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db, {}, { regionalCredentials: { [region]: INVENTED } });
    await storeCredentials(t.db, s.encryptionKey, {
      userId: s.users.titolare.id,
      service: 'srp_inventata',
      secret: { username: 'UTENTE-INVENTATO', password: 'parola-di-prova', pin: '1234' },
      passwordChangedOn: '2026-11-01',
    });
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const credentials = () =>
    createCredentialService({
      db: t.db,
      encryptionKey: s.encryptionKey,
      now: s.clock.now,
      nationalSecondFactor: new SimulatedSecondFactor('sistema_ts'),
      regional: [
        {
          region,
          info: INVENTED,
          secondFactor: second,
          strongAccess: null,
          softwareCode: 'SIMULATORE',
        },
      ],
    });

  it('la ricetta SSN chiede il secondo fattore per legge; il lotto perché lo dice la regione; il Fascicolo no', async () => {
    const c = credentials();
    const doctor = s.users.titolare.id;
    for (const use of ['ricetta_ssn', 'lotto_nre'] as const)
      await expect(c.authFor(doctor, use, 'srp')).rejects.toMatchObject({
        statusCode: 422,
        details: { codice: 'SESSIONE_MANCANTE', servizio: 'srp' },
      });
    await expect(c.authFor(doctor, 'fascicolo_regionale', 'srp')).resolves.toMatchObject({
      username: 'UTENTE-INVENTATO',
      sessionId: null,
    });
  });

  it('un invio della regione vuole il servizio dell’integrazione; un servizio che non c’è è un errore', async () => {
    const c = credentials();
    await expect(c.authFor(s.users.titolare.id, 'fascicolo_regionale')).rejects.toThrow(
      /senza il servizio delle credenziali/,
    );
    await expect(
      c.authFor(s.users.titolare.id, 'fascicolo_regionale', 'inesistente'),
    ).rejects.toMatchObject({ statusCode: 404 });
    // Gli invii nazionali vanno al Sistema TS, qualunque cosa dica il chiamante.
    await expect(c.authFor(s.users.titolare.id, 'certificato_inps')).resolves.toMatchObject({
      sessionId: null,
    });
  });
});

describe('il simulatore della ricetta controlla il secondo fattore della stessa regione (D301)', () => {
  let t: TestDatabase;
  let s: Scenario;

  beforeAll(async () => {
    t = await createTestDatabase();
    // Nessun servizio dato: il servizio della ricetta e il secondo fattore sono quelli del
    // pacchetto della regione degli studi delle prove, creati dal programma.
    s = await createScenario(t.db, {}, { preSendChecks: noRules });
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  it('con la sessione dello scenario la ricetta SSN parte; con la sessione chiusa dal servizio, no', async () => {
    const cookie = await login(s, 'titolare');
    const post = (url: string, payload: object = {}) =>
      s.app.inject({ method: 'POST', url, payload, headers: { cookie } });
    const draft = async () => {
      const res = await post(`/api/pazienti/${s.richPatient}/ricette`, {
        kind: 'pharma_ssn',
        lines: [{ drugName: 'Farmaco di prova 5 mg', activeIngredient: 'principio', quantity: 1 }],
      });
      expect(res.statusCode, res.body).toBe(201);
      return res.json<{ id: string }>().id;
    };
    expect((await post(`/api/ricette/${await draft()}/firma-e-invia`)).json()).toMatchObject({
      esito: 'accepted',
    });
    // Una richiesta di un codice nuovo, da un altro programma, chiude la sessione presso il
    // servizio della regione: il simulatore della ricetta lo sa.
    const second = s.secondFactor.regional;
    if (!(second instanceof SimulatedSecondFactor)) throw new Error('secondo fattore simulato');
    const [profile] = await t.db
      .select({ cf: doctorProfile.fiscalCode })
      .from(doctorProfile)
      .where(eq(doctorProfile.userId, s.users.titolare.id));
    await second.requestCode({
      auth: { username: 'altro', password: 'x', pin: '1', software: 'ALTRO_301' },
      fiscalCode: profile!.cf!,
    });
    expect((await post(`/api/ricette/${await draft()}/firma-e-invia`)).json()).toMatchObject({
      esito: 'auth',
    });
  });
});
