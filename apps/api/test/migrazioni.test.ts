import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrationsDir, readMigrations, runMigrations } from '../src/db/migrate';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

const sqlFiles = () => readdirSync(migrationsDir).filter((f) => f.endsWith('.sql'));

describe('migrazioni', () => {
  let t: TestDatabase;

  beforeAll(async () => {
    t = await createTestDatabase({ migrate: false });
  });
  afterAll(async () => {
    await t.drop();
  });

  it('ogni file SQL è nel registro di drizzle-kit e viceversa', () => {
    expect(readMigrations().map((m) => `${m.tag}.sql`)).toEqual(sqlFiles().sort());
  });

  it('si applicano da zero su un database vuoto', async () => {
    const applied = await runMigrations(t.pool);
    expect(applied.length).toBe(sqlFiles().length);
    const { rows } = await t.pool.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by 1",
    );
    expect(rows.map((r) => r.table_name)).toContain('studio');
  });

  it('applicate una seconda volta non cambiano nulla', async () => {
    expect(await runMigrations(t.pool)).toEqual([]);
    const { rows } = await t.pool.query<{ n: number }>(
      'select count(*)::int as n from schema_migrations',
    );
    expect(rows[0]?.n).toBe(sqlFiles().length);
  });

  it('la prima migrazione crea una tabella utilizzabile', async () => {
    const { rows } = await t.pool.query<{ kind: string }>(
      "insert into studio (name) values ('Studio di prova') returning kind",
    );
    expect(rows[0]?.kind).toBe('single');
  });

  it('rifiuta una migrazione modificata dopo essere stata applicata', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmg-migr-'));
    try {
      cpSync(migrationsDir, dir, { recursive: true });
      appendFileSync(join(dir, `${readMigrations()[0]!.tag}.sql`), '\n-- modifica');
      await expect(runMigrations(t.pool, dir)).rejects.toThrow(/modificata/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rifiuta un database con una migrazione il cui file non c’è più', async () => {
    await t.pool.query("insert into schema_migrations (tag, sha256) values ('9999_sparita', 'x')");
    try {
      await expect(runMigrations(t.pool)).rejects.toThrow(/non c'è più/);
    } finally {
      await t.pool.query("delete from schema_migrations where tag = '9999_sparita'");
    }
  });
});

describe('schema e migrazioni', () => {
  it('sono allineati: dallo schema non nasce nessuna migrazione nuova', () => {
    // drizzle-kit vuole un percorso relativo per --out (ci antepone «./») ed esce con 0
    // anche quando fallisce: per questo si controlla il testo dell'uscita.
    const apiDir = join(import.meta.dirname, '..');
    const rel = `.tmp-verifica-${randomBytes(4).toString('hex')}`;
    const tmp = join(apiDir, rel);
    try {
      cpSync(migrationsDir, tmp, { recursive: true });
      const out = execFileSync(
        'pnpm',
        [
          'exec',
          'drizzle-kit',
          'generate',
          '--dialect',
          'postgresql',
          '--schema',
          './src/db/schema/index.ts',
          '--casing',
          'snake_case',
          '--out',
          rel,
        ],
        { cwd: apiDir, encoding: 'utf8' },
      );
      expect(out).toContain('No schema changes');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
