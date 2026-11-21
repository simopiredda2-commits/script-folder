import { SimulatedAura, type AuraChoice } from '@mmg/integrations';
import { eq } from 'drizzle-orm';
import { rmSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  auraDoctorChange,
  doctorProfile,
  patient,
  patientArchiveMove,
  ppipRecord,
} from '../src/db/schema';
import { buildExport } from '../src/export/export';
import { studioDate } from '../src/prescriptions/rules-check';
import { importPpipCatalog } from './helpers/ppip';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

interface Riga {
  id: string;
  paziente: string;
  pazienteNellArchivio: boolean;
}

/**
 * Risposta di Simone del 21/11/2026, «secondo le regole» (D240): il compenso di una prestazione
 * aggiuntiva è del medico che l'ha eseguita (ACN, allegato 6, commi 4 e 6). Dopo «Sposta» (D200)
 * una prestazione eseguita prima dello spostamento va nella distinta del medico di prima, anche se
 * la si registra dopo; il giorno dello spostamento sceglie chi registra. Il paziente lascia
 * l'archivio della titolare il 18/11/2026; la prova va avanti al 20/11. Pazienti inventati.
 */
describe('prestazioni aggiuntive dopo «Sposta»: nella distinta di chi aveva il paziente (D240)', () => {
  let t: TestDatabase;
  let s: Scenario;
  let work: string;
  let monitor: pg.Client;
  const aura = new SimulatedAura();
  const cookies = { titolare: '', collega: '' };
  type Who = keyof typeof cookies;
  let moved: string;
  let changeId: string;
  const before: string[] = [];

  const req = (who: Who, method: 'GET' | 'POST', url: string, payload?: object) =>
    s.app.inject({
      method,
      url,
      headers: { cookie: cookies[who] },
      ...(payload !== undefined ? { payload } : {}),
    });
  const register = (who: Who, data: string, extra: object = {}) =>
    req(who, 'POST', `/api/pazienti/${moved}/ppip`, {
      data,
      codice: 'A1',
      luogo: 'studio',
      ...extra,
    });
  const archiveOfRecord = async (id: string) =>
    (await t.db.select().from(ppipRecord).where(eq(ppipRecord.id, id)))[0]!.archiveId;
  const distinta = async (who: Who, archive: string) =>
    (await req(who, 'GET', `/api/archivi/${archive}/ppip?mese=2026-11`)).json<{ righe: Riga[] }>()
      .righe;
  const choice = (doctorFiscalCode: string, over: Partial<AuraChoice> = {}): AuraChoice => ({
    doctorFiscalCode,
    chosenOn: '2026-11-16',
    expiresOn: null,
    endedOn: null,
    endReason: null,
    ...over,
  });

  beforeAll(async () => {
    t = await createTestDatabase();
    monitor = new pg.Client({ connectionString: t.url });
    await monitor.connect();
    s = await createScenario(
      t.db,
      { idleLockMinutes: null },
      { aura: { gateway: aura }, clockAt: new Date('2026-11-18T09:00:00Z') },
    );
    for (const who of Object.keys(cookies) as Who[]) cookies[who] = await login(s, who);
    work = (await importPpipCatalog(t.db)).work;
    const cf = async (userId: string) =>
      (
        await t.db
          .select({ cf: doctorProfile.fiscalCode })
          .from(doctorProfile)
          .where(eq(doctorProfile.userId, userId))
      )[0]!.cf!;
    // In AURA il paziente della titolare ha scelto il collega dello studio dal 16/11.
    moved = s.patients.titolare[1]!;
    const [p] = await t.db
      .update(patient)
      .set({ status: 'active' })
      .where(eq(patient.id, moved))
      .returning();
    aura.register({
      fiscalCode: p!.fiscalCode,
      lastName: p!.lastName.toUpperCase(),
      firstName: p!.firstName.toUpperCase(),
      birthDate: p!.birthDate,
      exemptions: [],
      choices: [
        choice(await cf(s.users.titolare.id), {
          chosenOn: '2020-01-01',
          endedOn: '2026-11-16',
          endReason: 'Scelta di un altro medico',
        }),
        choice(await cf(s.users.collega.id)),
      ],
    });
    expect((await req('titolare', 'POST', `/api/pazienti/${moved}/aura`)).statusCode).toBe(200);
    // Prima dello spostamento la titolare registra una prestazione del 17/11: è nella sua distinta.
    const early = await register('titolare', '2026-11-17');
    expect(early.statusCode, early.body).toBe(201);
    before.push(early.json<{ id: string }>().id);
    // Il 18/11 la titolare sposta il paziente nell'archivio del collega.
    const [c] = await t.db
      .select()
      .from(auraDoctorChange)
      .where(eq(auraDoctorChange.patientId, moved));
    changeId = c!.id;
    const res = await req('titolare', 'POST', `/api/aura/cambi-medico/${changeId}/sposta`, {
      medico: c!.toDoctorUserId,
      sceltaDal: c!.chosenOn,
    });
    expect(res.statusCode, res.body).toBe(200);
    // Due giorni dopo, con una sessione nuova.
    s.clock.advance(2 * 86_400_000);
    for (const who of Object.keys(cookies) as Who[]) cookies[who] = await login(s, who);
  });
  afterAll(async () => {
    await s?.app.close();
    await monitor?.end();
    await t?.drop();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it('«Sposta» resta nello storico degli spostamenti, che non si modifica né si cancella', async () => {
    const rows = await t.db
      .select()
      .from(patientArchiveMove)
      .where(eq(patientArchiveMove.patientId, moved));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fromArchiveId: s.archives.titolare,
      toArchiveId: s.archives.collega,
      movedBy: s.users.titolare.id,
      doctorChangeId: changeId,
    });
    expect(studioDate(rows[0]!.movedAt)).toBe('2026-11-18');
    await expect(
      t.db.update(patientArchiveMove).set({ toArchiveId: s.archives.titolare }),
    ).rejects.toThrow();
    await expect(t.db.delete(patientArchiveMove)).rejects.toThrow();
    // La cartella dice chi aveva il paziente, giorno per giorno.
    const page = (await req('collega', 'GET', `/api/pazienti/${moved}/ppip`)).json();
    expect(page.archivio).toBe(s.archives.collega);
    expect(page.spostamenti).toEqual([
      {
        giorno: '2026-11-18',
        da: s.archives.titolare,
        daNome: expect.any(String),
        a: s.archives.collega,
        aNome: expect.any(String),
      },
    ]);
  });

  it('eseguita prima dello spostamento e registrata dopo: nella distinta della titolare di prima', async () => {
    const res = await register('collega', '2026-11-17');
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json<{ id: string }>().id;
    before.push(id);
    expect(await archiveOfRecord(id)).toBe(s.archives.titolare);
    const hers = await distinta('titolare', s.archives.titolare);
    expect(hers.filter((r) => r.paziente === moved).map((r) => r.id)).toEqual(before);
    expect(hers.find((r) => r.id === id)!.pazienteNellArchivio).toBe(false);
    expect((await distinta('collega', s.archives.collega)).map((r) => r.id)).not.toContain(id);
    // Nella cartella del collega si vede in quale distinta è, e lì si annulla.
    const list = (await req('collega', 'GET', `/api/pazienti/${moved}/ppip`)).json()
      .prestazioni as { id: string; altroArchivio: string | null }[];
    expect(list.find((p) => p.id === id)!.altroArchivio).toEqual(expect.any(String));
    const refused = await req('collega', 'POST', `/api/pazienti/${moved}/ppip/${id}/annulla`, {
      motivo: 'Registrata per errore',
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().errore).toMatch(
      /il giorno dell’esecuzione: si annulla da quella distinta/,
    );
    // Un altro archivio per quel giorno non si sceglie.
    const wrong = await register('collega', '2026-11-17', { archivio: s.archives.collega });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().errore).toMatch(
      /Il 17\/11\/2026 il paziente era nell’archivio «.+»: la prestazione va nella sua distinta/,
    );
  });

  it('il giorno dello spostamento sceglie chi registra, fra l’archivio di prima e quello di dopo', async () => {
    const missing = await register('collega', '2026-11-18');
    expect(missing.statusCode).toBe(400);
    expect(missing.json().errore).toMatch(
      /Il 18\/11\/2026 il paziente è passato dall’archivio «.+» a «.+»: scegli in quale distinta/,
    );
    const other = await register('collega', '2026-11-18', {
      archivio: '00000000-0000-4000-8000-000000000000',
    });
    expect(other.statusCode).toBe(400);
    const hers = await register('collega', '2026-11-18', { archivio: s.archives.titolare });
    expect(hers.statusCode, hers.body).toBe(201);
    expect(await archiveOfRecord(hers.json<{ id: string }>().id)).toBe(s.archives.titolare);
    const his = await register('collega', '2026-11-18', { archivio: s.archives.collega });
    expect(his.statusCode, his.body).toBe(201);
    expect(await archiveOfRecord(his.json<{ id: string }>().id)).toBe(s.archives.collega);
  });

  it('eseguita dopo lo spostamento: nella distinta del collega', async () => {
    const res = await register('collega', '2026-11-19');
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json<{ id: string }>().id;
    expect(await archiveOfRecord(id)).toBe(s.archives.collega);
    expect((await distinta('collega', s.archives.collega)).map((r) => r.id)).toContain(id);
    expect((await distinta('titolare', s.archives.titolare)).map((r) => r.id)).not.toContain(id);
  });

  it('la titolare porta con sé le prestazioni della sua distinta e lo spostamento (regola 4)', async () => {
    const hers = await buildExport(t.db, s.archives.titolare, s.clock.now());
    const ids = hers.tabelle.ppip_record!.map((r) => r.id);
    for (const id of before) expect(ids).toContain(id);
    expect(hers.tabelle.patient!.map((p) => p.id)).not.toContain(moved);
    expect(hers.tabelle.patient_archive_move!.map((m) => m.patient_id)).toEqual([moved]);
    const his = await buildExport(t.db, s.archives.collega, s.clock.now());
    expect(his.tabelle.ppip_record!.map((r) => r.id)).toEqual(expect.arrayContaining(before));
    expect(his.tabelle.patient_archive_move!.map((m) => m.patient_id)).toEqual([moved]);
  });

  it('uno spostamento a metà della registrazione la ferma: si ricarica la pagina', async () => {
    // Un altro spostamento in corso tiene il paziente e lo riporta alla titolare.
    await monitor.query('begin');
    await monitor.query('select id from patient where id = $1 for update', [moved]);
    await monitor.query('update patient set archive_id = $2 where id = $1', [
      moved,
      s.archives.titolare,
    ]);
    let settled = false;
    const pending = register('collega', '2026-11-19').then((r) => {
      settled = true;
      return r;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(settled).toBe(false);
    await monitor.query('commit');
    const res = await pending;
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().errore).toMatch(/Nel frattempo il paziente è passato a un altro archivio/);
  });
});
