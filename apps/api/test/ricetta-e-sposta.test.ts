import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prescription } from '../src/db/schema';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

/**
 * «Sposta» (D200) e una ricetta nuova nello stesso momento (D239): la bozza blocca il paziente,
 * quindi o «Sposta» trova la ricetta aperta, o la ricetta trova lo spostamento e si ferma. Mai una
 * ricetta aperta nell'archivio di prima di un paziente già spostato. Pazienti inventati.
 */
describe('ricetta nuova mentre il paziente passa a un altro archivio (D239)', () => {
  let t: TestDatabase;
  let s: Scenario;
  let doctor: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db);
    doctor = await login(s, 'titolare');
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  it('la bozza aspetta lo spostamento in corso e poi si ferma, senza ricetta nell’archivio di prima', async () => {
    const ids = async () =>
      (
        await t.db
          .select({ id: prescription.id })
          .from(prescription)
          .where(eq(prescription.patientId, s.richPatient))
      ).map((r) => r.id);
    const before = await ids();
    // Uno spostamento in corso: il paziente bloccato, come fa «Sposta» prima di cambiare archivio.
    const client = await t.pool.connect();
    try {
      await client.query('begin');
      await client.query('select 1 from patient where id = $1 for update', [s.richPatient]);
      let done = false;
      const creating = s.app
        .inject({
          method: 'POST',
          url: `/api/pazienti/${s.richPatient}/ricette`,
          headers: { cookie: doctor },
          payload: {
            kind: 'pharma_ssn',
            lines: [{ drugName: 'Farmaco di prova 5 mg', quantity: 1 }],
          },
        })
        .finally(() => {
          done = true;
        });
      // La richiesta arriva al blocco del paziente; senza il blocco finirebbe subito.
      for (let i = 0; !done && i < 500; i++) {
        const { rows } = await client.query<{ n: number }>(
          "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
        );
        if (rows[0]!.n > 0) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(done).toBe(false);
      await client.query('update patient set archive_id = $1 where id = $2', [
        s.archives.collega,
        s.richPatient,
      ]);
      await client.query('commit');
      const res = await creating;
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json().errore).toMatch(/passato a un altro archivio nel frattempo/);
      // Nessuna ricetta nuova, né nell'archivio di prima né in quello nuovo.
      expect(await ids()).toEqual(before);
    } finally {
      // Il paziente torna nell'archivio del titolare, per la prova seguente; anche se la prova si è
      // fermata prima del commit, nessun blocco resta aperto.
      await client.query('rollback');
      await client.query('update patient set archive_id = $1 where id = $2', [
        s.archives.titolare,
        s.richPatient,
      ]);
      client.release();
    }
  });

  it('la bozza tiene fermo il paziente fino alla fine: «Sposta» non lo prende a metà', async () => {
    // La scrittura delle ricette resta ferma: la bozza ha già letto il paziente e aspetta lì.
    const writes = await t.pool.connect();
    const mover = await t.pool.connect();
    try {
      await writes.query('begin');
      await writes.query('lock table prescription in share mode');
      let done = false;
      const creating = s.app
        .inject({
          method: 'POST',
          url: `/api/pazienti/${s.richPatient}/ricette`,
          headers: { cookie: doctor },
          payload: {
            kind: 'pharma_ssn',
            lines: [{ drugName: 'Farmaco di prova 5 mg', quantity: 1 }],
          },
        })
        .finally(() => {
          done = true;
        });
      for (let i = 0; !done && i < 500; i++) {
        const { rows } = await writes.query<{ n: number }>(
          "select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'",
        );
        if (rows[0]!.n > 0) break;
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(done).toBe(false);
      // «Sposta» in quel momento: il paziente è della bozza, non si prende.
      await mover.query('begin');
      await expect(
        mover.query('select 1 from patient where id = $1 for update nowait', [s.richPatient]),
      ).rejects.toThrow(/could not obtain lock/);
      await mover.query('rollback');
      await writes.query('commit');
      const res = await creating;
      expect(res.statusCode, res.body).toBe(201);
    } finally {
      await writes.query('rollback');
      await mover.query('rollback');
      writes.release();
      mover.release();
    }
  });
});
