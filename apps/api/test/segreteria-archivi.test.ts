import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { latestSecretaryDecisions } from '../src/admin/secretary-archives';
import { createDatabase } from '../src/db/client';
import { migrationsDir, runMigrations } from '../src/db/migrate';
import { archiveSecretary } from '../src/db/schema';
import { loadArchiveContext } from '../src/patients/access';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

/**
 * Segreteria confermata per archivio, in medicina di gruppo (D181): ogni titolare conferma la
 * segreteria per il suo archivio, e finché non lo fa la segreteria non lo vede. Utenti inventati.
 */
describe('segreteria per archivio (tappa 16)', () => {
  let t: TestDatabase;
  let s: Scenario;
  const cookies: Record<string, string> = {};

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db, { idleLockMinutes: null });
    for (const who of ['amministratore', 'titolare', 'collega'] as const)
      cookies[who] = await login(s, who);
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const req = (cookie: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: object) =>
    s.app.inject({ method, url, headers: { cookie }, payload });
  const decisions = async () => {
    const d = await latestSecretaryDecisions(t.db, { userIds: [s.users.segreteria.id] });
    return {
      titolare: d.get(`${s.archives.titolare}:${s.users.segreteria.id}`)?.decision,
      collega: d.get(`${s.archives.collega}:${s.users.segreteria.id}`)?.decision,
    };
  };

  it('l’amministratore vede, archivio per archivio, chi ha confermato la segreteria', async () => {
    const list = (await req(cookies.amministratore!, 'GET', '/api/studio/utenti')).json();
    const sec = list.utenti.find((u: { id: string }) => u.id === s.users.segreteria.id);
    expect(sec.archiviSegreteria).toEqual([
      expect.objectContaining({
        archivio: { id: s.archives.titolare, nome: 'Archivio Marchi' },
        stato: 'confermata',
        da: 'Dott.ssa Elena Marchi',
      }),
      expect.objectContaining({
        archivio: { id: s.archives.collega, nome: 'Archivio Serra' },
        stato: 'confermata',
        da: 'Dott. Paolo Serra',
      }),
    ]);
    // Per chi non è segreteria non c'è.
    const owner = list.utenti.find((u: { id: string }) => u.id === s.users.titolare.id);
    expect(owner.archiviSegreteria).toBeNull();
  });

  it('il ruolo di segreteria tolto e ridato: le conferme di prima non valgono, ognuno decide di nuovo', async () => {
    const sec = s.users.segreteria;
    const off = await req(cookies.amministratore!, 'PATCH', `/api/studio/utenti/${sec.id}`, {
      ruoli: ['administrator'],
    });
    expect(off.statusCode, off.body).toBe(200);
    expect(await decisions()).toEqual({ titolare: 'da_confermare', collega: 'da_confermare' });
    const on = await req(cookies.amministratore!, 'PATCH', `/api/studio/utenti/${sec.id}`, {
      ruoli: ['secretary'],
    });
    expect(on.statusCode, on.body).toBe(200);
    expect(on.json().utente.inAttesaDiConferma).toBe(true);
    // La titolare la conferma come utente: vale per il suo archivio, non per quello del collega.
    const pending = (await req(cookies.titolare!, 'GET', '/api/studio/utenti/da-confermare'))
      .json()
      .utenti.find((u: { id: string }) => u.id === sec.id);
    const ok = await req(cookies.titolare!, 'POST', `/api/studio/utenti/${sec.id}/conferma`, {
      richiestaIl: pending.richiesta.il,
    });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(await decisions()).toEqual({ titolare: 'confermata', collega: 'da_confermare' });
    expect((await loadArchiveContext(t.db, s.archives.collega)).secretaries).not.toContain(sec.id);
    expect((await loadArchiveContext(t.db, s.archives.titolare)).secretaries).toContain(sec.id);
    const theirs = (await req(cookies.collega!, 'GET', '/api/studio/utenti/da-confermare')).json();
    expect(theirs.perArchivio.map((u: { id: string }) => u.id)).toEqual([sec.id]);
    expect(theirs.sulMioArchivio).toEqual([]);
  });

  it('le decisioni non si cambiano e non si cancellano: se ne aggiunge una', async () => {
    await expect(
      t.db
        .update(archiveSecretary)
        .set({ decision: 'confermata' })
        .where(eq(archiveSecretary.userId, s.users.segreteria.id)),
    ).rejects.toThrow();
    await expect(
      t.db.delete(archiveSecretary).where(eq(archiveSecretary.userId, s.users.segreteria.id)),
    ).rejects.toThrow();
  });
});

describe('migrazione 0028: chi lavorava già resta su tutti gli archivi (D181)', () => {
  it('le segreterie confermate prima della regola restano su ogni archivio dello studio; quelle in attesa no', async () => {
    const t = await createTestDatabase({ migrate: false });
    const dir = mkdtempSync(join(tmpdir(), 'mmg-migr-0028-'));
    try {
      // Il database come prima della migrazione 0028.
      cpSync(migrationsDir, dir, { recursive: true });
      const journalFile = join(dir, 'meta', '_journal.json');
      const journal = JSON.parse(readFileSync(journalFile, 'utf8')) as {
        entries: { tag: string }[];
      };
      journal.entries = journal.entries.filter((e) => e.tag < '0028');
      writeFileSync(journalFile, JSON.stringify(journal));
      await runMigrations(t.pool, dir);
      const db = createDatabase(t.pool);
      // Studio, utenti e archivi si scrivono a mano: lo schema di oggi ha colonne nate dopo la 0028
      // (per esempio le soglie dei tentativi della 0030 e le medicazioni avanzate della 0044).
      const [st] = (
        await t.pool.query<{ id: string }>(
          "insert into studio (name) values ('Studio di prova 0028') returning id",
        )
      ).rows;
      const user = async (
        username: string,
        roles: ('owner_doctor' | 'secretary')[],
        awaiting = false,
      ) =>
        (
          await t.pool.query<{ id: string }>(
            `insert into app_user (studio_id, username, display_name, password_hash, roles, awaiting_confirmation)
             values ($1, $2, $2, 'impronta-di-prova', $3::user_role[], $4) returning id`,
            [st!.id, username, roles, awaiting],
          )
        ).rows[0]!;
      const a = await user('titolare.a', ['owner_doctor']);
      const b = await user('titolare.b', ['owner_doctor']);
      const working = await user('segreteria.lavora', ['secretary']);
      const waiting = await user('segreteria.attesa', ['secretary'], true);
      const archives = (
        await t.pool.query<{ id: string }>(
          `insert into archive (studio_id, owner_user_id, name)
           values ($1, $2, 'Archivio A'), ($1, $3, 'Archivio B') returning id`,
          [st!.id, a.id, b.id],
        )
      ).rows;
      // Ora la 0028, con le altre.
      await runMigrations(t.pool);
      const rows = await db.select().from(archiveSecretary);
      expect(rows.map((r) => [r.archiveId, r.userId, r.decision, r.decidedBy]).sort()).toEqual(
        archives.map((x) => [x.id, working.id, 'confermata', null]).sort(),
      );
      expect(rows.some((r) => r.userId === waiting.id)).toBe(false);
      expect(
        await db
          .select()
          .from(archiveSecretary)
          .where(and(eq(archiveSecretary.userId, a.id))),
      ).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      await t.drop();
    }
  });
});
