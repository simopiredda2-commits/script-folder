import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allergyDetail, clinicalEntry } from '../src/db/schema';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

describe('ruoli e permessi attraverso il servizio', () => {
  let t: TestDatabase;
  let s: Scenario;
  const cookies: Record<string, string> = {};
  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db);
    for (const who of [
      'titolare',
      'collega',
      'segreteria',
      'sostituto',
      'amministratore',
    ] as const) {
      cookies[who] = await login(s, who);
    }
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const get = (who: string, url: string) =>
    s.app.inject({ method: 'GET', url, headers: { cookie: cookies[who]! } });

  it('il titolare apre la cartella con il riepilogo e vede anche la terapia riservata', async () => {
    const res = await get('titolare', `/api/pazienti/${s.richPatient}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().riepilogo.allergie).toHaveLength(1);
    const ter = await get('titolare', `/api/pazienti/${s.richPatient}/terapie`);
    expect(ter.json().terapie).toHaveLength(2);
    const diario = await get('titolare', `/api/pazienti/${s.richPatient}/diario`);
    expect(diario.json().diario).toHaveLength(2);
  });

  it('il titolare non apre i pazienti del collega (archivi separati)', async () => {
    expect((await get('titolare', `/api/pazienti/${s.patients.collega[0]}`)).statusCode).toBe(403);
    expect((await get('collega', `/api/pazienti/${s.richPatient}`)).statusCode).toBe(403);
  });

  it('l’elenco mostra a ciascun medico solo il proprio archivio, alla segreteria tutti', async () => {
    const own = (await get('titolare', '/api/pazienti'))
      .json()
      .pazienti.map((p: { id: string }) => p.id);
    expect(own.sort()).toEqual([...s.patients.titolare].sort());
    const all = (await get('segreteria', '/api/pazienti')).json().pazienti;
    expect(all).toHaveLength(s.patients.titolare.length + s.patients.collega.length);
    // L'amministratore dello studio non vede nessun archivio: la risposta lo dice, per spiegarlo.
    expect((await get('amministratore', '/api/pazienti')).json()).toEqual({
      pazienti: [],
      archivi: 0,
    });
    expect((await get('titolare', '/api/pazienti')).json().archivi).toBe(1);
  });

  it('la ricerca trova per cognome e per codice fiscale', async () => {
    const first = (await get('titolare', `/api/pazienti/${s.richPatient}`)).json().paziente;
    const byName = await get('titolare', `/api/pazienti?q=${encodeURIComponent(first.lastName)}`);
    expect(byName.json().pazienti.map((p: { id: string }) => p.id)).toContain(s.richPatient);
    const byCf = await get('titolare', `/api/pazienti?q=${first.fiscalCode.slice(0, 11)}`);
    expect(byCf.json().pazienti.map((p: { id: string }) => p.id)).toContain(s.richPatient);
  });

  it('la segreteria apre l’anagrafica senza riepilogo clinico, vede solo le terapie non riservate e non legge il diario', async () => {
    const res = await get('segreteria', `/api/pazienti/${s.richPatient}`);
    expect(res.statusCode).toBe(200);
    expect(res.json().riepilogo).toBeNull();
    const ter = await get('segreteria', `/api/pazienti/${s.richPatient}/terapie`);
    expect(ter.json().terapie.map((x: { drugName: string }) => x.drugName)).toEqual([
      'Farmaco di prova 5 mg',
    ]);
    expect((await get('segreteria', `/api/pazienti/${s.richPatient}/diario`)).statusCode).toBe(403);
  });

  it('il titolare decide che cosa vede la segreteria del suo archivio (riepilogo e diario)', async () => {
    const url = `/api/archivi/${s.archives.titolare}/impostazioni`;
    const patch = (who: string, payload: object) =>
      s.app.inject({ method: 'PATCH', url, payload, headers: { cookie: cookies[who]! } });
    for (const who of ['segreteria', 'sostituto', 'collega', 'amministratore']) {
      expect((await patch(who, { segreteriaLeggeRiepilogo: true })).statusCode, who).toBe(403);
    }
    const on = await patch('titolare', {
      segreteriaLeggeRiepilogo: true,
      segreteriaLeggeDiario: true,
    });
    expect(on.json()).toEqual({
      segreteriaLeggeDiario: true,
      segreteriaLeggeRiepilogo: true,
      medicazioniAvanzate: [],
    });

    // Un'allergia riservata: la vede il medico, non la segreteria.
    const [e] = await s.db
      .insert(clinicalEntry)
      .values({
        patientId: s.richPatient,
        kind: 'allergy',
        occurredOn: '2026-11-12',
        authorUserId: s.users.titolare.id,
        reserved: true,
      })
      .returning();
    await s.db
      .insert(allergyDetail)
      .values({ entryId: e!.id, substance: 'Allergia riservata di prova' });
    const doctorView = (await get('titolare', `/api/pazienti/${s.richPatient}`)).json();
    expect(doctorView.riepilogo.allergie).toHaveLength(2);
    const rec = (await get('segreteria', `/api/pazienti/${s.richPatient}`)).json();
    expect(rec.riepilogo.allergie).toHaveLength(1);
    const diario = await get('segreteria', `/api/pazienti/${s.richPatient}/diario`);
    expect(diario.statusCode).toBe(200);
    // La nota riservata resta visibile solo al medico.
    expect(diario.json().diario).toHaveLength(1);

    const off = await patch('titolare', {
      segreteriaLeggeRiepilogo: false,
      segreteriaLeggeDiario: false,
    });
    expect(off.json()).toEqual({
      segreteriaLeggeDiario: false,
      segreteriaLeggeRiepilogo: false,
      medicazioniAvanzate: [],
    });
    expect((await get('segreteria', `/api/pazienti/${s.richPatient}`)).json().riepilogo).toBeNull();
    expect((await get('titolare', url)).json().segreteriaLeggeRiepilogo).toBe(false);
  });

  it('il sostituto, nel periodo, lavora sull’archivio del titolare ma non esporta', async () => {
    expect((await get('sostituto', `/api/pazienti/${s.richPatient}/diario`)).statusCode).toBe(200);
    expect((await get('sostituto', `/api/pazienti/${s.patients.collega[0]}`)).statusCode).toBe(403);
    expect((await get('sostituto', '/api/esportazione')).statusCode).toBe(403);
  });

  it('l’amministratore non ha accesso clinico', async () => {
    expect((await get('amministratore', `/api/pazienti/${s.richPatient}`)).statusCode).toBe(403);
    expect((await get('amministratore', '/api/esportazione')).statusCode).toBe(403);
  });

  it('solo il titolare legge il registro degli accessi dei suoi pazienti', async () => {
    expect((await get('titolare', `/api/pazienti/${s.richPatient}/registro`)).statusCode).toBe(200);
    for (const who of ['segreteria', 'sostituto', 'collega', 'amministratore']) {
      expect((await get(who, `/api/pazienti/${s.richPatient}/registro`)).statusCode, who).toBe(403);
    }
  });
});
