import { SimulatedGateway, SimulatedSecondFactor } from '@mmg/integrations';
import { RUPAR_CREDENTIALS } from '@mmg/regions/piemonte';
import { and, count, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  changeHistory,
  doctorProfile,
  prescription,
  serviceCredential,
  serviceCredentialEvent,
  serviceSession,
} from '../../../src/db/schema';
import { studioDate } from '../../../src/prescriptions/rules-check';
import { createScenario, login, type Scenario } from '../../helpers/scenario';
import { createTestDatabase, type TestDatabase } from '../../helpers/test-db';
import { regionalGateway } from '../../helpers/regional-gateway';

/**
 * Le credenziali RUPAR del Piemonte dalla pagina delle credenziali fino agli invii al SAR (D100–
 * D102, D266, D301): codice ASL del medico, informazione «APP», X-Gestionale, tre mesi della
 * password. Il meccanismo nazionale, con regioni inventate, è in `credenziali-regione-scelta`.
 */

const noRules = () => Promise.resolve({ rulesVersion: null, issues: [] });

/** Drizzle avvolge l'errore di Postgres: il messaggio del trigger sta in `cause`. */
async function rejectsWith(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
  } catch (err) {
    const e = err as { message: string; cause?: { message: string } };
    expect(e.cause?.message ?? e.message).toMatch(pattern);
    return;
  }
  throw new Error(`Doveva fallire con ${pattern}`);
}

interface ServiceStatus {
  servizio: string;
  impostate: boolean;
  utente: string | null;
  passwordCambiataIl: string | null;
  scadenzaPassword: string | null;
  statoPassword: string | null;
  secondoFattore: boolean;
  sessione: { attiva: boolean; scadeIl: string | null };
}

describe('credenziali RUPAR e secondo fattore della Regione (D100–D102, D301)', () => {
  let t: TestDatabase;
  let s: Scenario;
  const c: Record<string, string> = {};
  let sar: SimulatedGateway;
  let ts: SimulatedGateway;
  let rupar2f: SimulatedSecondFactor;

  beforeAll(async () => {
    t = await createTestDatabase();
    const second = RUPAR_CREDENTIALS.secondFactor!({ now: () => s.clock.now() });
    if (!(second instanceof SimulatedSecondFactor)) throw new Error('secondo fattore simulato');
    rupar2f = second;
    const ts2f = new SimulatedSecondFactor('sistema_ts', { now: () => s.clock.now() });
    sar = regionalGateway({ sessions: rupar2f });
    ts = new SimulatedGateway('sistema_ts', { sessions: ts2f });
    s = await createScenario(
      t.db,
      {},
      {
        gateways: { regional: sar, sistema_ts: ts },
        secondFactor: { regional: rupar2f, sistema_ts: ts2f },
        preSendChecks: noRules,
      },
    );
    for (const who of ['titolare', 'segreteria', 'amministratore', 'sostituto'] as const)
      c[who] = await login(s, who);
    // La titolare parte senza credenziali e senza sessioni: le inserisce dalle rotte.
    await t.db.delete(serviceSession).where(eq(serviceSession.userId, s.users.titolare.id));
    await t.db.delete(serviceCredential).where(eq(serviceCredential.userId, s.users.titolare.id));
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const req = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    who = 'titolare',
    payload?: object,
  ) => s.app.inject({ method, url, headers: { cookie: c[who]! }, ...(payload ? { payload } : {}) });
  const statusOf = async (servizio: string, who = 'titolare') => {
    const res = await req('GET', '/api/profilo/credenziali', who);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ servizi: ServiceStatus[] }>().servizi.find((x) => x.servizio === servizio)!;
  };
  const draft = async (kind = 'pharma_ssn', who = 'titolare') => {
    const res = await req('POST', `/api/pazienti/${s.richPatient}/ricette`, who, {
      kind,
      lines: [{ drugName: 'Farmaco di prova 5 mg', quantity: 1 }],
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  };
  const send = (id: string, who = 'titolare') =>
    req('POST', `/api/ricette/${id}/firma-e-invia`, who, {});
  const events = async () =>
    (
      await t.db
        .select()
        .from(serviceCredentialEvent)
        .where(eq(serviceCredentialEvent.userId, s.users.titolare.id))
        .orderBy(serviceCredentialEvent.at)
    ).map((e) => `${e.service}:${e.event}`);

  it('sono solo del medico: la segreteria e l’amministratore non le vedono e non le cambiano', async () => {
    for (const who of ['segreteria', 'amministratore']) {
      expect((await req('GET', '/api/profilo/credenziali', who)).statusCode).toBe(403);
      const put = await req('PUT', '/api/profilo/credenziali/rupar', who, {
        utente: 'x',
        password: 'y',
        pin: '1',
      });
      expect(put.statusCode).toBe(403);
      expect(put.json<{ errore: string }>().errore).toMatch(/personali del medico/);
    }
  });

  it('senza credenziali l’invio si ferma prima di contattare il SAR, e la ricetta non cambia', async () => {
    const id = await draft();
    const before = sar.received.length;
    const res = await send(id);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      errore: expect.stringMatching(/Mancano le credenziali RUPAR Piemonte/),
      dettagli: { codice: 'CREDENZIALI_MANCANTI', servizio: 'rupar' },
    });
    expect(sar.received.length).toBe(before);
    const [p] = await t.db.select().from(prescription).where(eq(prescription.id, id));
    expect(p!.status).toBe('draft');
  });

  it('si inseriscono, e non si rileggono mai: solo le ultime tre lettere dell’utente', async () => {
    const res = await req('PUT', '/api/profilo/credenziali/rupar', 'titolare', {
      utente: 'RUPAR-PROVA-ABC',
      password: 'parola-segreta-di-prova',
      pin: '4321',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.body).not.toMatch(/parola-segreta-di-prova|4321|RUPAR-PROVA/);
    const st = await statusOf('rupar');
    expect(st).toMatchObject({
      impostate: true,
      utente: '…ABC',
      passwordCambiataIl: studioDate(s.clock.now()),
      statoPassword: 'valida',
      secondoFattore: true,
      sessione: { attiva: false, scadeIl: null },
    });
    // Nel database solo testo cifrato.
    const [row] = await t.db
      .select()
      .from(serviceCredential)
      .where(
        and(
          eq(serviceCredential.userId, s.users.titolare.id),
          eq(serviceCredential.service, 'rupar_piemonte'),
        ),
      );
    const raw = row!.secretEnc.toString('latin1');
    for (const plain of ['parola-segreta-di-prova', '4321', 'RUPAR-PROVA-ABC'])
      expect(raw).not.toContain(plain);
    // Nessuno storico: nessun segreto vecchio resta conservato.
    const [h] = await t.db
      .select({ n: count() })
      .from(changeHistory)
      .where(eq(changeHistory.tableName, 'service_credential'));
    expect(h!.n).toBe(0);
  });

  it('copiate sulla riga di un altro medico non si aprono', async () => {
    const [mine] = await t.db
      .select()
      .from(serviceCredential)
      .where(
        and(
          eq(serviceCredential.userId, s.users.titolare.id),
          eq(serviceCredential.service, 'rupar_piemonte'),
        ),
      );
    await t.db
      .update(serviceCredential)
      .set({ secretEnc: mine!.secretEnc })
      .where(
        and(
          eq(serviceCredential.userId, s.users.sostituto.id),
          eq(serviceCredential.service, 'rupar_piemonte'),
        ),
      );
    const res = await req('POST', '/api/profilo/credenziali/rupar/sessione/richiesta', 'sostituto');
    expect(res.statusCode).toBe(422);
    expect(res.json<{ errore: string }>().errore).toMatch(/non si possono leggere/);
    // Il sostituto le reinserisce: tornano sue.
    const put = await req('PUT', '/api/profilo/credenziali/rupar', 'sostituto', {
      utente: `rupar_piemonte-${s.users.sostituto.username}`,
      password: 'parola-di-prova',
      pin: '0000',
    });
    expect(put.statusCode, put.body).toBe(200);
  });

  it('il codice di sessione: richiesto, verificato, valido 8 ore; con un codice sbagliato no', async () => {
    const r = await req('POST', '/api/profilo/credenziali/rupar/sessione/richiesta');
    expect(r.statusCode, r.body).toBe(200);
    const { codiceDiProva } = r.json<{ inviato: boolean; codiceDiProva: string }>();
    expect(codiceDiProva).toMatch(/^[0-9a-f-]{36}$/);
    const wrong = await req('POST', '/api/profilo/credenziali/rupar/sessione', 'titolare', {
      codice: '00000000-0000-0000-0000-000000000000',
    });
    expect(wrong.statusCode).toBe(422);
    const ok = await req('POST', '/api/profilo/credenziali/rupar/sessione', 'titolare', {
      codice: codiceDiProva,
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const st = await statusOf('rupar');
    expect(st.sessione.attiva).toBe(true);
    expect(Date.parse(st.sessione.scadeIl!) - s.clock.now().getTime()).toBe(8 * 3_600_000);
    // Con la sessione la ricetta parte, con le credenziali e l'Id-Sessione della titolare.
    const id = await draft();
    const sent = await send(id);
    expect(sent.json()).toMatchObject({ esito: 'accepted' });
    // Con l'Id-Sessione per email anche X-Gestionale: codice del gestionale e ASL (V08, 4.2.5).
    expect(sar.receivedAuth.at(-1)).toEqual({
      username: 'RUPAR-PROVA-ABC',
      sessionId: codiceDiProva,
      bearer: false,
      software: 'SIMULATORE_301',
    });
    // Richiesta e verifica del codice hanno portato l'informazione «APP» (V08, 4.2.1–4.2.2).
    expect(rupar2f.receivedSoftware.slice(-2)).toEqual(['SIMULATORE_301', 'SIMULATORE_301']);
  });

  it('senza codice ASL del medico la RUPAR non si chiama: né il codice di sessione né le ricette (D266)', async () => {
    const before = rupar2f.receivedSoftware.length;
    await t.db
      .update(doctorProfile)
      .set({ aslCode: null })
      .where(eq(doctorProfile.userId, s.users.sostituto.id));
    try {
      const res = await req(
        'POST',
        '/api/profilo/credenziali/rupar/sessione/richiesta',
        'sostituto',
      );
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({
        errore: expect.stringMatching(
          /^Manca il codice ASL del medico: lo scrive l’amministratore/,
        ),
        dettagli: { codice: 'CODICE_ASL_MANCANTE', servizio: 'rupar' },
      });
      expect(rupar2f.receivedSoftware.length).toBe(before);
      // Il Sistema TS non usa il codice ASL: il suo codice di sessione si chiede lo stesso.
      const ts = await req(
        'POST',
        '/api/profilo/credenziali/sistema-ts/sessione/richiesta',
        'sostituto',
      );
      expect(ts.statusCode, ts.body).toBe(200);
    } finally {
      await t.db
        .update(doctorProfile)
        .set({ aslCode: '301' })
        .where(eq(doctorProfile.userId, s.users.sostituto.id));
    }
  });

  it('sessione scaduta: l’invio si ferma prima, con l’errore che porta alla pagina giusta', async () => {
    s.clock.advance(8 * 3_600_000 + 1000);
    // Otto ore dopo l'accesso al programma è bloccato per inattività: si rientra.
    for (const who of ['titolare', 'sostituto'] as const) c[who] = await login(s, who);
    const id = await draft();
    const before = sar.received.length;
    const res = await send(id);
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      dettagli: { codice: 'SESSIONE_SCADUTA', servizio: 'rupar' },
    });
    expect(sar.received.length).toBe(before);
    expect((await statusOf('rupar')).sessione.attiva).toBe(false);
  });

  it('sessione revocata dal servizio: errore d’accesso, si toglie, e la ricetta si rimanda così com’è', async () => {
    const r = await req('POST', '/api/profilo/credenziali/rupar/sessione/richiesta');
    const code = r.json<{ codiceDiProva: string }>().codiceDiProva;
    await req('POST', '/api/profilo/credenziali/rupar/sessione', 'titolare', { codice: code });
    const id = await draft();
    // Un'altra richiesta (per esempio da un altro programma) invalida la sessione presso il servizio.
    await rupar2f.requestCode({
      auth: { username: 'RUPAR-PROVA-ABC', password: 'x', pin: '1', software: 'ALTRO_301' },
      fiscalCode: await fiscalCode(),
    });
    const res = await send(id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      esito: 'auth',
      messaggio: expect.stringMatching(/codice di sessione/),
    });
    const [p] = await t.db.select().from(prescription).where(eq(prescription.id, id));
    expect(p).toMatchObject({ status: 'error', lastErrorKind: 'auth' });
    expect((await statusOf('rupar')).sessione.attiva).toBe(false);
    // Nuovo codice, poi la stessa ricetta si rimanda senza correggerla.
    const again = await req('POST', '/api/profilo/credenziali/rupar/sessione/richiesta');
    await req('POST', '/api/profilo/credenziali/rupar/sessione', 'titolare', {
      codice: again.json<{ codiceDiProva: string }>().codiceDiProva,
    });
    expect((await send(id)).json()).toMatchObject({ esito: 'accepted' });
  });

  const fiscalCode = async () =>
    (
      await t.db.execute<{ fiscal_code: string }>(
        sql`select fiscal_code from doctor_profile where user_id = ${s.users.titolare.id}`,
      )
    ).rows[0]!.fiscal_code;

  it('cambio della sola password: utente e PIN restano; la data del cambio è oggi', async () => {
    const res = await req('PUT', '/api/profilo/credenziali/rupar', 'titolare', {
      password: 'nuova-parola-di-prova',
    });
    expect(res.statusCode, res.body).toBe(200);
    const st = await statusOf('rupar');
    expect(st).toMatchObject({ utente: '…ABC', passwordCambiataIl: studioDate(s.clock.now()) });
    // La sessione resta: l'utente è lo stesso.
    expect(st.sessione.attiva).toBe(true);
  });

  it('password RUPAR cambiata 80 giorni fa: in scadenza; data nel futuro: rifiutata', async () => {
    const day = 86_400_000;
    const changed = studioDate(new Date(s.clock.now().getTime() - 80 * day));
    await req('PUT', '/api/profilo/credenziali/rupar', 'titolare', { passwordCambiataIl: changed });
    const st = await statusOf('rupar');
    expect(st.statoPassword).toBe('in_scadenza');
    expect(st.scadenzaPassword! > studioDate(s.clock.now())).toBe(true);
    const future = studioDate(new Date(s.clock.now().getTime() + 2 * day));
    const bad = await req('PUT', '/api/profilo/credenziali/rupar', 'titolare', {
      passwordCambiataIl: future,
    });
    expect(bad.statusCode).toBe(400);
  });

  it('la ricetta bianca usa il Sistema TS; il sostituto firma con le proprie credenziali', async () => {
    await req('PUT', '/api/profilo/credenziali/sistema-ts', 'titolare', {
      utente: 'TS-PROVA-XYZ',
      password: 'parola-ts-di-prova',
      pin: '9876',
    });
    const r = await req('POST', '/api/profilo/credenziali/sistema-ts/sessione/richiesta');
    await req('POST', '/api/profilo/credenziali/sistema-ts/sessione', 'titolare', {
      codice: r.json<{ codiceDiProva: string }>().codiceDiProva,
    });
    const white = await draft('white');
    expect((await send(white)).json()).toMatchObject({ esito: 'accepted' });
    expect(ts.receivedAuth.at(-1)!.username).toBe('TS-PROVA-XYZ');
    // Il sostituto: le sue credenziali RUPAR (rimesse sopra) e una sessione sua.
    const rs = await req('POST', '/api/profilo/credenziali/rupar/sessione/richiesta', 'sostituto');
    expect(rs.statusCode, rs.body).toBe(200);
    await req('POST', '/api/profilo/credenziali/rupar/sessione', 'sostituto', {
      codice: rs.json<{ codiceDiProva: string }>().codiceDiProva,
    });
    const id = await draft('pharma_ssn', 'sostituto');
    expect((await send(id, 'sostituto')).json()).toMatchObject({ esito: 'accepted' });
    expect(sar.receivedAuth.at(-1)!.username).toBe(`rupar_piemonte-${s.users.sostituto.username}`);
  });

  it('revoca e cancellazione; ogni passaggio nel registro degli eventi, senza valori, non modificabile', async () => {
    expect((await req('DELETE', '/api/profilo/credenziali/rupar/sessione')).statusCode).toBe(200);
    expect((await statusOf('rupar')).sessione.attiva).toBe(false);
    expect((await req('DELETE', '/api/profilo/credenziali/sistema-ts')).statusCode).toBe(200);
    expect(await statusOf('sistema-ts')).toMatchObject({
      impostate: false,
      sessione: { attiva: false },
    });
    const ev = await events();
    for (const e of [
      'rupar_piemonte:impostate',
      'rupar_piemonte:codice_richiesto',
      'rupar_piemonte:sessione_rifiutata',
      'rupar_piemonte:sessione_attivata',
      'rupar_piemonte:cambiate',
      'rupar_piemonte:sessione_revocata',
      'sistema_ts:cancellate',
    ])
      expect(ev, e).toContain(e);
    // Solo i campi che potrebbero portare valori: identificativi e date sono casuali, e un UUID
    // può contenere «4321» per caso (prova che falliva una volta ogni tanto in CI).
    const dump = JSON.stringify(
      (await t.db.select().from(serviceCredentialEvent)).map(
        ({ service, event, workstation, detail }) => ({ service, event, workstation, detail }),
      ),
    );
    expect(dump).not.toMatch(/parola|4321|9876|RUPAR-PROVA|TS-PROVA/);
    await rejectsWith(
      t.db.execute(sql`update service_credential_event set event = 'x'`),
      /non si modificano/,
    );
    await rejectsWith(t.db.execute(sql`delete from service_credential_event`), /non si modificano/);
    await rejectsWith(t.db.execute(sql`truncate service_credential_event`), /non si svuotano/);
  });

  it('l’esportazione dei dati non contiene credenziali né codici di sessione', async () => {
    const res = await req('GET', '/api/esportazione');
    expect(res.statusCode, res.body.slice(0, 200)).toBe(200);
    expect(res.body).not.toMatch(/service_credential|service_session|RUPAR-PROVA|parola/);
  });
});
