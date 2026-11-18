import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accessLog } from '../src/db/schema';
import {
  ENTRY_TABLES,
  HANDLED_SEPARATELY,
  PATIENT_TABLES,
  type ExportDocument,
} from '../src/export/export';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

describe('esportazione completa dei dati del medico', () => {
  let t: TestDatabase;
  let s: Scenario;
  let doc: ExportDocument;
  let raw: string;
  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db);
    const cookie = await login(s, 'titolare');
    await s.app.inject({
      method: 'GET',
      url: `/api/pazienti/${s.richPatient}`,
      headers: { cookie },
    });
    const res = await s.app.inject({
      method: 'GET',
      url: '/api/esportazione',
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="esportazione-/);
    raw = res.body;
    doc = res.json<ExportDocument>();
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  it('è JSON con formato e versione dichiarati', () => {
    expect(doc.formato).toBe('mmg-esportazione');
    expect(doc.versione).toBe(1);
  });

  it('contiene tutti e soli i pazienti dell’archivio del titolare', () => {
    const ids = doc.tabelle.patient!.map((p) => p.id);
    expect([...ids].sort()).toEqual([...s.patients.titolare].sort());
    for (const id of s.patients.collega) expect(raw).not.toContain(id);
  });

  it('contiene voci cliniche, dettagli, terapie, esenzioni, storico e registro', () => {
    expect(doc.tabelle.clinical_entry!.length).toBe(4);
    expect(doc.tabelle.diary_detail!.length).toBe(2);
    expect(doc.tabelle.therapy!.length).toBe(2);
    expect(doc.tabelle.exemption!.length).toBe(1);
    expect(doc.storico_modifiche.length).toBeGreaterThan(0);
    expect(doc.registro_accessi.some((r) => r.action === 'apertura_cartella')).toBe(true);
  });

  it('ogni tabella del database con dati dei pazienti è esportata', async () => {
    const res = await s.db.execute<{ table_name: string }>(sql`
      select distinct table_name from information_schema.columns
      where table_schema = 'public' and column_name in ('patient_id', 'entry_id')`);
    const known = new Set<string>([
      ...PATIENT_TABLES,
      ...ENTRY_TABLES,
      ...Object.keys(HANDLED_SEPARATELY),
    ]);
    for (const { table_name } of res.rows) expect(known, table_name).toContain(table_name);
    for (const tname of [...PATIENT_TABLES, ...ENTRY_TABLES, 'patient', 'family']) {
      expect(doc.tabelle, tname).toHaveProperty(tname);
    }
  });

  it('non contiene password né segreti', () => {
    for (const secret of [
      'password_hash',
      'passwordHash',
      'totp_secret',
      'external_credentials',
      'scrypt$',
    ]) {
      expect(raw).not.toContain(secret);
    }
  });

  it('le impronte corrispondono al contenuto', () => {
    for (const [name, rows] of Object.entries(doc.tabelle)) {
      const hash = createHash('sha256').update(JSON.stringify(rows)).digest('hex');
      expect(doc.impronte[name], name).toBe(hash);
    }
  });

  it('l’esportazione è registrata', async () => {
    const rows = await s.db
      .select()
      .from(accessLog)
      .where(and(eq(accessLog.action, 'esportazione'), eq(accessLog.userId, s.users.titolare.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('consentito');
  });
});
