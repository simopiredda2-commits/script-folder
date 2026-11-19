import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accessLog, appUser, archive, studio } from '../src/db/schema';
import { base32Decode } from '../src/security/base32';
import { totp } from '../src/security/totp';
import { createScenario, login, PASSWORD, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

describe('accesso con secondo fattore', () => {
  let t: TestDatabase;
  let s: Scenario;
  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db);
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const post = (url: string, payload: object, cookie?: string) =>
    s.app.inject({ method: 'POST', url, payload, headers: cookie ? { cookie } : {} });

  it('al primo accesso chiede di attivare il secondo fattore, poi apre la sessione', async () => {
    const cookie = await login(s, 'titolare');
    const me = await s.app.inject({ method: 'GET', url: '/api/io', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().ruoli[0].codice).toBe('owner_doctor');
    const [u] = await s.db.select().from(appUser).where(eq(appUser.id, s.users.titolare.id));
    expect(u!.totpEnabledAt).not.toBeNull();
    // Il segreto è cifrato nel database, non in chiaro.
    expect(u!.totpSecretEnc!.includes(s.secrets.get(u!.id)!)).toBe(false);
  });

  it('agli accessi successivi chiede il codice, senza riproporre l’attivazione', async () => {
    const res = await post('/api/accesso', {
      username: s.users.titolare.username,
      password: PASSWORD,
      postazione: 'ambulatorio-1',
    });
    expect(res.json().passo).toBe('secondo-fattore');
    expect(res.json().segreto).toBeUndefined();
  });

  it('password sbagliata e utente sconosciuto danno lo stesso messaggio', async () => {
    const a = await post('/api/accesso', {
      username: s.users.titolare.username,
      password: 'sbagliata',
      postazione: 'x',
    });
    const b = await post('/api/accesso', { username: 'nessuno', password: 'x', postazione: 'x' });
    expect(a.statusCode).toBe(401);
    expect(b.statusCode).toBe(401);
    expect(a.json().errore).toBe(b.json().errore);
  });

  it('un codice sbagliato non apre la sessione', async () => {
    const res = await post('/api/accesso', {
      username: s.users.titolare.username,
      password: PASSWORD,
      postazione: 'x',
    });
    const bad = await post('/api/accesso/codice', {
      passaggio: res.json().passaggio,
      codice: '000000',
    });
    expect(bad.statusCode).toBe(401);
    expect(bad.cookies.find((c) => c.name === 'sessione')).toBeUndefined();
  });

  it('lo stesso codice non vale due volte', async () => {
    const first = await post('/api/accesso', {
      username: s.users.titolare.username,
      password: PASSWORD,
      postazione: 'x',
    });
    s.clock.advance(30_000);
    const code = totp(s.secrets.get(s.users.titolare.id)!, s.clock.now().getTime());
    expect(
      (await post('/api/accesso/codice', { passaggio: first.json().passaggio, codice: code }))
        .statusCode,
    ).toBe(200);
    const second = await post('/api/accesso', {
      username: s.users.titolare.username,
      password: PASSWORD,
      postazione: 'x',
    });
    const replay = await post('/api/accesso/codice', {
      passaggio: second.json().passaggio,
      codice: code,
    });
    expect(replay.statusCode).toBe(401);
  });

  it('il passaggio fra password e codice scade dopo 5 minuti', async () => {
    const res = await post('/api/accesso', {
      username: s.users.titolare.username,
      password: PASSWORD,
      postazione: 'x',
    });
    s.clock.advance(6 * 60_000);
    const code = totp(s.secrets.get(s.users.titolare.id)!, s.clock.now().getTime());
    const late = await post('/api/accesso/codice', {
      passaggio: res.json().passaggio,
      codice: code,
    });
    expect(late.statusCode).toBe(401);
    expect(late.json().errore).toMatch(/scaduto/);
  });

  it('l’uscita chiude la sessione', async () => {
    const cookie = await login(s, 'segreteria');
    await post('/api/uscita', {}, cookie);
    const me = await s.app.inject({ method: 'GET', url: '/api/io', headers: { cookie } });
    expect(me.statusCode).toBe(401);
  });

  it('accessi, uscite e tentativi falliti finiscono nel registro', async () => {
    const actions = (await s.db.select({ a: accessLog.action }).from(accessLog)).map((r) => r.a);
    for (const a of [
      'accesso',
      'secondo_fattore_attivato',
      'accesso_fallito',
      'secondo_fattore_fallito',
      'uscita',
    ]) {
      expect(actions).toContain(a);
    }
  });
});

describe('soglie dello studio: blocco per inattività e tentativi falliti', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });

  it('con le soglie vuote i blocchi non scattano', async () => {
    const s = await createScenario(t.db, {
      idleLockMinutes: null,
      maxFailedLogins: null,
      failedLoginLockMinutes: null,
    });
    const cookie = await login(s, 'titolare');
    s.clock.advance(60 * 60_000);
    const me = await s.app.inject({ method: 'GET', url: '/api/io', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    await s.app.close();
  });

  it('dopo 5 minuti di inattività la sessione si blocca e si sblocca con il codice a 6 cifre', async () => {
    const s = await createScenario(t.db);
    const cookie = await login(s, 'titolare');
    const io = () => s.app.inject({ method: 'GET', url: '/api/io', headers: { cookie } });
    const unlock = (codice: string) =>
      s.app.inject({
        method: 'POST',
        url: '/api/accesso/sblocca',
        payload: { codice },
        headers: { cookie },
      });
    s.clock.advance(4 * 60_000);
    expect((await io()).statusCode).toBe(200);
    s.clock.advance(5 * 60_000 + 1);
    expect((await io()).statusCode).toBe(423);
    expect((await unlock('000000')).statusCode).toBe(401);
    // La password non sblocca: serve il codice dell'app.
    expect((await unlock(PASSWORD)).statusCode).toBe(401);
    s.clock.advance(30_000);
    const code = totp(s.secrets.get(s.users.titolare.id)!, s.clock.now().getTime());
    expect((await unlock(code)).statusCode).toBe(200);
    expect((await io()).statusCode).toBe(200);
    // Lo stesso codice non sblocca una seconda volta.
    s.clock.advance(5 * 60_000 + 1);
    expect((await io()).statusCode).toBe(423);
    expect((await unlock(code)).statusCode).toBe(401);
    await s.app.close();
  });

  it('le password sbagliate fanno aspettare la loro postazione; cinque codici sbagliati bloccano l’utente per 15 minuti', async () => {
    const s = await createScenario(t.db);
    const username = s.users.segreteria.username;
    const attempt = (password: string) =>
      s.app.inject({
        method: 'POST',
        url: '/api/accesso',
        payload: { username, password, postazione: 'x' },
      });
    for (let i = 0; i < 4; i++) expect((await attempt('sbagliata')).statusCode).toBe(401);
    expect((await attempt(PASSWORD)).statusCode).toBe(200);
    // Dopo cinque password sbagliate la postazione aspetta; il conto non si blocca (D188).
    for (let i = 0; i < 6; i++) expect((await attempt('sbagliata')).statusCode).toBe(401);
    expect((await attempt(PASSWORD)).statusCode).toBe(429);
    s.clock.advance(2_000);
    const right = await attempt(PASSWORD);
    expect(right.statusCode).toBe(200);
    // Cinque codici sbagliati sì: chi li scrive conosceva la password.
    const passaggio = right.json<{ passaggio: string }>().passaggio;
    for (const codice of ['000001', '000002', '000003', '000004', '000005'])
      await s.app.inject({
        method: 'POST',
        url: '/api/accesso/codice',
        payload: { passaggio, codice },
      });
    const blocked = await attempt(PASSWORD);
    expect(blocked.statusCode).toBe(401);
    expect(blocked.json().errore).toMatch(/bloccato/);
    s.clock.advance(14 * 60_000);
    expect((await attempt(PASSWORD)).json().errore).toMatch(/bloccato/);
    s.clock.advance(2 * 60_000);
    expect((await attempt(PASSWORD)).statusCode).toBe(200);
    await s.app.close();
  });

  it('per difetto: 5 minuti, 50 password, 5 codici, 15 minuti; la segreteria non vede diario né riepilogo', async () => {
    const [row] = await t.db.insert(studio).values({ name: 'Nuovo studio' }).returning();
    expect(row!.idleLockMinutes).toBe(5);
    expect(row!.maxFailedLogins).toBe(50);
    expect(row!.maxFailedCodes).toBe(5);
    expect(row!.failedLoginLockMinutes).toBe(15);
    const s = await createScenario(t.db);
    const [a] = await t.db.select().from(archive).where(eq(archive.id, s.archives.titolare));
    expect(a!.secretaryCanReadDiary).toBe(false);
    expect(a!.secretaryCanReadSummary).toBe(false);
    await s.app.close();
  });

  it('il segreto restituito all’attivazione è in Base32 valido', async () => {
    const s = await createScenario(t.db);
    const res = await s.app.inject({
      method: 'POST',
      url: '/api/accesso',
      payload: { username: s.users.amministratore.username, password: PASSWORD, postazione: 'x' },
    });
    expect(base32Decode(res.json().segreto).length).toBe(20);
    await s.app.close();
  });
});
