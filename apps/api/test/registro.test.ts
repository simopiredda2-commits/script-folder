import { and, count, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifyAccessLog } from '../src/audit/access-log';
import { accessLog, changeHistory, clinicalEntry, patient } from '../src/db/schema';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

/** Drizzle avvolge l'errore di Postgres: il messaggio del trigger sta in `cause`. */
async function rejectsWith(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
  } catch (err) {
    const e = err as { message: string; cause?: { message: string } };
    expect(e.cause?.message ?? e.message).toMatch(pattern);
    return;
  }
  throw new Error(`Doveva fallire con ${pattern}`);
}

describe('registro degli accessi', () => {
  let t: TestDatabase;
  let s: Scenario;
  let titolare: string;
  let segreteria: string;
  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db);
    titolare = await login(s, 'titolare');
    segreteria = await login(s, 'segreteria');
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const logCount = async (patientId: string) =>
    (
      await s.db.select({ n: count() }).from(accessLog).where(eq(accessLog.patientId, patientId))
    )[0]!.n;

  it('ci sono rotte sui dati dei pazienti e sono tutte marcate', () => {
    expect(s.app.patientScopedRoutes.length).toBeGreaterThanOrEqual(5);
    // Ogni rotta con :id in /api/pazienti/ deve essere marcata come rotta su un paziente.
    const marked = new Set(s.app.patientScopedRoutes.map((r) => `${r.method} ${r.url}`));
    for (const r of s.app.patientScopedRoutes) expect(r.url).toContain(':id');
    expect(marked.size).toBe(s.app.patientScopedRoutes.length);
  });

  it('ogni rotta su un paziente scrive il registro, anche quando l’accesso è negato', async () => {
    const id = s.richPatient;
    for (const route of s.app.patientScopedRoutes) {
      for (const cookie of [titolare, segreteria]) {
        const before = await logCount(id);
        await s.app.inject({
          method: route.method as 'GET',
          url: route.url.replace(':id', id),
          headers: { cookie },
          payload: route.method === 'PATCH' ? { phone: '+39 000 0000000' } : undefined,
        });
        expect(await logCount(id), `${route.method} ${route.url}`).toBe(before + 1);
      }
    }
  });

  it('l’accesso negato è registrato come negato, con il motivo', async () => {
    const res = await s.app.inject({
      method: 'GET',
      url: `/api/pazienti/${s.richPatient}/diario`,
      headers: { cookie: segreteria },
    });
    expect(res.statusCode).toBe(403);
    const [last] = await s.db
      .select()
      .from(accessLog)
      .where(and(eq(accessLog.patientId, s.richPatient), eq(accessLog.action, 'lettura_diario')))
      .orderBy(sql`${accessLog.seq} desc`)
      .limit(1);
    expect(last!.outcome).toBe('negato');
    expect(JSON.stringify(last!.details)).toMatch(/diario/);
    expect(last!.workstation).toBe('postazione-segreteria');
  });

  it('non si modifica, non si cancella, non si svuota', async () => {
    await rejectsWith(s.db.execute(sql`update access_log set action = 'x'`), /non si modifica/);
    await rejectsWith(s.db.execute(sql`delete from access_log`), /non si modifica/);
    await rejectsWith(s.db.execute(sql`truncate access_log cascade`), /non si svuota/);
  });

  it('la catena delle impronte è integra', async () => {
    expect(await verifyAccessLog(s.db)).toBeNull();
    const rows = await s.db.select({ seq: accessLog.seq }).from(accessLog).orderBy(accessLog.seq);
    expect(rows.map((r) => r.seq)).toEqual(rows.map((_, i) => i + 1));
  });
});

describe('alterazioni del registro scoperte dalla catena', () => {
  let t: TestDatabase;
  let s: Scenario;
  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db);
    const cookie = await login(s, 'titolare');
    for (let i = 0; i < 3; i++) {
      await s.app.inject({
        method: 'GET',
        url: `/api/pazienti/${s.richPatient}`,
        headers: { cookie },
      });
    }
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  // Chi possiede le tabelle può spegnere i trigger: la catena serve proprio a scoprirlo.
  const asOwner = async (statement: ReturnType<typeof sql>) => {
    await s.db.execute(sql`alter table access_log disable trigger access_log_immutable`);
    try {
      await s.db.execute(statement);
    } finally {
      await s.db.execute(sql`alter table access_log enable trigger access_log_immutable`);
    }
  };

  it('una riga modificata rompe la catena in quel punto', async () => {
    expect(await verifyAccessLog(s.db)).toBeNull();
    await asOwner(sql`update access_log set outcome = 'negato' where seq = 3`);
    expect(await verifyAccessLog(s.db)).toBe(3);
    await asOwner(sql`update access_log set outcome = 'riuscito' where seq = 3`);
  });

  it('una riga tolta lascia un buco che la verifica trova', async () => {
    const before = await verifyAccessLog(s.db);
    const target = before === null ? 4 : before + 1;
    await asOwner(sql`delete from access_log where seq = ${target}`);
    expect(await verifyAccessLog(s.db)).not.toBeNull();
  });
});

describe('storico delle modifiche e dati mai cancellati', () => {
  let t: TestDatabase;
  let s: Scenario;
  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db);
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  it('una modifica dell’anagrafica entra nello storico con l’utente che l’ha fatta', async () => {
    const cookie = await login(s, 'segreteria');
    const res = await s.app.inject({
      method: 'PATCH',
      url: `/api/pazienti/${s.richPatient}/anagrafica`,
      headers: { cookie },
      payload: { phone: '+39 000 1112223' },
    });
    expect(res.statusCode).toBe(200);
    const [h] = await s.db
      .select()
      .from(changeHistory)
      .where(and(eq(changeHistory.rowId, s.richPatient), eq(changeHistory.operation, 'UPDATE')));
    expect(h!.userId).toBe(s.users.segreteria.id);
    expect((h!.newRow as { phone: string }).phone).toBe('+39 000 1112223');
    expect((h!.oldRow as { phone: string }).phone).not.toBe('+39 000 1112223');
  });

  it('lo storico non si modifica né si cancella', async () => {
    await rejectsWith(
      s.db.execute(sql`update change_history set operation = 'x'`),
      /non si modifica/,
    );
    await rejectsWith(s.db.execute(sql`delete from change_history`), /non si modifica/);
  });

  it('pazienti e voci cliniche non si cancellano: si annullano', async () => {
    await rejectsWith(
      s.db.delete(patient).where(eq(patient.id, s.richPatient)),
      /non si cancellano/,
    );
    await rejectsWith(
      s.db.delete(clinicalEntry).where(eq(clinicalEntry.patientId, s.richPatient)),
      /non si cancellano/,
    );
    await rejectsWith(s.db.execute(sql`truncate clinical_entry cascade`), /non si cancellano/);
    const updated = await s.db
      .update(clinicalEntry)
      .set({ status: 'annulled', annulReason: 'Inserita per errore', annulledAt: new Date() })
      .where(eq(clinicalEntry.patientId, s.richPatient))
      .returning();
    expect(updated.length).toBeGreaterThan(0);
  });

  it('ogni tabella con dati dei pazienti ha storico e divieto di cancellazione', async () => {
    const res = await s.db.execute<{ table_name: string }>(sql`
      select distinct table_name from information_schema.columns
      where table_schema = 'public' and column_name in ('patient_id', 'entry_id')
        and table_name not in ('access_log')`);
    const triggers = await s.db.execute<{ name: string }>(
      sql`select tgname as name from pg_trigger where not tgisinternal`,
    );
    const names = new Set(triggers.rows.map((r) => r.name));
    for (const { table_name } of res.rows) {
      expect(names, table_name).toContain(`${table_name}_history`);
      expect(names, table_name).toContain(`${table_name}_no_delete`);
    }
    expect(names).toContain('patient_history');
    expect(names).toContain('patient_no_delete');
  });
});
