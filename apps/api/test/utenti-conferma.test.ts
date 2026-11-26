import { randomBytes } from 'node:crypto';
import { buildFiscalCode, type Role } from '@mmg/domain';
import { generatePatients } from '@mmg/fixtures';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  FISCAL_CODE_PENDING_NOTICE,
  SECRETARY_OWN_ARCHIVE_NOTICE,
  CLINICAL_CREDENTIALS_REFUSAL,
  CLINICAL_UNLOCK_REFUSAL,
  createUserAdminService,
  LAST_OWNER_SUSPEND_REFUSAL,
  NOT_CONFIRMER,
  OWNER_ROLE_ADD_REFUSAL,
  OWNER_ROLE_REMOVAL_REFUSAL,
  OWNER_SUSPEND_REFUSAL,
} from '../src/admin/user-service';
import { AWAITING_CONFIRMATION_ERROR, GENERIC_LOGIN_ERROR, type Actor } from '../src/auth/service';
import { storeSession } from '../src/credentials/service';
import { createFirstStudio } from '../src/db/first-studio';
import {
  accessLog,
  appUser,
  archive,
  patient,
  regionalAuthorizationRequest,
  serviceCredentialEvent,
  serviceSession,
  session,
} from '../src/db/schema';
import { withActor } from '../src/db/tx';
import { restoreUser, showRequest } from '../src/db/user-restore';
import { base32Decode } from '../src/security/base32';
import { hashPassword } from '../src/security/password';
import { totp } from '../src/security/totp';
import {
  createScenario,
  login,
  PASSWORD,
  type Scenario,
  type ScenarioUser,
} from './helpers/scenario';
import { regionalCredentials } from './helpers/regional-gateway';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

/** Codice fiscale inventato: luogo di nascita con la X, che nessun comune ha (D12). */
const cf = (surname: string, name: string, sex: 'M' | 'F', birthDate = '1975-05-05') =>
  buildFiscalCode({ surname, name, birthDate, sex, placeCode: 'X001' });

type Method = 'GET' | 'POST' | 'PATCH';

/**
 * Poteri dell'amministratore (tappa 14): conferma dei titolari per chi apre dati dei pazienti,
 * ripristino delle credenziali solo dal server, titolari con pazienti protetti, sessioni dei servizi
 * chiuse quando cambiano i codici del medico. Utenti e pazienti inventati.
 */
describe('conferma dei titolari e poteri dell’amministratore (tappa 14)', () => {
  let t: TestDatabase;
  let s: Scenario;
  const cookies = {} as Record<
    'amministratore' | 'titolare' | 'collega' | 'segreteria' | 'sostituto',
    string
  >;
  /** Ogni password vista nelle prove: nessuna deve finire nel registro. */
  const passwordsSeen: string[] = [PASSWORD];
  /** Segreti del secondo fattore per nome utente, per gli accessi delle prove. */
  const secrets = new Map<string, Buffer>();

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db, { idleLockMinutes: null });
    for (const who of ['amministratore', 'titolare', 'collega', 'segreteria', 'sostituto'] as const)
      cookies[who] = await login(s, who);
    for (const u of Object.values(s.users)) secrets.set(u.username, s.secrets.get(u.id)!);
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const req = (cookie: string | undefined, method: Method, url: string, payload?: object) =>
    s.app.inject({ method, url, headers: cookie ? { cookie } : {}, payload });
  const access = (username: string, password: string) =>
    s.app.inject({
      method: 'POST',
      url: '/api/accesso',
      payload: { username, password, postazione: 'postazione-prova' },
    });

  /** Accesso completo; il secondo fattore si attiva se serve. */
  async function loginAs(username: string, password: string): Promise<string> {
    const res = await access(username, password);
    if (res.statusCode !== 200) throw new Error(`Accesso di ${username} fallito: ${res.body}`);
    const body = res.json<{ passaggio: string; segreto?: string }>();
    if (body.segreto) secrets.set(username, base32Decode(body.segreto));
    s.clock.advance(30_000);
    const done = await s.app.inject({
      method: 'POST',
      url: '/api/accesso/codice',
      payload: {
        passaggio: body.passaggio,
        codice: totp(secrets.get(username)!, s.clock.now().getTime()),
      },
    });
    if (done.statusCode !== 200) throw new Error(`Codice di ${username} rifiutato: ${done.body}`);
    return `sessione=${done.cookies.find((c) => c.name === 'sessione')!.value}`;
  }

  /** Primo accesso con la password temporanea e cambio subito. */
  async function firstAccess(username: string, temporary: string, chosen: string) {
    passwordsSeen.push(temporary, chosen);
    const cookie = await loginAs(username, temporary);
    const r = await req(cookie, 'POST', '/api/profilo/password', {
      passwordAttuale: temporary,
      nuovaPassword: chosen,
    });
    expect(r.statusCode, r.body).toBe(200);
    return cookie;
  }

  async function createUser(cookie: string, payload: object) {
    const r = await req(cookie, 'POST', '/api/studio/utenti', payload);
    expect(r.statusCode, r.body).toBe(201);
    const b = r.json();
    if (b.passwordTemporanea) passwordsSeen.push(b.passwordTemporanea);
    return b as {
      utente: {
        id: string;
        nomeUtente: string;
        inAttesaDiConferma: boolean;
        richiestaDiConferma: { da: string | null; il: string } | null;
        confermaDalServizio: boolean;
      };
      passwordTemporanea?: string;
      avvisi: string[];
    };
  }

  const pendingOf = async (cookie: string) => {
    const r = await req(cookie, 'GET', '/api/studio/utenti/da-confermare');
    expect(r.statusCode, r.body).toBe(200);
    return r.json().utenti as {
      id: string;
      nomeUtente: string;
      richiesta: { da: string | null; il: string };
      passwordAllaConferma: boolean;
    }[];
  };

  /** Conferma dal titolare per la richiesta che legge nel suo elenco. */
  async function confirm(cookie: string, id: string) {
    const pending = (await pendingOf(cookie)).find((x) => x.id === id);
    expect(pending, 'utente nell’elenco da confermare').toBeTruthy();
    const r = await req(cookie, 'POST', `/api/studio/utenti/${id}/conferma`, {
      richiestaIl: pending!.richiesta.il,
    });
    expect(r.statusCode, r.body).toBe(200);
    const password = r.json().passwordTemporanea as string | undefined;
    if (password) passwordsSeen.push(password);
    return { password, body: r.json() };
  }

  /**
   * Conferma dal server in due passi, come chi gestisce il servizio: legge la richiesta (`--mostra`)
   * e conferma quella, con la sua data (`--conferma --richiesta-il`).
   */
  async function serverConfirm(username: string) {
    const shown = await showRequest(t.db, { utente: username });
    return restoreUser(t.db, { utente: username, conferma: true, richiestaIl: shown.requestedAt! });
  }

  const adminLog = async (studioId = s.studioId): Promise<Record<string, unknown>[]> =>
    (
      await t.db
        .select()
        .from(accessLog)
        .where(and(eq(accessLog.studioId, studioId), eq(accessLog.action, 'amministrazione')))
        .orderBy(asc(accessLog.seq))
    ).map((r) => ({
      userId: r.userId,
      outcome: r.outcome,
      workstation: r.workstation,
      ...(r.details as Record<string, unknown>),
    }));

  const userRow = async (id: string) =>
    (await t.db.select().from(appUser).where(eq(appUser.id, id)))[0]!;

  const actorOf = (u: Pick<ScenarioUser, 'id'>, roles: Role[], studioId = s.studioId): Actor => ({
    userId: u.id,
    studioId,
    roles,
    displayName: 'Utente di prova',
    sessionId: '00000000-0000-4000-8000-000000000000',
    workstation: 'postazione-prova',
    mustChangePassword: false,
  });

  it('conferma e rifiuto solo dai medici titolari: 403 prima dei dati, e il rifiuto è registrato', async () => {
    const target = s.users.segreteria.id;
    const routes: [Method, string, object?][] = [
      ['GET', '/api/studio/utenti/da-confermare'],
      ['POST', `/api/studio/utenti/${target}/conferma`, { richiestaIl: new Date().toISOString() }],
      // Id e corpo non validi: il permesso si controlla prima dei dati.
      ['POST', '/api/studio/utenti/non-un-id/conferma', { qualcosa: true }],
      ['POST', `/api/studio/utenti/${target}/rifiuta`],
    ];
    const denied = async () =>
      (await adminLog()).filter((e) => e.outcome === 'negato' && e.motivo === NOT_CONFIRMER).length;
    const before = await denied();
    for (const who of ['amministratore', 'segreteria', 'sostituto'] as const)
      for (const [method, url, payload] of routes) {
        const r = await req(cookies[who], method, url, payload);
        expect(r.statusCode, `${who} ${method} ${url}`).toBe(403);
        expect(r.json().errore).toBe(NOT_CONFIRMER);
      }
    expect((await denied()) - before).toBe(routes.length * 3);
    expect((await req(undefined, 'GET', '/api/studio/utenti/da-confermare')).statusCode).toBe(401);

    // Il servizio controlla il permesso anche senza la rotta.
    const service = createUserAdminService({ db: t.db, now: s.clock.now });
    for (const u of [s.users.amministratore, s.users.segreteria, s.users.sostituto]) {
      const a = actorOf(u, u.roles);
      await expect(service.pending(a)).rejects.toMatchObject({ statusCode: 403 });
      await expect(
        service.confirm(a, target, { richiestaIl: new Date().toISOString() }),
      ).rejects.toMatchObject({ statusCode: 403, message: NOT_CONFIRMER });
      await expect(service.refuse(a, target)).rejects.toMatchObject({ statusCode: 403 });
    }

    // I titolari leggono l'elenco: per ora nessuno è in attesa.
    expect(await pendingOf(cookies.titolare)).toEqual([]);
    const notWaiting = await req(
      cookies.titolare,
      'POST',
      `/api/studio/utenti/${target}/conferma`,
      {
        richiestaIl: new Date().toISOString(),
      },
    );
    expect(notWaiting.statusCode).toBe(409);
    expect(notWaiting.json().errore).toBe('L’utente non è in attesa di conferma');
  });

  it('chi è in attesa non usa nemmeno una sessione, un passaggio d’accesso o uno sblocco rimasti aperti', async () => {
    // Quando un utente va in attesa le sue sessioni si chiudono; qui la prova le lascia aperte
    // apposta, per vedere che l'accesso le rifiuta comunque.
    const sec = s.users.segreteria;
    expect((await req(cookies.segreteria, 'GET', '/api/io')).statusCode).toBe(200);
    const started = await access(sec.username, PASSWORD);
    expect(started.json().passo).toBe('secondo-fattore');
    const [open] = await t.db
      .select({ id: session.id })
      .from(session)
      .where(and(eq(session.userId, sec.id), isNull(session.revokedAt)));
    await t.db.update(appUser).set({ awaitingConfirmation: true }).where(eq(appUser.id, sec.id));
    try {
      expect((await req(cookies.segreteria, 'GET', '/api/io')).statusCode).toBe(401);
      s.clock.advance(30_000);
      const code = await s.app.inject({
        method: 'POST',
        url: '/api/accesso/codice',
        payload: {
          passaggio: started.json().passaggio,
          codice: totp(secrets.get(sec.username)!, s.clock.now().getTime()),
        },
      });
      expect(code.statusCode).toBe(401);
      expect(code.json().errore).toBe('Passaggio scaduto: ripeti l’accesso');
      // Sessione bloccata per inattività: con il codice giusto non si sblocca.
      await t.db.update(session).set({ lockedAt: s.clock.now() }).where(eq(session.id, open!.id));
      s.clock.advance(30_000);
      const unlock = await s.app.inject({
        method: 'POST',
        url: '/api/accesso/sblocca',
        headers: { cookie: cookies.segreteria },
        payload: { codice: totp(secrets.get(sec.username)!, s.clock.now().getTime()) },
      });
      expect(unlock.statusCode).toBe(401);
    } finally {
      await t.db.update(appUser).set({ awaitingConfirmation: false }).where(eq(appUser.id, sec.id));
      await t.db.update(session).set({ lockedAt: null }).where(eq(session.id, open!.id));
    }
    // Tornata com'era, la sessione di prima vale di nuovo: non era stata chiusa.
    expect((await req(cookies.segreteria, 'GET', '/api/io')).statusCode).toBe(200);
  });

  it('una segreteria creata dall’amministratore resta fuori finché un titolare non la conferma; la password la riceve il titolare', async () => {
    const b = await createUser(cookies.amministratore, {
      nomeUtente: 'nuova.segreteria',
      nome: 'Nuova Segreteria',
      ruoli: ['secretary'],
    });
    const id = b.utente.id;
    // L'amministratore non riceve la password: non può entrare al posto della segreteria.
    expect(b.passwordTemporanea).toBeUndefined();
    expect(b.avvisi[0]).toMatch(/^In attesa della conferma di un medico titolare dello studio/);
    expect(b.avvisi[1]).toMatch(/La password temporanea la riceve il medico titolare/);
    expect(b.utente).toMatchObject({
      inAttesaDiConferma: true,
      richiestaDiConferma: { da: 'Andrea Conti' },
    });
    expect((await adminLog()).at(-1)).toMatchObject({
      azione: 'creazione',
      utente: 'nuova.segreteria',
      attesaConferma: true,
    });

    // Nemmeno con la password giusta (qui la prova la scrive nel database, come se qualcuno la
    // sapesse): il messaggio dell'attesa arriva solo dopo la password giusta.
    const known = 'una password conosciuta da qualcuno';
    await t.db
      .update(appUser)
      .set({ passwordHash: await hashPassword(known) })
      .where(eq(appUser.id, id));
    const waiting = await access('nuova.segreteria', known);
    expect(waiting.statusCode).toBe(401);
    expect(waiting.json().errore).toBe(AWAITING_CONFIRMATION_ERROR);
    const wrong = await access('nuova.segreteria', 'una password sbagliata');
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().errore).toBe(GENERIC_LOGIN_ERROR);
    const failures = await t.db
      .select()
      .from(accessLog)
      .where(and(eq(accessLog.userId, id), eq(accessLog.action, 'accesso_fallito')))
      .orderBy(asc(accessLog.seq));
    expect(failures.map((f) => (f.details as { motivo: string }).motivo)).toEqual([
      'in attesa della conferma di un medico titolare',
      'password errata',
    ]);
    // L'amministratore non le dà una password: la strada è il server.
    const reset = await req(
      cookies.amministratore,
      'POST',
      `/api/studio/utenti/${id}/password-temporanea`,
    );
    expect(reset.statusCode).toBe(403);
    expect(reset.json().errore).toBe(CLINICAL_CREDENTIALS_REFUSAL);

    // I titolari dello studio la vedono, con chi l'ha creata e quando.
    const pending = (await pendingOf(cookies.titolare)).find((x) => x.id === id)!;
    expect(pending).toMatchObject({
      nomeUtente: 'nuova.segreteria',
      nome: 'Nuova Segreteria',
      ruoli: [{ codice: 'secretary', nome: 'Segreteria' }],
      stato: 'attivo',
      richiesta: { da: 'Andrea Conti', il: b.utente.richiestaDiConferma!.il },
      passwordAllaConferma: true,
      medico: null,
    });
    expect((await pendingOf(cookies.collega)).map((x) => x.id)).toContain(id);
    // Una richiesta diversa da quella letta non si conferma; senza la data, dati non validi.
    const stale = await req(cookies.titolare, 'POST', `/api/studio/utenti/${id}/conferma`, {
      richiestaIl: new Date(Date.parse(pending.richiesta.il) - 1000).toISOString(),
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().errore).toMatch(/^La richiesta è cambiata/);
    expect(
      (await req(cookies.titolare, 'POST', `/api/studio/utenti/${id}/conferma`, {})).statusCode,
    ).toBe(400);

    const ok = await req(cookies.titolare, 'POST', `/api/studio/utenti/${id}/conferma`, {
      richiestaIl: pending.richiesta.il,
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const password = ok.json().passwordTemporanea as string;
    expect(password).toMatch(/^[A-Za-z0-9_-]{16}$/);
    passwordsSeen.push(password);
    expect(ok.json().utente).toMatchObject({ inAttesaDiConferma: false, stato: 'attivo' });
    expect(ok.json().avvisi[0]).toMatch(/Consegna di persona la password temporanea/);
    // La password che qualcuno sapeva non vale più; quella del titolare sì, e il secondo fattore
    // si attiva adesso, sul telefono di chi la riceve.
    expect((await access('nuova.segreteria', known)).json().errore).toBe(GENERIC_LOGIN_ERROR);
    expect((await access('nuova.segreteria', password)).json().passo).toBe(
      'attiva-secondo-fattore',
    );
    const cookie = await firstAccess('nuova.segreteria', password, 'la segreteria nuova lavora');
    // In medicina di gruppo (D181): l'archivio della titolare che l'ha confermata, non ancora
    // quello del collega.
    expect(ok.json().avvisi[1]).toBe(SECRETARY_OWN_ARCHIVE_NOTICE);
    const seen = async () =>
      (await req(cookie, 'GET', '/api/pazienti')).json().pazienti as unknown[];
    expect(await seen()).toHaveLength(5);
    const theirs = async () =>
      (await req(cookies.collega, 'GET', '/api/studio/utenti/da-confermare')).json<{
        perArchivio: { id: string; archivio: { nome: string } }[];
        sulMioArchivio: { id: string }[];
      }>();
    expect((await theirs()).perArchivio.find((x) => x.id === id)?.archivio.nome).toBe(
      'Archivio Serra',
    );
    // Il collega la conferma per il suo: da adesso vede anche i suoi pazienti.
    const mine = await req(cookies.collega, 'POST', `/api/studio/utenti/${id}/archivio/conferma`);
    expect(mine.statusCode, mine.body).toBe(200);
    expect(await seen()).toHaveLength(8);
    expect((await theirs()).sulMioArchivio.map((x) => x.id)).toContain(id);
    expect((await adminLog()).at(-1)).toMatchObject({
      userId: s.users.collega.id,
      azione: 'conferma_archivio',
      utente: 'nuova.segreteria',
      archivio: s.archives.collega,
    });
    // Due volte no; e la tolgo: torna a vedere solo l'archivio della titolare.
    expect(
      (await req(cookies.collega, 'POST', `/api/studio/utenti/${id}/archivio/conferma`)).statusCode,
    ).toBe(409);
    const off = await req(cookies.collega, 'POST', `/api/studio/utenti/${id}/archivio/rifiuta`);
    expect(off.statusCode, off.body).toBe(200);
    expect(await seen()).toHaveLength(5);
    // La segreteria non decide per sé, e l'amministratore non decide per i titolari.
    expect(
      (await req(cookie, 'POST', `/api/studio/utenti/${id}/archivio/conferma`)).statusCode,
    ).toBe(403);
    expect(
      (await req(cookies.amministratore, 'POST', `/api/studio/utenti/${id}/archivio/conferma`))
        .statusCode,
    ).toBe(403);
    const back = await req(cookies.collega, 'POST', `/api/studio/utenti/${id}/archivio/conferma`);
    expect(back.statusCode, back.body).toBe(200);
    expect(await seen()).toHaveLength(8);

    // Confermata: non è più nell'elenco, e una seconda conferma non serve.
    expect((await pendingOf(cookies.titolare)).map((x) => x.id)).not.toContain(id);
    const again = await req(cookies.titolare, 'POST', `/api/studio/utenti/${id}/conferma`, {
      richiestaIl: pending.richiesta.il,
    });
    expect(again.statusCode).toBe(409);
    // I due rifiuti della conferma (richiesta cambiata, non più in attesa) sono nel registro.
    expect(
      (await adminLog())
        .filter(
          (e) =>
            e.outcome === 'negato' && e.azione === 'conferma' && e.utente === 'nuova.segreteria',
        )
        .map((e) => [e.userId, e.motivo]),
    ).toEqual([
      [
        s.users.titolare.id,
        'La richiesta è cambiata dopo che l’hai letta: controlla di nuovo i dati dell’utente e conferma',
      ],
      [s.users.titolare.id, 'L’utente non è in attesa di conferma'],
    ]);
    const listed = (await req(cookies.amministratore, 'GET', '/api/studio/utenti'))
      .json()
      .utenti.find((x: { id: string }) => x.id === id);
    expect(listed).toMatchObject({
      inAttesaDiConferma: false,
      richiestaDiConferma: null,
      confermato: { da: 'Dott.ssa Elena Marchi' },
    });
    // Nel registro: chi ha confermato, che cosa, per quale richiesta.
    expect(
      (await adminLog()).find(
        (e) =>
          e.azione === 'conferma' && e.utente === 'nuova.segreteria' && e.outcome === 'riuscito',
      ),
    ).toMatchObject({
      userId: s.users.titolare.id,
      outcome: 'riuscito',
      area: 'utenti',
      utenteId: id,
      ruoliDopo: ['secretary'],
      campi: ['conferma', 'password', 'secondoFattore'],
      richiestaDa: s.users.amministratore.username,
      richiestaIl: pending.richiesta.il,
    });
  });

  it('anche il primo titolare di uno studio vuoto aspetta: lo conferma chi gestisce il servizio, poi lui conferma gli altri', async () => {
    const fresh = await createFirstStudio(t.db, {
      nome: 'Studio nuovo di prova',
      tipo: 'singolo',
      regione: 'piemonte',
      amministratore: 'amministratore.nuovo',
      nomeAmministratore: 'Amministratore Nuovo',
    });
    const adminCookie = await firstAccess(
      'amministratore.nuovo',
      fresh.temporaryPassword,
      'amministrazione dello studio nuovo',
    );
    const first = await createUser(adminCookie, {
      nomeUtente: 'primo.titolare',
      nome: 'Dott.ssa Anna Primi',
      ruoli: ['owner_doctor'],
      medico: { codiceFiscale: cf('Primi', 'Anna', 'F'), nome: 'Anna', cognome: 'Primi' },
    });
    // Nessuna eccezione di avvio: aspetta, e l'amministratore non riceve la sua password.
    expect(first.utente.inAttesaDiConferma).toBe(true);
    expect(first.passwordTemporanea).toBeUndefined();
    expect(first.utente.confermaDalServizio).toBe(true);
    // L'avviso dice i due passi del server, senza la data: la stampa solo il primo.
    expect(first.avvisi).toEqual([
      expect.stringMatching(/^In attesa della conferma di un medico titolare dello studio/),
      expect.stringContaining('lo conferma chi gestisce il servizio, sul server'),
    ]);
    expect(first.avvisi[1]).toContain(
      '(pnpm utente:ripristina -- --utente primo.titolare --mostra)',
    );
    expect(first.avvisi[1]).toContain(
      '(pnpm utente:ripristina -- --utente primo.titolare --conferma --richiesta-il DATA)',
    );
    expect(first.avvisi[1]).not.toContain(first.utente.richiestaDiConferma!.il);
    const ownerId = first.utente.id;
    expect((await userRow(ownerId)).awaitingConfirmation).toBe(true);
    // Nessun titolare può confermarlo dal programma: lo conferma chi gestisce il servizio, con una
    // password nuova che consegna lui; nel registro, senza utente.
    const byServer = await serverConfirm('primo.titolare');
    expect(byServer).toMatchObject({
      actions: ['conferma'],
      status: 'active',
      awaitingConfirmation: false,
    });
    passwordsSeen.push(byServer.temporaryPassword!);
    expect((await adminLog(fresh.studioId)).at(-1)).toMatchObject({
      userId: null,
      outcome: 'riuscito',
      area: 'utenti',
      azione: 'conferma',
      tramite: 'comando del server',
      utente: 'primo.titolare',
      campi: ['conferma', 'password', 'secondoFattore'],
      richiestaDa: 'amministratore.nuovo',
    });
    const ownerCookie = await firstAccess(
      'primo.titolare',
      byServer.temporaryPassword!,
      'il primo titolare entra',
    );
    expect((await req(ownerCookie, 'GET', '/api/io')).json().archivio.nome).toBe(
      'Archivio di Anna Primi',
    );

    // Adesso c'è un titolare attivo: la segreteria aspetta lui.
    const secretary = await createUser(adminCookie, {
      nomeUtente: 'segreteria.nuova',
      nome: 'Segreteria Nuova',
      ruoli: ['secretary'],
    });
    expect(secretary.utente.inAttesaDiConferma).toBe(true);
    expect((await pendingOf(ownerCookie)).map((x) => x.nomeUtente)).toEqual(['segreteria.nuova']);
    // I titolari di un altro studio non la vedono e non la confermano.
    expect((await pendingOf(cookies.titolare)).map((x) => x.nomeUtente)).not.toContain(
      'segreteria.nuova',
    );
    const elsewhere = await req(
      cookies.titolare,
      'POST',
      `/api/studio/utenti/${secretary.utente.id}/conferma`,
      { richiestaIl: secretary.utente.richiestaDiConferma!.il },
    );
    expect(elsewhere.statusCode).toBe(404);

    // Un paziente nell'archivio del titolare: l'amministratore non lo sospende più.
    const [own] = await t.db.select().from(archive).where(eq(archive.ownerUserId, ownerId));
    const [p] = generatePatients({
      seed: `studio-nuovo-${randomBytes(3).toString('hex')}`,
      count: 1,
    });
    await withActor(t.db, ownerId, (tx) =>
      tx.insert(patient).values({
        studioId: fresh.studioId,
        archiveId: own!.id,
        firstName: p!.firstName,
        lastName: p!.lastName,
        sex: p!.sex,
        birthDate: p!.birthDate,
        birthPlaceCode: p!.birthPlace.code,
        birthPlaceName: p!.birthPlace.name,
        fiscalCode: p!.fiscalCode,
        status: p!.status,
      }),
    );
    const suspend = await req(adminCookie, 'POST', `/api/studio/utenti/${ownerId}/sospendi`);
    expect(suspend.statusCode).toBe(409);
    expect(suspend.json().errore).toBe(OWNER_SUSPEND_REFUSAL);
    // Lo sospende chi gestisce il servizio (dopo l'esportazione). Restano pazienti nello studio:
    // un titolare nuovo, ora che non c'è un titolare attivo, aspetta comunque la conferma.
    await restoreUser(t.db, { utente: 'primo.titolare', sospendi: true });
    const second = await createUser(adminCookie, {
      nomeUtente: 'secondo.titolare',
      nome: 'Dott. Bruno Secondi',
      ruoli: ['owner_doctor'],
      medico: { codiceFiscale: cf('Secondi', 'Bruno', 'M'), nome: 'Bruno', cognome: 'Secondi' },
    });
    expect(second.utente.inAttesaDiConferma).toBe(true);
    expect(second.passwordTemporanea).toBeUndefined();
    // Nessun titolare attivo: l'avviso dice la strada del server.
    expect(second.avvisi[1]).toMatch(/--utente secondo\.titolare --conferma/);
    // Il primo titolare torna (comando del server, password nuova) e conferma.
    const back = await restoreUser(t.db, { utente: 'primo.titolare', riattiva: true });
    expect(back.actions).toEqual(['password_temporanea', 'riattivazione']);
    const ownerAgain = await firstAccess(
      'primo.titolare',
      back.temporaryPassword!,
      'il primo titolare rientra',
    );
    expect((await pendingOf(ownerAgain)).map((x) => x.nomeUtente).sort()).toEqual([
      'secondo.titolare',
      'segreteria.nuova',
    ]);
    // Ora un titolare può confermare: il comando del server rifiuta e rimanda al programma.
    await expect(serverConfirm('segreteria.nuova')).rejects.toThrow(
      /la conferma la fa lui, dal programma/,
    );
    expect((await userRow(secretary.utente.id)).awaitingConfirmation).toBe(true);
    const confirmed = await confirm(ownerAgain, second.utente.id);
    expect(confirmed.password).toBeDefined();
    await firstAccess('secondo.titolare', confirmed.password!, 'il secondo titolare entra');
  });

  it('due sospensioni insieme non lasciano lo studio senza un titolare che possa confermare', async () => {
    const fresh = await createFirstStudio(t.db, {
      nome: 'Studio delle richieste insieme',
      tipo: 'gruppo',
      regione: 'piemonte',
      amministratore: 'amministratore.insieme',
      nomeAmministratore: 'Amministratore Insieme',
    });
    passwordsSeen.push(fresh.temporaryPassword);
    const service = createUserAdminService({ db: t.db, now: s.clock.now });
    const a = actorOf({ id: fresh.userId }, ['administrator'], fresh.studioId);
    const body = (n: string, surname: string) => ({
      nomeUtente: `titolare.${n}`,
      nome: `Dott. ${surname}`,
      ruoli: ['owner_doctor'] as Role[],
      medico: { codiceFiscale: cf(surname, 'Carlo', 'M'), nome: 'Carlo', cognome: surname },
    });
    // Due titolari senza pazienti: il primo lo conferma il server, il secondo il primo.
    const one = await service.create(a, body('uno', 'Unici'));
    const two = await service.create(a, body('due', 'Duetti'));
    expect([one, two].map((r) => r.passwordTemporanea)).toEqual([undefined, undefined]);
    passwordsSeen.push((await serverConfirm('titolare.uno')).temporaryPassword!);
    const request = (await userRow(two.utente.id)).confirmationRequestedAt!.toISOString();
    const confirmed = await service.confirm(
      actorOf({ id: one.utente.id }, ['owner_doctor'], fresh.studioId),
      two.utente.id,
      { richiestaIl: request },
    );
    passwordsSeen.push(confirmed.passwordTemporanea!);
    // La prova tiene il blocco con cui il registro mette in fila le sue righe (migrazione 0002):
    // la prima sospensione resta aperta, con lo studio bloccato, finché la seconda non è partita.
    const waiting = async (n: number) => {
      for (let i = 0; i < 400; i++) {
        const { rows } = await t.pool.query<{ n: number }>(
          "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
        );
        if (rows[0]!.n >= n) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error(`Non ci sono ${n} transazioni in attesa di un blocco`);
    };
    const holder = await t.pool.connect();
    let results: PromiseSettledResult<unknown>[];
    try {
      await holder.query('begin');
      await holder.query('select pg_advisory_xact_lock(4620119)');
      const first = service.setStatus(a, one.utente.id, false);
      await waiting(1);
      const second = service.setStatus(a, two.utente.id, false);
      await waiting(2);
      await holder.query('commit');
      results = await Promise.allSettled([first, second]);
    } finally {
      holder.release();
    }
    // Una sola passa: per la seconda il titolare rimasto è l'ultimo attivo e confermato.
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect((results[1] as PromiseRejectedResult).reason).toMatchObject({
      statusCode: 409,
      message: LAST_OWNER_SUSPEND_REFUSAL,
    });
    expect([(await userRow(one.utente.id)).status, (await userRow(two.utente.id)).status]).toEqual([
      'suspended',
      'active',
    ]);
    expect((await adminLog(fresh.studioId)).at(-1)).toMatchObject({
      outcome: 'negato',
      azione: 'sospensione',
      utente: 'titolare.due',
      motivo: LAST_OWNER_SUSPEND_REFUSAL,
    });
  });

  it('un ruolo con i dati dei pazienti aggiunto a un utente esistente lo rimette in attesa', async () => {
    // Un amministratore, con credenziali che l'amministratore può conoscere: alla conferma
    // credenziali nuove, che riceve il titolare.
    const created = await createUser(cookies.amministratore, {
      nomeUtente: 'amministratore.due',
      nome: 'Amministratore Due',
      ruoli: ['administrator'],
    });
    expect(created.utente.inAttesaDiConferma).toBe(false);
    const id = created.utente.id;
    const own = 'la mia password di amministratore';
    const cookie = await firstAccess('amministratore.due', created.passwordTemporanea!, own);
    const add = await req(cookies.amministratore, 'PATCH', `/api/studio/utenti/${id}`, {
      ruoli: ['secretary', 'administrator'],
    });
    expect(add.statusCode, add.body).toBe(200);
    expect(add.json().utente).toMatchObject({
      inAttesaDiConferma: true,
      ruoli: [{ codice: 'secretary' }, { codice: 'administrator' }],
    });
    expect(add.json().avvisi).toEqual([
      expect.stringMatching(/^In attesa della conferma di un medico titolare/),
      'Sessioni aperte chiuse: 1.',
      expect.stringMatching(/riceve una password temporanea nuova/),
    ]);
    expect((await req(cookie, 'GET', '/api/io')).statusCode).toBe(401);
    expect((await access('amministratore.due', own)).json().errore).toBe(
      AWAITING_CONFIRMATION_ERROR,
    );
    expect((await adminLog()).at(-1)).toMatchObject({
      azione: 'modifica',
      utente: 'amministratore.due',
      ruoliPrima: ['administrator'],
      ruoliDopo: ['secretary', 'administrator'],
      attesaConferma: true,
      sessioniChiuse: 1,
    });
    expect((await pendingOf(cookies.titolare)).find((x) => x.id === id)).toMatchObject({
      passwordAllaConferma: true,
    });
    const confirmed = await confirm(cookies.titolare, id);
    expect(confirmed.password).toBeDefined();
    // La password di prima non vale più, e il secondo fattore si attiva di nuovo.
    expect((await access('amministratore.due', own)).json().errore).toBe(GENERIC_LOGIN_ERROR);
    expect((await access('amministratore.due', confirmed.password!)).json().passo).toBe(
      'attiva-secondo-fattore',
    );

    // Una segreteria già confermata, con un ruolo in più: aspetta, poi rientra con le sue.
    const sec = s.users.segreteria;
    const more = await req(cookies.amministratore, 'PATCH', `/api/studio/utenti/${sec.id}`, {
      ruoli: ['secretary', 'substitute_doctor'],
      medico: { codiceFiscale: cf('Bassi', 'Lucia', 'F'), nome: 'Lucia', cognome: 'Bassi' },
    });
    expect(more.statusCode, more.body).toBe(200);
    expect(more.json().avvisi).toEqual([
      expect.stringMatching(/^In attesa della conferma/),
      'Sessioni aperte chiuse: 1.',
      'Dopo la conferma l’utente rientra con la sua password e il suo secondo fattore.',
    ]);
    expect((await req(cookies.segreteria, 'GET', '/api/io')).statusCode).toBe(401);
    expect((await access(sec.username, PASSWORD)).json().errore).toBe(AWAITING_CONFIRMATION_ERROR);
    expect((await pendingOf(cookies.titolare)).find((x) => x.id === sec.id)).toMatchObject({
      passwordAllaConferma: false,
    });
    const back = await confirm(cookies.titolare, sec.id);
    expect(back.password).toBeUndefined();
    expect(back.body.avvisi).toEqual([
      'Utente confermato: entra con la sua password e il suo secondo fattore.',
    ]);
    expect((await access(sec.username, PASSWORD)).json().passo).toBe('secondo-fattore');
    cookies.segreteria = await loginAs(sec.username, PASSWORD);
    expect((await req(cookies.segreteria, 'GET', '/api/pazienti')).statusCode).toBe(200);
    // Togliere il ruolo in più non chiede conferme.
    const less = await req(cookies.amministratore, 'PATCH', `/api/studio/utenti/${sec.id}`, {
      ruoli: ['secretary'],
    });
    expect(less.json().utente.inAttesaDiConferma).toBe(false);
    expect((await req(cookies.segreteria, 'GET', '/api/io')).statusCode).toBe(200);

    // Senza più ruoli con i dati dei pazienti, la richiesta si ritira.
    const withdrawn = await createUser(cookies.amministratore, {
      nomeUtente: 'ritirata.prova',
      nome: 'Richiesta Ritirata',
      ruoli: ['secretary'],
    });
    const w = await req(
      cookies.amministratore,
      'PATCH',
      `/api/studio/utenti/${withdrawn.utente.id}`,
      { ruoli: ['administrator'] },
    );
    expect(w.json().utente.inAttesaDiConferma).toBe(false);
    expect(w.json().avvisi).toContain(
      'Senza ruoli con i dati dei pazienti la conferma non serve più: la richiesta è ritirata.',
    );
    expect((await pendingOf(cookies.titolare)).map((x) => x.id)).not.toContain(withdrawn.utente.id);
  });

  it('titolare con pazienti: l’amministratore non lo sospende, non gli toglie il ruolo, non lo mette in attesa; senza pazienti sì', async () => {
    const doctor = s.users.titolare;
    const suspend = await req(
      cookies.amministratore,
      'POST',
      `/api/studio/utenti/${doctor.id}/sospendi`,
    );
    expect(suspend.statusCode).toBe(409);
    expect(suspend.json().errore).toBe(OWNER_SUSPEND_REFUSAL);
    const remove = await req(cookies.amministratore, 'PATCH', `/api/studio/utenti/${doctor.id}`, {
      ruoli: ['substitute_doctor'],
    });
    expect(remove.statusCode).toBe(409);
    expect(remove.json().errore).toBe(OWNER_ROLE_REMOVAL_REFUSAL);
    // Un ruolo in più lo metterebbe in attesa, fuori dal suo archivio: nemmeno quello.
    const add = await req(cookies.amministratore, 'PATCH', `/api/studio/utenti/${doctor.id}`, {
      ruoli: ['owner_doctor', 'secretary'],
    });
    expect(add.statusCode).toBe(409);
    expect(add.json().errore).toBe(OWNER_ROLE_ADD_REFUSAL);
    const row = await userRow(doctor.id);
    expect(row).toMatchObject({
      roles: ['owner_doctor'],
      status: 'active',
      awaitingConfirmation: false,
    });
    expect((await req(cookies.titolare, 'GET', '/api/io')).statusCode).toBe(200);
    // Gli altri dati si cambiano: ruolo di amministratore in più compreso.
    const admin = await req(cookies.amministratore, 'PATCH', `/api/studio/utenti/${doctor.id}`, {
      ruoli: ['owner_doctor', 'administrator'],
    });
    expect(admin.statusCode, admin.body).toBe(200);
    expect(admin.json().utente.inAttesaDiConferma).toBe(false);
    // Il ruolo di titolare non si toglie nemmeno senza darne altri con i dati dei pazienti.
    const only = await req(cookies.amministratore, 'PATCH', `/api/studio/utenti/${doctor.id}`, {
      ruoli: ['administrator'],
    });
    expect(only.statusCode).toBe(409);
    expect(only.json().errore).toBe(OWNER_ROLE_REMOVAL_REFUSAL);
    await req(cookies.amministratore, 'PATCH', `/api/studio/utenti/${doctor.id}`, {
      ruoli: ['owner_doctor'],
    });
    expect((await userRow(doctor.id)).roles).toEqual(['owner_doctor']);
    const refusals = (await adminLog()).filter(
      (e) => e.outcome === 'negato' && e.utente === doctor.username,
    );
    expect(refusals.map((e) => [e.azione, e.motivo])).toEqual([
      ['sospensione', OWNER_SUSPEND_REFUSAL],
      ['modifica', OWNER_ROLE_REMOVAL_REFUSAL],
      ['modifica', OWNER_ROLE_ADD_REFUSAL],
      ['modifica', OWNER_ROLE_REMOVAL_REFUSAL],
    ]);
    const listed = (await req(cookies.amministratore, 'GET', '/api/studio/utenti')).json().utenti;
    const flag = (id: string) =>
      listed.find((x: { id: string }) => x.id === id).titolareConPazienti as boolean;
    expect([doctor.id, s.users.collega.id, s.users.segreteria.id].map(flag)).toEqual([
      true,
      true,
      false,
    ]);

    // Un titolare senza pazienti: confermato, si sospende, si riattiva, perde il ruolo.
    const empty = await createUser(cookies.amministratore, {
      nomeUtente: 'titolare.vuoto',
      nome: 'Dott.ssa Vera Vuoti',
      ruoli: ['owner_doctor'],
      medico: { codiceFiscale: cf('Vuoti', 'Vera', 'F'), nome: 'Vera', cognome: 'Vuoti' },
    });
    expect(empty.utente.inAttesaDiConferma).toBe(true);
    await confirm(cookies.titolare, empty.utente.id);
    const off = await req(
      cookies.amministratore,
      'POST',
      `/api/studio/utenti/${empty.utente.id}/sospendi`,
    );
    expect(off.statusCode, off.body).toBe(200);
    const on = await req(
      cookies.amministratore,
      'POST',
      `/api/studio/utenti/${empty.utente.id}/riattiva`,
    );
    expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({ utente: { inAttesaDiConferma: false }, avvisi: [] });
    const demoted = await req(
      cookies.amministratore,
      'PATCH',
      `/api/studio/utenti/${empty.utente.id}`,
      { ruoli: ['substitute_doctor'] },
    );
    expect(demoted.statusCode, demoted.body).toBe(200);
    expect(demoted.json().avvisi[0]).toMatch(/resta con tutti i suoi dati/);
  });

  it('l’amministratore non ripristina password e secondo fattore di medici e segreteria, e non li sblocca', async () => {
    for (const u of [s.users.titolare, s.users.sostituto, s.users.segreteria]) {
      const before = await userRow(u.id);
      for (const action of ['password-temporanea', 'azzera-secondo-fattore']) {
        const r = await req(cookies.amministratore, 'POST', `/api/studio/utenti/${u.id}/${action}`);
        expect(r.statusCode, `${action} ${u.username}`).toBe(403);
        expect(r.json().errore).toBe(CLINICAL_CREDENTIALS_REFUSAL);
      }
      const after = await userRow(u.id);
      expect(after.passwordHash).toBe(before.passwordHash);
      expect(after.totpEnabledAt).toEqual(before.totpEnabledAt);
      expect(after.mustChangePassword).toBe(false);
    }
    const listed = (await req(cookies.amministratore, 'GET', '/api/studio/utenti')).json().utenti;
    const restore = (id: string) =>
      listed.find((x: { id: string }) => x.id === id).ripristinoDalServizio as boolean;
    expect(
      [s.users.titolare, s.users.sostituto, s.users.segreteria, s.users.amministratore].map((u) =>
        restore(u.id),
      ),
    ).toEqual([true, true, true, false]);
    // Nemmeno lo sblocco dopo i tentativi falliti: riaprirebbe i tentativi su credenziali che
    // non sono sue. Lo fa chi gestisce il servizio, sul server, o il blocco finisce da solo.
    expect((await access(s.users.sostituto.username, 'sbagliata')).statusCode).toBe(401);
    const unlock = await req(
      cookies.amministratore,
      'POST',
      `/api/studio/utenti/${s.users.sostituto.id}/sblocca`,
    );
    expect(unlock.statusCode).toBe(403);
    expect(unlock.json().errore).toBe(CLINICAL_UNLOCK_REFUSAL);
    expect((await userRow(s.users.sostituto.id)).failedLogins).toBe(1);
    expect((await adminLog()).at(-1)).toMatchObject({
      outcome: 'negato',
      azione: 'sblocco',
      utente: s.users.sostituto.username,
      motivo: CLINICAL_UNLOCK_REFUSAL,
    });
  });

  it('codice fiscale o codice regionale del medico corretti: si chiudono le sessioni dei servizi legate', async () => {
    const doctor = s.users.collega;
    // Il servizio della regione degli studi delle prove (D301).
    const service = regionalCredentials();
    const sessions = () =>
      t.db
        .select({ service: serviceSession.service })
        .from(serviceSession)
        .where(eq(serviceSession.userId, doctor.id));
    expect((await sessions()).map((x) => x.service).sort()).toEqual(
      [service.key, 'sistema_ts'].sort(),
    );
    // Una richiesta di accesso con SPID o CIE ancora aperta: con il codice di prima non vale più.
    const [request] = await t.db
      .insert(regionalAuthorizationRequest)
      .values({
        userId: doctor.id,
        service: service.key,
        stateHash: `impronta-di-prova-${randomBytes(4).toString('hex')}`,
        verifierEnc: Buffer.from('cifrato-di-prova'),
        redirectUri: '/ritorno-di-prova',
        expiresAt: new Date(s.clock.now().getTime() + 600_000),
      })
      .returning();
    const medico = (over: Record<string, string> = {}) => ({
      codiceFiscale: cf('Serra', 'Paolo', 'M', '1971-02-02'),
      nome: 'Paolo',
      cognome: 'Serra',
      codiceRegionale: 'MMG-PROVA-2',
      asl: 'ASL di prova',
      ...over,
    });
    const r = await req(cookies.amministratore, 'PATCH', `/api/studio/utenti/${doctor.id}`, {
      medico: medico(),
    });
    expect(r.statusCode, r.body).toBe(200);
    // La correzione del codice fiscale aspetta il medico (D181): le sessioni restano.
    expect(r.json().avvisi).toEqual([FISCAL_CODE_PENDING_NOTICE]);
    expect((await sessions()).map((x) => x.service).sort()).toEqual(
      [service.key, 'sistema_ts'].sort(),
    );
    expect((await adminLog()).at(-1)).toMatchObject({
      azione: 'modifica',
      utente: doctor.username,
      campi: ['medico.nome', 'medico.cognome', 'medico.codiceFiscale'],
      codiceFiscaleInAttesaDelMedico: true,
    });
    const mine = await req(cookies.collega, 'GET', '/api/profilo/recapiti');
    expect(mine.json().correzioneCodiceFiscale).toMatchObject({ proposto: medico().codiceFiscale });
    expect((await req(cookies.collega, 'GET', '/api/io')).json().codiceFiscaleDaConfermare).toBe(
      true,
    );
    // Il medico la conferma: il codice cambia e le sessioni legate al codice di prima si chiudono.
    const ok = await req(cookies.collega, 'POST', '/api/profilo/codice-fiscale/conferma', {
      proposto: medico().codiceFiscale,
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json().avvisi).toEqual([
      'Codice fiscale aggiornato: da adesso è questo, anche per i servizi.',
      `Codice fiscale del medico cambiato: chiuse le sue sessioni Sistema TS e ${service.name}. Il medico le riattiva da «Credenziali dei servizi».`,
    ]);
    expect(ok.json()).toMatchObject({
      codiceFiscale: medico().codiceFiscale,
      correzioneCodiceFiscale: null,
    });
    expect(await sessions()).toEqual([]);
    const [used] = await t.db
      .select()
      .from(regionalAuthorizationRequest)
      .where(eq(regionalAuthorizationRequest.id, request!.id));
    expect(used!.usedAt).not.toBeNull();
    const events = await t.db
      .select()
      .from(serviceCredentialEvent)
      .where(
        and(
          eq(serviceCredentialEvent.userId, doctor.id),
          eq(serviceCredentialEvent.event, 'sessione_chiusa'),
        ),
      );
    const detail = 'codice fiscale corretto dall’amministratore, confermato dal medico';
    expect(events.map((e) => [e.service, e.detail, e.workstation]).sort()).toEqual(
      [
        [service.key, detail, 'postazione-collega'],
        ['sistema_ts', detail, 'postazione-collega'],
      ].sort(),
    );
    expect((await adminLog()).at(-1)).toMatchObject({
      area: 'profilo',
      azione: 'conferma_codice_fiscale',
      utente: doctor.username,
      campi: ['medico.codiceFiscale'],
      propostaDa: s.users.amministratore.username,
      sessioniServiziChiuse: ['sistema_ts', service.key],
    });
    // Il medico le vede chiuse, e le riattiva lui.
    const status = (await req(cookies.collega, 'GET', '/api/profilo/credenziali')).json();
    expect(status.servizi.map((x: { sessione: { attiva: boolean } }) => x.sessione.attiva)).toEqual(
      [false, false],
    );

    // Solo il codice regionale: si chiude la sessione regionale; quella del Sistema TS resta.
    for (const key of ['sistema_ts', service.key])
      await storeSession(t.db, s.encryptionKey, {
        userId: doctor.id,
        service: key,
        token: `sessione-di-prova-${key}`,
        validUntil: new Date(s.clock.now().getTime() + 3_600_000),
      });
    const regional = await req(cookies.amministratore, 'PATCH', `/api/studio/utenti/${doctor.id}`, {
      medico: medico({ codiceRegionale: 'MMG-PROVA-22' }),
    });
    expect(regional.statusCode, regional.body).toBe(200);
    expect(regional.json().avvisi).toEqual([
      `Codice regionale del medico cambiato: chiusa la sua sessione ${service.name}. Il medico la riattiva da «Credenziali dei servizi».`,
    ]);
    expect((await sessions()).map((x) => x.service)).toEqual(['sistema_ts']);
    // Un altro dato del medico, l'azienda sanitaria, non chiude nulla.
    const asl = await req(cookies.amministratore, 'PATCH', `/api/studio/utenti/${doctor.id}`, {
      medico: medico({ codiceRegionale: 'MMG-PROVA-22', asl: 'ASL di prova due' }),
    });
    expect(asl.json().avvisi).toEqual([]);
    expect((await sessions()).map((x) => x.service)).toEqual(['sistema_ts']);
  });

  it('il comando del server ripristina e registra, senza utente e senza segreti', async () => {
    const target = s.users.sostituto;
    const r = await restoreUser(
      t.db,
      { utente: ` ${target.username.toUpperCase()} `, secondoFattore: true },
      { now: s.clock.now },
    );
    expect(r).toMatchObject({
      username: target.username,
      studioName: 'Studio associato di prova',
      actions: ['password_temporanea', 'azzeramento_secondo_fattore'],
      closedSessions: 1,
      status: 'active',
      awaitingConfirmation: false,
      secondFactorWasInactive: false,
    });
    expect(r.temporaryPassword).toMatch(/^[A-Za-z0-9_-]{16}$/);
    passwordsSeen.push(r.temporaryPassword!);
    expect((await req(cookies.sostituto, 'GET', '/api/io')).statusCode).toBe(401);
    expect((await access(target.username, PASSWORD)).json().errore).toBe(GENERIC_LOGIN_ERROR);
    expect((await access(target.username, r.temporaryPassword!)).json().passo).toBe(
      'attiva-secondo-fattore',
    );
    const rows = (await adminLog()).filter((e) => e.tramite === 'comando del server');
    expect(rows).toEqual([
      {
        userId: null,
        outcome: 'riuscito',
        workstation: null,
        area: 'utenti',
        azione: 'password_temporanea',
        tramite: 'comando del server',
        utente: target.username,
        utenteId: target.id,
        ruoliPrima: ['substitute_doctor'],
        ruoliDopo: ['substitute_doctor'],
        campi: ['password'],
        sessioniChiuse: 1,
      },
      {
        userId: null,
        outcome: 'riuscito',
        workstation: null,
        area: 'utenti',
        azione: 'azzeramento_secondo_fattore',
        tramite: 'comando del server',
        utente: target.username,
        utenteId: target.id,
        ruoliPrima: ['substitute_doctor'],
        ruoliDopo: ['substitute_doctor'],
        campi: ['secondoFattore'],
      },
    ]);

    // Un titolare con pazienti lo sospende chi gestisce il servizio, senza password nuova.
    const doctor = s.users.collega;
    const off = await restoreUser(t.db, { utente: doctor.username, sospendi: true });
    expect(off).toMatchObject({
      actions: ['sospensione'],
      temporaryPassword: null,
      status: 'suspended',
      closedSessions: 1,
    });
    expect((await req(cookies.collega, 'GET', '/api/io')).statusCode).toBe(401);
    await expect(restoreUser(t.db, { utente: doctor.username, sospendi: true })).rejects.toThrow(
      /già sospeso/,
    );
    const on = await restoreUser(t.db, { utente: doctor.username, riattiva: true });
    expect(on).toMatchObject({
      actions: ['password_temporanea', 'riattivazione'],
      status: 'active',
    });
    passwordsSeen.push(on.temporaryPassword!);
    // Secondo fattore non azzerato: resta quello del medico.
    expect((await access(doctor.username, on.temporaryPassword!)).json().passo).toBe(
      'secondo-fattore',
    );
    await expect(restoreUser(t.db, { utente: doctor.username, riattiva: true })).rejects.toThrow(
      /già attivo/,
    );
    await expect(restoreUser(t.db, { utente: 'nessuno.cosi' })).rejects.toThrow(
      'Nessun utente «nessuno.cosi»',
    );
    await expect(
      restoreUser(t.db, { utente: doctor.username, sospendi: true, riattiva: true }),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(restoreUser(t.db, { utente: '' })).rejects.toBeInstanceOf(ZodError);
    // L'unico amministratore attivo di uno studio non si sospende: si ripristina.
    const alone = await createFirstStudio(t.db, {
      nome: 'Studio con un solo amministratore',
      tipo: 'singolo',
      regione: 'piemonte',
      amministratore: 'amministratore.solo',
      nomeAmministratore: 'Amministratore Solo',
    });
    passwordsSeen.push(alone.temporaryPassword);
    await expect(
      restoreUser(t.db, { utente: 'amministratore.solo', sospendi: true }),
    ).rejects.toThrow(/unico amministratore attivo/);
    expect((await userRow(alone.userId)).status).toBe('active');
    // Il secondo fattore non attivo non si azzera: lo si dice.
    const fresh = await restoreUser(t.db, { utente: 'amministratore.solo', secondoFattore: true });
    expect(fresh).toMatchObject({
      actions: ['password_temporanea'],
      secondFactorWasInactive: true,
    });
    passwordsSeen.push(fresh.temporaryPassword!);
    // Chi aspetta la conferma resta in attesa: il comando non la salta.
    const waiting = await createUser(cookies.amministratore, {
      nomeUtente: 'attesa.server',
      nome: 'Attesa Server',
      ruoli: ['secretary'],
    });
    const w = await restoreUser(t.db, { utente: 'attesa.server' });
    passwordsSeen.push(w.temporaryPassword!);
    expect(w.awaitingConfirmation).toBe(true);
    expect((await userRow(waiting.utente.id)).awaitingConfirmation).toBe(true);
    expect((await access('attesa.server', w.temporaryPassword!)).json().errore).toBe(
      AWAITING_CONFIRMATION_ERROR,
    );
    // Rifiutato, poi riattivato dal server: torna da confermare, con una richiesta del server.
    const asked = (await pendingOf(cookies.titolare)).find((x) => x.id === waiting.utente.id)!;
    expect(asked.richiesta.da).toBe('Andrea Conti');
    const no = await req(
      cookies.titolare,
      'POST',
      `/api/studio/utenti/${waiting.utente.id}/rifiuta`,
    );
    expect(no.statusCode, no.body).toBe(200);
    const later = () => new Date(s.clock.now().getTime() + 60_000);
    const back = await restoreUser(
      t.db,
      { utente: 'attesa.server', riattiva: true },
      { now: later },
    );
    passwordsSeen.push(back.temporaryPassword!);
    const again = (await pendingOf(cookies.titolare)).find((x) => x.id === waiting.utente.id)!;
    expect(again.richiesta.da).toBeNull();
    expect(Date.parse(again.richiesta.il)).toBeGreaterThan(Date.parse(asked.richiesta.il));
  });

  it('rifiuto: l’utente resta sospeso e in attesa; se l’amministratore lo riattiva torna da confermare', async () => {
    const b = await createUser(cookies.amministratore, {
      nomeUtente: 'da.rifiutare',
      nome: 'Da Rifiutare',
      ruoli: ['secretary'],
    });
    const id = b.utente.id;
    const refused = await req(cookies.titolare, 'POST', `/api/studio/utenti/${id}/rifiuta`);
    expect(refused.statusCode, refused.body).toBe(200);
    expect(refused.json()).toMatchObject({
      utente: { stato: 'sospeso', inAttesaDiConferma: true },
      avvisi: [expect.stringMatching(/^Utente rifiutato: resta sospeso/)],
    });
    expect((await pendingOf(cookies.titolare)).map((x) => x.id)).not.toContain(id);
    // Anche con la password giusta, per un sospeso il messaggio è quello generico.
    const known = 'la password del rifiutato';
    await t.db
      .update(appUser)
      .set({ passwordHash: await hashPassword(known) })
      .where(eq(appUser.id, id));
    expect((await access('da.rifiutare', known)).json().errore).toBe(GENERIC_LOGIN_ERROR);
    expect(
      (await req(cookies.titolare, 'POST', `/api/studio/utenti/${id}/rifiuta`)).json().errore,
    ).toBe('L’utente è già sospeso');
    const suspendedConfirm = await req(
      cookies.titolare,
      'POST',
      `/api/studio/utenti/${id}/conferma`,
      {
        richiestaIl: b.utente.richiestaDiConferma!.il,
      },
    );
    expect(suspendedConfirm.statusCode).toBe(409);
    expect(suspendedConfirm.json().errore).toMatch(/sospeso: prima lo riattiva l’amministratore/);
    const listed = (await req(cookies.amministratore, 'GET', '/api/studio/utenti'))
      .json()
      .utenti.find((x: { id: string }) => x.id === id);
    expect(listed).toMatchObject({ stato: 'sospeso', inAttesaDiConferma: true });

    // L'amministratore lo riattiva: è una richiesta nuova, che il titolare rivede.
    s.clock.advance(60_000);
    const again = await req(cookies.amministratore, 'POST', `/api/studio/utenti/${id}/riattiva`);
    expect(again.statusCode, again.body).toBe(200);
    expect(again.json().avvisi).toEqual([
      'L’utente resta in attesa della conferma di un medico titolare: la richiesta ha la data di adesso.',
    ]);
    const pending = (await pendingOf(cookies.titolare)).find((x) => x.id === id)!;
    expect(Date.parse(pending.richiesta.il)).toBeGreaterThan(
      Date.parse(b.utente.richiestaDiConferma!.il),
    );
    expect((await access('da.rifiutare', known)).json().errore).toBe(AWAITING_CONFIRMATION_ERROR);
    const done = await confirm(cookies.titolare, id);
    expect(done.password).toBeDefined();
    // Anche i rifiuti 409 della conferma e del rifiuto vanno nel registro, con il motivo.
    const log = (await adminLog()).filter((e) => e.utente === 'da.rifiutare');
    expect(log.map((e) => [e.azione, e.outcome, e.motivo ?? null])).toEqual([
      ['creazione', 'riuscito', null],
      ['rifiuto', 'riuscito', null],
      ['rifiuto', 'negato', 'L’utente è già sospeso'],
      ['conferma', 'negato', 'L’utente è sospeso: prima lo riattiva l’amministratore'],
      ['riattivazione', 'riuscito', null],
      ['conferma', 'riuscito', null],
    ]);
    expect(log.find((e) => e.azione === 'rifiuto')).toMatchObject({
      userId: s.users.titolare.id,
      campi: ['stato'],
      attesaConferma: true,
      richiestaDa: s.users.amministratore.username,
    });
  });

  it('conferma: il titolare deve esserlo adesso, attivo e confermato, anche senza la rotta', async () => {
    const service = createUserAdminService({ db: t.db, now: s.clock.now });
    const owner = await createUser(cookies.amministratore, {
      nomeUtente: 'titolare.in.attesa',
      nome: 'Dott. Ugo Attesi',
      ruoli: ['owner_doctor'],
      medico: { codiceFiscale: cf('Attesi', 'Ugo', 'M'), nome: 'Ugo', cognome: 'Attesi' },
    });
    const other = await createUser(cookies.amministratore, {
      nomeUtente: 'per.la.prova',
      nome: 'Per La Prova',
      ruoli: ['secretary'],
    });
    const body = { richiestaIl: other.utente.richiestaDiConferma!.il };
    // Un titolare in attesa non conferma (non entra; e il servizio lo controlla comunque).
    await expect(
      service.confirm(actorOf({ id: owner.utente.id }, ['owner_doctor']), other.utente.id, body),
    ).rejects.toMatchObject({ statusCode: 403, message: NOT_CONFIRMER });
    // Né chi nella sessione ha ancora il ruolo di titolare, ma nel frattempo l'ha perso.
    await expect(
      service.refuse(actorOf(s.users.sostituto, ['owner_doctor']), other.utente.id),
    ).rejects.toMatchObject({ statusCode: 403, message: NOT_CONFIRMER });
    expect((await userRow(other.utente.id)).awaitingConfirmation).toBe(true);
    expect((await userRow(other.utente.id)).status).toBe('active');
    expect(
      (await adminLog()).filter(
        (e) => e.outcome === 'negato' && e.utente === 'per.la.prova' && e.motivo === NOT_CONFIRMER,
      ),
    ).toHaveLength(2);
  });

  it('nessuna password, impronta o segreto nel registro e negli eventi delle credenziali', async () => {
    const rows = await t.db.select().from(accessLog);
    const events = await t.db.select().from(serviceCredentialEvent);
    const text = JSON.stringify([rows.map((r) => r.details), events.map((e) => e.detail)]);
    expect(passwordsSeen.length).toBeGreaterThan(15);
    for (const p of passwordsSeen) expect(text).not.toContain(p);
    expect(text).not.toMatch(/scrypt\$|totp|sessione-di-prova/i);
  });
});
