import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createDatabase, createPool, type Database } from '../../src/db/client';
import { runMigrations } from '../../src/db/migrate';

export interface TestDatabase {
  name: string;
  url: string;
  pool: pg.Pool;
  db: Database;
  drop: () => Promise<void>;
}

/** URL del database di sviluppo, usato solo per creare e cancellare i database di prova. */
function adminUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL mancante: le prove del database non si saltano. In cloud la imposta scripts/avvio-sessione.sh.',
    );
  }
  return url;
}

/**
 * Crea un database vuoto e temporaneo (mmg_test_…), opzionalmente con le migrazioni applicate.
 * Ogni file di prova ha il suo: le prove non si disturbano e partono sempre da zero.
 */
export async function createTestDatabase(
  options: { migrate?: boolean } = {},
): Promise<TestDatabase> {
  const name = `mmg_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: adminUrl() });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();

  const url = new URL(adminUrl());
  url.pathname = `/${name}`;
  const pool = createPool(url.toString());
  if (options.migrate ?? true) await runMigrations(pool);

  return {
    name,
    url: url.toString(),
    pool,
    db: createDatabase(pool),
    drop: async () => {
      await pool.end();
      const c = new pg.Client({ connectionString: adminUrl() });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}
