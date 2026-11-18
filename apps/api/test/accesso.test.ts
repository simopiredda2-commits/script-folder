import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accessLog, appUser, studio } from '../src/db/schema';
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

  it('senza valori (da completare) i blocchi non sono attivi', async () => {
    const s = await createScenario(t.db);
    const cookie = await login(s, 'titolare');
    s.clock.advance(60 * 60_000);
    const me = await s.app.inject({ method: 'GET', url: '/api/io', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    await s.app.close();
  });

  it('con il valore impostato, la sessione inattiva si blocca e si sblocca con la password', async () => {
    const s = await createScenario(t.db, { idleLockMinutes: 5 });
    const cookie = await login(s, 'titolare');
    s.clock.advance(4 * 60_000);
    expect(
      (await s.app.inject({ method: 'GET', url: '/api/io', headers: { cookie } })).statusCode,
    ).toBe(200);
    s.clock.advance(5 * 60_000 + 1);
    const locked = await s.app.inject({ method: 'GET', url: '/api/io', headers: { cookie } });
    expect(locked.statusCode).toBe(423);
    const wrong = await s.app.inject({
      method: 'POST',
      url: '/api/accesso/sblocca',
      payload: { password: 'sbagliata' },
      headers: { cookie },
    });
    expect(wrong.statusCode).toBe(401);
    const ok = await s.app.inject({
      method: 'POST',
      url: '/api/accesso/sblocca',
      payload: { password: PASSWORD },
      headers: { cookie },
    });
    expect(ok.statusCode).toBe(200);
    expect(
      (await s.app.inject({ method: 'GET', url: '/api/io', headers: { cookie } })).statusCode,
    ).toBe(200);
    await s.app.close();
  });

  it('con le soglie impostate, troppi tentativi falliti bloccano l’utente per un tempo', async () => {
    const s = await createScenario(t.db, { maxFailedLogins: 3, failedLoginLockMinutes: 10 });
    const username = s.users.segreteria.username;
    const attempt = (password: string) =>
      s.app.inject({
        method: 'POST',
        url: '/api/accesso',
        payload: { username, password, postazione: 'x' },
      });
    for (let i = 0; i < 3; i++) expect((await attempt('sbagliata')).statusCode).toBe(401);
    const blocked = await attempt(PASSWORD);
    expect(blocked.statusCode).toBe(401);
    expect(blocked.json().errore).toMatch(/bloccato/);
    s.clock.advance(11 * 60_000);
    expect((await attempt(PASSWORD)).statusCode).toBe(200);
    await s.app.close();
  });

  it('le soglie sono impostazioni dello studio, vuote per difetto', async () => {
    const [row] = await t.db.insert(studio).values({ name: 'Nuovo studio' }).returning();
    expect(row!.idleLockMinutes).toBeNull();
    expect(row!.maxFailedLogins).toBeNull();
    expect(row!.failedLoginLockMinutes).toBeNull();
    expect(row!.secretaryCanReadDiary).toBe(false);
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
