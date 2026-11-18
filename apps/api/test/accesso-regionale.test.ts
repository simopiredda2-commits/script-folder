import {
  SimulatedGateway,
  SimulatedRegionalAuthorization,
  SimulatedSecondFactor,
} from '@mmg/integrations';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { serviceCredential, serviceCredentialEvent, serviceSession } from '../src/db/schema';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

const noRules = () => Promise.resolve({ rulesVersion: null, issues: [] });
const RETURN = '/api/profilo/credenziali/rupar/accesso-regionale/ritorno';

describe('accesso regionale con SPID o CIE (D109)', () => {
  let t: TestDatabase;
  let s: Scenario;
  const c: Record<string, string> = {};
  let regional: SimulatedRegionalAuthorization;
  let sar: SimulatedGateway;

  beforeAll(async () => {
    t = await createTestDatabase();
    regional = new SimulatedRegionalAuthorization({ now: () => s.clock.now() });
    sar = new SimulatedGateway('sar', { oauth: regional });
    s = await createScenario(
      t.db,
      {},
      {
        gateways: { sar, sistema_ts: new SimulatedGateway('sistema_ts') },
        secondFactor: {
          sistema_ts: new SimulatedSecondFactor('sistema_ts', { now: () => s.clock.now() }),
          rupar_piemonte: new SimulatedSecondFactor('rupar_piemonte', { now: () => s.clock.now() }),
        },
        regional: { gateway: regional, clientId: 'SIMULATORE_000', redirectUri: RETURN },
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
      client_id: 'SIMULATORE_000',
      response_type: 'code',
      redirect_uri: RETURN,
      scope: 'prescrizione',
      code_challenge_method: 'S256',
    });
    expect(await back(await approve(url))).toEqual({ accesso: 'ok' });
    const st = await rupar();
    expect(st.sessione).toMatchObject({ attiva: true, modalita: 'spid_cie' });
    expect(Date.parse(st.sessione.scadeIl!) - s.clock.now().getTime()).toBe(8 * 3_600_000);
    const sent = await sendPrescription();
    expect(sent.json(), sent.body).toMatchObject({ esito: 'accepted' });
    expect(sar.receivedAuth.at(-1)).toEqual({ username: '', sessionId: null, bearer: true });
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
    expect(row!.tokenEnc.toString('latin1')).not.toContain('SIMJWT');
  });

  it('state falso, o di un altro medico: niente accesso', async () => {
    const before = await rupar();
    const forged = await approve(await start(), 'spid', (p) => p.set('state', 'inventato'));
    expect(await back(forged)).toMatchObject({
      accesso: 'errore',
      motivo: expect.stringMatching(/non riconosciuta/),
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
      motivo: expect.stringMatching(/non riconosciuta/),
    });
    expect((await rupar()).sessione.attiva).toBe(false);
  });

  it('senza il profilo di prescrizione concesso dalla Regione: niente accesso', async () => {
    const location = await approve(await start(), 'spid', (q) => q.set('scope', 'erogazione'));
    expect(await back(location)).toMatchObject({
      accesso: 'errore',
      motivo: expect.stringMatching(/profilo di prescrizione/),
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
      motivo: expect.stringMatching(/identità diversa/),
    });
    expect((await rupar()).sessione.attiva).toBe(false);
  });

  it('annullato dal medico; codice già usato; richiesta scaduta', async () => {
    expect(await back(await approve(await start(), 'annulla'))).toMatchObject({
      accesso: 'errore',
      motivo: 'Accesso regionale annullato o negato',
    });
    const location = await approve(await start());
    expect(await back(location)).toEqual({ accesso: 'ok' });
    expect(await back(location)).toMatchObject({
      accesso: 'errore',
      motivo: expect.stringMatching(/non riconosciuta/),
    });
    const late = await start();
    s.clock.advance(11 * 60_000);
    c.titolare = await login(s, 'titolare');
    expect(await back(await approve(late))).toMatchObject({
      accesso: 'errore',
      motivo: expect.stringMatching(/scaduta/),
    });
  });

  it('ritorno senza accesso al programma: un messaggio chiaro, non un errore tecnico', async () => {
    const location = await approve(await start());
    expect(await back(location, null)).toMatchObject({
      accesso: 'errore',
      motivo: expect.stringMatching(/Accesso al programma scaduto/),
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
});
