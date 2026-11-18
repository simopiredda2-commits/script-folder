import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accessLog, problemDetail, clinicalEntry, therapy } from '../src/db/schema';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

describe('scheda della terapia: nuova, modifica, sospensione, ripresa', () => {
  let t: TestDatabase;
  let s: Scenario;
  let doctor: string;
  let secretary: string;
  let problemId: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db);
    doctor = await login(s, 'titolare');
    secretary = await login(s, 'segreteria');
    const [p] = await t.db
      .select({ id: problemDetail.entryId })
      .from(problemDetail)
      .innerJoin(clinicalEntry, eq(clinicalEntry.id, problemDetail.entryId))
      .where(eq(clinicalEntry.patientId, s.richPatient));
    problemId = p!.id;
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const req = (method: 'GET' | 'POST' | 'PUT', url: string, cookie: string, payload?: object) =>
    s.app.inject({ method, url, headers: { cookie }, ...(payload ? { payload } : {}) });
  const base = {
    drugAic: '900000011',
    drugName: 'PROVALINA 28 compresse 5 mg',
    activeIngredient: 'principio di prova',
    dose: '1',
    doseUnit: 'compressa',
    frequency: '1 volta al giorno',
    timeOfDay: 'la sera',
    route: 'per bocca',
    unitsPerDay: '1',
    kind: 'chronic',
    startOn: '2026-11-01',
    packsPerPrescription: 1,
  };
  const url = () => `/api/pazienti/${s.richPatient}/terapie`;

  it('il medico crea una terapia con indicazione e la ritrova tra le terapie', async () => {
    const res = await req('POST', url(), doctor, { ...base, indicationEntryId: problemId });
    expect(res.statusCode, res.body).toBe(201);
    const list = (await req('GET', url(), doctor)).json().terapie;
    const created = list.find((x: { id: string }) => x.id === res.json().id);
    expect(created).toMatchObject({
      drugName: 'PROVALINA 28 compresse 5 mg',
      unitsPerDay: '1',
      status: 'active',
      indicationEntryId: problemId,
    });
  });

  it('i controlli formali della scheda: motivazione della non sostituibilità, fine del ciclo, indicazione', async () => {
    const r1 = await req('POST', url(), doctor, { ...base, notSubstitutable: true });
    expect(r1.statusCode).toBe(400);
    expect(JSON.stringify(r1.json())).toMatch(/serve una sintetica motivazione \(R13\)/);
    expect((await req('POST', url(), doctor, { ...base, kind: 'cycle' })).statusCode).toBe(400);
    expect(
      (await req('POST', url(), doctor, { ...base, startOn: '2026-11-10', endOn: '2026-11-01' }))
        .statusCode,
    ).toBe(400);
    expect((await req('POST', url(), doctor, { ...base, suggestedS: true })).statusCode).toBe(400);
    // Un problema di un altro paziente non può essere l'indicazione.
    const other = s.patients.titolare.find((x) => x !== s.richPatient)!;
    const res = await req('POST', `/api/pazienti/${other}/terapie`, doctor, {
      ...base,
      indicationEntryId: problemId,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().errore).toMatch(/non è un problema di questo paziente/);
  });

  it('la segreteria non modifica le terapie, e il tentativo è registrato', async () => {
    const res = await req('POST', url(), secretary, base);
    expect(res.statusCode).toBe(403);
    const logged = await t.db
      .select()
      .from(accessLog)
      .where(
        and(eq(accessLog.userId, s.users.segreteria.id), eq(accessLog.action, 'nuova_terapia')),
      );
    expect(logged.map((l) => l.outcome)).toContain('negato');
  });

  it('modifica: si salva la scheda intera', async () => {
    const id = (await req('POST', url(), doctor, base)).json().id;
    const res = await req('PUT', `${url()}/${id}`, doctor, {
      ...base,
      dose: '2',
      unitsPerDay: '2',
      byActiveIngredient: true,
      notSubstitutable: true,
      notSubstitutableReason: 'Motivazione di prova',
    });
    expect(res.statusCode, res.body).toBe(200);
    const [row] = await t.db.select().from(therapy).where(eq(therapy.id, id));
    expect(row).toMatchObject({
      dose: '2',
      unitsPerDay: '2',
      byActiveIngredient: true,
      notSubstitutableReason: 'Motivazione di prova',
    });
  });

  it('sospensione per reazione avversa: la reazione entra tra le allergie; poi si riprende', async () => {
    const id = (await req('POST', url(), doctor, base)).json().id;
    expect((await req('POST', `${url()}/${id}/sospendi`, doctor, {})).statusCode).toBe(400);
    const res = await req('POST', `${url()}/${id}/sospendi`, doctor, {
      motivo: 'Reazione cutanea di prova',
      reazioneAvversa: true,
      reazione: 'Eritema di prova',
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ stato: 'suspended', reazioneRegistrata: true });
    const [row] = await t.db.select().from(therapy).where(eq(therapy.id, id));
    expect(row).toMatchObject({
      status: 'suspended',
      suspendedReason: 'Reazione cutanea di prova',
    });
    const summary = (await req('GET', `/api/pazienti/${s.richPatient}`, doctor)).json().riepilogo;
    expect(summary.allergie).toContainEqual({
      sostanza: 'principio di prova',
      reazione: 'Eritema di prova',
    });
    expect(
      (await req('POST', `${url()}/${id}/sospendi`, doctor, { motivo: 'Di nuovo' })).statusCode,
    ).toBe(409);
    expect((await req('POST', `${url()}/${id}/riprendi`, doctor)).statusCode).toBe(200);
    const [again] = await t.db.select().from(therapy).where(eq(therapy.id, id));
    expect(again).toMatchObject({ status: 'active', suspendedReason: null });
    expect((await req('POST', `${url()}/${id}/riprendi`, doctor)).statusCode).toBe(409);
  });

  it('una terapia riservata non si tocca senza il permesso di leggerla', async () => {
    const [reserved] = await t.db
      .select()
      .from(therapy)
      .where(and(eq(therapy.patientId, s.richPatient), eq(therapy.reserved, true)));
    // La segreteria si ferma già alla guardia; il medico titolare la modifica.
    expect((await req('PUT', `${url()}/${reserved!.id}`, secretary, base)).statusCode).toBe(403);
    expect(
      (await req('PUT', `${url()}/${reserved!.id}`, doctor, { ...base, reserved: true }))
        .statusCode,
    ).toBe(200);
  });

  it('/api/io dice al titolare qual è il suo archivio; alla segreteria no', async () => {
    expect((await req('GET', '/api/io', doctor)).json().archivio).toMatchObject({
      id: s.archives.titolare,
    });
    expect((await req('GET', '/api/io', secretary)).json().archivio).toBeNull();
  });
});
