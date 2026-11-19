import { SimulatedAura, type AuraChoice } from '@mmg/integrations';
import { and, desc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accessLog,
  auraChange,
  auraDoctorChange,
  doctorProfile,
  patient,
  prescription,
  sickLeaveCertificate,
} from '../src/db/schema';
import { buildExport } from '../src/export/export';
import { studioDate } from '../src/prescriptions/rules-check';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

interface ToDecide {
  id: string;
  paziente: { id: string; cognome: string; nome: string };
  medico: string;
  sceltaDal: string;
}
interface Incoming {
  id: string;
  paziente: Record<string, string>;
  daMedico: string;
  sceltaDal: string;
}

/**
 * Risposta della fermata dopo l'unione della #13 (D200): il paziente sceglie in AURA un altro medico
 * dello studio. Un avviso in Oggi ai due medici; lo spostamento nell'archivio del nuovo medico lo
 * conferma il titolare di prima, con un clic, o sceglie di non spostarlo.
 */
describe('AURA: cambio di medico dentro lo studio (D200)', () => {
  let t: TestDatabase;
  let s: Scenario;
  const cookies = { titolare: '', collega: '', segreteria: '', sostituto: '' };
  type Who = keyof typeof cookies;
  let ownerCf: string;
  let colleagueCf: string;
  const aura = new SimulatedAura();

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db, {}, { aura: { gateway: aura } });
    for (const who of Object.keys(cookies) as Who[]) cookies[who] = await login(s, who);
    const cf = async (userId: string) =>
      (
        await t.db
          .select({ cf: doctorProfile.fiscalCode })
          .from(doctorProfile)
          .where(eq(doctorProfile.userId, userId))
      )[0]!.cf!;
    ownerCf = await cf(s.users.titolare.id);
    colleagueCf = await cf(s.users.collega.id);
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const inject = (method: 'GET' | 'POST', url: string, who: Who, payload?: object) =>
    s.app.inject({
      method,
      url,
      headers: { cookie: cookies[who] },
      ...(payload ? { payload } : {}),
    });
  const list = async (who: Who) => {
    const res = await inject('GET', '/api/aura/cambi-medico', who);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ daDecidere: ToDecide[]; inArrivo: Incoming[] }>();
  };
  /** Il cambio come lo vede chi decide: medico scelto e data della scelta. */
  const seenOf = async (id: string) => {
    const [c] = await t.db.select().from(auraDoctorChange).where(eq(auraDoctorChange.id, id));
    return { medico: c!.toDoctorUserId, sceltaDal: c!.chosenOn };
  };
  const move = async (id: string, who: Who = 'titolare', seen?: object) =>
    inject('POST', `/api/aura/cambi-medico/${id}/sposta`, who, seen ?? (await seenOf(id)));
  const keep = async (id: string, who: Who = 'titolare', seen?: object) =>
    inject('POST', `/api/aura/cambi-medico/${id}/non-spostare`, who, seen ?? (await seenOf(id)));
  const sync = async (patientId: string) => {
    const res = await inject('POST', `/api/pazienti/${patientId}/aura`, 'titolare');
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ esito: string }>();
  };
  const today = () => studioDate(s.clock.now());
  const day = (n: number) => studioDate(new Date(s.clock.now().getTime() + n * 86_400_000));
  const choice = (doctorFiscalCode: string, over: Partial<AuraChoice> = {}): AuraChoice => ({
    doctorFiscalCode,
    chosenOn: today(),
    expiresOn: null,
    endedOn: null,
    endReason: null,
    ...over,
  });
  const rowOf = async (patientId: string) =>
    (
      await t.db.select().from(auraDoctorChange).where(eq(auraDoctorChange.patientId, patientId))
    )[0];
  const patientRow = async (id: string) =>
    (await t.db.select().from(patient).where(eq(patient.id, id)))[0]!;
  const changesOf = (patientId: string, kind: string) =>
    t.db
      .select()
      .from(auraChange)
      .where(and(eq(auraChange.patientId, patientId), eq(auraChange.kind, kind)))
      .orderBy(auraChange.at);
  const lastLog = async (userId: string, action: string) =>
    (
      await t.db
        .select()
        .from(accessLog)
        .where(and(eq(accessLog.userId, userId), eq(accessLog.action, action)))
        .orderBy(desc(accessLog.seq))
        .limit(1)
    )[0];
  /** Le notifiche arrivano senza aspettare la risposta: si aspetta che siano applicate. */
  async function until(check: () => Promise<boolean>) {
    for (let i = 0; i < 150; i++) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('La notifica di AURA non è arrivata');
  }

  /**
   * Un paziente in carico nell'archivio del titolare che in AURA ha scelto il collega dello studio:
   * la scelta del titolare è cessata il giorno della scelta nuova.
   */
  async function switches(index: number, chosenOn = day(-1)) {
    const id = s.patients.titolare[index]!;
    const [p] = await t.db
      .update(patient)
      .set({ status: 'active' })
      .where(eq(patient.id, id))
      .returning();
    const auraId = aura.register({
      fiscalCode: p!.fiscalCode,
      lastName: p!.lastName.toUpperCase(),
      firstName: p!.firstName.toUpperCase(),
      birthDate: p!.birthDate,
      exemptions: [],
      choices: [
        choice(ownerCf, {
          chosenOn: '2020-01-01',
          endedOn: chosenOn,
          endReason: 'Scelta di un altro medico',
        }),
        choice(colleagueCf, { chosenOn }),
      ],
    });
    expect((await sync(id)).esito).toBe('aggiornato');
    return { id, auraId, p: p! };
  }

  let moved: { id: string; rowId: string };

  it('A: il paziente sceglie un collega dello studio: da decidere per il titolare di prima, informato il collega, e la lettura resta nel registro', async () => {
    const { id, p } = await switches(1);
    const row = await rowOf(id);
    expect(row).toMatchObject({
      status: 'da_decidere',
      fromArchiveId: s.archives.titolare,
      toArchiveId: s.archives.collega,
      toDoctorUserId: s.users.collega.id,
      chosenOn: day(-1),
      decidedBy: null,
    });
    moved = { id, rowId: row!.id };
    // Nell'archivio di prima il paziente risulta revocato (D198), finché non si sposta.
    expect(await patientRow(id)).toMatchObject({
      archiveId: s.archives.titolare,
      status: 'revoked',
    });
    const [news] = await changesOf(id, 'archivio');
    expect(news).toMatchObject({ change: 'nuova', subject: 'Dott. Paolo Serra' });
    expect(news!.description).toContain('Dott.ssa Elena Marchi');

    const owner = await list('titolare');
    expect(owner.daDecidere).toContainEqual(
      expect.objectContaining({
        id: row!.id,
        paziente: { id, cognome: p.lastName, nome: p.firstName },
        medico: 'Dott. Paolo Serra',
        sceltaDal: day(-1),
      }),
    );
    expect(owner.inArrivo.map((x) => x.id)).not.toContain(row!.id);

    // Il collega lo sa, senza il collegamento alla cartella: l'archivio non è suo.
    const colleague = await list('collega');
    expect(colleague.daDecidere.map((x) => x.id)).not.toContain(row!.id);
    const incoming = colleague.inArrivo.find((x) => x.id === row!.id)!;
    expect(incoming).toMatchObject({ daMedico: 'Dott.ssa Elena Marchi', sceltaDal: day(-1) });
    expect(incoming.paziente).toEqual({ cognome: p.lastName, nome: p.firstName });
    expect(await lastLog(s.users.collega.id, 'lettura_cambi_medico')).toMatchObject({
      patientId: id,
      outcome: 'consentito',
    });

    // Segreteria e sostituto non decidono e non sono il medico scelto.
    for (const who of ['segreteria', 'sostituto'] as const) {
      const other = await list(who);
      expect([...other.daDecidere, ...other.inArrivo].map((x) => x.id)).not.toContain(row!.id);
    }
  });

  it('B: sposta solo il titolare di prima: il collega, la segreteria e il sostituto no, e il no resta nel registro', async () => {
    const users = {
      collega: s.users.collega,
      segreteria: s.users.segreteria,
      sostituto: s.users.sostituto,
    };
    for (const who of ['collega', 'segreteria', 'sostituto'] as const) {
      const res = await move(moved.rowId, who);
      expect(res.statusCode, `${who}: ${res.body}`).toBe(403);
      expect(await lastLog(users[who].id, 'spostamento_archivio')).toMatchObject({
        patientId: moved.id,
        outcome: 'negato',
      });
      expect((await keep(moved.rowId, who)).statusCode).toBe(403);
    }
    expect((await rowOf(moved.id))!.status).toBe('da_decidere');
    expect((await patientRow(moved.id)).archiveId).toBe(s.archives.titolare);
  });

  it('C: con ricette o certificati aperti nell’archivio lo spostamento si ferma e li elenca; chiusi, il paziente passa al collega e torna in carico', async () => {
    const [pr] = await t.db
      .insert(prescription)
      .values({
        patientId: moved.id,
        archiveId: s.archives.titolare,
        kind: 'pharma_ssn',
        status: 'to_sign',
        preparedBy: s.users.segreteria.id,
      })
      .returning();
    const [source] = await t.db
      .select()
      .from(sickLeaveCertificate)
      .where(eq(sickLeaveCertificate.id, s.draftCertificate));
    const { id: sourceId, ...copy } = source!;
    expect(sourceId).toBe(s.draftCertificate);
    const [cert] = await t.db
      .insert(sickLeaveCertificate)
      .values({ ...copy, patientId: moved.id, archiveId: s.archives.titolare, status: 'draft' })
      .returning();

    // Il cambio visto non è più quello di AURA (altra data): si ricarica, niente si sposta.
    const stale = await move(moved.rowId, 'titolare', {
      medico: s.users.collega.id,
      sceltaDal: '2020-01-01',
    });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json<{ errore: string }>().errore).toBe(
      'AURA ha cambiato la scelta del paziente: ricarica la pagina',
    );

    const stopped = await move(moved.rowId);
    expect(stopped.statusCode, stopped.body).toBe(409);
    expect(stopped.json<{ errore: string }>().errore).toBe(
      'Prima dello spostamento vanno chiuse: 1 ricetta da firmare, 1 certificato in bozza',
    );
    expect((await patientRow(moved.id)).archiveId).toBe(s.archives.titolare);
    expect((await rowOf(moved.id))!.status).toBe('da_decidere');

    await t.db.update(prescription).set({ status: 'cancelled' }).where(eq(prescription.id, pr!.id));
    await t.db
      .update(sickLeaveCertificate)
      .set({ status: 'cancelled' })
      .where(eq(sickLeaveCertificate.id, cert!.id));

    const res = await move(moved.rowId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ stato: 'spostato', statoPaziente: 'active' });
    expect(await patientRow(moved.id)).toMatchObject({
      archiveId: s.archives.collega,
      status: 'active',
    });
    expect(await rowOf(moved.id)).toMatchObject({
      status: 'spostato',
      decidedBy: s.users.titolare.id,
    });
    const archived = await changesOf(moved.id, 'archivio');
    expect(archived.map((c) => c.change)).toEqual(['nuova', 'cambiata']);
    expect(archived[1]!.description).toContain('Spostato nell’archivio di Dott. Paolo Serra');
    expect((await changesOf(moved.id, 'stato')).at(-1)!.description).toContain(
      'Paziente di nuovo in carico',
    );
    expect(await lastLog(s.users.titolare.id, 'spostamento_archivio')).toMatchObject({
      patientId: moved.id,
      outcome: 'riuscito',
      details: { da: s.archives.titolare, a: s.archives.collega, cambio: moved.rowId },
    });

    // Adesso è un paziente del collega; per il titolare di prima non c'è più niente da decidere.
    const opened = await inject('GET', `/api/pazienti/${moved.id}`, 'collega');
    expect(opened.statusCode, opened.body).toBe(200);
    expect((await list('titolare')).daDecidere.map((x) => x.id)).not.toContain(moved.rowId);
    expect((await list('collega')).inArrivo.map((x) => x.id)).not.toContain(moved.rowId);
    // Un secondo clic non sposta due volte.
    expect((await move(moved.rowId)).statusCode).toBe(409);
  });

  it('D: «Non spostare» resta finché AURA non manda una scelta nuova', async () => {
    const { id, auraId } = await switches(2);
    const row = await rowOf(id);
    // Visto per un altro medico: si ricarica, e resta da decidere.
    const stale = await keep(row!.id, 'titolare', {
      medico: s.users.sostituto.id,
      sceltaDal: day(-1),
    });
    expect(stale.statusCode, stale.body).toBe(409);
    expect((await rowOf(id))!.status).toBe('da_decidere');
    const res = await keep(row!.id);
    expect(res.statusCode, res.body).toBe(200);
    expect(await rowOf(id)).toMatchObject({
      status: 'non_spostato',
      decidedBy: s.users.titolare.id,
    });
    expect(await lastLog(s.users.titolare.id, 'cambio_medico_non_spostato')).toMatchObject({
      patientId: id,
      outcome: 'riuscito',
    });
    expect((await list('titolare')).daDecidere.map((x) => x.id)).not.toContain(row!.id);

    // La stessa scelta, controllata di nuovo: non si ripropone.
    await sync(id);
    expect((await rowOf(id))!.status).toBe('non_spostato');
    expect(await changesOf(id, 'archivio')).toHaveLength(1);
    expect((await patientRow(id)).archiveId).toBe(s.archives.titolare);

    // Una scelta nuova, con un'altra data: di nuovo da decidere.
    aura.setChoice(auraId, choice(colleagueCf, { chosenOn: today() }));
    await until(async () => (await rowOf(id))!.status === 'da_decidere');
    expect(await rowOf(id)).toMatchObject({ chosenOn: today(), decidedBy: null, decidedAt: null });
    expect(await changesOf(id, 'archivio')).toHaveLength(2);
  });

  it('E: la proposta decade quando non vale più: il paziente torna dal titolare, o è deceduto', async () => {
    const { id, auraId } = await switches(3);
    expect((await rowOf(id))!.status).toBe('da_decidere');
    // Torna dal titolare: la scelta del collega cessa, quella nuova del titolare vale.
    aura.setChoice(
      auraId,
      choice(colleagueCf, { chosenOn: day(-1), endedOn: today(), endReason: 'Revoca' }),
    );
    aura.setChoice(auraId, choice(ownerCf, { chosenOn: today() }));
    await until(async () => (await rowOf(id))!.status === 'superato');
    await until(async () => (await patientRow(id)).status === 'active');
    expect((await patientRow(id)).archiveId).toBe(s.archives.titolare);
    expect((await move((await rowOf(id))!.id)).statusCode).toBe(409);

    // Deceduto: la proposta decade al controllo dopo.
    const other = await switches(4);
    expect((await rowOf(other.id))!.status).toBe('da_decidere');
    await t.db.update(patient).set({ status: 'deceased' }).where(eq(patient.id, other.id));
    await sync(other.id);
    expect((await rowOf(other.id))!.status).toBe('superato');
    expect((await list('titolare')).daDecidere.map((x) => x.id)).not.toContain(
      (await rowOf(other.id))!.id,
    );
  });

  it('F: con un controllo AURA in corso sul paziente, lo spostamento non aspetta il blocco e lo dice', async () => {
    // Il paziente della prova D, di nuovo da decidere con la scelta nuova.
    const id = s.patients.titolare[2]!;
    const row = await rowOf(id);
    expect(row!.status).toBe('da_decidere');
    const holder = await t.pool.connect();
    try {
      await holder.query('begin');
      await holder.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`aura:${id}`]);
      const res = await move(row!.id);
      expect(res.statusCode, res.body).toBe(409);
      expect(res.json<{ errore: string }>().errore).toBe(
        'Controllo con AURA in corso per questo paziente: riprova tra poco',
      );
      await holder.query('commit');
    } finally {
      holder.release();
    }
    expect((await patientRow(id)).archiveId).toBe(s.archives.titolare);
    expect((await move(row!.id)).statusCode).toBe(200);
  });

  it('G: il cambio va nell’esportazione dell’archivio dove sta il paziente, con lo storico, e non si cancella', async () => {
    const ids = async (archiveId: string) =>
      ((await buildExport(t.db, archiveId, s.clock.now())).tabelle.aura_doctor_change ?? []).map(
        (r) => r.id,
      );
    expect(await ids(s.archives.collega)).toContain(moved.rowId);
    expect(await ids(s.archives.titolare)).not.toContain(moved.rowId);
    const history = await t.db.execute<{ n: string }>(
      sql`select count(*) as n from change_history where table_name = 'aura_doctor_change' and row_id = ${moved.rowId}`,
    );
    expect(Number(history.rows[0]!.n)).toBeGreaterThanOrEqual(2);
    await expect(
      t.db.delete(auraDoctorChange).where(eq(auraDoctorChange.id, moved.rowId)),
    ).rejects.toThrow();
  });
});
