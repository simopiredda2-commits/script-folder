import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPool } from '../src/db/client';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

describe('gruppo di connessioni al database', () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase({ migrate: false });
  });
  afterAll(async () => {
    await t?.drop();
  });

  it('una connessione inattiva chiusa da Postgres non ferma il processo: si avvisa e si va avanti', async () => {
    const warn = vi.spyOn(process, 'emitWarning').mockImplementation(() => {});
    const pool = createPool(t.url, { max: 1 });
    try {
      await pool.query('select 1');
      expect(pool.idleCount).toBe(1);
      // Come un riavvio di Postgres, o un database cancellato con FORCE: la connessione inattiva
      // del gruppo riceve «terminating connection due to administrator command».
      const admin = new pg.Client({ connectionString: t.url });
      await admin.connect();
      await admin.query(
        'select pg_terminate_backend(pid) from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid()',
      );
      await admin.end();
      await vi.waitFor(() => expect(pool.totalCount).toBe(0));
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/^Connessione inattiva al database chiusa: terminating connection/),
      );
      // Il gruppo apre una connessione nuova.
      expect((await pool.query('select 1 as uno')).rows).toEqual([{ uno: 1 }]);
    } finally {
      warn.mockRestore();
      await pool.end();
    }
  });
});
