import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { base32Decode } from '../src/security/base32';
import { totp } from '../src/security/totp';
import { createScenario, PASSWORD, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

/** Accesso del titolare con password e codice, restituendo il cookie della sessione così com'è. */
async function sessionCookie(s: Scenario) {
  const user = s.users.titolare;
  const res = await s.app.inject({
    method: 'POST',
    url: '/api/accesso',
    payload: { username: user.username, password: PASSWORD, postazione: 'postazione-cookie' },
  });
  expect(res.statusCode, res.body).toBe(200);
  const body = res.json<{ passaggio: string; segreto?: string }>();
  if (body.segreto) s.secrets.set(user.id, base32Decode(body.segreto));
  s.clock.advance(30_000);
  const done = await s.app.inject({
    method: 'POST',
    url: '/api/accesso/codice',
    payload: {
      passaggio: body.passaggio,
      codice: totp(s.secrets.get(user.id)!, s.clock.now().getTime()),
    },
  });
  expect(done.statusCode, done.body).toBe(200);
  return done.cookies.find((c) => c.name === 'sessione')!;
}

describe('cookie della sessione', () => {
  let t: TestDatabase;
  let s: Scenario;

  beforeAll(async () => {
    t = await createTestDatabase();
    // L'orologio del servizio un giorno indietro: come un computer con l'ora sbagliata, o una
    // prova che ferma l'orologio a mezzogiorno mentre l'ora vera è un'altra.
    s = await createScenario(t.db, {}, { clockAt: new Date(Date.now() - 86_400_000) });
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  it('dice quanto dura (Max-Age), non a che ora scade: il browser la conta con il suo orologio', async () => {
    const cookie = await sessionCookie(s);
    // Le sessioni dello scenario durano 12 ore.
    expect(cookie.maxAge).toBe(12 * 3600);
    expect(cookie.expires).toBeUndefined();
    expect(cookie).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' });
  });
});
