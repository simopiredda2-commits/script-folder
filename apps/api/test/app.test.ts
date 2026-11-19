import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { SERVICE_BUSY_ERROR } from '../src/auth/service';
import { createDatabase, createPool } from '../src/db/client';
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

  it('con tutte le connessioni del database occupate oltre l’attesa massima risponde 503, non resta fermo (terza revisione)', async () => {
    const pool = createPool(t.url, { max: 1, connectionTimeoutMillis: 200 });
    const app = buildApp({
      db: createDatabase(pool),
      config: { encryptionKey: randomBytes(32), sessionMaxHours: 12, cookieSecure: false },
    });
    const held = await pool.connect();
    try {
      const started = Date.now();
      const res = await app.inject({ method: 'GET', url: '/api/salute' });
      expect(res.statusCode, res.body).toBe(503);
      expect(res.json()).toEqual({ errore: SERVICE_BUSY_ERROR });
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      held.release();
    }
    // Liberata la connessione, il servizio risponde come sempre.
    expect((await app.inject({ method: 'GET', url: '/api/salute' })).statusCode).toBe(200);
    await app.close();
    await pool.end();
  });
});
