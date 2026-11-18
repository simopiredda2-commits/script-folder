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
    const app = buildApp({ db: t.db });
    const res = await app.inject({ method: 'GET', url: '/api/salute' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ stato: 'ok' });
    await app.close();
  });
});
