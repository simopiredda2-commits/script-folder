/**
 * Prova di fattibilità in Node: migrazioni, servizio e scenario delle prove su PGlite (D221).
 */
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import { buildApp } from '../../api/src/app';
import type { Database } from '../../api/src/db/client';
import { readMigrations } from '../../api/src/db/migrate';
import * as schema from '../../api/src/db/schema';
import { createScenario, login } from '../../api/test/helpers/scenario';

const t0 = Date.now();
const pg = await PGlite.create();
console.log('PGlite pronto in', Date.now() - t0, 'ms');
await pg.exec(`create table if not exists schema_migrations (
  tag text primary key, sha256 text not null, applied_at timestamptz not null default now())`);
const t1 = Date.now();
for (const m of readMigrations()) {
  try {
    await pg.transaction(async (tx) => {
      for (const s of m.statements) await tx.exec(s);
      await tx.query('insert into schema_migrations (tag, sha256) values ($1, $2)', [
        m.tag,
        m.sha256,
      ]);
    });
  } catch (err) {
    console.error('Migrazione fallita:', m.tag, (err as Error).message);
    process.exit(1);
  }
}
console.log('Migrazioni in', Date.now() - t1, 'ms');
const db = drizzle(pg, { schema, casing: 'snake_case' }) as unknown as Database;
const app = buildApp({
  db,
  config: { encryptionKey: randomBytes(32), sessionMaxHours: 12, cookieSecure: false },
});
const salute = await app.inject({ method: 'GET', url: '/api/salute' });
console.log('salute', salute.statusCode, salute.body);
await app.close();
const t2 = Date.now();
const s = await createScenario(db);
console.log('Scenario in', Date.now() - t2, 'ms');
const cookie = await login(s, 'titolare');
for (const url of [
  '/api/io',
  '/api/oggi',
  '/api/pazienti',
  `/api/pazienti/${s.richPatient}`,
  `/api/pazienti/${s.richPatient}/terapie`,
  `/api/pazienti/${s.richPatient}/cronologia`,
]) {
  const r = await s.app.inject({ method: 'GET', url, headers: { cookie } });
  console.log(url, r.statusCode, r.body.slice(0, 160));
}
await s.app.close();
await pg.close();
