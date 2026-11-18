import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type pg from 'pg';

/**
 * Migrazioni versionate.
 *
 * I file SQL li genera drizzle-kit dallo schema (`pnpm --filter @mmg/api db:generate`), oppure si
 * scrivono a mano per ciò che lo schema non esprime (trigger, permessi): `drizzle-kit generate
 * --custom`. Li applica questo esecutore, che in più rifiuta una migrazione modificata o sparita
 * dopo essere stata applicata (decisione D9).
 */
export const migrationsDir = join(import.meta.dirname, '..', '..', 'migrations');

export interface Migration {
  tag: string;
  sha256: string;
  statements: string[];
}

interface Journal {
  entries: { idx: number; tag: string }[];
}

/** Chiave del blocco consultivo: due avvii contemporanei non applicano due volte la stessa migrazione. */
const LOCK_KEY = 4_620_118;

export function readMigrations(dir: string = migrationsDir): Migration[] {
  const journal = JSON.parse(readFileSync(join(dir, 'meta', '_journal.json'), 'utf8')) as Journal;
  return [...journal.entries]
    .sort((a, b) => a.idx - b.idx)
    .map(({ tag }) => {
      const sql = readFileSync(join(dir, `${tag}.sql`), 'utf8');
      return {
        tag,
        sha256: createHash('sha256').update(sql).digest('hex'),
        statements: sql
          .split('--> statement-breakpoint')
          .map((s) => s.trim())
          .filter(Boolean),
      };
    });
}

/** Applica in ordine, ognuna nella sua transazione, le migrazioni non ancora applicate. */
export async function runMigrations(pool: pg.Pool, dir: string = migrationsDir): Promise<string[]> {
  const migrations = readMigrations(dir);
  const client = await pool.connect();
  const appliedNow: string[] = [];
  try {
    await client.query('select pg_advisory_lock($1)', [LOCK_KEY]);
    await client.query(`create table if not exists schema_migrations (
      tag text primary key,
      sha256 text not null,
      applied_at timestamptz not null default now()
    )`);
    const { rows } = await client.query<{ tag: string; sha256: string }>(
      'select tag, sha256 from schema_migrations',
    );
    const applied = new Map(rows.map((r) => [r.tag, r.sha256]));
    const known = new Set(migrations.map((m) => m.tag));
    for (const tag of applied.keys()) {
      if (!known.has(tag)) {
        throw new Error(`La migrazione ${tag} è applicata nel database ma il suo file non c'è più`);
      }
    }
    for (const m of migrations) {
      const previous = applied.get(m.tag);
      if (previous !== undefined) {
        if (previous !== m.sha256) {
          throw new Error(
            `La migrazione ${m.tag} è stata modificata dopo essere stata applicata: scrivine una nuova`,
          );
        }
        continue;
      }
      await client.query('begin');
      try {
        for (const statement of m.statements) await client.query(statement);
        await client.query('insert into schema_migrations (tag, sha256) values ($1, $2)', [
          m.tag,
          m.sha256,
        ]);
        await client.query('commit');
        appliedNow.push(m.tag);
      } catch (err) {
        await client.query('rollback');
        throw err;
      }
    }
    return appliedNow;
  } finally {
    await client.query('select pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}
