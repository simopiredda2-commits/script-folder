import { NRE_LOT_SIZE, nreLotPrefix } from '@mmg/domain';
import { SimulatedGateway, SimulatedSecondFactor } from '@mmg/integrations';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  doctorProfile,
  nreLot,
  serviceCredential,
  serviceCredentialEvent,
  serviceSession,
} from '../../../src/db/schema';
import { createScenario, login, type Scenario } from '../../helpers/scenario';
import { createTestDatabase, type TestDatabase } from '../../helpers/test-db';
import { RUPAR_CREDENTIALS, SimulatedSar, SimulatedSirpedAccess } from '@mmg/regions/piemonte';

const noRules = () => Promise.resolve({ rulesVersion: null, issues: [] });
const RETURN = '/api/profilo/credenziali/rupar/accesso-regionale/ritorno';

describe('accesso regionale con SPID o CIE (D109)', () => {
  let t: TestDatabase;
  let s: Scenario;
  const c: Record<string, string> = {};
  let regional: SimulatedSirpedAccess;
  let sar: SimulatedSar;
  /** Per le prove dei campi del token: cambia i campi prima dell'emissione (V08, 4.3.2). */
  let tamperClaims: ((c: Record<string, unknown>) => Record<string, unknown>) | null = null;

  beforeAll(async () => {
    t = await createTestDatabase();
    regional = new SimulatedSirpedAccess({
      now: () => s.clock.now(),
      claims: (claims: Record<string, unknown>) => tamperClaims?.(claims) ?? claims,
    });
    sar = new SimulatedSar({ oauth: regional });
    s = await createScenario(
      t.db,
      {},
      {
        gateways: { regional: sar, sistema_ts: new SimulatedGateway('sistema_ts') },
        secondFactor: {
          sistema_ts: new SimulatedSecondFactor('sistema_ts', { now: () => s.clock.now() }),
          regional: RUPAR_CREDENTIALS.secondFactor!({ now: () => s.clock.now() }),
        },
        regional: { gateway: regional, redirectUri: RETURN },
        preSendChecks: noRules,
      },
    );
    for (const who of ['titolare', 'segreteria', 'sostituto'] as const)
      c[who] = await login(s, who);
    // La titolare entra solo con SPID o CIE: niente credenziali RUPAR, niente sessione per email.
    for (const table of [serviceSession, serviceCredential] as const)
      await t.db
        .delete(table)
        .where(and(eq(table.userId, s.users.titolare.id), eq(table.service, 'rupar_piemonte')));
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const req = (
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    who = 'titolare',
    payload?: object,
  ) => s.app.inject({ method, url, headers: { cookie: c[who]! }, ...(payload ? { payload } : {}) });
  const start = async (who = 'titolare') => {
    const res = await req('POST', '/api/profilo/credenziali/rupar/accesso-regionale', who);
    expect(res.statusCode, res.body).toBe(200);
    return new URL(res.json<{ indirizzo: string }>().indirizzo, 'http://programma.invalid');
  };
  /** La pagina regionale simulata: il medico entra (o annulla) e torna al programma. */
  const approve = async (url: URL, azione = 'spid', tamper?: (p: URLSearchParams) => void) => {
    const page = await s.app.inject({ method: 'GET', url: url.pathname + url.search });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Accesso regionale simulato');
    const p = new URLSearchParams(url.search);
    p.delete('response_type');
    p.delete('code_challenge_method');
    p.set('azione', azione);
    tamper?.(p);
    const res = await s.app.inject({
      method: 'GET',
      url: `/api/simulatore/accesso-regionale/esito?${p.toString()}`,
    });
    expect(res.statusCode, res.body).toBe(302);
    return res.headers.location as string;
  };
  const back = async (location: string, who: string | null = 'titolare') => {
    const res = await s.app.inject({
      method: 'GET',
      url: location,
      headers: who ? { cookie: c[who]! } : {},
    });
    expect(res.statusCode, res.body).toBe(302);
    const to = new URL(res.headers.location as string, 'http://programma.invalid');
    expect(to.pathname).toBe('/profilo/credenziali');
    return Object.fromEntries(to.searchParams);
  };
  const rupar = async (who = 'titolare') =>
    (await req('GET', '/api/profilo/credenziali', who))
      .json<{
        servizi: {
          servizio: string;
          accessoRegionale: boolean;
          sessione: { attiva: boolean; scadeIl: string | null; modalita: string | null };
        }[];
      }>()
      .servizi.find((x) => x.servizio === 'rupar')!;
  const sendPrescription = async () => {
    const d = await req('POST', `/api/pazienti/${s.richPatient}/ricette`, 'titolare', {
      kind: 'pharma_ssn',
      lines: [{ drugName: 'Farmaco di prova 5 mg', quantity: 1 }],
    });
    expect(d.statusCode, d.body).toBe(201);
    return req('POST', `/api/ricette/${d.json<{ id: string }>().id}/firma-e-invia`, 'titolare', {});
  };

  /** Un lotto di NRE avuto prima, con utente, password e PIN RUPAR (V06, 3.1.1; D269). */
  const giveLot = async () => {
    const [p] = await t.db
      .select({ fiscalCode: doctorProfile.fiscalCode })
      .from(doctorProfile)
      .where(eq(doctorProfile.userId, s.users.titolare.id));
    const r = await sar.requestLot(
      { regionCode: '010', lotType: '1', doctorFiscalCode: p!.fiscalCode! },
      { username: 'utente-di-prova', password: 'parola-di-prova', pin: '1234' },
    );
    if (r.outcome !== 'assigned') throw new Error('atteso un lotto');
    await t.db.insert(nreLot).values({
      doctorUserId: s.users.titolare.id,
      doctorFiscalCode: p!.fiscalCode!,
      environment: 'simulator',
      ...r.lot,
      prefix: nreLotPrefix(r.lot),
      size: NRE_LOT_SIZE,
    });
  };

  it('solo il medico avvia l’accesso regionale', async () => {
    expect(
      (await req('POST', '/api/profilo/credenziali/rupar/accesso-regionale', 'segreteria'))
        .statusCode,
    ).toBe(403);
  });

  it('la pagina simulata accetta solo indirizzi di ritorno interni al programma', async () => {
    const url = await start();
    url.searchParams.set('redirect_uri', 'https://esempio.invalid/raccolta');
    const res = await s.app.inject({ method: 'GET', url: url.pathname + url.search });
    expect(res.statusCode).toBe(400);
  });

  it('flusso completo: entra con SPID, torna, e la ricetta SSN parte con il token, senza credenziali RUPAR', async () => {
    expect((await rupar()).accessoRegionale).toBe(true);
    const url = await start();
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: 'SIMULATORE_301',
      response_type: 'code',
      redirect_uri: RETURN,
      scope: 'prescrizione',
      code_challenge_method: 'S256',
    });
    expect(await back(await approve(url))).toEqual({ accesso: 'ok' });
    const st = await rupar();
    expect(st.sessione).toMatchObject({ attiva: true, modalita: 'spid_cie' });
    // La scadenza è il campo exp del token, in secondi interi: 8 ore, meno i millisecondi.
    const left = Date.parse(st.sessione.scadeIl!) - s.clock.now().getTime();
    expect(left).toBeGreaterThan(8 * 3_600_000 - 1000);
    expect(left).toBeLessThanOrEqual(8 * 3_600_000);
    // Il lotto di NRE vuole utente, password e PIN RUPAR anche con il token (V06, 3.1.1; D269):
    // senza credenziali e senza numeri la ricetta non parte, e il messaggio lo dice.
    const refused = await sendPrescription();
    expect(refused.statusCode, refused.body).toBe(422);
    expect(refused.json().errore).toMatch(
      /servono utente, password e PIN RUPAR del medico, anche con l’accesso con SPID o CIE/,
    );
    // Al SAR non è partita nessuna richiesta: il token non si manda per il lotto.
    expect(sar.lotRequests).toHaveLength(0);
    // Con un lotto avuto prima, la ricetta parte con il token.
    await giveLot();
    const sent = await sendPrescription();
    expect(sent.json(), sent.body).toMatchObject({ esito: 'accepted' });
    // Con il token niente X-Gestionale: il gestionale è nel token, in aud (V08, 4.3.6).
    expect(sar.receivedAuth.at(-1)).toEqual({
      username: '',
      sessionId: null,
      bearer: true,
      software: null,
    });
    // Nel database il token è cifrato.
    const [row] = await t.db
      .select()
      .from(serviceSession)
      .where(
        and(
          eq(serviceSession.userId, s.users.titolare.id),
          eq(serviceSession.service, 'rupar_piemonte'),
        ),
      );
    // L'intestazione del JWT del simulatore, in chiaro, non c'è.
    expect(row!.tokenEnc.toString('latin1')).not.toContain('eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0');
  });

  it('state falso, o di un altro medico: niente accesso', async () => {
    const before = await rupar();
    const forged = await approve(await start(), 'spid', (p) => p.set('state', 'inventato'));
    expect(await back(forged)).toMatchObject({
      accesso: 'errore',
      motivo: 'non-riconosciuta',
    });
    // Il sostituto avvia, la titolare prova a usare il ritorno del sostituto.
    const other = await approve(await start('sostituto'));
    expect(await back(other, 'titolare')).toMatchObject({ accesso: 'errore' });
    expect((await rupar()).sessione.scadeIl).toBe(before.sessione.scadeIl);
  });

  it('la richiesta è legata al medico che l’ha avviata, anche con un’identità che corrisponde', async () => {
    await req('DELETE', '/api/profilo/credenziali/rupar/sessione');
    const [p] = (
      await t.db.execute<{ fiscal_code: string }>(
        sql`select fiscal_code from doctor_profile where user_id = ${s.users.titolare.id}`,
      )
    ).rows;
    // Il sostituto avvia e fa entrare l'identità della titolare: il ritorno resta del sostituto.
    const location = await approve(await start('sostituto'), 'spid', (q) =>
      q.set('login_hint', p!.fiscal_code),
    );
    expect(await back(location, 'titolare')).toMatchObject({
      accesso: 'errore',
      motivo: 'non-riconosciuta',
    });
    expect((await rupar()).sessione.attiva).toBe(false);
  });

  it('senza il profilo di prescrizione concesso dalla Regione: niente accesso', async () => {
    const location = await approve(await start(), 'spid', (q) => q.set('scope', 'erogazione'));
    expect(await back(location)).toMatchObject({
      accesso: 'errore',
      motivo: 'senza-profilo',
    });
    expect((await rupar()).sessione.attiva).toBe(false);
  });

  it('identità diversa da quella del medico collegato: rifiutata, e il token revocato', async () => {
    await req('DELETE', '/api/profilo/credenziali/rupar/sessione');
    const location = await approve(await start(), 'spid', (p) =>
      p.set('login_hint', 'XXXXXX00X00X000X'),
    );
    expect(await back(location)).toMatchObject({
      accesso: 'errore',
      motivo: 'identita-diversa',
    });
    expect((await rupar()).sessione.attiva).toBe(false);
  });

  it('annullato dal medico; codice già usato; richiesta scaduta', async () => {
    expect(await back(await approve(await start(), 'annulla'))).toMatchObject({
      accesso: 'errore',
      motivo: 'annullato',
    });
    const location = await approve(await start());
    expect(await back(location)).toEqual({ accesso: 'ok' });
    expect(await back(location)).toMatchObject({
      accesso: 'errore',
      motivo: 'non-riconosciuta',
    });
    const late = await start();
    s.clock.advance(11 * 60_000);
    c.titolare = await login(s, 'titolare');
    expect(await back(await approve(late))).toMatchObject({
      accesso: 'errore',
      motivo: 'non-riconosciuta',
    });
  });

  it('ritorno senza accesso al programma: un messaggio chiaro, non un errore tecnico', async () => {
    const location = await approve(await start());
    expect(await back(location, null)).toMatchObject({
      accesso: 'errore',
      motivo: 'sessione',
    });
  });

  it('token scaduto: la ricetta si ferma prima e chiede di rientrare; revoca', async () => {
    expect(await back(await approve(await start()))).toEqual({ accesso: 'ok' });
    const [row] = await t.db
      .select()
      .from(serviceSession)
      .where(
        and(
          eq(serviceSession.userId, s.users.titolare.id),
          eq(serviceSession.service, 'rupar_piemonte'),
        ),
      );
    s.clock.advance(8 * 3_600_000 + 1000);
    c.titolare = await login(s, 'titolare');
    const res = await sendPrescription();
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      errore: expect.stringMatching(/SPID o CIE è scaduto/),
      dettagli: { codice: 'SESSIONE_SCADUTA', servizio: 'rupar' },
    });
    expect(await back(await approve(await start()))).toEqual({ accesso: 'ok' });
    const token = (
      await t.db
        .select()
        .from(serviceSession)
        .where(
          and(
            eq(serviceSession.userId, s.users.titolare.id),
            eq(serviceSession.service, 'rupar_piemonte'),
          ),
        )
    )[0]!;
    expect(token.tokenEnc.equals(row!.tokenEnc)).toBe(false);
    expect((await req('DELETE', '/api/profilo/credenziali/rupar/sessione')).statusCode).toBe(200);
    expect((await rupar()).sessione.attiva).toBe(false);
    const events = (
      await t.db
        .select()
        .from(serviceCredentialEvent)
        .where(eq(serviceCredentialEvent.userId, s.users.titolare.id))
    ).map((e) => e.event);
    for (const e of [
      'accesso_regionale_avviato',
      'accesso_regionale_rifiutato',
      'sessione_attivata',
      'sessione_revocata',
    ])
      expect(events, e).toContain(e);
  });

  it('token per un altro gestionale (aud) o già scaduto (exp): niente accesso (V08, 4.3.2)', async () => {
    await req('DELETE', '/api/profilo/credenziali/rupar/sessione');
    const detail = async () =>
      (
        await t.db
          .select()
          .from(serviceCredentialEvent)
          .where(
            and(
              eq(serviceCredentialEvent.userId, s.users.titolare.id),
              eq(serviceCredentialEvent.event, 'accesso_regionale_rifiutato'),
            ),
          )
      )
        .map((e) => e.detail ?? '')
        .join('\n');
    try {
      tamperClaims = (claims) => ({ ...claims, aud: 'ALTRO_GESTIONALE_301' });
      expect(await back(await approve(await start()))).toMatchObject({
        accesso: 'errore',
        motivo: 'token-negato',
      });
      expect(await detail()).toContain('altro gestionale (ALTRO_GESTIONALE_301)');
      tamperClaims = (claims) => ({
        ...claims,
        exp: Math.floor(s.clock.now().getTime() / 1000) - 1,
      });
      expect(await back(await approve(await start()))).toMatchObject({
        accesso: 'errore',
        motivo: 'token-negato',
      });
      expect(await detail()).toContain('token già scaduto');
    } finally {
      tamperClaims = null;
    }
    expect((await rupar()).sessione.attiva).toBe(false);
  });

  it('revoca di un token che per la Regione era già chiuso: si chiude anche qui, e si annota (V08, 4.3.5)', async () => {
    expect(await back(await approve(await start()))).toEqual({ accesso: 'ok' });
    const [row] = await t.db
      .select()
      .from(serviceSession)
      .where(
        and(
          eq(serviceSession.userId, s.users.titolare.id),
          eq(serviceSession.service, 'rupar_piemonte'),
        ),
      );
    expect(row).toBeDefined();
    // La Regione lo revoca da sé (per esempio un accesso nuovo da un altro gestionale): il nostro
    // DELETE riceve 401.
    s.clock.advance(8 * 3_600_000 + 1000);
    c.titolare = await login(s, 'titolare');
    expect((await req('DELETE', '/api/profilo/credenziali/rupar/sessione')).statusCode).toBe(200);
    expect((await rupar()).sessione.attiva).toBe(false);
    const details = (
      await t.db
        .select()
        .from(serviceCredentialEvent)
        .where(
          and(
            eq(serviceCredentialEvent.userId, s.users.titolare.id),
            eq(serviceCredentialEvent.event, 'sessione_revocata'),
          ),
        )
    ).map((e) => e.detail);
    expect(details).toContain('SPID o CIE: per la Regione era già chiuso');
  });

  it('la pagina regionale simulata rimanda solo al ritorno del programma, mai fuori (D193)', async () => {
    const common = {
      client_id: 'SIMULATORE_301',
      scope: 'prescrizione',
      state: 'qualunque',
      code_challenge: 'a'.repeat(43),
    };
    for (const redirect of [
      '//esempio.invalid/raccolta',
      '/\\esempio.invalid/raccolta',
      'https://esempio.invalid/raccolta',
      '/api/altro/ritorno',
    ]) {
      const page = await s.app.inject({
        method: 'GET',
        url: `/api/simulatore/accesso-regionale?${new URLSearchParams({
          ...common,
          response_type: 'code',
          code_challenge_method: 'S256',
          redirect_uri: redirect,
        }).toString()}`,
      });
      expect(page.statusCode, redirect).toBe(400);
      const out = await s.app.inject({
        method: 'GET',
        url: `/api/simulatore/accesso-regionale/esito?${new URLSearchParams({
          ...common,
          redirect_uri: redirect,
          azione: 'annulla',
        }).toString()}`,
      });
      expect(out.statusCode, redirect).toBe(400);
      expect(out.headers.location, redirect).toBeUndefined();
    }
  });

  const setAsl = (aslCode: string | null) =>
    t.db
      .update(doctorProfile)
      .set({ aslCode })
      .where(eq(doctorProfile.userId, s.users.titolare.id));
  const lastRevocation = async () =>
    (
      await t.db
        .select({ detail: serviceCredentialEvent.detail })
        .from(serviceCredentialEvent)
        .where(
          and(
            eq(serviceCredentialEvent.userId, s.users.titolare.id),
            eq(serviceCredentialEvent.event, 'sessione_revocata'),
          ),
        )
        .orderBy(sql`${serviceCredentialEvent.at} desc`)
        .limit(1)
    )[0]?.detail;

  it('client_id: il codice del gestionale con il codice ASL del medico; senza codice ASL l’accesso non parte (D266)', async () => {
    expect((await start()).searchParams.get('client_id')).toBe('SIMULATORE_301');
    await setAsl(null);
    try {
      const res = await req('POST', '/api/profilo/credenziali/rupar/accesso-regionale');
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({
        errore: expect.stringMatching(/^Manca il codice ASL del medico/),
        dettagli: { codice: 'CODICE_ASL_MANCANTE', servizio: 'rupar' },
      });
    } finally {
      await setAsl('301');
    }
  });

  it('se l’ASL cambia fra l’avvio e il ritorno vale il client_id della richiesta; la revoca usa quello del token', async () => {
    const url = await start();
    expect(url.searchParams.get('client_id')).toBe('SIMULATORE_301');
    await setAsl('203');
    try {
      expect(await back(await approve(url))).toEqual({ accesso: 'ok' });
      expect((await rupar()).sessione.modalita).toBe('spid_cie');
      // Con il client_id di adesso (SIMULATORE_203) la Regione direbbe che il token non è suo.
      const del = await req('DELETE', '/api/profilo/credenziali/rupar/sessione');
      expect(del.statusCode, del.body).toBe(200);
      expect(await lastRevocation()).toBe('SPID o CIE');
    } finally {
      await setAsl('301');
    }
  });
});
