import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildFiscalCode } from '@mmg/domain';
import { generatePatients } from '@mmg/fixtures';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  CLINICAL_CREDENTIALS_REFUSAL,
  CLINICAL_UNLOCK_REFUSAL,
  LAST_OWNER_ROLE_ADD_REFUSAL,
  LAST_OWNER_ROLE_REMOVAL_REFUSAL,
  LAST_OWNER_SUSPEND_REFUSAL,
  NOT_CONFIRMER,
  OWNER_REACTIVATE_REFUSAL,
  OWNER_ROLE_REMOVAL_REFUSAL,
  OWNER_SUSPEND_REFUSAL,
  serviceSuspendedRefusal,
  USER_ACTIONS,
} from '../src/admin/user-service';
import { ACTION_LABELS, AREA_LABELS, describeAdminEntry } from '../src/admin/archive-service';
import {
  AWAITING_CONFIRMATION_ERROR,
  createAuthService,
  EXPIRED_CHALLENGE_ERROR,
  FAILED_LOGIN_LOCK_MAX_MINUTES,
  GENERIC_LOGIN_ERROR,
  LOCKED_LOGIN_ERROR,
  TOO_MANY_CODES_ERROR,
  type Actor,
  type SessionResult,
} from '../src/auth/service';
import { createCredentialService, storeSession } from '../src/credentials/service';
import { createFirstStudio } from '../src/db/first-studio';
import {
  accessLog,
  appUser,
  archive,
  authChallenge,
  doctorProfile,
  patient,
  serviceCredentialEvent,
  serviceSession,
  session,
  studio,
} from '../src/db/schema';
import { withActor } from '../src/db/tx';
import {
  RESTORE_LOG_ACTIONS,
  restoreUser,
  showRequest,
  STALE_SERVER_REQUEST,
} from '../src/db/user-restore';
import { base32Decode } from '../src/security/base32';
import { hashPassword } from '../src/security/password';
import { CONTROL_CHARACTERS_MESSAGE } from '../src/security/plain-text';
import { hashToken, newToken } from '../src/security/secrets';
import { totp } from '../src/security/totp';
import { createScenario, login, PASSWORD, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

/** Codice fiscale inventato: luogo di nascita con la X, che nessun comune ha (D12). */
const cf = (surname: string, name: string, sex: 'M' | 'F', birthDate = '1975-05-05') =>
  buildFiscalCode({ surname, name, birthDate, sex, placeCode: 'X001' });

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT';

/**
 * Revisione avversaria dei poteri dell'amministratore (tappa 14): gli attacchi della revisione
 * (A1–A7), rifatti sul codice corretto, devono fallire; con le prove dei controlli nuovi (blocco
 * e secondo fattore, consumo del passaggio, registro, sessioni dei servizi, comando del server).
 * Utenti e pazienti inventati.
 */
describe('poteri dell’amministratore: gli attacchi della revisione falliscono (tappa 14)', () => {
  let t: TestDatabase;
  let s: Scenario;
  const cookies = {} as Record<'amministratore' | 'titolare', string>;
  /** Segreti del secondo fattore per nome utente, per gli accessi delle prove. */
  const secrets = new Map<string, Buffer>();
  /** Ogni password vista nelle prove: nessuna deve finire nel registro. */
  const passwordsSeen: string[] = [PASSWORD];
  const sfx = randomBytes(2).toString('hex');

  beforeAll(async () => {
    t = await createTestDatabase();
    // Le attese per provenienza (D188) sono spente: qui si guardano il conto e i poteri, con
    // tutte le richieste dallo stesso indirizzo; le attese hanno le loro prove.
    s = await createScenario(t.db, { idleLockMinutes: null }, { loginSources: null });
    cookies.amministratore = await login(s, 'amministratore');
    cookies.titolare = await login(s, 'titolare');
    await login(s, 'collega');
    for (const u of Object.values(s.users)) {
      const secret = s.secrets.get(u.id);
      if (secret) secrets.set(u.username, secret);
    }
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const req = (cookie: string | undefined, method: Method, url: string, payload?: object) =>
    s.app.inject({ method, url, headers: cookie ? { cookie } : {}, payload });
  const access = (username: string, password: string, postazione = 'postazione-prova') =>
    s.app.inject({
      method: 'POST',
      url: '/api/accesso',
      payload: { username, password, postazione },
    });
  const codeOn = (passaggio: string, codice: string) =>
    s.app.inject({ method: 'POST', url: '/api/accesso/codice', payload: { passaggio, codice } });
  const codeNow = (username: string) => {
    s.clock.advance(30_000);
    return totp(secrets.get(username)!, s.clock.now().getTime());
  };

  async function loginAs(username: string, password: string): Promise<string> {
    const res = await access(username, password);
    if (res.statusCode !== 200) throw new Error(`Accesso di ${username} fallito: ${res.body}`);
    const body = res.json<{ passaggio: string; segreto?: string }>();
    if (body.segreto) secrets.set(username, base32Decode(body.segreto));
    const done = await codeOn(body.passaggio, codeNow(username));
    if (done.statusCode !== 200) throw new Error(`Codice di ${username} rifiutato: ${done.body}`);
    return `sessione=${done.cookies.find((c) => c.name === 'sessione')!.value}`;
  }

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
        inAttesaDiConferma: boolean;
        richiestaDiConferma: { il: string } | null;
        confermaDalServizio: boolean;
      };
      passwordTemporanea?: string;
      avvisi: string[];
    };
  }

  const pendingOf = async (cookie: string) => {
    const r = await req(cookie, 'GET', '/api/studio/utenti/da-confermare');
    expect(r.statusCode, r.body).toBe(200);
    return r.json().utenti as { id: string; nomeUtente: string; richiesta: { il: string } }[];
  };

  async function confirm(cookie: string, id: string) {
    const pending = (await pendingOf(cookie)).find((x) => x.id === id)!;
    const r = await req(cookie, 'POST', `/api/studio/utenti/${id}/conferma`, {
      richiestaIl: pending.richiesta.il,
    });
    expect(r.statusCode, r.body).toBe(200);
    const password = r.json().passwordTemporanea as string | undefined;
    if (password) passwordsSeen.push(password);
    return password;
  }

  const userRow = async (id: string) =>
    (await t.db.select().from(appUser).where(eq(appUser.id, id)))[0]!;

  const challengeOf = async (token: string) =>
    (
      await t.db
        .select()
        .from(authChallenge)
        .where(eq(authChallenge.tokenHash, hashToken(token)))
    )[0]!;

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

  const setStudio = (values: Partial<typeof studio.$inferInsert>) =>
    t.db.update(studio).set(values).where(eq(studio.id, s.studioId));

  /** Attende che `n` transazioni del database di prova aspettino un blocco. */
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

  /**
   * Conferma dal server in due passi, come chi gestisce il servizio: legge la richiesta (`--mostra`)
   * e conferma quella, con la sua data (`--conferma --richiesta-il`).
   */
  async function serverConfirm(username: string, extra: { riattiva?: boolean } = {}) {
    const shown = await showRequest(t.db, { utente: username });
    return restoreUser(
      t.db,
      { utente: username, conferma: true, richiestaIl: shown.requestedAt!, ...extra },
      { now: s.clock.now },
    );
  }

  /**
   * Il comando del server come lo lancia chi gestisce il servizio, dalla radice del repository
   * (`pnpm utente:ripristina -- …`), sul database di prova: uscita, testo e errori.
   */
  const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
  const runCli = (args: string[]) =>
    new Promise<{ code: number; out: string; err: string }>((resolve) => {
      execFile(
        'pnpm',
        ['utente:ripristina', '--', ...args],
        {
          cwd: ROOT,
          encoding: 'utf8',
          env: {
            ...process.env,
            DATABASE_URL: t.url,
            APP_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
          },
        },
        (error, stdout, stderr) =>
          resolve({
            code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
            out: stdout,
            err: stderr,
          }),
      );
    });

  /** Servizio d'accesso sullo stesso database e con la stessa chiave del servizio delle prove. */
  const authService = () =>
    createAuthService({
      db: t.db,
      encryptionKey: s.encryptionKey,
      sessionMaxHours: 12,
      issuer: 'emittente-di-prova',
      now: s.clock.now,
    });

  async function freshStudio(tag: string) {
    const fresh = await createFirstStudio(t.db, {
      nome: `Studio ${tag}`,
      tipo: 'gruppo',
      regione: 'piemonte',
      amministratore: `adm.${tag}.${sfx}`,
      nomeAmministratore: `Amministratore ${tag}`,
    });
    const adminCookie = await firstAccess(
      `adm.${tag}.${sfx}`,
      fresh.temporaryPassword,
      `amministrazione dello studio ${tag}`,
    );
    return { fresh, adminCookie };
  }

  /** Un titolare nuovo dello studio dello scenario, confermato dalla titolare: senza pazienti. */
  async function confirmedOwner(tag: string, surname: string) {
    const u = await createUser(cookies.amministratore, {
      nomeUtente: `${tag}.${sfx}`,
      nome: `Dott. ${surname}`,
      ruoli: ['owner_doctor'],
      medico: { codiceFiscale: cf(surname, 'Carlo', 'M'), nome: 'Carlo', cognome: surname },
    });
    await confirm(cookies.titolare, u.utente.id);
    return u.utente.id;
  }

  /** Il primo paziente entra nell'archivio del titolare, in una transazione che resta aperta. */
  async function holdFirstPatient(ownerId: string) {
    const [own] = await t.db.select().from(archive).where(eq(archive.ownerUserId, ownerId));
    const [p] = generatePatients({ seed: `poteri-${randomBytes(3).toString('hex')}`, count: 1 });
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let inserted!: () => void;
    const insertedP = new Promise<void>((r) => (inserted = r));
    const writing = withActor(t.db, ownerId, async (tx) => {
      await tx.insert(patient).values({
        studioId: own!.studioId,
        archiveId: own!.id,
        firstName: p!.firstName,
        lastName: p!.lastName,
        sex: p!.sex,
        birthDate: p!.birthDate,
        birthPlaceCode: p!.birthPlace.code,
        birthPlaceName: p!.birthPlace.name,
        fiscalCode: p!.fiscalCode,
        status: p!.status,
      });
      inserted();
      await hold;
    });
    await insertedP;
    return { release, writing };
  }

  it('A1: niente eccezione di avvio: il «primo titolare» che è anche segreteria aspetta, e l’amministratore non ne riceve la password', async () => {
    const { fresh, adminCookie } = await freshStudio('a1');
    const fake = await createUser(adminCookie, {
      nomeUtente: `finto.a1.${sfx}`,
      nome: 'Dott. Finto Primo',
      ruoli: ['owner_doctor', 'secretary'],
      medico: { codiceFiscale: cf('Finto', 'Mario', 'M'), nome: 'Mario', cognome: 'Finto' },
    });
    expect(fake.utente).toMatchObject({ inAttesaDiConferma: true, confermaDalServizio: true });
    expect(fake.passwordTemporanea).toBeUndefined();
    expect(fake.avvisi[1]).toContain(`--utente finto.a1.${sfx} --conferma`);
    const id = fake.utente.id;
    // Dal programma l'amministratore non lo fa entrare: non conferma, non dà password, non azzera
    // il secondo fattore, non sblocca.
    const asAdmin = await req(adminCookie, 'POST', `/api/studio/utenti/${id}/conferma`, {
      richiestaIl: fake.utente.richiestaDiConferma!.il,
    });
    expect(asAdmin.statusCode).toBe(403);
    expect(asAdmin.json().errore).toBe(NOT_CONFIRMER);
    for (const action of ['password-temporanea', 'azzera-secondo-fattore']) {
      const r = await req(adminCookie, 'POST', `/api/studio/utenti/${id}/${action}`);
      expect(r.statusCode, action).toBe(403);
      expect(r.json().errore).toBe(CLINICAL_CREDENTIALS_REFUSAL);
    }
    const unlock = await req(adminCookie, 'POST', `/api/studio/utenti/${id}/sblocca`);
    expect(unlock.statusCode).toBe(403);
    expect(unlock.json().errore).toBe(CLINICAL_UNLOCK_REFUSAL);
    // Nemmeno con una password nota (la prova la scrive nel database).
    const known = 'una password nota all amministratore';
    await t.db
      .update(appUser)
      .set({ passwordHash: await hashPassword(known) })
      .where(eq(appUser.id, id));
    expect((await access(`finto.a1.${sfx}`, known)).json().errore).toBe(
      AWAITING_CONFIRMATION_ERROR,
    );

    // Lo stesso con i ruoli dati dopo: un amministratore di cui l'amministratore conosce la
    // password riceve titolare e segreteria. Aspetta, e quella password non lo fa entrare.
    const mine = await createUser(adminCookie, {
      nomeUtente: `amm.a1.${sfx}`,
      nome: 'Amministratore Due',
      ruoli: ['administrator'],
    });
    const chosen = 'la password del secondo amministratore';
    await firstAccess(`amm.a1.${sfx}`, mine.passwordTemporanea!, chosen);
    const more = await req(adminCookie, 'PATCH', `/api/studio/utenti/${mine.utente.id}`, {
      ruoli: ['owner_doctor', 'secretary', 'administrator'],
      medico: { codiceFiscale: cf('Mio', 'Luigi', 'M'), nome: 'Luigi', cognome: 'Mio' },
    });
    expect(more.statusCode, more.body).toBe(200);
    expect(more.json().utente).toMatchObject({
      inAttesaDiConferma: true,
      confermaDalServizio: true,
    });
    expect(more.json().avvisi.at(-1)).toContain(`--utente amm.a1.${sfx} --conferma`);
    expect((await access(`amm.a1.${sfx}`, chosen)).json().errore).toBe(AWAITING_CONFIRMATION_ERROR);
    // Lo conferma chi gestisce il servizio, con credenziali nuove che consegna lui.
    const done = await serverConfirm(`amm.a1.${sfx}`);
    passwordsSeen.push(done.temporaryPassword!);
    expect((await access(`amm.a1.${sfx}`, chosen)).json().errore).toBe(GENERIC_LOGIN_ERROR);
    expect((await access(`amm.a1.${sfx}`, done.temporaryPassword!)).json().passo).toBe(
      'attiva-secondo-fattore',
    );
    expect((await adminLog(fresh.studioId)).at(-1)).toMatchObject({
      userId: null,
      azione: 'conferma',
      tramite: 'comando del server',
      utente: `amm.a1.${sfx}`,
    });
    // Adesso un titolare può confermare: il server non lo fa più al suo posto.
    await expect(serverConfirm(`finto.a1.${sfx}`)).rejects.toThrow(
      /la conferma la fa lui, dal programma/,
    );
    expect((await userRow(id)).awaitingConfirmation).toBe(true);
  });

  it('A2: l’ultimo titolare non si sospende e non perde il ruolo dal programma: nessun «primo titolare» di riserva', async () => {
    const { fresh, adminCookie } = await freshStudio('a2');
    const real = await createUser(adminCookie, {
      nomeUtente: `vera.a2.${sfx}`,
      nome: 'Dott.ssa Vera Seconda',
      ruoli: ['owner_doctor'],
      medico: { codiceFiscale: cf('Seconda', 'Vera', 'F'), nome: 'Vera', cognome: 'Seconda' },
    });
    expect(real.utente.inAttesaDiConferma).toBe(true);
    expect(real.passwordTemporanea).toBeUndefined();
    const byServer = await serverConfirm(`vera.a2.${sfx}`);
    const realCookie = await firstAccess(
      `vera.a2.${sfx}`,
      byServer.temporaryPassword!,
      'la password scelta dalla titolare',
    );
    const id = real.utente.id;
    // Nessun paziente, ma è l'ultima titolare attiva e confermata: niente sospensione, niente
    // ruolo tolto, niente ruolo in più che la metterebbe in attesa.
    const susp = await req(adminCookie, 'POST', `/api/studio/utenti/${id}/sospendi`);
    expect(susp.statusCode).toBe(409);
    expect(susp.json().errore).toBe(LAST_OWNER_SUSPEND_REFUSAL);
    const demote = await req(adminCookie, 'PATCH', `/api/studio/utenti/${id}`, {
      ruoli: ['substitute_doctor'],
    });
    expect(demote.statusCode).toBe(409);
    expect(demote.json().errore).toBe(LAST_OWNER_ROLE_REMOVAL_REFUSAL);
    const more = await req(adminCookie, 'PATCH', `/api/studio/utenti/${id}`, {
      ruoli: ['owner_doctor', 'secretary'],
    });
    expect(more.statusCode).toBe(409);
    expect(more.json().errore).toBe(LAST_OWNER_ROLE_ADD_REFUSAL);
    expect(await userRow(id)).toMatchObject({
      status: 'active',
      roles: ['owner_doctor'],
      awaitingConfirmation: false,
    });
    expect((await req(realCookie, 'GET', '/api/io')).statusCode).toBe(200);
    expect(
      (await adminLog(fresh.studioId))
        .filter((e) => e.outcome === 'negato' && e.utente === `vera.a2.${sfx}`)
        .map((e) => [e.azione, e.motivo]),
    ).toEqual([
      ['sospensione', LAST_OWNER_SUSPEND_REFUSAL],
      ['modifica', LAST_OWNER_ROLE_REMOVAL_REFUSAL],
      ['modifica', LAST_OWNER_ROLE_ADD_REFUSAL],
    ]);
    const listed = (await req(adminCookie, 'GET', '/api/studio/utenti'))
      .json()
      .utenti.find((x: { id: string }) => x.id === id);
    expect(listed).toMatchObject({ ultimoTitolare: true, titolareConPazienti: false });

    // Un titolare nuovo voluto dall'amministratore aspetta lei, che lo vede nel suo elenco; il
    // server non lo conferma al suo posto.
    const fake = await createUser(adminCookie, {
      nomeUtente: `finto.a2.${sfx}`,
      nome: 'Dott. Finto Secondo',
      ruoli: ['owner_doctor'],
      medico: { codiceFiscale: cf('Finto', 'Luca', 'M'), nome: 'Luca', cognome: 'Finto' },
    });
    expect(fake.utente).toMatchObject({ inAttesaDiConferma: true, confermaDalServizio: false });
    expect(fake.passwordTemporanea).toBeUndefined();
    expect(fake.avvisi[1]).toMatch(/La password temporanea la riceve il medico titolare/);
    expect((await pendingOf(realCookie)).map((x) => x.id)).toContain(fake.utente.id);
    await expect(serverConfirm(`finto.a2.${sfx}`)).rejects.toThrow(
      /la conferma la fa lui, dal programma/,
    );
    expect((await userRow(fake.utente.id)).awaitingConfirmation).toBe(true);
  });

  it('A3: il blocco per tentativi dura al massimo un’ora, e i tentativi falliti portano l’indirizzo della richiesta', async () => {
    for (const minutiBlocco of [1440, 61]) {
      const r = await req(cookies.amministratore, 'PUT', '/api/studio', {
        sicurezza: { minutiInattivita: 30, tentativiFalliti: 50, codiciSbagliati: 3, minutiBlocco },
      });
      expect(r.statusCode, `${minutiBlocco}`).toBe(400);
      expect(r.json().dettagli.problemi).toEqual([
        'Durata del blocco: un numero intero da 5 a 60 minuti',
      ]);
    }
    const victim = s.users.titolare;
    try {
      // Anche un valore salvato prima del limite (la prova lo scrive nel database) vale un'ora.
      await setStudio({ maxFailedLogins: 3, failedLoginLockMinutes: 1440 });
      for (let i = 0; i < 3; i++)
        expect(
          (await access(victim.username, 'una password a caso', 'postazione-inventata')).statusCode,
        ).toBe(401);
      const locked = await userRow(victim.id);
      expect(locked.lockedUntil!.getTime() - s.clock.now().getTime()).toBe(
        FAILED_LOGIN_LOCK_MAX_MINUTES * 60_000,
      );
      expect((await access(victim.username, PASSWORD)).json().errore).toBe(LOCKED_LOGIN_ERROR);
      s.clock.advance(FAILED_LOGIN_LOCK_MAX_MINUTES * 60_000 + 1000);
      expect((await access(victim.username, PASSWORD)).json().passo).toBe('secondo-fattore');
      // Nel registro: la postazione scritta da chi tenta e l'indirizzo della richiesta.
      const failures = await t.db
        .select()
        .from(accessLog)
        .where(and(eq(accessLog.userId, victim.id), eq(accessLog.action, 'accesso_fallito')))
        .orderBy(asc(accessLog.seq));
      expect(
        failures.map((f) => {
          const d = f.details as { motivo: string; indirizzo: string };
          return [f.workstation, d.motivo, d.indirizzo];
        }),
      ).toEqual([
        ['postazione-inventata', 'password errata', '127.0.0.1'],
        ['postazione-inventata', 'password errata', '127.0.0.1'],
        ['postazione-inventata', 'password errata', '127.0.0.1'],
        ['postazione-prova', 'utente bloccato per troppi tentativi', '127.0.0.1'],
      ]);
    } finally {
      await setStudio({ maxFailedLogins: 50, maxFailedCodes: 5, failedLoginLockMinutes: 15 });
    }
  });

  it('A4: la sospensione aspetta il primo paziente che sta entrando nell’archivio, e rifiuta', async () => {
    const id = await confirmedOwner('quarto', 'Quarti');
    const { release, writing } = await holdFirstPatient(id);
    setTimeout(release, 700);
    const started = Date.now();
    const susp = await req(cookies.amministratore, 'POST', `/api/studio/utenti/${id}/sospendi`);
    await writing;
    expect(Date.now() - started).toBeGreaterThanOrEqual(600);
    expect(susp.statusCode, susp.body).toBe(409);
    expect(susp.json().errore).toBe(OWNER_SUSPEND_REFUSAL);
    expect((await userRow(id)).status).toBe('active');
  });

  it('A4 bis: lo stesso quando l’amministratore toglie il ruolo di titolare', async () => {
    const id = await confirmedOwner('quinto', 'Quinti');
    const { release, writing } = await holdFirstPatient(id);
    setTimeout(release, 700);
    const started = Date.now();
    const demote = await req(cookies.amministratore, 'PATCH', `/api/studio/utenti/${id}`, {
      ruoli: ['substitute_doctor'],
    });
    await writing;
    expect(Date.now() - started).toBeGreaterThanOrEqual(600);
    expect(demote.statusCode, demote.body).toBe(409);
    expect(demote.json().errore).toBe(OWNER_ROLE_REMOVAL_REFUSAL);
    expect((await userRow(id)).roles).toEqual(['owner_doctor']);
  });

  it('A5: bloccato, nessun codice vale, nemmeno sul passaggio già aperto; il passaggio si chiude dopo i codici sbagliati; l’amministratore non sblocca un titolare', async () => {
    const victim = s.users.collega;
    try {
      await setStudio({ maxFailedLogins: 3, failedLoginLockMinutes: 15 });
      // Passaggio aperto con la password giusta; poi tre password sbagliate bloccano l'utente.
      const open = (await access(victim.username, PASSWORD)).json().passaggio as string;
      for (let i = 0; i < 3; i++) await access(victim.username, `tentativo ${i} sbagliato`);
      expect((await access(victim.username, PASSWORD)).json().errore).toBe(LOCKED_LOGIN_ERROR);
      // Sul passaggio aperto nessun codice vale, e il passaggio si chiude.
      const wrong = await codeOn(open, '000000');
      expect(wrong.statusCode).toBe(401);
      expect(wrong.json().errore).toBe(LOCKED_LOGIN_ERROR);
      expect((await challengeOf(open)).usedAt).not.toBeNull();
      const right = await codeOn(open, codeNow(victim.username));
      expect(right.statusCode).toBe(401);
      expect((await userRow(victim.id)).lockedUntil!.getTime()).toBeGreaterThan(
        s.clock.now().getTime(),
      );
      // L'amministratore non toglie il blocco di un medico: lo fa chi gestisce il servizio.
      const un = await req(
        cookies.amministratore,
        'POST',
        `/api/studio/utenti/${victim.id}/sblocca`,
      );
      expect(un.statusCode).toBe(403);
      expect(un.json().errore).toBe(CLINICAL_UNLOCK_REFUSAL);
      const byServer = await restoreUser(
        t.db,
        { utente: victim.username, sblocca: true },
        { now: s.clock.now },
      );
      expect(byServer).toMatchObject({ actions: ['sblocco'], temporaryPassword: null });

      // Senza il blocco dell'utente, il passaggio si chiude da sé dopo i tentativi dello studio:
      // il codice giusto, dopo, non entra.
      await setStudio({ maxFailedLogins: 3, maxFailedCodes: 3, failedLoginLockMinutes: null });
      const second = (await access(victim.username, PASSWORD)).json().passaggio as string;
      expect((await codeOn(second, '000000')).json().errore).toBe('Codice non valido');
      expect((await codeOn(second, '111111')).json().errore).toBe('Codice non valido');
      expect((await codeOn(second, '222222')).json().errore).toBe(TOO_MANY_CODES_ERROR);
      expect((await codeOn(second, codeNow(victim.username))).json().errore).toBe(
        EXPIRED_CHALLENGE_ERROR,
      );
      expect((await challengeOf(second)).triedCodes).toBe(3);
      // Senza soglie dello studio vale il valore per difetto: cinque codici.
      await setStudio({
        maxFailedLogins: null,
        maxFailedCodes: null,
        failedLoginLockMinutes: null,
      });
      const third = (await access(victim.username, PASSWORD)).json().passaggio as string;
      for (const c of ['000000', '111111', '222222', '333333'])
        expect((await codeOn(third, c)).json().errore).toBe('Codice non valido');
      expect((await codeOn(third, '444444')).json().errore).toBe(TOO_MANY_CODES_ERROR);
      // Ogni codice sbagliato porta l'indirizzo della richiesta.
      const failed = await t.db
        .select()
        .from(accessLog)
        .where(
          and(eq(accessLog.userId, victim.id), eq(accessLog.action, 'secondo_fattore_fallito')),
        );
      expect(failed.length).toBe(9);
      expect(failed.map((f) => (f.details as { indirizzo?: unknown }).indirizzo)).toEqual(
        Array(9).fill('127.0.0.1'),
      );
      // Su un passaggio nuovo il codice giusto entra.
      const fourth = (await access(victim.username, PASSWORD)).json().passaggio as string;
      expect((await codeOn(fourth, codeNow(victim.username))).statusCode).toBe(200);
    } finally {
      await setStudio({ maxFailedLogins: 50, maxFailedCodes: 5, failedLoginLockMinutes: 15 });
    }
  });

  it('A6: togliere e rimettere la segreteria non lascia all’amministratore credenziali che valgono (coperto)', async () => {
    const created = await createUser(cookies.amministratore, {
      nomeUtente: `segr.a6.${sfx}`,
      nome: 'Segreteria Sei',
      ruoli: ['secretary'],
    });
    const p1 = await confirm(cookies.titolare, created.utente.id);
    await firstAccess(`segr.a6.${sfx}`, p1!, 'la segreteria sei lavora');
    const id = created.utente.id;
    // Via il ruolo clinico: ora l'amministratore può darle una password e azzerare il fattore.
    const off = await req(cookies.amministratore, 'PATCH', `/api/studio/utenti/${id}`, {
      ruoli: ['administrator'],
    });
    expect(off.statusCode).toBe(200);
    const reset = await req(
      cookies.amministratore,
      'POST',
      `/api/studio/utenti/${id}/password-temporanea`,
    );
    expect(reset.statusCode, reset.body).toBe(200);
    const known = reset.json().passwordTemporanea as string;
    const adminAsHer = await firstAccess(
      `segr.a6.${sfx}`,
      known,
      'password nota all amministratore',
    );
    // Il ruolo torna: in attesa, e alla conferma credenziali nuove al titolare.
    const back = await req(cookies.amministratore, 'PATCH', `/api/studio/utenti/${id}`, {
      ruoli: ['secretary'],
    });
    expect(back.json().utente.inAttesaDiConferma).toBe(true);
    expect((await req(adminAsHer, 'GET', '/api/io')).statusCode).toBe(401);
    const p2 = await confirm(cookies.titolare, id);
    expect(p2).toBeDefined();
    expect((await access(`segr.a6.${sfx}`, 'password nota all amministratore')).statusCode).toBe(
      401,
    );
  });

  it('C: il passaggio si consuma una volta sola, anche con due codici giusti insieme', async () => {
    const auth = authService();
    const u = await createUser(cookies.amministratore, {
      nomeUtente: `amm.c.${sfx}`,
      nome: 'Amministratore del Passaggio',
      ruoli: ['administrator'],
    });
    const start = await access(`amm.c.${sfx}`, u.passwordTemporanea!);
    expect(start.json().passo).toBe('attiva-secondo-fattore');
    secrets.set(`amm.c.${sfx}`, base32Decode(start.json().segreto));
    const input = {
      challengeToken: start.json().passaggio as string,
      code: codeNow(`amm.c.${sfx}`),
    };
    // La prima richiesta resta ferma sul blocco del registro, dentro la sua transazione; la
    // seconda parte intanto e aspetta l'utente bloccato dalla prima.
    const holder = await t.pool.connect();
    let results: SessionResult[];
    try {
      await holder.query('begin');
      await holder.query('select pg_advisory_xact_lock(4620119)');
      const first = auth.verifySecondFactor(input);
      await waiting(1);
      const second = auth.verifySecondFactor(input);
      await waiting(2);
      await holder.query('commit');
      results = await Promise.all([first, second]);
    } finally {
      holder.release();
    }
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(results[1]).toEqual({ ok: false, message: EXPIRED_CHALLENGE_ERROR });
    expect(await t.db.select().from(session).where(eq(session.userId, u.utente.id))).toHaveLength(
      1,
    );
  });

  it('C: lo stesso codice giusto su due passaggi insieme apre una sola sessione', async () => {
    const auth = authService();
    const u = await createUser(cookies.amministratore, {
      nomeUtente: `amm.d.${sfx}`,
      nome: 'Amministratore del Codice Doppio',
      ruoli: ['administrator'],
    });
    const chosen = 'la password del codice doppio';
    await firstAccess(`amm.d.${sfx}`, u.passwordTemporanea!, chosen);
    const one = (await access(`amm.d.${sfx}`, chosen)).json().passaggio as string;
    const two = (await access(`amm.d.${sfx}`, chosen)).json().passaggio as string;
    const code = codeNow(`amm.d.${sfx}`);
    // Tutti e due leggono l'ultimo codice usato prima che il primo lo scriva: il secondo lo
    // rilegge sotto blocco, dopo il primo, e non vale.
    const holder = await t.pool.connect();
    let results: SessionResult[];
    try {
      await holder.query('begin');
      await holder.query('select pg_advisory_xact_lock(4620119)');
      const first = auth.verifySecondFactor({ challengeToken: one, code });
      await waiting(1);
      const second = auth.verifySecondFactor({ challengeToken: two, code });
      await waiting(2);
      await holder.query('commit');
      results = await Promise.all([first, second]);
    } finally {
      holder.release();
    }
    expect(results.map((r) => r.ok)).toEqual([true, false]);
    expect(results[1]).toEqual({ ok: false, message: 'Codice non valido' });
    // La sessione del primo accesso e una sola nuova.
    expect(await t.db.select().from(session).where(eq(session.userId, u.utente.id))).toHaveLength(
      2,
    );
    // Il codice ripetuto conta come un codice sbagliato: nel registro e sul passaggio.
    const failed = await t.db
      .select()
      .from(accessLog)
      .where(
        and(eq(accessLog.userId, u.utente.id), eq(accessLog.action, 'secondo_fattore_fallito')),
      );
    expect(failed.map((f) => f.details)).toEqual([{ motivo: 'codice errato', indirizzo: null }]);
    expect((await challengeOf(two)).triedCodes).toBe(1);
  });

  it('C: con il codice giusto l’utente si rilegge sotto blocco: sospeso, in attesa o bloccato nel frattempo, niente sessione', async () => {
    const auth = authService();
    const u = await createUser(cookies.amministratore, {
      nomeUtente: `amm.r.${sfx}`,
      nome: 'Amministratore della Rilettura',
      ruoli: ['administrator'],
    });
    const chosen = 'la password della rilettura';
    await firstAccess(`amm.r.${sfx}`, u.passwordTemporanea!, chosen);
    const id = u.utente.id;
    const cases: [string, string, unknown[], string][] = [
      [
        'sospeso',
        "update app_user set status = 'suspended' where id = $1",
        [id],
        EXPIRED_CHALLENGE_ERROR,
      ],
      [
        'in attesa',
        'update app_user set awaiting_confirmation = true where id = $1',
        [id],
        EXPIRED_CHALLENGE_ERROR,
      ],
      [
        'bloccato',
        'update app_user set locked_until = $2 where id = $1',
        [id, new Date(s.clock.now().getTime() + 3_600_000)],
        LOCKED_LOGIN_ERROR,
      ],
    ];
    for (const [what, change, params, message] of cases) {
      const started = await access(`amm.r.${sfx}`, chosen);
      expect(started.json().passo, what).toBe('secondo-fattore');
      const input = {
        challengeToken: started.json().passaggio as string,
        code: codeNow(`amm.r.${sfx}`),
      };
      // Il cambio arriva dopo la prima lettura del passaggio e prima della sessione.
      const holder = await t.pool.connect();
      let r: SessionResult;
      try {
        await holder.query('begin');
        await holder.query(change, params);
        const pending = auth.verifySecondFactor(input);
        await waiting(1);
        await holder.query('commit');
        r = await pending;
      } finally {
        holder.release();
      }
      expect(r, what).toEqual({ ok: false, message });
      expect((await challengeOf(input.challengeToken)).usedAt, what).not.toBeNull();
      await t.db
        .update(appUser)
        .set({ status: 'active', awaitingConfirmation: false, lockedUntil: null })
        .where(eq(appUser.id, id));
    }
    // Solo la sessione del primo accesso.
    expect(await t.db.select().from(session).where(eq(session.userId, id))).toHaveLength(1);
  });

  it('G: nome e cognome cambiati dal medico vanno nel registro, con i campi e senza i valori', async () => {
    const put = (nome: string, cognome: string, telefono = '000 0000001') =>
      req(cookies.titolare, 'PUT', '/api/profilo/recapiti', {
        nome,
        cognome,
        telefono,
        email: 'studio.marchi@esempio.invalid',
        pec: '',
      });
    const rows = async () => (await adminLog()).filter((e) => e.area === 'profilo');
    // Solo il telefono: nessuna riga.
    expect((await put('Elena', 'Marchi', '000 0000009')).statusCode).toBe(200);
    expect(await rows()).toEqual([]);
    expect((await put('Elena Maria', 'Marchi')).statusCode).toBe(200);
    expect((await put('Elena', 'Marchi Rossi')).statusCode).toBe(200);
    const who = {
      userId: s.users.titolare.id,
      outcome: 'riuscito',
      workstation: 'postazione-titolare',
      area: 'profilo',
      azione: 'modifica',
      utente: s.users.titolare.username,
      utenteId: s.users.titolare.id,
    };
    const logged = await rows();
    expect(logged).toEqual([
      { ...who, campi: ['medico.nome'] },
      { ...who, campi: ['medico.nome', 'medico.cognome'] },
    ]);
    expect(JSON.stringify(logged)).not.toMatch(/Elena|Marchi|Rossi|Maria/);
    // Le leggono amministratore e titolari nel registro di amministrazione.
    const listed = await req(cookies.amministratore, 'GET', '/api/studio/registro-amministrazione');
    expect(
      listed
        .json()
        .righe.filter((r: { area: string }) => r.area === 'Profilo del medico')
        .map((r: { azione: string }) => r.azione),
    ).toEqual(['Modifica', 'Modifica']);
    await put('Elena', 'Marchi');
  });

  it('H: una sessione dei servizi aperta con un codice fiscale diverso da quello attuale non vale, e si chiude', async () => {
    const credentials = createCredentialService({
      db: t.db,
      encryptionKey: s.encryptionKey,
      now: s.clock.now,
      regionalSoftwareCode: 'SIMULATORE',
      secondFactor: s.secondFactor,
    });
    const doctor = s.users.sostituto;
    // Con il codice fiscale di adesso le sessioni dello scenario valgono.
    await expect(credentials.authFor(doctor.id, 'ricetta_bianca')).resolves.toMatchObject({
      sessionId: expect.any(String),
    });
    const [before] = await t.db
      .select()
      .from(doctorProfile)
      .where(eq(doctorProfile.userId, doctor.id));
    const corrected = cf('Fiore', 'Marco', 'M', '1971-03-03');
    const patch = await req(cookies.amministratore, 'PATCH', `/api/studio/utenti/${doctor.id}`, {
      medico: {
        codiceFiscale: corrected,
        nome: 'Marco',
        cognome: 'Fiore',
        codiceRegionale: 'MMG-PROVA-3',
        asl: 'ASL di prova',
      },
    });
    expect(patch.statusCode, patch.body).toBe(200);
    // La correzione vale quando il medico la conferma (D181).
    const confirmed = await req(
      await login(s, 'sostituto'),
      'POST',
      '/api/profilo/codice-fiscale/conferma',
      { proposto: corrected },
    );
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    // La gara del problema 8: la sessione si salva dopo la chiusura, con il codice fiscale letto
    // prima della correzione. Non vale, e si chiude.
    const later = () => new Date(s.clock.now().getTime() + 3_600_000);
    for (const [service, mode, use] of [
      ['rupar_piemonte', 'spid_cie', 'ricetta_ssn'],
      ['sistema_ts', 'email', 'ricetta_bianca'],
    ] as const) {
      await storeSession(t.db, s.encryptionKey, {
        userId: doctor.id,
        service,
        token: `sessione-di-prova-${service}`,
        validUntil: later(),
        mode,
        subject: before!.fiscalCode,
      });
      await expect(credentials.authFor(doctor.id, use)).rejects.toMatchObject({
        statusCode: 422,
        details: { codice: 'SESSIONE_MANCANTE' },
      });
      expect(
        await t.db
          .select()
          .from(serviceSession)
          .where(and(eq(serviceSession.userId, doctor.id), eq(serviceSession.service, service))),
      ).toEqual([]);
    }
    const closed = await t.db
      .select()
      .from(serviceCredentialEvent)
      .where(
        and(
          eq(serviceCredentialEvent.userId, doctor.id),
          eq(
            serviceCredentialEvent.detail,
            'aperta con un codice fiscale diverso da quello attuale del medico',
          ),
        ),
      );
    expect(closed.map((e) => [e.service, e.event]).sort()).toEqual([
      ['rupar_piemonte', 'sessione_chiusa'],
      ['sistema_ts', 'sessione_chiusa'],
    ]);
    // Una sessione salvata senza il codice fiscale con cui è stata aperta (per esempio prima di
    // questa regola) non vale nemmeno lei.
    await storeSession(t.db, s.encryptionKey, {
      userId: doctor.id,
      service: 'sistema_ts',
      token: 'sessione-di-prova-senza-codice',
      validUntil: later(),
      subject: null,
    });
    await expect(credentials.authFor(doctor.id, 'ricetta_bianca')).rejects.toMatchObject({
      statusCode: 422,
      details: { codice: 'SESSIONE_MANCANTE' },
    });
    // Con il codice fiscale attuale la sessione vale; la pagina delle credenziali mostra spenta
    // quella aperta con il codice di prima.
    await storeSession(t.db, s.encryptionKey, {
      userId: doctor.id,
      service: 'sistema_ts',
      token: 'sessione-di-prova-giusta',
      validUntil: later(),
      subject: corrected,
    });
    await expect(credentials.authFor(doctor.id, 'ricetta_bianca')).resolves.toMatchObject({
      sessionId: 'sessione-di-prova-giusta',
    });
    await storeSession(t.db, s.encryptionKey, {
      userId: doctor.id,
      service: 'rupar_piemonte',
      token: 'sessione-di-prova-vecchia',
      validUntil: later(),
      mode: 'spid_cie',
      subject: before!.fiscalCode,
    });
    const actor: Actor = {
      userId: doctor.id,
      studioId: s.studioId,
      roles: ['substitute_doctor'],
      displayName: 'Dott. Marco Fiore',
      sessionId: '00000000-0000-4000-8000-000000000000',
      workstation: 'postazione-prova',
      mustChangePassword: false,
    };
    const status = await credentials.status(actor);
    expect(status.servizi.map((x) => [x.servizio, x.sessione.attiva]).sort()).toEqual([
      ['rupar', false],
      ['sistema-ts', true],
    ]);
  });

  it('comando del server: --conferma solo senza titolari che possano confermare, --sblocca senza toccare le credenziali', async () => {
    const { fresh, adminCookie } = await freshStudio('cmd');
    // Una segreteria in attesa, poi sospesa dall'amministratore: nessun titolare nello studio.
    const sec = await createUser(adminCookie, {
      nomeUtente: `segr.cmd.${sfx}`,
      nome: 'Segreteria del Comando',
      ruoli: ['secretary'],
    });
    const id = sec.utente.id;
    expect(sec.utente.confermaDalServizio).toBe(true);
    expect((await req(adminCookie, 'POST', `/api/studio/utenti/${id}/sospendi`)).statusCode).toBe(
      200,
    );
    // Un passaggio e una sessione rimasti aperti (la prova li scrive): la conferma li chiude.
    const { hash: challengeHash } = newToken();
    await t.db.insert(authChallenge).values({
      userId: id,
      tokenHash: challengeHash,
      purpose: 'enroll',
      workstation: 'postazione-prova',
      expiresAt: new Date(s.clock.now().getTime() + 300_000),
    });
    const { hash: sessionHash } = newToken();
    await t.db.insert(session).values({
      userId: id,
      tokenHash: sessionHash,
      workstation: 'postazione-prova',
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    await expect(serverConfirm(`segr.cmd.${sfx}`)).rejects.toThrow(
      'L’utente è sospeso: per confermarlo aggiungi --riattiva',
    );
    await expect(
      restoreUser(t.db, {
        utente: `adm.cmd.${sfx}`,
        conferma: true,
        richiestaIl: s.clock.now().toISOString(),
      }),
    ).rejects.toThrow('L’utente non è in attesa di conferma: niente da confermare');
    await expect(
      restoreUser(t.db, {
        utente: `segr.cmd.${sfx}`,
        conferma: true,
        sospendi: true,
        richiestaIl: sec.utente.richiestaDiConferma!.il,
      }),
    ).rejects.toBeInstanceOf(ZodError);
    const done = await serverConfirm(`segr.cmd.${sfx}`, { riattiva: true });
    passwordsSeen.push(done.temporaryPassword!);
    expect(done).toMatchObject({
      actions: ['riattivazione', 'conferma'],
      status: 'active',
      awaitingConfirmation: false,
      closedSessions: 1,
    });
    expect(done.temporaryPassword).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(await userRow(id)).toMatchObject({
      awaitingConfirmation: false,
      confirmationIssuesPassword: false,
      confirmedBy: null,
      mustChangePassword: true,
      totpEnabledAt: null,
      totpSecretEnc: null,
      status: 'active',
    });
    expect((await userRow(id)).confirmedAt).not.toBeNull();
    const [stale] = await t.db
      .select()
      .from(authChallenge)
      .where(eq(authChallenge.tokenHash, challengeHash));
    expect(stale!.usedAt).not.toBeNull();
    const rows = (await adminLog(fresh.studioId)).filter((e) => e.utente === `segr.cmd.${sfx}`);
    expect(rows.slice(-2)).toEqual([
      {
        userId: null,
        outcome: 'riuscito',
        workstation: null,
        area: 'utenti',
        azione: 'riattivazione',
        tramite: 'comando del server',
        utente: `segr.cmd.${sfx}`,
        utenteId: id,
        ruoliPrima: ['secretary'],
        ruoliDopo: ['secretary'],
        campi: ['stato'],
        sessioniChiuse: 1,
      },
      {
        userId: null,
        outcome: 'riuscito',
        workstation: null,
        area: 'utenti',
        azione: 'conferma',
        tramite: 'comando del server',
        utente: `segr.cmd.${sfx}`,
        utenteId: id,
        ruoliPrima: ['secretary'],
        ruoliDopo: ['secretary'],
        campi: ['conferma', 'password', 'secondoFattore'],
        richiestaDa: `adm.cmd.${sfx}`,
        richiestaIl: sec.utente.richiestaDiConferma!.il,
      },
    ]);
    const listed = (await req(adminCookie, 'GET', '/api/studio/utenti'))
      .json()
      .utenti.find((x: { id: string }) => x.id === id);
    expect(listed).toMatchObject({
      inAttesaDiConferma: false,
      confermato: { da: null },
      confermaDalServizio: false,
    });
    expect((await access(`segr.cmd.${sfx}`, done.temporaryPassword!)).json().passo).toBe(
      'attiva-secondo-fattore',
    );

    // --sblocca: toglie il blocco della segreteria dello scenario, senza password nuova e senza
    // chiudere le sessioni; va da solo.
    const secretary = s.users.segreteria;
    const cookie = await login(s, 'segreteria');
    await expect(restoreUser(t.db, { utente: secretary.username, sblocca: true })).rejects.toThrow(
      'L’utente non è bloccato e non ha tentativi falliti: niente da sbloccare',
    );
    // La soglia alta per difetto: 50 password sbagliate (D188).
    for (let i = 0; i < 50; i++) await access(secretary.username, `sbagliata ${i}`);
    expect((await access(secretary.username, PASSWORD)).json().errore).toBe(LOCKED_LOGIN_ERROR);
    const hashBefore = (await userRow(secretary.id)).passwordHash;
    for (const other of [{ secondoFattore: true }, { riattiva: true }, { conferma: true }])
      await expect(
        restoreUser(t.db, { utente: secretary.username, sblocca: true, ...other }),
      ).rejects.toBeInstanceOf(ZodError);
    const unlocked = await restoreUser(
      t.db,
      { utente: secretary.username, sblocca: true },
      { now: s.clock.now },
    );
    expect(unlocked).toMatchObject({
      actions: ['sblocco'],
      temporaryPassword: null,
      closedSessions: 0,
    });
    expect(await userRow(secretary.id)).toMatchObject({
      failedLogins: 0,
      lockedUntil: null,
      passwordHash: hashBefore,
    });
    expect((await req(cookie, 'GET', '/api/io')).statusCode).toBe(200);
    expect((await access(secretary.username, PASSWORD)).json().passo).toBe('secondo-fattore');
    expect((await adminLog()).at(-1)).toEqual({
      userId: null,
      outcome: 'riuscito',
      workstation: null,
      area: 'utenti',
      azione: 'sblocco',
      tramite: 'comando del server',
      utente: secretary.username,
      utenteId: secretary.id,
      ruoliPrima: ['secretary'],
      ruoliDopo: ['secretary'],
      campi: ['blocco'],
    });
  });

  it('A7: un titolare con pazienti sospeso dal server non lo riattiva l’amministratore', async () => {
    const doctor = s.users.collega;
    await restoreUser(t.db, { utente: doctor.username, sospendi: true });
    expect(await userRow(doctor.id)).toMatchObject({
      status: 'suspended',
      suspendedByService: true,
    });
    const on = await req(
      cookies.amministratore,
      'POST',
      `/api/studio/utenti/${doctor.id}/riattiva`,
    );
    expect(on.statusCode).toBe(409);
    expect(on.json().errore).toBe(serviceSuspendedRefusal(doctor.username));
    expect(on.json().errore).toContain(
      `pnpm utente:ripristina -- --utente ${doctor.username} --riattiva`,
    );
    expect((await userRow(doctor.id)).status).toBe('suspended');
    expect((await adminLog()).at(-1)).toMatchObject({
      outcome: 'negato',
      azione: 'riattivazione',
      utente: doctor.username,
      motivo: serviceSuspendedRefusal(doctor.username),
    });
    const listed = (await req(cookies.amministratore, 'GET', '/api/studio/utenti'))
      .json()
      .utenti.find((x: { id: string }) => x.id === doctor.id);
    expect(listed).toMatchObject({
      stato: 'sospeso',
      titolareConPazienti: true,
      sospesoDalServizio: true,
    });
    // Lo riattiva chi gestisce il servizio, sul server: il segno della sospensione si toglie.
    const back = await restoreUser(t.db, { utente: doctor.username, riattiva: true });
    passwordsSeen.push(back.temporaryPassword!);
    expect(await userRow(doctor.id)).toMatchObject({
      status: 'active',
      suspendedByService: false,
    });
    // Un titolare con pazienti sospeso senza il segno del server (righe di prima di questa
    // regola): dal programma non si riattiva lo stesso, perché ha pazienti.
    await t.db.update(appUser).set({ status: 'suspended' }).where(eq(appUser.id, doctor.id));
    const legacy = await req(
      cookies.amministratore,
      'POST',
      `/api/studio/utenti/${doctor.id}/riattiva`,
    );
    expect(legacy.statusCode).toBe(409);
    expect(legacy.json().errore).toBe(OWNER_REACTIVATE_REFUSAL);
    await t.db.update(appUser).set({ status: 'active' }).where(eq(appUser.id, doctor.id));
  });

  it('A7 bis: chi è sospeso dal server, di qualunque ruolo, non lo riattiva l’amministratore; le sue sospensioni sì', async () => {
    const created = await createUser(cookies.amministratore, {
      nomeUtente: `segr.a7.${sfx}`,
      nome: 'Segreteria Sette',
      ruoli: ['secretary'],
    });
    const p1 = await confirm(cookies.titolare, created.utente.id);
    await firstAccess(`segr.a7.${sfx}`, p1!, 'la segreteria sette lavora');
    const id = created.utente.id;
    // Sospesa dal server: dal programma non torna, e le credenziali di prima non valgono.
    await restoreUser(t.db, { utente: `segr.a7.${sfx}`, sospendi: true }, { now: s.clock.now });
    const on = await req(cookies.amministratore, 'POST', `/api/studio/utenti/${id}/riattiva`);
    expect(on.statusCode, on.body).toBe(409);
    expect(on.json().errore).toBe(serviceSuspendedRefusal(`segr.a7.${sfx}`));
    expect((await access(`segr.a7.${sfx}`, 'la segreteria sette lavora')).statusCode).toBe(401);
    expect(
      (await req(cookies.amministratore, 'GET', '/api/studio/utenti'))
        .json()
        .utenti.find((x: { id: string }) => x.id === id),
    ).toMatchObject({ stato: 'sospeso', sospesoDalServizio: true, titolareConPazienti: false });
    // Il server la riattiva; poi una sospensione dell'amministratore la riattiva l'amministratore.
    passwordsSeen.push(
      (await restoreUser(t.db, { utente: `segr.a7.${sfx}`, riattiva: true }, { now: s.clock.now }))
        .temporaryPassword!,
    );
    const off = await req(cookies.amministratore, 'POST', `/api/studio/utenti/${id}/sospendi`);
    expect(off.statusCode, off.body).toBe(200);
    expect(off.json().utente).toMatchObject({ stato: 'sospeso', sospesoDalServizio: false });
    const back = await req(cookies.amministratore, 'POST', `/api/studio/utenti/${id}/riattiva`);
    expect(back.statusCode, back.body).toBe(200);
  });

  it('A7 ter: un titolare finto confermato per errore e sospeso dal server non torna dal programma', async () => {
    const { adminCookie } = await freshStudio('a7t');
    const fake = await createUser(adminCookie, {
      nomeUtente: `finto.a7t.${sfx}`,
      nome: 'Dott. Finto Settimo',
      ruoli: ['owner_doctor', 'secretary'],
      medico: { codiceFiscale: cf('Finto', 'Ivo', 'M'), nome: 'Ivo', cognome: 'Finto' },
    });
    // Chi gestisce il servizio lo conferma per errore, poi se ne accorge e lo sospende dal server.
    passwordsSeen.push((await serverConfirm(`finto.a7t.${sfx}`)).temporaryPassword!);
    await restoreUser(t.db, { utente: `finto.a7t.${sfx}`, sospendi: true }, { now: s.clock.now });
    const on = await req(adminCookie, 'POST', `/api/studio/utenti/${fake.utente.id}/riattiva`);
    expect(on.statusCode, on.body).toBe(409);
    expect(on.json().errore).toBe(serviceSuspendedRefusal(`finto.a7t.${sfx}`));
    expect(await userRow(fake.utente.id)).toMatchObject({
      status: 'suspended',
      suspendedByService: true,
    });
  });

  it('A1 bis: la conferma dal server mostra che cosa conferma e vale solo per la richiesta letta', async () => {
    const { fresh, adminCookie } = await freshStudio('a1b');
    const username = `chiesto.a1b.${sfx}`;
    const u = await createUser(adminCookie, {
      nomeUtente: username,
      nome: 'Dott.ssa Anna Chiesta',
      ruoli: ['owner_doctor'],
      medico: {
        codiceFiscale: cf('Chiesta', 'Anna', 'F'),
        nome: 'Anna',
        cognome: 'Chiesta',
        codiceRegionale: 'MMG-A1B-1',
        asl: 'ASL di prova',
      },
    });
    const id = u.utente.id;
    const before = await userRow(id);
    // Primo passo: la richiesta com'è adesso, senza cambiare nulla.
    const shown = await showRequest(t.db, { utente: username });
    expect(shown).toMatchObject({
      username,
      displayName: 'Dott.ssa Anna Chiesta',
      studioName: 'Studio a1b',
      roles: ['owner_doctor'],
      roleNames: ['Medico titolare'],
      doctor: {
        firstName: 'Anna',
        lastName: 'Chiesta',
        fiscalCode: cf('Chiesta', 'Anna', 'F'),
        regionalCode: 'MMG-A1B-1',
        asl: 'ASL di prova',
      },
      status: 'active',
      suspendedByService: false,
      awaitingConfirmation: true,
      requestedBy: { username: `adm.a1b.${sfx}`, displayName: 'Amministratore a1b' },
      requestedAt: u.utente.richiestaDiConferma!.il,
      ownerCanConfirm: false,
    });
    expect(await userRow(id)).toEqual(before);
    // Nel registro solo che il server l'ha letta, con la data della richiesta: nessun valore.
    expect((await adminLog(fresh.studioId)).at(-1)).toEqual({
      userId: null,
      outcome: 'riuscito',
      workstation: null,
      area: 'utenti',
      azione: 'consultazione_richiesta',
      tramite: 'comando del server',
      utente: username,
      utenteId: id,
      richiestaIl: shown.requestedAt,
    });
    // Senza la data non si conferma: prima si legge.
    await expect(restoreUser(t.db, { utente: username, conferma: true })).rejects.toBeInstanceOf(
      ZodError,
    );
    // Prima che chi gestisce il servizio confermi, l'amministratore cambia ruoli, nome e dati del
    // medico: la conferma con la data letta si rifiuta e non cambia nulla.
    s.clock.advance(60_000);
    const changed = await req(adminCookie, 'PATCH', `/api/studio/utenti/${id}`, {
      ruoli: ['owner_doctor', 'secretary'],
      nome: 'Dott. Luca Altro',
      medico: { codiceFiscale: cf('Altro', 'Luca', 'M'), nome: 'Luca', cognome: 'Altro' },
    });
    expect(changed.statusCode, changed.body).toBe(200);
    await expect(
      restoreUser(t.db, { utente: username, conferma: true, richiestaIl: shown.requestedAt! }),
    ).rejects.toThrow(STALE_SERVER_REQUEST);
    expect(await userRow(id)).toMatchObject({ awaitingConfirmation: true, status: 'active' });
    // Riletta: ruoli, nome e dati nuovi, con una data nuova; con quella si conferma.
    const again = await showRequest(t.db, { utente: username });
    expect(again).toMatchObject({
      displayName: 'Dott. Luca Altro',
      roleNames: ['Medico titolare', 'Segreteria'],
      doctor: { firstName: 'Luca', lastName: 'Altro', fiscalCode: cf('Altro', 'Luca', 'M') },
    });
    expect(again.requestedAt).not.toBe(shown.requestedAt);
    const done = await restoreUser(
      t.db,
      { utente: username, conferma: true, richiestaIl: again.requestedAt! },
      { now: s.clock.now },
    );
    passwordsSeen.push(done.temporaryPassword!);
    expect(done.actions).toEqual(['conferma']);
    expect((await userRow(id)).awaitingConfirmation).toBe(false);
    // --mostra va da solo.
    await expect(
      restoreUser(t.db, { utente: username, mostra: true, sblocca: true }),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it('--rifiuta: l’utente resta in attesa e diventa sospeso dal server; dal programma non torna', async () => {
    const { fresh, adminCookie } = await freshStudio('rif');
    const username = `rifiutato.${sfx}`;
    const u = await createUser(adminCookie, {
      nomeUtente: username,
      nome: 'Dott. Rifiutato',
      ruoli: ['owner_doctor'],
      medico: { codiceFiscale: cf('Rifiuti', 'Rino', 'M'), nome: 'Rino', cognome: 'Rifiuti' },
    });
    const id = u.utente.id;
    const shown = await showRequest(t.db, { utente: username });
    const r = await restoreUser(t.db, { utente: username, rifiuta: true }, { now: s.clock.now });
    expect(r).toMatchObject({
      actions: ['rifiuto'],
      temporaryPassword: null,
      status: 'suspended',
      suspendedByService: true,
      awaitingConfirmation: true,
    });
    const row = await userRow(id);
    expect(row).toMatchObject({
      status: 'suspended',
      suspendedByService: true,
      awaitingConfirmation: true,
    });
    expect(row.confirmationRequestedAt!.toISOString()).toBe(shown.requestedAt);
    expect((await adminLog(fresh.studioId)).at(-1)).toEqual({
      userId: null,
      outcome: 'riuscito',
      workstation: null,
      area: 'utenti',
      azione: 'rifiuto',
      tramite: 'comando del server',
      utente: username,
      utenteId: id,
      ruoliPrima: ['owner_doctor'],
      ruoliDopo: ['owner_doctor'],
      campi: ['stato'],
      sessioniChiuse: 0,
      attesaConferma: true,
      richiestaDa: `adm.rif.${sfx}`,
      richiestaIl: shown.requestedAt,
    });
    // L'amministratore non lo riattiva; l'elenco lo dice sospeso dal servizio.
    const on = await req(adminCookie, 'POST', `/api/studio/utenti/${id}/riattiva`);
    expect(on.statusCode).toBe(409);
    expect(on.json().errore).toBe(serviceSuspendedRefusal(username));
    expect(
      (await req(adminCookie, 'GET', '/api/studio/utenti'))
        .json()
        .utenti.find((x: { id: string }) => x.id === id),
    ).toMatchObject({ stato: 'sospeso', inAttesaDiConferma: true, sospesoDalServizio: true });
    // Il server non lo conferma senza riattivarlo e non lo rifiuta due volte; --rifiuta va da solo
    // e vale solo per chi è in attesa.
    await expect(
      restoreUser(t.db, { utente: username, conferma: true, richiestaIl: shown.requestedAt! }),
    ).rejects.toThrow('L’utente è sospeso: per confermarlo aggiungi --riattiva');
    await expect(restoreUser(t.db, { utente: username, rifiuta: true })).rejects.toThrow(
      /già sospeso da chi gestisce il servizio/,
    );
    await expect(
      restoreUser(t.db, { utente: username, rifiuta: true, sospendi: true }),
    ).rejects.toBeInstanceOf(ZodError);
    await expect(restoreUser(t.db, { utente: `adm.rif.${sfx}`, rifiuta: true })).rejects.toThrow(
      /non è in attesa di conferma: niente da rifiutare/,
    );
    // Riattivato dal server: torna in attesa con una richiesta nuova del server, senza il segno.
    const later = () => new Date(s.clock.now().getTime() + 60_000);
    const back = await restoreUser(t.db, { utente: username, riattiva: true }, { now: later });
    passwordsSeen.push(back.temporaryPassword!);
    expect(await userRow(id)).toMatchObject({
      status: 'active',
      suspendedByService: false,
      awaitingConfirmation: true,
      confirmationRequestedBy: null,
    });
  });

  it('comando del server come processo vero: --mostra stampa ruoli e dati del medico, --conferma vuole la data stampata, --rifiuta', async () => {
    const { adminCookie } = await freshStudio('cli');
    const username = `doppio.cli.${sfx}`;
    const u = await createUser(adminCookie, {
      nomeUtente: username,
      nome: 'Dott. Ugo Doppio',
      ruoli: ['owner_doctor', 'secretary'],
      medico: {
        codiceFiscale: cf('Doppio', 'Ugo', 'M'),
        nome: 'Ugo',
        cognome: 'Doppio',
        codiceRegionale: 'MMG-CLI-1',
        asl: 'ASL di prova',
      },
    });
    const secretary = await createUser(adminCookie, {
      nomeUtente: `segr.cli.${sfx}`,
      nome: 'Segreteria del Comando',
      ruoli: ['secretary'],
    });
    const date = u.utente.richiestaDiConferma!.il;
    // Primo passo: la richiesta, con i ruoli in italiano e i dati del medico.
    const shown = await runCli(['--utente', username, '--mostra']);
    expect(shown.code, shown.err).toBe(0);
    expect(shown.out).toMatch(/ruoli:\s+Medico titolare, Segreteria/);
    expect(shown.out).toMatch(
      new RegExp(
        `dati del medico:\\s+nome Ugo, cognome Doppio, codice fiscale ${cf('Doppio', 'Ugo', 'M')}, codice regionale MMG-CLI-1, ASL ASL di prova`,
      ),
    );
    expect(shown.out).toMatch(
      new RegExp(`richiesta di:\\s+adm\\.cli\\.${sfx} \\(Amministratore cli\\)`),
    );
    expect(shown.out).toMatch(new RegExp(`richiesta il:\\s+${date.replace(/\./g, '\\.')}`));
    expect(shown.out).toContain(`--utente ${username} --conferma --richiesta-il ${date}`);
    expect((await userRow(u.utente.id)).awaitingConfirmation).toBe(true);
    // Senza la data, o con un'altra: rifiuta, uscita 1, e non cambia nulla.
    const noDate = await runCli(['--utente', username, '--conferma']);
    expect(noDate.code).toBe(1);
    expect(noDate.err).toContain(
      '--richiesta-il: serve la data della richiesta che stampa --mostra',
    );
    const otherDate = await runCli([
      '--utente',
      username,
      '--conferma',
      '--richiesta-il',
      '2026-01-01T00:00:00.000Z',
    ]);
    expect(otherDate.code).toBe(1);
    expect(otherDate.err).toContain('rileggila con --mostra');
    expect((await userRow(u.utente.id)).awaitingConfirmation).toBe(true);
    // Con la data stampata: confermato, la password si vede una volta.
    const ok = await runCli(['--utente', username, '--conferma', '--richiesta-il', date]);
    expect(ok.code, ok.err).toBe(0);
    const password = /password temporanea:\s+(\S+)/.exec(ok.out)?.[1];
    expect(password).toMatch(/^[A-Za-z0-9_-]{16}$/);
    passwordsSeen.push(password!);
    expect((await userRow(u.utente.id)).awaitingConfirmation).toBe(false);
    // --rifiuta: la segreteria resta in attesa, sospesa dal server.
    const no = await runCli(['--utente', `segr.cli.${sfx}`, '--rifiuta']);
    expect(no.code, no.err).toBe(0);
    expect(no.out).toContain('richiesta rifiutata');
    expect(await userRow(secretary.utente.id)).toMatchObject({
      status: 'suspended',
      suspendedByService: true,
      awaitingConfirmation: true,
    });
  }, 180_000);

  it('caratteri di controllo: il servizio li rifiuta nei nomi e nei dati del medico; --mostra rende visibili quelli già nel database (terza revisione)', async () => {
    const { fresh, adminCookie } = await freshStudio('ctl');
    // ESC che sul terminale riscriverebbe la riga dei ruoli («NUOVO R5» della terza revisione).
    const esc = '\u001b[1A\u001b[2K\u001b[1G  ruoli:           Medico titolare';
    const refused = [
      { nome: 'Dott. Vero', medicoNome: `Vera${esc}` },
      { nome: 'Dott. Vero\n  ruoli: Medico titolare', medicoNome: 'Vera' },
      { nome: 'Dott. Vero\u202E', medicoNome: 'Vera' },
    ];
    for (const [i, x] of refused.entries()) {
      const res = await req(adminCookie, 'POST', '/api/studio/utenti', {
        nomeUtente: `ctl.no${i}.${sfx}`,
        nome: x.nome,
        ruoli: ['owner_doctor', 'secretary'],
        medico: {
          codiceFiscale: cf('Controlli', 'Vera', 'F'),
          nome: x.medicoNome,
          cognome: 'Controlli',
        },
      });
      expect(res.statusCode, res.body).toBe(400);
      expect(res.body).toContain(CONTROL_CHARACTERS_MESSAGE);
    }
    const u = await createUser(adminCookie, {
      nomeUtente: `ctl.uno.${sfx}`,
      nome: 'Dott. Vero',
      ruoli: ['owner_doctor', 'secretary'],
      medico: { codiceFiscale: cf('Controlli', 'Vera', 'F'), nome: 'Vera', cognome: 'Controlli' },
    });
    // Anche in modifica, nei dati del medico.
    const changed = await req(adminCookie, 'PATCH', `/api/studio/utenti/${u.utente.id}`, {
      medico: {
        codiceFiscale: cf('Controlli', 'Vera', 'F'),
        nome: 'Vera',
        cognome: `Controlli${esc}`,
      },
    });
    expect(changed.statusCode, changed.body).toBe(400);
    // Un nome così, già nel database (scritto prima o a mano): --mostra lo stampa visibile, e i
    // ruoli restano quelli veri, anche con i codici.
    await withActor(t.db, fresh.userId, async (tx) => {
      await tx
        .update(appUser)
        .set({ displayName: `Dott. Vero${esc}` })
        .where(eq(appUser.id, u.utente.id));
      await tx
        .update(doctorProfile)
        .set({ firstName: `Vera${esc}` })
        .where(eq(doctorProfile.userId, u.utente.id));
    });
    const shown = await runCli(['--utente', `ctl.uno.${sfx}`, '--mostra']);
    expect(shown.code, shown.err).toBe(0);
    expect(shown.out).not.toContain('\u001b');
    expect(shown.out).toContain('nome mostrato:   Dott. Vero\\u{001B}[1A\\u{001B}[2K');
    expect(shown.out).toContain('nome Vera\\u{001B}[1A');
    expect(shown.out).toMatch(
      /ruoli:\s+Medico titolare, Segreteria \(codici: owner_doctor, secretary\)/,
    );
  }, 180_000);

  it('registro di amministrazione: ogni area e ogni azione ha la sua etichetta, e le azioni del server lo dicono', async () => {
    const names = { archives: new Map<string, string>(), afts: new Map<string, string>() };
    // Le azioni scritte dal programma e dal comando del server, e quelle delle altre sezioni.
    const actions = [
      ...USER_ACTIONS,
      ...RESTORE_LOG_ACTIONS,
      'lettura',
      'creazione',
      'modifica',
      'archiviazione',
    ];
    for (const azione of actions) expect(ACTION_LABELS[azione], azione).toBeTruthy();
    for (const area of ['studio', 'utenti', 'postazioni', 'stampa', 'elenchi', 'profilo'])
      expect(AREA_LABELS[area], area).toBeTruthy();
    expect(
      describeAdminEntry(
        'amministrazione',
        'riuscito',
        { area: 'profilo', azione: 'modifica' },
        names,
      ),
    ).toEqual({ area: 'Profilo del medico', azione: 'Modifica', dettaglio: null });
    expect(
      describeAdminEntry(
        'amministrazione',
        'riuscito',
        { area: 'utenti', azione: 'rifiuto', tramite: 'comando del server', utente: 'x.y' },
        names,
      ),
    ).toEqual({
      area: 'Utenti e ruoli',
      azione: 'Rifiuto della conferma',
      dettaglio: 'Dal server, con il comando di chi gestisce il servizio · utente x.y',
    });
    // Un valore sconosciuto di «tramite» non si mostra.
    expect(
      describeAdminEntry(
        'amministrazione',
        'riuscito',
        { area: 'utenti', azione: 'conferma', tramite: 'un testo qualsiasi' },
        names,
      ).dettaglio,
    ).toBeNull();
    // Nel registro dello studio: le azioni del server di queste prove, con le etichette.
    const listed = (
      await req(cookies.amministratore, 'GET', '/api/studio/registro-amministrazione')
    ).json().righe as { area: string; azione: string; dettaglio: string | null }[];
    const byServer = listed.filter((r) => r.dettaglio?.startsWith('Dal server'));
    // Sblocco della segreteria, sospensione e riattivazione (con la password nuova) dei medici.
    expect(new Set(byServer.map((r) => r.azione))).toEqual(
      new Set([
        'Sblocco dopo i tentativi falliti',
        'Sospensione',
        'Riattivazione',
        'Password temporanea',
      ]),
    );
    expect(byServer.every((r) => r.area === 'Utenti e ruoli')).toBe(true);
  });

  it('nessuna password, impronta o segreto nel registro', async () => {
    const rows = await t.db.select().from(accessLog);
    const text = JSON.stringify(rows.map((r) => r.details));
    expect(passwordsSeen.length).toBeGreaterThan(10);
    for (const p of passwordsSeen) expect(text).not.toContain(p);
    expect(text).not.toMatch(/scrypt\$|totp|sessione-di-prova/i);
  });
});
