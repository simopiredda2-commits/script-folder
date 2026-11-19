import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LOGIN_SOURCE_LIMITS, waitAfter, waitText } from '../src/auth/login-sources';
import { GENERIC_LOGIN_ERROR, LOCKED_LOGIN_ERROR } from '../src/auth/service';
import { createDatabase } from '../src/db/client';
import { migrationsDir, runMigrations } from '../src/db/migrate';
import { accessLog, accountLock, appUser, loginSource, studio } from '../src/db/schema';
import { totp } from '../src/security/totp';
import { createScenario, login, PASSWORD, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

/**
 * Tentativi sbagliati (D181, D188): attese crescenti per indirizzo e postazione dopo le password
 * sbagliate; blocco del conto alla soglia alta per le password, alla soglia di prima per i codici;
 * un avviso di ogni blocco all'utente e ai medici titolari dello studio.
 */

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t?.drop();
});

/** Richieste dallo scenario, con l'indirizzo scelto (`req.ip`). */
function client(s: Scenario) {
  const attempt = (username: string, password: string, postazione: string, ip: string) =>
    s.app.inject({
      method: 'POST',
      url: '/api/accesso',
      payload: { username, password, postazione },
      remoteAddress: ip,
    });
  const get = (cookie: string, url: string) =>
    s.app.inject({ method: 'GET', url, headers: { cookie } });
  const post = (cookie: string, url: string, payload: object) =>
    s.app.inject({ method: 'POST', url, headers: { cookie }, payload });
  const failuresFrom = async (userId: string) =>
    (
      await t.db
        .select()
        .from(accessLog)
        .where(and(eq(accessLog.userId, userId), eq(accessLog.action, 'accesso_fallito')))
        .orderBy(asc(accessLog.seq))
    ).map((r) => r.details as { motivo: string; indirizzo: string; attesaSecondi?: number });
  const userRow = async (id: string) =>
    (await t.db.select().from(appUser).where(eq(appUser.id, id)))[0]!;
  return { attempt, get, post, failuresFrom, userRow };
}

describe('attese dopo le password sbagliate, per postazione e indirizzo', () => {
  let s: Scenario;
  let c: ReturnType<typeof client>;
  beforeAll(async () => {
    s = await createScenario(t.db);
    c = client(s);
  });
  afterAll(async () => {
    await s?.app.close();
  });

  it('i valori provvisori: 5 dalla postazione, 20 dall’indirizzo, da 2 secondi a 15 minuti', () => {
    expect(LOGIN_SOURCE_LIMITS).toEqual({
      workstationFree: 5,
      addressFree: 20,
      firstWaitSeconds: 2,
      maxWaitSeconds: 900,
      forgetAfterHours: 24,
    });
    expect([5, 6, 7, 8, 14, 15, 30].map((n) => waitAfter(n, 5, LOGIN_SOURCE_LIMITS))).toEqual([
      0, 2, 4, 8, 512, 900, 900,
    ]);
    expect([1, 2, 59, 60, 61, 900].map(waitText)).toEqual([
      '1 secondo',
      '2 secondi',
      '59 secondi',
      '1 minuto',
      '2 minuti',
      '15 minuti',
    ]);
  });

  it('dalla stessa postazione cinque password sbagliate passano, poi le attese raddoppiano; il medico da un’altra postazione entra', async () => {
    const victim = s.users.titolare;
    const ip = '10.1.0.1';
    const wrong = () => c.attempt(victim.username, 'non è questa', 'pc-sala-attesa', ip);
    for (let i = 0; i < 6; i++) {
      const r = await wrong();
      expect(r.statusCode).toBe(401);
      expect(r.json().errore).toBe(GENERIC_LOGIN_ERROR);
    }
    // La sesta ha fatto partire l'attesa: la settima non si guarda.
    const waiting = await wrong();
    expect(waiting.statusCode).toBe(429);
    expect(waiting.json()).toEqual({
      errore: 'Troppe password sbagliate da questa postazione: riprova tra 2 secondi',
      dettagli: { attesaSecondi: 2 },
    });
    expect(waiting.headers['retry-after']).toBe('2');
    // Anche la password giusta, da lì, aspetta.
    expect((await c.attempt(victim.username, PASSWORD, 'pc-sala-attesa', ip)).statusCode).toBe(429);
    // Dallo stesso indirizzo, un'altra postazione: il medico entra.
    const doctor = await c.attempt(victim.username, PASSWORD, 'ambulatorio', ip);
    expect(doctor.statusCode, doctor.body).toBe(200);
    // Passata l'attesa, la password sbagliata si guarda di nuovo e l'attesa raddoppia.
    s.clock.advance(2_000);
    expect((await wrong()).statusCode).toBe(401);
    expect((await wrong()).json().errore).toMatch(/riprova tra 4 secondi$/);
    s.clock.advance(4_000);
    expect((await wrong()).statusCode).toBe(401);
    expect((await wrong()).json().errore).toMatch(/riprova tra 8 secondi$/);
    // Nel registro le password guardate, con l'attesa che ognuna ha fatto partire; le richieste
    // respinte durante l'attesa non ci sono.
    expect((await c.failuresFrom(victim.id)).map((d) => d.attesaSecondi ?? 0)).toEqual([
      0, 0, 0, 0, 0, 2, 4, 8,
    ]);
    // Il conto non si è bloccato: otto password sono lontane dalla soglia alta.
    const row = await c.userRow(victim.id);
    expect(row.lockedUntil).toBeNull();
    expect(row.failedLogins).toBe(8);
  });

  it('cambiare il nome della postazione non basta: dallo stesso indirizzo, dopo venti, aspettano tutte; da un altro indirizzo no', async () => {
    const victim = s.users.collega;
    const ip = '10.2.0.1';
    for (let i = 0; i < 21; i++)
      expect((await c.attempt(victim.username, 'a caso', `pc-${i}`, ip)).statusCode).toBe(401);
    const waiting = await c.attempt(victim.username, 'a caso', 'pc-nuovo', ip);
    expect(waiting.statusCode).toBe(429);
    expect(waiting.json().errore).toBe(
      'Troppe password sbagliate da questo indirizzo: riprova tra 2 secondi',
    );
    expect((await c.attempt(victim.username, PASSWORD, 'studio', '10.2.0.2')).statusCode).toBe(200);
  });

  it('una password giusta fa ricominciare da capo la sua provenienza', async () => {
    const victim = s.users.segreteria;
    const ip = '10.3.0.1';
    const at = (password: string) => c.attempt(victim.username, password, 'segreteria', ip);
    for (let i = 0; i < 6; i++) expect((await at('sbagliata')).statusCode).toBe(401);
    expect((await at('sbagliata')).statusCode).toBe(429);
    s.clock.advance(2_000);
    expect((await at(PASSWORD)).statusCode).toBe(200);
    const rows = await t.db.select().from(loginSource);
    expect(rows.filter((r) => r.sourceKey.startsWith(ip))).toEqual([]);
    for (let i = 0; i < 6; i++) expect((await at('sbagliata')).statusCode).toBe(401);
    expect((await at('sbagliata')).json().errore).toMatch(/riprova tra 2 secondi$/);
  });

  it('dopo un giorno senza password sbagliate la provenienza ricomincia da capo', async () => {
    const victim = s.users.sostituto;
    const ip = '10.4.0.1';
    const wrong = () => c.attempt(victim.username, 'sbagliata', 'portatile', ip);
    for (let i = 0; i < 6; i++) expect((await wrong()).statusCode).toBe(401);
    expect((await wrong()).statusCode).toBe(429);
    s.clock.advance(24 * 3_600_000 + 1_000);
    for (let i = 0; i < 6; i++) expect((await wrong()).statusCode).toBe(401);
    // La prima attesa, non quella dopo dodici password.
    expect((await wrong()).json().errore).toMatch(/riprova tra 2 secondi$/);
  });

  it('venti password insieme dalla stessa postazione: se ne guardano sei, le altre aspettano', async () => {
    const victim = s.users.amministratore;
    const ip = '10.5.0.1';
    const all = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        c.attempt(victim.username, `insieme ${i}`, 'pc-insieme', ip),
      ),
    );
    const codes = all.map((r) => r.statusCode).sort();
    expect(codes).toEqual([...Array(6).fill(401), ...Array(14).fill(429)]);
    const looked = (await c.failuresFrom(victim.id)).filter((d) => d.indirizzo === ip);
    expect(looked).toHaveLength(6);
  });
});

describe('blocco del conto e avvisi del blocco', () => {
  let s: Scenario;
  let other: Scenario;
  let c: ReturnType<typeof client>;
  const cookies: Record<string, string> = {};
  beforeAll(async () => {
    // La soglia alta più bassa ammessa, perché la prova arrivi al blocco presto.
    s = await createScenario(t.db, { maxFailedLogins: 20 });
    other = await createScenario(t.db);
    c = client(s);
    for (const who of ['titolare', 'collega', 'sostituto', 'amministratore'] as const)
      cookies[who] = await login(s, who);
    cookies.altroStudio = await login(other, 'titolare');
  });
  afterAll(async () => {
    await s?.app.close();
    await other?.app.close();
  });

  const unseen = async (cookie: string) =>
    (await c.get(cookie, '/api/io')).json<{ blocchiDaVedere: number }>().blocchiDaVedere;

  it('venti password sbagliate da quattro indirizzi bloccano il conto; l’avviso va all’utente e ai titolari, non agli altri', async () => {
    const victim = s.users.segreteria;
    const before = s.clock.now();
    for (let k = 0; k < 4; k++)
      for (let i = 0; i < 5; i++) {
        const r = await c.attempt(victim.username, `prova ${k}.${i}`, 'pc-fuori', `10.9.${k}.1`);
        expect(r.statusCode).toBe(401);
        expect(r.json().errore).toBe(k === 3 && i === 4 ? LOCKED_LOGIN_ERROR : GENERIC_LOGIN_ERROR);
      }
    const row = await c.userRow(victim.id);
    expect(row.lockedUntil!.getTime() - before.getTime()).toBe(15 * 60_000);
    expect(row.failedLogins).toBe(0);
    const [lock] = await t.db.select().from(accountLock).where(eq(accountLock.userId, victim.id));
    expect(lock).toMatchObject({
      studioId: s.studioId,
      reason: 'passwords',
      failures: 20,
      // Gli indirizzi, il più recente per primo; la postazione scritta, una volta sola.
      addresses: ['10.9.3.1', '10.9.2.1', '10.9.1.1', '10.9.0.1'],
      workstations: ['pc-fuori'],
    });
    const logged = await t.db
      .select()
      .from(accessLog)
      .where(and(eq(accessLog.userId, victim.id), eq(accessLog.action, 'conto_bloccato')));
    expect(logged.map((l) => l.details)).toEqual([
      { motivo: 'password sbagliate', tentativi: 20, minuti: 15, indirizzo: '10.9.3.1' },
    ]);

    // I due titolari dello studio vedono l'avviso; il sostituto, l'amministratore e il titolare
    // di un altro studio no.
    expect(await unseen(cookies.titolare!)).toBe(1);
    expect(await unseen(cookies.collega!)).toBe(1);
    expect(await unseen(cookies.sostituto!)).toBe(0);
    expect(await unseen(cookies.amministratore!)).toBe(0);
    expect(await unseen(cookies.altroStudio!)).toBe(0);
    const list = await c.get(cookies.titolare!, '/api/blocchi');
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual({
      totale: 1,
      blocchi: [
        {
          id: lock!.id,
          utente: { id: victim.id, nome: expect.any(String), nomeUtente: victim.username },
          proprio: false,
          motivo: 'passwords',
          motivoTesto: 'password sbagliate',
          tentativi: 20,
          bloccatoIl: lock!.lockedAt.toISOString(),
          bloccatoFinoA: lock!.lockedUntil.toISOString(),
          indirizzi: lock!.addresses,
          postazioni: ['pc-fuori'],
        },
      ],
    });
    // Chi non lo vede non lo segna; il titolare sì, e resta da vedere per il collega.
    expect(
      (await c.post(cookies.sostituto!, '/api/blocchi/visti', { blocchi: [lock!.id] })).json(),
    ).toEqual({ segnati: 0 });
    expect(
      (await c.post(cookies.titolare!, '/api/blocchi/visti', { blocchi: [lock!.id] })).json(),
    ).toEqual({ segnati: 1 });
    expect(await unseen(cookies.titolare!)).toBe(0);
    expect(await unseen(cookies.collega!)).toBe(1);

    // Finito il blocco la segreteria entra e vede il suo avviso.
    s.clock.advance(15 * 60_000 + 1_000);
    cookies.segreteria = await login(s, 'segreteria');
    const own = (await c.get(cookies.segreteria, '/api/blocchi')).json<{
      blocchi: { proprio: boolean }[];
    }>();
    expect(own.blocchi.map((b) => b.proprio)).toEqual([true]);
    // Ogni lettura degli avvisi è nel registro.
    const reads = await t.db
      .select()
      .from(accessLog)
      .where(and(eq(accessLog.studioId, s.studioId), eq(accessLog.action, 'lettura_blocchi')));
    expect(reads.map((r) => r.userId)).toEqual([s.users.titolare.id, victim.id]);
  });

  it('i blocchi e chi li ha visti non si modificano e non si cancellano', async () => {
    await expect(t.db.update(accountLock).set({ failures: 1 })).rejects.toThrow();
    await expect(t.db.delete(accountLock)).rejects.toThrow();
    await expect(t.pool.query('truncate account_lock_seen')).rejects.toThrow();
  });

  it('cinque codici sbagliati bloccano il conto, come prima: chi li scrive conosceva la password', async () => {
    const victim = s.users.collega;
    const start = await c.attempt(victim.username, PASSWORD, 'pc-collega', '10.8.0.1');
    expect(start.statusCode, start.body).toBe(200);
    const passaggio = start.json<{ passaggio: string }>().passaggio;
    const valid = new Set(
      [-30_000, 0, 30_000].map((d) => totp(s.secrets.get(victim.id)!, s.clock.now().getTime() + d)),
    );
    const wrongCodes = ['000000', '111111', '222222', '333333', '444444'].filter(
      (x) => !valid.has(x),
    );
    expect(wrongCodes).toHaveLength(5);
    const answers: string[] = [];
    for (const codice of wrongCodes)
      answers.push(
        (
          await s.app.inject({
            method: 'POST',
            url: '/api/accesso/codice',
            payload: { passaggio, codice },
            remoteAddress: '10.8.0.1',
          })
        ).json<{ errore: string }>().errore,
      );
    expect(answers).toEqual([...Array(4).fill('Codice non valido'), LOCKED_LOGIN_ERROR]);
    const [lock] = await t.db.select().from(accountLock).where(eq(accountLock.userId, victim.id));
    expect(lock).toMatchObject({
      reason: 'codes',
      failures: 5,
      addresses: ['10.8.0.1'],
      workstations: ['pc-collega'],
    });
    expect((await c.userRow(victim.id)).failedCodes).toBe(0);
    // Il titolare lo vede (le sessioni di prima sono bloccate dall'inattività: si rientra).
    expect(await unseen(await login(s, 'titolare'))).toBe(1);
    // Finito il blocco lei vede il suo e quello della segreteria, che non ha ancora segnato.
    s.clock.advance(15 * 60_000 + 1_000);
    const own = (await c.get(await login(s, 'collega'), '/api/blocchi')).json<{
      blocchi: { proprio: boolean; motivo: string }[];
    }>();
    expect(own.blocchi.map((b) => [b.proprio, b.motivo])).toEqual([
      [true, 'codes'],
      [false, 'passwords'],
    ]);
  });

  it('i codici sbagliati allo sblocco della sessione contano come i codici dell’accesso', async () => {
    const victim = s.users.sostituto;
    s.clock.advance(6 * 60_000);
    expect((await c.get(cookies.sostituto!, '/api/io')).statusCode).toBe(423);
    const unlock = (codice: string) =>
      s.app.inject({
        method: 'POST',
        url: '/api/accesso/sblocca',
        payload: { codice },
        headers: { cookie: cookies.sostituto! },
      });
    for (const codice of ['000000', '111111', '222222', '333333'])
      expect((await unlock(codice)).statusCode).toBe(401);
    expect((await c.userRow(victim.id)).failedCodes).toBe(4);
    expect((await unlock('444444')).statusCode).toBe(401);
    const row = await c.userRow(victim.id);
    expect(row.lockedUntil).not.toBeNull();
    const [lock] = await t.db.select().from(accountLock).where(eq(accountLock.userId, victim.id));
    expect(lock).toMatchObject({ reason: 'codes', failures: 5 });
  });

  it('un conto bloccato a metà da un’altra richiesta non si allunga e non dà un avviso nuovo', async () => {
    const victim = s.users.amministratore;
    const before = await t.db.select().from(accountLock).where(eq(accountLock.userId, victim.id));
    const until = new Date(s.clock.now().getTime() + 60_000);
    const holder = await t.pool.connect();
    let answer;
    try {
      await holder.query('begin');
      await holder.query('select id from app_user where id = $1 for no key update', [victim.id]);
      // La password sbagliata ha letto l'utente senza blocco e aspetta la sua riga per contarsi.
      const pending = c.attempt(victim.username, 'arrivata insieme', 'pc', '10.7.0.1');
      for (let i = 0; i < 40; i++) {
        const { rows } = await t.pool.query<{ n: number }>(
          "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
        );
        if (rows[0]!.n > 0) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      // Intanto un'altra richiesta ha portato il conto alla soglia e l'ha bloccato.
      await holder.query(
        'update app_user set failed_logins = 19, locked_until = $2 where id = $1',
        [victim.id, until],
      );
      await holder.query('commit');
      answer = await pending;
    } finally {
      await holder.query('rollback').catch(() => undefined);
      holder.release();
    }
    expect(answer.json().errore).toBe(LOCKED_LOGIN_ERROR);
    const row = await c.userRow(victim.id);
    expect([row.failedLogins, row.lockedUntil!.getTime()]).toEqual([0, until.getTime()]);
    expect(await t.db.select().from(accountLock).where(eq(accountLock.userId, victim.id))).toEqual(
      before,
    );
    await t.db
      .update(appUser)
      .set({ failedLogins: 0, lockedUntil: null })
      .where(eq(appUser.id, victim.id));
  });
});

describe('soglie per difetto e migrazione 0030 (D188)', () => {
  it('uno studio nuovo: 50 password, 5 codici, 15 minuti', async () => {
    const [row] = await t.db.insert(studio).values({ name: 'Studio nuovo 0030' }).returning();
    expect([row!.maxFailedLogins, row!.maxFailedCodes, row!.failedLoginLockMinutes]).toEqual([
      50, 5, 15,
    ]);
  });

  it('la soglia di prima passa ai codici; le password vanno alla soglia alta; vuota resta vuota', async () => {
    const db0 = await createTestDatabase({ migrate: false });
    const dir = mkdtempSync(join(tmpdir(), 'mmg-migr-0030-'));
    try {
      cpSync(migrationsDir, dir, { recursive: true });
      const journalFile = join(dir, 'meta', '_journal.json');
      const journal = JSON.parse(readFileSync(journalFile, 'utf8')) as {
        entries: { tag: string }[];
      };
      journal.entries = journal.entries.filter((e) => e.tag < '0030');
      writeFileSync(journalFile, JSON.stringify(journal));
      await runMigrations(db0.pool, dir);
      // Lo schema di oggi ha colonne che prima non c'erano: le righe si scrivono a mano.
      await db0.pool.query(
        `insert into studio (name, max_failed_logins, failed_login_lock_minutes) values
          ('Tre', 3, 15), ('Dieci', 10, 60), ('Vuota', null, null)`,
      );
      await runMigrations(db0.pool);
      const rows = await createDatabase(db0.pool)
        .select({
          name: studio.name,
          passwords: studio.maxFailedLogins,
          codes: studio.maxFailedCodes,
          minutes: studio.failedLoginLockMinutes,
        })
        .from(studio)
        .orderBy(asc(studio.name));
      expect(rows).toEqual([
        { name: 'Dieci', passwords: 50, codes: 10, minutes: 60 },
        { name: 'Tre', passwords: 50, codes: 3, minutes: 15 },
        { name: 'Vuota', passwords: null, codes: null, minutes: null },
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await db0.drop();
    }
  });
});
