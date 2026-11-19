import { randomBytes } from 'node:crypto';
import { buildFiscalCode } from '@mmg/domain';
import { generatePatients } from '@mmg/fixtures';
import { SimulatedSecondFactor } from '@mmg/integrations';
import { and, asc, count, eq, gt, sql } from 'drizzle-orm';
import { strToU8 } from 'fflate';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import {
  ARCHIVE_BUSY_REFUSAL,
  CHANGED_MEANWHILE,
  OWNER_REFUSE_REFUSAL,
  OWNER_SUSPEND_REFUSAL,
} from '../src/admin/user-service';
import {
  createAuthService,
  EXPIRED_CHALLENGE_ERROR,
  GENERIC_LOGIN_ERROR,
  LOCKED_CHANGE_ERROR,
  LOCKED_LOGIN_ERROR,
  SERVICE_BUSY_ERROR,
  TOO_MANY_CODES_ERROR,
} from '../src/auth/service';
import { createCredentialService } from '../src/credentials/service';
import { createDatabase, createPool } from '../src/db/client';
import { createFirstStudio } from '../src/db/first-studio';
import {
  accessLog,
  appUser,
  archive,
  authChallenge,
  patient,
  serviceSession,
  session,
} from '../src/db/schema';
import { withActor } from '../src/db/tx';
import { restoreUser } from '../src/db/user-restore';
import {
  OWNER_AWAITING_NO_NEW_PATIENTS,
  OWNER_GONE_NO_NEW_PATIENTS,
  OWNER_SUSPENDED_NO_NEW_PATIENTS,
} from '../src/patients/archive-owner';
import { base32Decode } from '../src/security/base32';
import { hashToken } from '../src/security/secrets';
import { totp } from '../src/security/totp';
import { column } from './helpers/importazione-xlsx';
import { createScenario, login, PASSWORD, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

/**
 * Seconda revisione avversaria dei poteri dell'amministratore (tappa 14): le prove d'attacco con
 * le richieste in parallelo e con i blocchi delle righe, rifatte sul codice corretto, devono
 * fallire. Codici e password mandati insieme (punto 5), attese sui blocchi (problema nuovo 2),
 * gara inversa della sospensione (punto 7), indirizzo dietro un proxy (punti 4 e 9), sessione dei
 * servizi durante la correzione del codice fiscale (punto 8). Utenti e pazienti inventati.
 */

/** Codice fiscale inventato: luogo di nascita con la X, che nessun comune ha (D12). */
const cf = (surname: string, name: string, sex: 'M' | 'F', birthDate = '1975-05-05') =>
  buildFiscalCode({ surname, name, birthDate, sex, placeCode: 'X001' });

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT';

let t: TestDatabase;
/** Client per guardare il database dall'esterno del gruppo di connessioni del servizio. */
let monitor: pg.Client;

beforeAll(async () => {
  t = await createTestDatabase();
  monitor = new pg.Client({ connectionString: t.url });
  await monitor.connect();
});
afterAll(async () => {
  await monitor?.end();
  await t?.drop();
});

/** Transazioni del database di prova ferme su un blocco, adesso. */
async function lockWaiters(): Promise<number> {
  const { rows } = await monitor.query<{ n: number }>(
    "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
  );
  return rows[0]!.n;
}

/** Attende che `n` transazioni aspettino un blocco. */
async function waiting(n: number) {
  for (let i = 0; i < 400; i++) {
    if ((await lockWaiters()) >= n) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Non ci sono ${n} transazioni in attesa di un blocco`);
}

/** Aiuti sullo scenario: richieste, accessi, righe del registro. */
function helpers(s: Scenario) {
  const secrets = new Map<string, Buffer>();
  for (const u of Object.values(s.users)) {
    const secret = s.secrets.get(u.id);
    if (secret) secrets.set(u.username, secret);
  }
  const req = (cookie: string | undefined, method: Method, url: string, payload?: object) =>
    s.app.inject({ method, url, headers: cookie ? { cookie } : {}, payload });
  const access = (username: string, password: string) =>
    s.app.inject({
      method: 'POST',
      url: '/api/accesso',
      payload: { username, password, postazione: 'postazione-prova' },
    });
  const codeOn = (passaggio: string, codice: string) =>
    s.app.inject({ method: 'POST', url: '/api/accesso/codice', payload: { passaggio, codice } });
  /** I codici che il servizio accetta adesso (intervallo di prima, di adesso e di dopo). */
  const validCodes = (username: string) => {
    const at = s.clock.now().getTime();
    return [at - 30_000, at, at + 30_000].map((x) => totp(secrets.get(username)!, x));
  };
  /** `n` codici diversi che il servizio rifiuta adesso. */
  const wrongCodes = (username: string, n: number) => {
    const valid = new Set(validCodes(username));
    const out: string[] = [];
    while (out.length < n) {
      const c = String(randomBytes(3).readUIntBE(0, 3) % 1_000_000).padStart(6, '0');
      if (!valid.has(c) && !out.includes(c)) out.push(c);
    }
    return out;
  };
  async function loginAs(username: string, password: string): Promise<string> {
    const res = await access(username, password);
    if (res.statusCode !== 200) throw new Error(`Accesso di ${username} fallito: ${res.body}`);
    const body = res.json<{ passaggio: string; segreto?: string }>();
    if (body.segreto) secrets.set(username, base32Decode(body.segreto));
    s.clock.advance(30_000);
    const done = await codeOn(
      body.passaggio,
      totp(secrets.get(username)!, s.clock.now().getTime()),
    );
    if (done.statusCode !== 200) throw new Error(`Codice di ${username} rifiutato: ${done.body}`);
    return `sessione=${done.cookies.find((c) => c.name === 'sessione')!.value}`;
  }
  async function firstAccess(username: string, temporary: string, chosen: string) {
    const cookie = await loginAs(username, temporary);
    const r = await req(cookie, 'POST', '/api/profilo/password', {
      passwordAttuale: temporary,
      nuovaPassword: chosen,
    });
    expect(r.statusCode, r.body).toBe(200);
    return cookie;
  }
  const userRow = async (id: string) =>
    (await t.db.select().from(appUser).where(eq(appUser.id, id)))[0]!;
  const resetUser = (id: string) =>
    t.db.update(appUser).set({ failedLogins: 0, lockedUntil: null }).where(eq(appUser.id, id));
  const challengeOf = async (token: string) =>
    (
      await t.db
        .select()
        .from(authChallenge)
        .where(eq(authChallenge.tokenHash, hashToken(token)))
    )[0]!;
  const sessionsOf = async (userId: string) =>
    (await t.db.select({ n: count() }).from(session).where(eq(session.userId, userId)))[0]!.n;
  const challengesOf = async (userId: string) =>
    (
      await t.db.select({ n: count() }).from(authChallenge).where(eq(authChallenge.userId, userId))
    )[0]!.n;
  /** Numero dell'ultima riga del registro: le righe dopo sono della prova che segue. */
  const lastSeq = async () =>
    Number(
      (await t.db.execute<{ n: string }>(sql`select coalesce(max(seq), 0) as n from access_log`))
        .rows[0]!.n,
    );
  const logSince = async (userId: string, action: string, since: number) =>
    (
      await t.db
        .select()
        .from(accessLog)
        .where(
          and(
            eq(accessLog.userId, userId),
            sql`${accessLog.action} = ${action}`,
            gt(accessLog.seq, since),
          ),
        )
        .orderBy(asc(accessLog.seq))
    ).map((r) => r.details as Record<string, unknown>);
  return {
    secrets,
    req,
    access,
    codeOn,
    validCodes,
    wrongCodes,
    loginAs,
    firstAccess,
    userRow,
    resetUser,
    challengeOf,
    sessionsOf,
    challengesOf,
    lastSeq,
    logSince,
  };
}

describe('codici e password mandati insieme (seconda revisione, punto 5)', () => {
  let s: Scenario;
  let h: ReturnType<typeof helpers>;

  beforeAll(async () => {
    // Le soglie più strette ammesse: 3 tentativi, poi un'ora di blocco.
    s = await createScenario(t.db, {
      idleLockMinutes: null,
      maxFailedLogins: 3,
      failedLoginLockMinutes: 60,
    });
    for (const who of ['titolare', 'collega', 'sostituto', 'segreteria'] as const)
      await login(s, who);
    h = helpers(s);
  });
  afterAll(async () => {
    await s?.app.close();
  });

  it('40 codici sbagliati insieme sullo stesso passaggio: se ne guardano 3, l’utente si blocca e il codice giusto dopo non apre nulla', async () => {
    const victim = s.users.collega;
    await h.resetUser(victim.id);
    s.clock.advance(60_000);
    const started = await h.access(victim.username, PASSWORD);
    expect(started.statusCode, started.body).toBe(200);
    const ch = started.json().passaggio as string;
    const since = await h.lastSeq();
    const sessions = await h.sessionsOf(victim.id);
    const all = await Promise.all(h.wrongCodes(victim.username, 40).map((c) => h.codeOn(ch, c)));
    expect(all.every((r) => r.statusCode === 401)).toBe(true);
    // Codici guardati: quelli che il registro conta come sbagliati. Mai più della soglia.
    const looked = await h.logSince(victim.id, 'secondo_fattore_fallito', since);
    expect(looked.filter((d) => d.motivo === 'codice errato')).toHaveLength(3);
    const c = await h.challengeOf(ch);
    expect(c.triedCodes).toBe(3);
    expect(c.usedAt).not.toBeNull();
    // Ogni codice guardato conta per l'utente: tre su tre, e alla soglia il blocco.
    expect((await h.userRow(victim.id)).lockedUntil!.getTime()).toBeGreaterThan(
      s.clock.now().getTime(),
    );
    // I codici non guardati trovano il passaggio pieno, chiuso o l'utente bloccato.
    const messages = all.map((r) => r.json().errore as string);
    expect(
      messages.every((m) =>
        [
          'Codice non valido',
          LOCKED_LOGIN_ERROR,
          TOO_MANY_CODES_ERROR,
          EXPIRED_CHALLENGE_ERROR,
        ].includes(m),
      ),
    ).toBe(true);
    expect(messages).toContain(LOCKED_LOGIN_ERROR);
    // Il codice giusto, dopo la chiusura, non apre nulla.
    const late = await h.codeOn(ch, h.validCodes(victim.username)[1]!);
    expect(late.statusCode).toBe(401);
    expect(late.json().errore).toBe(EXPIRED_CHALLENGE_ERROR);
    expect(await h.sessionsOf(victim.id)).toBe(sessions);
    expect((await h.access(victim.username, PASSWORD)).json().errore).toBe(LOCKED_LOGIN_ERROR);
  });

  it('il codice giusto mandato insieme a 40 sbagliati: se ne guardano al più 3, ed entra solo se è tra quelli', async () => {
    const victim = s.users.titolare;
    await h.resetUser(victim.id);
    s.clock.advance(60_000);
    const ch = (await h.access(victim.username, PASSWORD)).json().passaggio as string;
    const right = h.validCodes(victim.username)[1]!;
    const wrongs = h.wrongCodes(victim.username, 40);
    const burst = [...wrongs.slice(0, 20), right, ...wrongs.slice(20)];
    const since = await h.lastSeq();
    const sessions = await h.sessionsOf(victim.id);
    const all = await Promise.all(burst.map((c) => h.codeOn(ch, c)));
    const opened = (await h.sessionsOf(victim.id)) - sessions;
    const wrongLooked = (await h.logSince(victim.id, 'secondo_fattore_fallito', since)).filter(
      (d) => d.motivo === 'codice errato',
    ).length;
    console.log(
      JSON.stringify({ giusto: all[20]!.statusCode, sbagliatiGuardati: wrongLooked, opened }),
    );
    expect(opened).toBeLessThanOrEqual(1);
    expect(wrongLooked + opened).toBeLessThanOrEqual(3);
    expect((await h.challengeOf(ch)).triedCodes).toBeLessThanOrEqual(3);
    // Il codice giusto apre la sessione solo se è tra i codici guardati.
    expect(all[20]!.statusCode).toBe(opened === 1 ? 200 : 401);
    expect(all.filter((r) => r.statusCode === 200)).toHaveLength(opened);
  });

  it('lo stesso con le richieste su due gruppi di connessioni diversi', async () => {
    const victim = s.users.sostituto;
    await h.resetUser(victim.id);
    s.clock.advance(60_000);
    const ch = (await h.access(victim.username, PASSWORD)).json().passaggio as string;
    const pools = [createPool(t.url), createPool(t.url)];
    try {
      const services = pools.map((p) =>
        createAuthService({
          db: createDatabase(p),
          encryptionKey: s.encryptionKey,
          sessionMaxHours: 12,
          issuer: 'emittente-di-prova',
          now: s.clock.now,
        }),
      );
      const since = await h.lastSeq();
      const codes = h.wrongCodes(victim.username, 30);
      const results = await Promise.all(
        codes.map((code, i) => services[i % 2]!.verifySecondFactor({ challengeToken: ch, code })),
      );
      expect(results.every((r) => !r.ok)).toBe(true);
      const looked = (await h.logSince(victim.id, 'secondo_fattore_fallito', since)).filter(
        (d) => d.motivo === 'codice errato',
      );
      expect(looked).toHaveLength(3);
      expect((await h.challengeOf(ch)).triedCodes).toBe(3);
      expect((await h.userRow(victim.id)).lockedUntil!.getTime()).toBeGreaterThan(
        s.clock.now().getTime(),
      );
    } finally {
      await Promise.all(pools.map((p) => p.end()));
      await h.resetUser(victim.id);
    }
  });

  it('password sbagliate insieme: ognuna conta, e il blocco scatta alla soglia', async () => {
    const victim = s.users.segreteria;
    // Due insieme, una meno della soglia: il conto è due, nessun blocco.
    await h.resetUser(victim.id);
    let since = await h.lastSeq();
    await Promise.all(['prima', 'seconda'].map((p) => h.access(victim.username, `sbagliata ${p}`)));
    expect(await h.userRow(victim.id)).toMatchObject({ failedLogins: 2, lockedUntil: null });
    expect((await h.logSince(victim.id, 'accesso_fallito', since)).map((d) => d.motivo)).toEqual([
      'password errata',
      'password errata',
    ]);
    // Tre insieme, la soglia: bloccata.
    await h.resetUser(victim.id);
    await Promise.all([1, 2, 3].map((i) => h.access(victim.username, `sbagliata ${i}`)));
    expect((await h.userRow(victim.id)).lockedUntil!.getTime()).toBeGreaterThan(
      s.clock.now().getTime(),
    );
    // Trenta insieme: tutte guardate sono nel registro e contate; la giusta dopo non passa.
    await h.resetUser(victim.id);
    since = await h.lastSeq();
    const all = await Promise.all(
      Array.from({ length: 30 }, (_, i) => h.access(victim.username, `indovinata numero ${i}`)),
    );
    expect(all.every((r) => r.statusCode === 401)).toBe(true);
    const failures = await h.logSince(victim.id, 'accesso_fallito', since);
    const evaluated = failures.filter((d) => d.motivo === 'password errata').length;
    // Quelle partite dopo il blocco non si guardano nemmeno: il registro le dice bloccate.
    expect(evaluated + failures.filter((d) => d.motivo !== 'password errata').length).toBe(30);
    expect(evaluated).toBeGreaterThanOrEqual(3);
    const row = await h.userRow(victim.id);
    // Il conto torna a zero a ogni blocco: resta il resto della divisione per la soglia.
    expect(row.failedLogins).toBe(evaluated % 3);
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(s.clock.now().getTime());
    expect((await h.access(victim.username, PASSWORD)).json().errore).toBe(LOCKED_LOGIN_ERROR);
    await h.resetUser(victim.id);
  });

  it('arrivate dopo il blocco, la password giusta e quella sbagliata ricevono lo stesso messaggio, e nessun passaggio si apre', async () => {
    const victim = s.users.segreteria;
    await h.resetUser(victim.id);
    const challenges = await h.challengesOf(victim.id);
    const holder = await t.pool.connect();
    let results: Awaited<ReturnType<typeof h.access>>[];
    try {
      await holder.query('begin');
      await holder.query('select id from app_user where id = $1 for no key update', [victim.id]);
      // Tutte e due hanno già letto l'utente senza blocco e verificano la password.
      const wrong = h.access(victim.username, 'una password sbagliata');
      const right = h.access(victim.username, PASSWORD);
      await waiting(2);
      // Il blocco arriva mentre aspettano (per esempio da altri tentativi sbagliati).
      await holder.query('update app_user set locked_until = $2 where id = $1', [
        victim.id,
        new Date(s.clock.now().getTime() + 3_600_000),
      ]);
      await holder.query('commit');
      results = await Promise.all([wrong, right]);
    } finally {
      await holder.query('rollback').catch(() => undefined);
      holder.release();
    }
    expect(results.map((r) => [r.statusCode, r.json().errore])).toEqual([
      [401, LOCKED_LOGIN_ERROR],
      [401, LOCKED_LOGIN_ERROR],
    ]);
    expect(await h.challengesOf(victim.id)).toBe(challenges);
    await h.resetUser(victim.id);
  });

  it('cambio della password e sblocco della sessione: con il blocco arrivato a metà, la password giusta non cambia nulla e il codice giusto non sblocca', async () => {
    const victim = s.users.sostituto;
    await h.resetUser(victim.id);
    const cookie = await h.loginAs(victim.username, PASSWORD);
    const until = () => new Date(s.clock.now().getTime() + 3_600_000);
    // Cambio della password: la verifica della password attuale aspetta la riga.
    const holder = await t.pool.connect();
    try {
      await holder.query('begin');
      await holder.query('select id from app_user where id = $1 for no key update', [victim.id]);
      const change = h.req(cookie, 'POST', '/api/profilo/password', {
        passwordAttuale: PASSWORD,
        nuovaPassword: 'una password nuova che non deve valere',
      });
      await waiting(1);
      await holder.query('update app_user set locked_until = $2 where id = $1', [
        victim.id,
        until(),
      ]);
      await holder.query('commit');
      const r = await change;
      expect(r.statusCode).toBe(429);
      expect(r.json().errore).toBe(LOCKED_CHANGE_ERROR);
    } finally {
      await holder.query('rollback').catch(() => undefined);
      holder.release();
    }
    expect((await h.userRow(victim.id)).mustChangePassword).toBe(false);
    await h.resetUser(victim.id);
    expect((await h.access(victim.username, PASSWORD)).json().passo).toBe('secondo-fattore');
    // Sblocco della sessione dopo l'inattività: lo stesso.
    await t.db
      .update(session)
      .set({ lockedAt: s.clock.now() })
      .where(eq(session.tokenHash, hashToken(cookie.slice('sessione='.length))));
    s.clock.advance(30_000);
    const code = h.validCodes(victim.username)[1]!;
    const holder2 = await t.pool.connect();
    try {
      await holder2.query('begin');
      await holder2.query('select id from app_user where id = $1 for no key update', [victim.id]);
      const unlock = h.req(cookie, 'POST', '/api/accesso/sblocca', { codice: code });
      await waiting(1);
      await holder2.query('update app_user set locked_until = $2 where id = $1', [
        victim.id,
        until(),
      ]);
      await holder2.query('commit');
      expect((await unlock).statusCode).toBe(401);
    } finally {
      await holder2.query('rollback').catch(() => undefined);
      holder2.release();
    }
    expect((await h.req(cookie, 'GET', '/api/io')).statusCode).toBe(423);
    await h.resetUser(victim.id);
  });

  it('un passaggio di attivazione aperto prima non vale dopo l’attivazione: niente seconda sessione, il segreto resta (terza revisione)', async () => {
    const victim = s.users.sostituto;
    // Il secondo fattore da attivare, come dopo un azzeramento.
    await t.db
      .update(appUser)
      .set({ totpEnabledAt: null, totpSecretEnc: null, totpLastStep: null })
      .where(eq(appUser.id, victim.id));
    await h.resetUser(victim.id);
    s.clock.advance(60_000);
    // Due accessi: due passaggi di attivazione, con due segreti diversi.
    const first = (await h.access(victim.username, PASSWORD)).json<{
      passaggio: string;
      segreto: string;
    }>();
    const second = (await h.access(victim.username, PASSWORD)).json<{
      passaggio: string;
      segreto: string;
    }>();
    expect(first.segreto).toBeTruthy();
    expect(second.segreto).toBeTruthy();
    expect(second.segreto).not.toBe(first.segreto);
    const at = () => s.clock.now().getTime();
    const sessions = await h.sessionsOf(victim.id);
    const ok = await h.codeOn(first.passaggio, totp(base32Decode(first.segreto), at()));
    expect(ok.statusCode, ok.body).toBe(200);
    // L'attivazione chiude l'altro passaggio.
    expect((await h.challengeOf(second.passaggio)).usedAt).not.toBeNull();
    const late = await h.codeOn(second.passaggio, totp(base32Decode(second.segreto), at()));
    expect(late.statusCode).toBe(401);
    // Anche riaperto a mano, il passaggio di attivazione non vale: il secondo fattore è attivo.
    await t.db
      .update(authChallenge)
      .set({ usedAt: null })
      .where(eq(authChallenge.tokenHash, hashToken(second.passaggio)));
    s.clock.advance(30_000);
    const reopened = await h.codeOn(second.passaggio, totp(base32Decode(second.segreto), at()));
    expect(reopened.statusCode).toBe(401);
    expect(reopened.json().errore).toBe(EXPIRED_CHALLENGE_ERROR);
    expect(await h.sessionsOf(victim.id)).toBe(sessions + 1);
    // Il segreto è quello attivato con il primo passaggio.
    s.clock.advance(30_000);
    const again = (await h.access(victim.username, PASSWORD)).json<{
      passaggio: string;
      segreto?: string;
    }>();
    expect(again.segreto).toBeUndefined();
    const back = await h.codeOn(again.passaggio, totp(base32Decode(first.segreto), at()));
    expect(back.statusCode, back.body).toBe(200);
  });
});

describe('attese sui blocchi (seconda revisione, problema nuovo 2)', () => {
  let s: Scenario;
  let h: ReturnType<typeof helpers>;
  let admin: string;

  beforeAll(async () => {
    s = await createScenario(t.db, { idleLockMinutes: null });
    for (const who of ['titolare', 'collega', 'segreteria', 'sostituto'] as const)
      await login(s, who);
    admin = await login(s, 'amministratore');
    h = helpers(s);
  });
  afterAll(async () => {
    await s?.app.close();
  });

  /**
   * Una scrittura lunga nell'archivio del titolare, come un'importazione: resta aperta. Dice anche
   * il processo di Postgres che la tiene, per trovare chi la aspetta.
   */
  async function holdArchiveWrite(ownerId: string) {
    const [own] = await t.db.select().from(archive).where(eq(archive.ownerUserId, ownerId));
    const [p] = generatePatients({ seed: `attesa-${randomBytes(3).toString('hex')}`, count: 1 });
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    let inserted!: (pid: number) => void;
    const insertedP = new Promise<number>((r) => (inserted = r));
    const writing = withActor(t.db, ownerId, async (tx) => {
      const pid = (await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`)).rows[0]!
        .pid;
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
      inserted(pid);
      await hold;
    });
    const holderPid = await insertedP;
    return { release, writing, holderPid };
  }

  /** Il processo che aspetta i blocchi tenuti da `pid`. */
  async function waiterOf(pid: number): Promise<number> {
    for (let i = 0; i < 400; i++) {
      const { rows } = await monitor.query<{ pid: number }>(
        'select pid from pg_stat_activity where $1 = any(pg_blocking_pids(pid))',
        [pid],
      );
      if (rows[0]) return rows[0].pid;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('Nessuna transazione aspetta la scrittura');
  }

  /** Quante transazioni aspettano i blocchi tenuti da `pid`, adesso. */
  async function blockedBy(pid: number): Promise<number> {
    const { rows } = await monitor.query<{ n: number }>(
      'select count(*)::int as n from pg_stat_activity where $1 = any(pg_blocking_pids(pid))',
      [pid],
    );
    return rows[0]!.n;
  }

  it('la sospensione che aspetta un’importazione risponde 409 entro pochi secondi, e intanto gli accessi dello studio e il servizio vanno avanti', async () => {
    // Un altro studio, con il suo amministratore dentro.
    const sfx = randomBytes(2).toString('hex');
    const other = await createFirstStudio(t.db, {
      nome: 'Altro studio delle attese',
      tipo: 'singolo',
      regione: 'piemonte',
      amministratore: `adm.attese.${sfx}`,
      nomeAmministratore: 'Amministratore delle attese',
    });
    const otherCookie = await h.loginAs(`adm.attese.${sfx}`, other.temporaryPassword);
    const victim = s.users.collega;
    const { release, writing, holderPid } = await holdArchiveWrite(victim.id);
    let peakBlocked = 0;
    try {
      const started = Date.now();
      const susp = h
        .req(admin, 'POST', `/api/studio/utenti/${victim.id}/sospendi`)
        .then((r) => ({ r, ms: Date.now() - started }));
      // La sospensione aspetta l'archivio: chi aspetta lei, intanto?
      const suspensionPid = await waiterOf(holderPid);
      const watch = setInterval(() => {
        void blockedBy(suspensionPid).then((n) => (peakBlocked = Math.max(peakBlocked, n)));
      }, 20);
      try {
        // Mentre la sospensione aspetta: la titolare entra (password e codice), otto password
        // sbagliate della segreteria si contano, l'amministratore dell'altro studio lavora.
        const [cookie, wrongs, io] = await Promise.all([
          h.loginAs(s.users.titolare.username, PASSWORD),
          Promise.all(
            Array.from({ length: 8 }, (_, i) => h.access(s.users.segreteria.username, `no ${i}`)),
          ),
          h.req(otherCookie, 'GET', '/api/io'),
        ]);
        expect(cookie).toMatch(/^sessione=/);
        // Nessuna aspetta i blocchi della sospensione: nessun 503. Si contano (soglia 5: le
        // ultime trovano la segreteria bloccata).
        expect(wrongs.map((r) => r.statusCode)).toEqual(Array(8).fill(401));
        expect(
          wrongs.every((r) =>
            [GENERIC_LOGIN_ERROR, LOCKED_LOGIN_ERROR].includes(r.json().errore as string),
          ),
        ).toBe(true);
        expect(io.statusCode).toBe(200);
      } finally {
        clearInterval(watch);
      }
      const { r, ms } = await susp;
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().errore).toBe(ARCHIVE_BUSY_REFUSAL);
      expect(ms).toBeGreaterThanOrEqual(1_900);
      expect(ms).toBeLessThan(8_000);
      // Nessuno ha aspettato i blocchi della sospensione: mentre lei aspetta l'archivio non tiene
      // gli utenti dello studio, e le connessioni del servizio non si fermano dietro di lei.
      expect(peakBlocked).toBe(0);
      const refusal = (
        await t.db
          .select()
          .from(accessLog)
          .where(and(eq(accessLog.studioId, s.studioId), eq(accessLog.outcome, 'negato')))
          .orderBy(asc(accessLog.seq))
      )
        .map((x) => x.details as Record<string, unknown>)
        .filter((d) => d.area === 'utenti' && d.azione === 'sospensione')
        .at(-1);
      expect(refusal).toMatchObject({ utente: victim.username, motivo: ARCHIVE_BUSY_REFUSAL });
    } finally {
      release();
      await writing;
      await h.resetUser(s.users.segreteria.id);
    }
    // Finita la scrittura, la sospensione vede i pazienti e rifiuta per quelli.
    const again = await h.req(admin, 'POST', `/api/studio/utenti/${victim.id}/sospendi`);
    expect(again.statusCode).toBe(409);
    expect(again.json().errore).toBe(OWNER_SUSPEND_REFUSAL);
    expect((await h.userRow(victim.id)).status).toBe('active');
  });

  it('nell’accesso, con la riga dell’utente occupata oltre un secondo: 503, e il tentativo non si conta', async () => {
    const victim = s.users.segreteria;
    await h.resetUser(victim.id);
    const cookie = await h.loginAs(victim.username, PASSWORD);
    // Un passaggio aperto prima, per il codice.
    s.clock.advance(30_000);
    const ch = (await h.access(victim.username, PASSWORD)).json().passaggio as string;
    const sessions = await h.sessionsOf(victim.id);
    const challenges = await h.challengesOf(victim.id);
    const holder = await t.pool.connect();
    try {
      await holder.query('begin');
      await holder.query('select id from app_user where id = $1 for no key update', [victim.id]);
      const busy = (r: { statusCode: number; json: () => { errore?: string } }) => [
        r.statusCode,
        r.json().errore,
      ];
      expect(busy(await h.access(victim.username, 'una password sbagliata'))).toEqual([
        503,
        SERVICE_BUSY_ERROR,
      ]);
      expect(busy(await h.access(victim.username, PASSWORD))).toEqual([503, SERVICE_BUSY_ERROR]);
      expect(busy(await h.codeOn(ch, h.validCodes(victim.username)[1]!))).toEqual([
        503,
        SERVICE_BUSY_ERROR,
      ]);
      expect(
        busy(
          await h.req(cookie, 'POST', '/api/profilo/password', {
            passwordAttuale: 'non è questa la password',
            nuovaPassword: 'una password nuova e lunga',
          }),
        ),
      ).toEqual([503, SERVICE_BUSY_ERROR]);
      // Sblocco della sessione dopo l'inattività, con il codice giusto: lo stesso.
      await t.db
        .update(session)
        .set({ lockedAt: s.clock.now() })
        .where(eq(session.tokenHash, hashToken(cookie.slice('sessione='.length))));
      expect(
        busy(
          await h.req(cookie, 'POST', '/api/accesso/sblocca', {
            codice: h.validCodes(victim.username)[1]!,
          }),
        ),
      ).toEqual([503, SERVICE_BUSY_ERROR]);
    } finally {
      await holder.query('commit');
      await holder.query('rollback').catch(() => undefined);
      holder.release();
    }
    // Niente contato, niente aperto.
    expect(await h.userRow(victim.id)).toMatchObject({ failedLogins: 0, lockedUntil: null });
    expect(await h.sessionsOf(victim.id)).toBe(sessions);
    expect(await h.challengesOf(victim.id)).toBe(challenges);
    // Libera la riga, tutto torna a funzionare.
    s.clock.advance(30_000);
    expect((await h.codeOn(ch, h.validCodes(victim.username)[1]!)).statusCode).toBe(200);
  });

  it('anche il cambio dei ruoli di un titolare aspetta l’archivio al più due secondi, poi 409', async () => {
    const victim = s.users.collega;
    const { release, writing } = await holdArchiveWrite(victim.id);
    try {
      const started = Date.now();
      const r = await h.req(admin, 'PATCH', `/api/studio/utenti/${victim.id}`, {
        ruoli: ['substitute_doctor'],
      });
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().errore).toBe(ARCHIVE_BUSY_REFUSAL);
      expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
    } finally {
      release();
      await writing;
    }
    expect((await h.userRow(victim.id)).roles).toEqual(['owner_doctor']);
  });

  it('l’attesa massima vale solo per il blocco della riga: dopo, la sospensione e l’accesso aspettano il registro quanto serve', async () => {
    // Un titolare nuovo senza pazienti, confermato dalla titolare: la sospensione ne blocca
    // l'archivio con l'attesa massima, poi scrive il registro.
    const created = await h.req(admin, 'POST', '/api/studio/utenti', {
      nomeUtente: `titolare.attesa.${randomBytes(2).toString('hex')}`,
      nome: 'Dott. Attesi',
      ruoli: ['owner_doctor'],
      medico: { codiceFiscale: cf('Attesi', 'Aldo', 'M'), nome: 'Aldo', cognome: 'Attesi' },
    });
    expect(created.statusCode, created.body).toBe(201);
    const ownerId = created.json().utente.id as string;
    const owner = await h.loginAs(s.users.titolare.username, PASSWORD);
    const confirmed = await h.req(owner, 'POST', `/api/studio/utenti/${ownerId}/conferma`, {
      richiestaIl: created.json().utente.richiestaDiConferma.il,
    });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    // Un utente di un altro studio, che apre il passaggio prima: il suo codice scrive il registro.
    // (Uno dello stesso studio aspetterebbe gli utenti, bloccati dalla sospensione fino alla sua
    // fine: dopo un secondo, 503.)
    const sfx = randomBytes(2).toString('hex');
    const other = await createFirstStudio(t.db, {
      nome: 'Studio dell’attesa sul registro',
      tipo: 'singolo',
      regione: 'piemonte',
      amministratore: `adm.registro.${sfx}`,
      nomeAmministratore: 'Amministratore del registro',
    });
    await h.firstAccess(
      `adm.registro.${sfx}`,
      other.temporaryPassword,
      'la password dell amministratore del registro',
    );
    s.clock.advance(30_000);
    const opened = await h.access(
      `adm.registro.${sfx}`,
      'la password dell amministratore del registro',
    );
    expect(opened.statusCode, opened.body).toBe(200);
    // La prova tiene il blocco del registro (migrazione 0002) più a lungo delle attese massime.
    const holder = await t.pool.connect();
    try {
      await holder.query('begin');
      await holder.query('select pg_advisory_xact_lock(4620119)');
      const suspending = h.req(admin, 'POST', `/api/studio/utenti/${ownerId}/sospendi`);
      const signing = h.codeOn(opened.json().passaggio, h.validCodes(`adm.registro.${sfx}`)[1]!);
      await waiting(2);
      await new Promise((r) => setTimeout(r, 2_500));
      await holder.query('commit');
      const [susp, signed] = await Promise.all([suspending, signing]);
      expect(susp.statusCode, susp.body).toBe(200);
      expect(signed.statusCode, signed.body).toBe(200);
    } finally {
      await holder.query('rollback').catch(() => undefined);
      holder.release();
    }
    expect((await h.userRow(ownerId)).status).toBe('suspended');
  });

  it('se l’utente diventa titolare tra la prima lettura e il blocco, la sospensione si ferma invece di bloccare l’archivio dopo', async () => {
    const created = await h.req(admin, 'POST', '/api/studio/utenti', {
      nomeUtente: `amm.diventa.${randomBytes(2).toString('hex')}`,
      nome: 'Amministratore che diventa titolare',
      ruoli: ['administrator'],
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().utente.id as string;
    const holder = await t.pool.connect();
    let results: Awaited<ReturnType<typeof h.req>>[];
    try {
      await holder.query('begin');
      await holder.query('select pg_advisory_xact_lock(4620119)');
      // Il cambio dei ruoli resta a metà, con gli utenti dello studio bloccati.
      const promoting = h.req(admin, 'PATCH', `/api/studio/utenti/${id}`, {
        ruoli: ['administrator', 'owner_doctor'],
        medico: { codiceFiscale: cf('Diventi', 'Ada', 'F'), nome: 'Ada', cognome: 'Diventi' },
      });
      await waiting(1);
      // La sospensione legge l'utente com'era (non titolare) e aspetta gli utenti dello studio.
      const suspending = h.req(admin, 'POST', `/api/studio/utenti/${id}/sospendi`);
      await waiting(2);
      await holder.query('commit');
      results = await Promise.all([promoting, suspending]);
    } finally {
      await holder.query('rollback').catch(() => undefined);
      holder.release();
    }
    expect(results[0]!.statusCode, results[0]!.body).toBe(200);
    expect(results[1]!.statusCode, results[1]!.body).toBe(409);
    expect(results[1]!.json().errore).toBe(CHANGED_MEANWHILE);
    expect((await h.userRow(id)).status).toBe('active');
  });

  it('un ripristino dal server a metà del codice giusto non lascia una sessione', async () => {
    const victim = s.users.titolare;
    await h.resetUser(victim.id);
    s.clock.advance(60_000);
    const started = await h.access(victim.username, PASSWORD);
    expect(started.statusCode, started.body).toBe(200);
    const ch = started.json().passaggio as string;
    const code = h.validCodes(victim.username)[1]!;
    const [orig] = await t.db.select().from(appUser).where(eq(appUser.id, victim.id));
    const sessions = await h.sessionsOf(victim.id);
    const client = await t.pool.connect();
    try {
      // Come il comando del server: utente bloccato, password cambiata, passaggi chiusi.
      await client.query('begin');
      await client.query('select id from app_user where id = $1 for update', [victim.id]);
      await client.query("update app_user set password_hash = 'x' where id = $1", [victim.id]);
      await client.query(
        'update auth_challenge set used_at = now() where user_id = $1 and used_at is null',
        [victim.id],
      );
      const pending = h.codeOn(ch, code);
      await waiting(1);
      await client.query('commit');
      const r = await pending;
      expect(r.statusCode, r.body).toBe(401);
      expect(await h.sessionsOf(victim.id)).toBe(sessions);
    } finally {
      await client.query('rollback').catch(() => undefined);
      client.release();
    }
    await t.db
      .update(appUser)
      .set({ passwordHash: orig!.passwordHash })
      .where(eq(appUser.id, victim.id));
  });
});

describe('gara inversa della sospensione (seconda revisione, punto 7)', () => {
  let s: Scenario;
  let h: ReturnType<typeof helpers>;
  const c = {} as Record<'amministratore' | 'titolare' | 'segreteria', string>;
  const sfx = randomBytes(2).toString('hex');

  beforeAll(async () => {
    s = await createScenario(t.db, { idleLockMinutes: null });
    c.amministratore = await login(s, 'amministratore');
    c.titolare = await login(s, 'titolare');
    c.segreteria = await login(s, 'segreteria');
    h = helpers(s);
  });
  afterAll(async () => {
    await s?.app.close();
  });

  /** Un titolare nuovo, confermato dalla titolare, con l'archivio vuoto e il primo accesso fatto. */
  async function newOwner(tag: string, surname: string) {
    const created = await h.req(c.amministratore, 'POST', '/api/studio/utenti', {
      nomeUtente: `${tag}.${sfx}`,
      nome: `Dott. ${surname}`,
      ruoli: ['owner_doctor'],
      medico: { codiceFiscale: cf(surname, 'Carlo', 'M'), nome: 'Carlo', cognome: surname },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().utente.id as string;
    const pending = (await h.req(c.titolare, 'GET', '/api/studio/utenti/da-confermare'))
      .json()
      .utenti.find((x: { id: string }) => x.id === id);
    const ok = await h.req(c.titolare, 'POST', `/api/studio/utenti/${id}/conferma`, {
      richiestaIl: pending.richiesta.il,
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const cookie = await h.firstAccess(
      `${tag}.${sfx}`,
      ok.json().passwordTemporanea,
      `la password del dottor ${surname}`,
    );
    const [own] = await t.db.select().from(archive).where(eq(archive.ownerUserId, id));
    return { id, cookie, archiveId: own!.id };
  }

  const person = (n: number) => {
    const [p] = generatePatients({ seed: `gara-${sfx}-${n}`, count: 1 });
    return {
      cognome: p!.lastName,
      nome: p!.firstName,
      sesso: p!.sex,
      nascita: p!.birthDate,
      luogoNascitaCodice: p!.birthPlace.code,
      luogoNascita: p!.birthPlace.name,
      codiceFiscale: p!.fiscalCode,
    };
  };
  const patientsIn = async (archiveId: string) =>
    (await t.db.select({ n: count() }).from(patient).where(eq(patient.archiveId, archiveId)))[0]!.n;

  /**
   * La sospensione resta a metà: archivio del titolare bloccato e stato già cambiato, ferma sul
   * blocco con cui il registro mette in fila le sue righe (migrazione 0002), che tiene la prova.
   */
  async function suspensionInProgress(ownerId: string) {
    const holder = await t.pool.connect();
    await holder.query('begin');
    await holder.query('select pg_advisory_xact_lock(4620119)');
    const suspended = h.req(c.amministratore, 'POST', `/api/studio/utenti/${ownerId}/sospendi`);
    await waiting(1);
    return {
      suspended,
      finish: async () => {
        await holder.query('commit');
        await holder.query('rollback').catch(() => undefined);
        holder.release();
      },
    };
  }

  it('dal pannello: un paziente che entra mentre il titolare viene sospeso aspetta la sospensione, e non entra', async () => {
    const owner = await newOwner('gara.pannello', 'Pannelli');
    const susp = await suspensionInProgress(owner.id);
    let created: Awaited<ReturnType<typeof h.req>>;
    let suspended: Awaited<ReturnType<typeof h.req>>;
    try {
      const creating = h.req(c.segreteria, 'POST', '/api/pazienti', {
        archivioId: owner.archiveId,
        identita: person(1),
      });
      // Il paziente aspetta il blocco dell'archivio, preso dalla sospensione.
      await waiting(2);
      await susp.finish();
      [suspended, created] = await Promise.all([susp.suspended, creating]);
    } catch (e) {
      await susp.finish().catch(() => undefined);
      throw e;
    }
    expect(suspended.statusCode, suspended.body).toBe(200);
    expect(created.statusCode, created.body).toBe(409);
    expect(created.json().errore).toBe(OWNER_SUSPENDED_NO_NEW_PATIENTS);
    expect(await patientsIn(owner.archiveId)).toBe(0);
    // Il rifiuto è nel registro, con il motivo.
    const [row] = await t.db
      .select()
      .from(accessLog)
      .where(
        and(
          eq(accessLog.userId, s.users.segreteria.id),
          eq(accessLog.action, 'nuovo_paziente'),
          eq(accessLog.outcome, 'negato'),
        ),
      )
      .orderBy(asc(accessLog.seq));
    expect(row!.details).toMatchObject({
      archivio: owner.archiveId,
      motivo: OWNER_SUSPENDED_NO_NEW_PATIENTS,
    });
    // E dopo, con il titolare sospeso, lo stesso.
    const later = await h.req(c.segreteria, 'POST', '/api/pazienti', {
      archivioId: owner.archiveId,
      identita: person(2),
    });
    expect(later.statusCode).toBe(409);
    expect(later.json().errore).toBe(OWNER_SUSPENDED_NO_NEW_PATIENTS);
  });

  it('dall’importazione: la prova che parte mentre il titolare viene sospeso aspetta, e si ferma', async () => {
    const owner = await newOwner('gara.import', 'Importi');
    const header = ['Codice fiscale', 'Cognome', 'Nome', 'Sesso', 'Data di nascita'];
    const p = person(3);
    const csv = [header, [p.codiceFiscale, p.cognome, p.nome, p.sesso, p.nascita]]
      .map((r) => r.join(';'))
      .join('\r\n');
    const up = await h.req(owner.cookie, 'POST', '/api/importazioni', {
      nome: 'assistiti.csv',
      contenuto: Buffer.from(strToU8(`${csv}\r\n`)).toString('base64'),
    });
    expect(up.statusCode, up.body).toBe(201);
    const ref = (name: string) => ({
      colonna: { lettera: column(header.indexOf(name)), nome: name },
    });
    const mappatura = {
      parti: [
        {
          tabella: 'CSV',
          intestazione: 1,
          destinazione: 'pazienti',
          campi: {
            codiceFiscale: ref('Codice fiscale'),
            cognome: ref('Cognome'),
            nome: ref('Nome'),
            sesso: ref('Sesso'),
            nascita: ref('Data di nascita'),
          },
        },
      ],
    };
    const susp = await suspensionInProgress(owner.id);
    let tried: Awaited<ReturnType<typeof h.req>>;
    let suspended: Awaited<ReturnType<typeof h.req>>;
    try {
      const trying = h.req(owner.cookie, 'POST', `/api/importazioni/${up.json().id}/prova`, {
        mappatura,
      });
      await waiting(2);
      await susp.finish();
      [suspended, tried] = await Promise.all([susp.suspended, trying]);
    } catch (e) {
      await susp.finish().catch(() => undefined);
      throw e;
    }
    expect(suspended.statusCode, suspended.body).toBe(200);
    expect(tried.statusCode, tried.body).toBe(409);
    expect(tried.json().errore).toBe(OWNER_SUSPENDED_NO_NEW_PATIENTS);
    expect(await patientsIn(owner.archiveId)).toBe(0);
  });

  it('nell’archivio di chi non è più titolare non entrano pazienti nuovi', async () => {
    const owner = await newOwner('gara.ruolo', 'Ruoli');
    const off = await h.req(c.amministratore, 'PATCH', `/api/studio/utenti/${owner.id}`, {
      ruoli: ['substitute_doctor'],
    });
    expect(off.statusCode, off.body).toBe(200);
    const r = await h.req(c.segreteria, 'POST', '/api/pazienti', {
      archivioId: owner.archiveId,
      identita: person(4),
    });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().errore).toBe(OWNER_GONE_NO_NEW_PATIENTS);
    // Un titolare attivo, invece, riceve i pazienti come prima.
    const ok = await h.req(c.segreteria, 'POST', '/api/pazienti', {
      archivioId: s.archives.titolare,
      identita: person(5),
    });
    expect(ok.statusCode, ok.body).toBe(201);
  });

  /** Un titolare creato dall'amministratore e non ancora confermato: in attesa, con il suo archivio. */
  async function awaitingOwner(tag: string, surname: string) {
    const created = await h.req(c.amministratore, 'POST', '/api/studio/utenti', {
      nomeUtente: `${tag}.${sfx}`,
      nome: `Dott. ${surname}`,
      ruoli: ['owner_doctor'],
      medico: { codiceFiscale: cf(surname, 'Carlo', 'M'), nome: 'Carlo', cognome: surname },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().utente.id as string;
    const [own] = await t.db.select().from(archive).where(eq(archive.ownerUserId, id));
    return { id, archiveId: own!.id };
  }

  it('nell’archivio di un titolare in attesa non entrano pazienti: non si propone, non si sceglie come medico di famiglia; dopo la conferma sì (terza revisione)', async () => {
    const owner = await awaitingOwner('gara.attesa', 'Attesi');
    const r = await h.req(c.segreteria, 'POST', '/api/pazienti', {
      archivioId: owner.archiveId,
      identita: person(7),
    });
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().errore).toBe(OWNER_AWAITING_NO_NEW_PATIENTS);
    expect(await patientsIn(owner.archiveId)).toBe(0);
    // Il modulo del nuovo paziente non propone il suo archivio.
    const form = (await h.req(c.segreteria, 'GET', '/api/pazienti/nuovo')).json<{
      archivi: { id: string }[];
    }>();
    expect(form.archivi.map((a) => a.id)).not.toContain(owner.archiveId);
    expect(form.archivi.map((a) => a.id)).toContain(s.archives.titolare);
    // Fra i medici di famiglia possibili non c'è.
    const view = (
      await h.req(c.segreteria, 'GET', `/api/pazienti/${s.patients.titolare[0]}/amministrazione`)
    ).json<{ medici: { id: string }[] }>();
    expect(view.medici.map((m) => m.id)).not.toContain(owner.id);
    expect(view.medici.map((m) => m.id)).toContain(s.users.titolare.id);
    // Confermato dalla titolare, il suo archivio riceve pazienti.
    const pending = (await h.req(c.titolare, 'GET', '/api/studio/utenti/da-confermare'))
      .json()
      .utenti.find((x: { id: string }) => x.id === owner.id);
    const ok = await h.req(c.titolare, 'POST', `/api/studio/utenti/${owner.id}/conferma`, {
      richiestaIl: pending.richiesta.il,
    });
    expect(ok.statusCode, ok.body).toBe(200);
    const later = await h.req(c.segreteria, 'POST', '/api/pazienti', {
      archivioId: owner.archiveId,
      identita: person(8),
    });
    expect(later.statusCode, later.body).toBe(201);
  });

  it('il rifiuto di un titolare in attesa blocca il suo archivio: con l’archivio occupato, 409 entro pochi secondi (terza revisione)', async () => {
    const owner = await awaitingOwner('gara.rifiuto', 'Rifiuti');
    // Un'altra transazione tiene la riga dell'archivio, come un paziente che sta entrando.
    const holder = await t.pool.connect();
    try {
      await holder.query('begin');
      await holder.query('select id from archive where id = $1 for key share', [owner.archiveId]);
      const started = Date.now();
      const r = await h.req(c.titolare, 'POST', `/api/studio/utenti/${owner.id}/rifiuta`);
      expect(r.statusCode, r.body).toBe(409);
      expect(r.json().errore).toBe(ARCHIVE_BUSY_REFUSAL);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      await holder.query('rollback').catch(() => undefined);
      holder.release();
    }
    const [still] = await t.db.select().from(appUser).where(eq(appUser.id, owner.id));
    expect(still!.status).toBe('active');
    // Libero l'archivio, il rifiuto passa.
    const r2 = await h.req(c.titolare, 'POST', `/api/studio/utenti/${owner.id}/rifiuta`);
    expect(r2.statusCode, r2.body).toBe(200);
  });

  it('un titolare in attesa con pazienti già nell’archivio non si rifiuta dal programma: lo sospenderebbe con i pazienti (terza revisione)', async () => {
    const owner = await newOwner('gara.rifiuto2', 'Scartini');
    const p = await h.req(c.segreteria, 'POST', '/api/pazienti', {
      archivioId: owner.archiveId,
      identita: person(9),
    });
    expect(p.statusCode, p.body).toBe(201);
    // Uno stato che il programma non crea (un titolare con pazienti non va in attesa): come se i
    // pazienti fossero entrati prima della richiesta.
    await withActor(t.db, s.users.amministratore.id, (tx) =>
      tx
        .update(appUser)
        .set({ awaitingConfirmation: true, confirmationRequestedAt: s.clock.now() })
        .where(eq(appUser.id, owner.id)),
    );
    const r = await h.req(c.titolare, 'POST', `/api/studio/utenti/${owner.id}/rifiuta`);
    expect(r.statusCode, r.body).toBe(409);
    expect(r.json().errore).toBe(OWNER_REFUSE_REFUSAL);
    const [u] = await t.db.select().from(appUser).where(eq(appUser.id, owner.id));
    expect(u!.status).toBe('active');
  });

  it('il comando del server: --sospendi blocca anche lui l’archivio, e il paziente che arriva durante non entra', async () => {
    const owner = await newOwner('gara.server', 'Serveri');
    // Il comando resta a metà, fermo sul blocco del registro che tiene la prova.
    const holder = await t.pool.connect();
    let created: Awaited<ReturnType<typeof h.req>>;
    try {
      await holder.query('begin');
      await holder.query('select pg_advisory_xact_lock(4620119)');
      const suspending = restoreUser(
        t.db,
        { utente: `gara.server.${sfx}`, sospendi: true },
        { now: s.clock.now },
      );
      await waiting(1);
      const creating = h.req(c.segreteria, 'POST', '/api/pazienti', {
        archivioId: owner.archiveId,
        identita: person(6),
      });
      await waiting(2);
      await holder.query('commit');
      const [done] = await Promise.all([suspending, creating.then((r) => (created = r))]);
      expect(done.actions).toEqual(['sospensione']);
    } finally {
      await holder.query('rollback').catch(() => undefined);
      holder.release();
    }
    expect(created!.statusCode, created!.body).toBe(409);
    expect(created!.json().errore).toBe(OWNER_SUSPENDED_NO_NEW_PATIENTS);
    expect(await patientsIn(owner.archiveId)).toBe(0);
  });
});

describe('indirizzo della richiesta dietro un proxy (seconda revisione, punti 4 e 9)', () => {
  let s: Scenario;

  beforeAll(async () => {
    s = await createScenario(t.db, { idleLockMinutes: null, maxFailedLogins: null });
  });
  afterAll(async () => {
    await s?.app.close();
  });

  const appWith = (trustedProxies?: string[]) =>
    buildApp({
      db: t.db,
      config: {
        encryptionKey: s.encryptionKey,
        sessionMaxHours: 12,
        cookieSecure: false,
        ...(trustedProxies ? { trustedProxies } : {}),
      },
      now: s.clock.now,
      secondFactor: s.secondFactor,
    });

  /** Un accesso sbagliato da `remoteAddress`, con un X-Forwarded-For; l'indirizzo nel registro. */
  async function addressOf(
    app: ReturnType<typeof buildApp>,
    remoteAddress: string,
    forwarded: string,
  ) {
    const user = s.users.amministratore;
    const r = await app.inject({
      method: 'POST',
      url: '/api/accesso',
      remoteAddress,
      headers: { 'x-forwarded-for': forwarded },
      payload: { username: user.username, password: 'una password sbagliata', postazione: 'p' },
    });
    expect(r.statusCode).toBe(401);
    const [row] = await t.db
      .select()
      .from(accessLog)
      .where(and(eq(accessLog.userId, user.id), eq(accessLog.action, 'accesso_fallito')))
      .orderBy(sql`${accessLog.seq} desc`)
      .limit(1);
    return (row!.details as { indirizzo: string }).indirizzo;
  }

  it('senza proxy fidati un X-Forwarded-For scritto da chi accede non cambia l’indirizzo', async () => {
    expect(await addressOf(s.app, '127.0.0.1', '203.0.113.7')).toBe('127.0.0.1');
    expect(await addressOf(s.app, '198.51.100.20', '203.0.113.7')).toBe('198.51.100.20');
  });

  it('con il proxy fidato vale l’indirizzo del cliente; con un altro proxy fidato no', async () => {
    const local = appWith(['127.0.0.1']);
    const otherProxy = appWith(['198.51.100.1']);
    const network = appWith(['198.51.100.0/24']);
    try {
      expect(await addressOf(local, '127.0.0.1', '203.0.113.7')).toBe('203.0.113.7');
      // Il cliente è il primo indirizzo non fidato da destra: un proxy non fidato in mezzo resta.
      expect(await addressOf(local, '127.0.0.1', '203.0.113.5, 198.51.100.66')).toBe(
        '198.51.100.66',
      );
      expect(await addressOf(otherProxy, '127.0.0.1', '203.0.113.7')).toBe('127.0.0.1');
      expect(await addressOf(network, '198.51.100.20', '203.0.113.9')).toBe('203.0.113.9');
      expect(await addressOf(network, '127.0.0.1', '203.0.113.9')).toBe('127.0.0.1');
    } finally {
      await Promise.all([local.close(), otherProxy.close(), network.close()]);
    }
  });
});

describe('sessione dei servizi durante la correzione del codice fiscale (seconda revisione, punto 8)', () => {
  /** Simulatore del Sistema TS che si ferma dentro la verifica del codice. */
  class Gated extends SimulatedSecondFactor {
    gate: Promise<void> | null = null;
    entered: (() => void) | null = null;
    override async check(input: Parameters<SimulatedSecondFactor['check']>[0]) {
      if (this.gate) {
        this.entered?.();
        await this.gate;
      }
      return super.check(input);
    }
  }
  let s: Scenario;
  let gated: Gated;

  beforeAll(async () => {
    gated = new Gated('sistema_ts', { now: () => s.clock.now() });
    const regional = new SimulatedSecondFactor('rupar_piemonte', { now: () => s.clock.now() });
    s = await createScenario(
      t.db,
      { idleLockMinutes: null },
      { secondFactor: { sistema_ts: gated, rupar_piemonte: regional } },
    );
  });
  afterAll(async () => {
    await s?.app.close();
  });

  it('la sessione salvata dopo la correzione, con il codice fiscale di prima, non vale e si chiude', async () => {
    const doctor = await login(s, 'titolare');
    const admin = await login(s, 'amministratore');
    const asked = await s.app.inject({
      method: 'POST',
      url: '/api/profilo/credenziali/sistema-ts/sessione/richiesta',
      headers: { cookie: doctor },
    });
    expect(asked.statusCode, asked.body).toBe(200);
    let release!: () => void;
    gated.gate = new Promise<void>((r) => (release = r));
    const entered = new Promise<void>((r) => (gated.entered = r));
    const confirming = s.app.inject({
      method: 'POST',
      url: '/api/profilo/credenziali/sistema-ts/sessione',
      headers: { cookie: doctor },
      payload: { codice: asked.json().codiceDiProva as string },
    });
    await entered;
    // L'amministratore corregge il codice fiscale mentre il servizio verifica il codice.
    const fix = await s.app.inject({
      method: 'PATCH',
      url: `/api/studio/utenti/${s.users.titolare.id}`,
      headers: { cookie: admin },
      payload: {
        medico: {
          codiceFiscale: buildFiscalCode({
            surname: 'Marchi',
            name: 'Elena',
            birthDate: '1971-02-02',
            sex: 'F',
            placeCode: 'X001',
          }),
          nome: 'Elena',
          cognome: 'Marchi',
        },
      },
    });
    expect(fix.statusCode, fix.body).toBe(200);
    gated.gate = null;
    release();
    expect((await confirming).statusCode).toBe(200);
    const rows = await t.db
      .select()
      .from(serviceSession)
      .where(eq(serviceSession.userId, s.users.titolare.id));
    expect(rows.some((r) => r.service === 'sistema_ts')).toBe(true);
    // Salvata dopo la chiusura: spenta nella pagina, rifiutata dagli invii, e chiusa.
    const st = await s.app.inject({
      method: 'GET',
      url: '/api/profilo/credenziali',
      headers: { cookie: doctor },
    });
    expect(
      st.json().servizi.find((x: { servizio: string }) => x.servizio === 'sistema-ts').sessione
        .attiva,
    ).toBe(false);
    const credentials = createCredentialService({
      db: t.db,
      encryptionKey: s.encryptionKey,
      now: s.clock.now,
      secondFactor: s.secondFactor,
    });
    await expect(credentials.authFor(s.users.titolare.id, 'ricetta_bianca')).rejects.toMatchObject({
      statusCode: 422,
    });
    expect(
      (
        await t.db
          .select()
          .from(serviceSession)
          .where(eq(serviceSession.userId, s.users.titolare.id))
      ).some((r) => r.service === 'sistema_ts'),
    ).toBe(false);
  });
});
