import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

describe('servizio applicativo', () => {
  let t: TestDatabase;
  beforeAll(async () => {
    t = await createTestDatabase();
  });
  afterAll(async () => {
    await t?.drop();
  });

  it('risponde sullo stato di salute e raggiunge il database', async () => {
    const app = buildApp({
      db: t.db,
      config: { encryptionKey: randomBytes(32), sessionMaxHours: 12, cookieSecure: false },
    });
    const res = await app.inject({ method: 'GET', url: '/api/salute' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ stato: 'ok' });
    await app.close();
  });

  it('senza sessione le rotte non pubbliche rispondono 401', async () => {
    const app = buildApp({
      db: t.db,
      config: { encryptionKey: randomBytes(32), sessionMaxHours: 12, cookieSecure: false },
    });
    for (const url of ['/api/io', '/api/pazienti', '/api/esportazione']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
    await app.close();
  });
});
