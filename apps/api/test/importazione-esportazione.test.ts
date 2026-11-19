import { and, eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  allergyDetail,
  clinicalEntry,
  diaryDetail,
  exemption,
  historicalPrescription,
  labResultDetail,
  measurementDetail,
  patient,
  prescription,
  prescriptionLine,
  problemDetail,
  therapy,
  vaccinationDetail,
} from '../src/db/schema';
import { withActor } from '../src/db/tx';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

/**
 * Trasferimento di un archivio tra due studi che usano il programma (tappa 15): l'esportazione
 * completa del primo (docs/esportazione.md) si importa nel secondo, con la mappatura proposta,
 * senza doppioni a una seconda importazione. Due studi inventati nello stesso database di prova.
 */
describe('importazione della nostra esportazione in un altro studio', () => {
  let t: TestDatabase;
  let source: Scenario;
  let target: Scenario;
  let exported: string;
  let doctor: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    source = await createScenario(t.db);
    const rich = source.richPatient;
    const author = source.users.titolare.id;
    // Altre voci del paziente ricco: parametro, vaccinazione, esame, ricetta inviata e passata.
    await withActor(t.db, author, async (tx) => {
      // I pazienti inventati deceduti non hanno la data del decesso, che i controlli dei dati
      // amministrativi chiedono (a mano come dall'importazione): qui gliela si dà.
      await tx
        .update(patient)
        .set({ deceasedOn: '2026-01-01' })
        .where(
          and(eq(patient.archiveId, source.archives.titolare), eq(patient.status, 'deceased')),
        );
      const entry = async (kind: typeof clinicalEntry.$inferInsert.kind) =>
        (
          await tx
            .insert(clinicalEntry)
            .values({ patientId: rich, kind, occurredOn: '2026-10-01', authorUserId: author })
            .returning({ id: clinicalEntry.id })
        )[0]!.id;
      // Una nota annullata nello studio d'origine: resta nell'esportazione, non si importa.
      const [annulled] = await tx
        .insert(clinicalEntry)
        .values({
          patientId: rich,
          kind: 'diary',
          occurredOn: '2026-10-02',
          authorUserId: author,
          status: 'annulled',
          annulledAt: new Date(),
          annulledBy: author,
          annulReason: 'Scritta nella cartella sbagliata (prova)',
        })
        .returning({ id: clinicalEntry.id });
      await tx
        .insert(diaryDetail)
        .values({ entryId: annulled!.id, contactType: 'office', text: 'Nota annullata inventata' });
      await tx.insert(measurementDetail).values({
        entryId: await entry('measurement'),
        measure: 'Peso',
        value: '70.5',
        unit: 'kg',
      });
      await tx.insert(vaccinationDetail).values({
        entryId: await entry('vaccination'),
        vaccine: 'Vaccino inventato',
        lot: 'L-1',
        doseNumber: 2,
      });
      await tx.insert(labResultDetail).values({
        entryId: await entry('lab_result'),
        analyte: 'Analita inventato',
        value: '5,4',
        unit: 'mmol/L',
      });
      const [p] = await tx
        .insert(prescription)
        .values({
          patientId: rich,
          archiveId: source.archives.titolare,
          kind: 'pharma_ssn',
          status: 'sent',
          nre: '000000000000000',
          preparedBy: author,
          signedBy: author,
          sentAt: new Date('2026-09-15T09:00:00Z'),
        })
        .returning({ id: prescription.id });
      await tx.insert(prescriptionLine).values({
        prescriptionId: p!.id,
        position: 1,
        drugName: 'Farmaco di prova 5 mg',
        activeIngredient: 'principio di prova',
        quantity: 2,
      });
      await tx.insert(historicalPrescription).values({
        patientId: rich,
        archiveId: source.archives.titolare,
        kind: 'prestazione',
        prescribedOn: '2025-05-05',
        serviceCode: '90.27.1',
        serviceDescription: 'Prestazione inventata',
        recordedBy: author,
      });
    });
    const cookie = await login(source, 'titolare');
    const res = await source.app.inject({
      method: 'GET',
      url: '/api/esportazione',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    exported = res.body;
    target = await createScenario(t.db);
    doctor = await login(target, 'titolare');
  });
  afterAll(async () => {
    await source?.app.close();
    await target?.app.close();
    await t?.drop();
  });

  async function importAll(body: string) {
    const up = await target.app.inject({
      method: 'POST',
      url: '/api/importazioni',
      headers: { cookie: doctor },
      payload: { nome: 'esportazione.json', contenuto: Buffer.from(body).toString('base64') },
    });
    expect(up.statusCode, up.body).toBe(201);
    const a = up.json<{
      id: string;
      formato: string;
      mappaturaProposta: unknown;
      note: string[];
    }>();
    expect(a.formato).toBe('mmg-esportazione');
    expect(a.mappaturaProposta).not.toBeNull();
    const mappatura = a.mappaturaProposta;
    for (const step of ['prova', 'importa']) {
      const res = await target.app.inject({
        method: 'POST',
        url: `/api/importazioni/${a.id}/${step}`,
        headers: { cookie: doctor },
        payload: { mappatura },
      });
      expect(res.statusCode, res.body).toBe(200);
      if (step === 'importa')
        return { analysis: a, result: res.json<{ conteggi: Record<string, number> }>() };
    }
    throw new Error('non raggiunto');
  }

  it('pazienti, voci cliniche, esenzioni, terapie e ricette arrivano nell’archivio del nuovo titolare', async () => {
    const { result } = await importAll(exported);
    expect(result.conteggi).toMatchObject({ scartate: 0, pazientiNuovi: 5 });
    const sourcePatients = await t.db
      .select()
      .from(patient)
      .where(eq(patient.archiveId, source.archives.titolare));
    const imported = await t.db
      .select()
      .from(patient)
      .where(eq(patient.archiveId, target.archives.titolare));
    // Nell'archivio d'arrivo ci sono i suoi pazienti e, in più, tutti quelli dell'esportazione.
    const sourceCodes = sourcePatients.map((p) => p.fiscalCode).sort();
    expect(
      imported
        .map((p) => p.fiscalCode)
        .filter((c) => sourceCodes.includes(c))
        .sort(),
    ).toEqual(sourceCodes);
    expect(imported).toHaveLength(target.patients.titolare.length + sourceCodes.length);
    const [richSource] = await t.db
      .select()
      .from(patient)
      .where(eq(patient.id, source.richPatient));
    const rich = imported.find((p) => p.fiscalCode === richSource!.fiscalCode)!;
    expect(rich).toMatchObject({
      firstName: richSource!.firstName,
      lastName: richSource!.lastName,
      birthDate: richSource!.birthDate,
      studioId: target.studioId,
    });
    const entries = await t.db
      .select()
      .from(clinicalEntry)
      .where(eq(clinicalEntry.patientId, rich.id));
    expect(entries.map((e) => e.kind).sort()).toEqual(
      ['allergy', 'diary', 'diary', 'lab_result', 'measurement', 'problem', 'vaccination'].sort(),
    );
    for (const e of entries) expect(e.authorUserId).toBe(target.users.titolare.id);
    const ids = entries.map((e) => e.id);
    const diary = await t.db.select().from(diaryDetail).where(inArray(diaryDetail.entryId, ids));
    expect(diary.map((d) => d.text).sort()).toEqual(
      ['Nota riservata di prova.', 'Visita di controllo, paziente inventato.'].sort(),
    );
    // La nota riservata resta riservata.
    const reserved = entries.find(
      (e) => e.id === diary.find((d) => d.text.startsWith('Nota'))!.entryId,
    );
    expect(reserved!.reserved).toBe(true);
    expect(
      (await t.db.select().from(problemDetail).where(inArray(problemDetail.entryId, ids)))[0],
    ).toMatchObject({ icdCode: '000.0', description: 'Problema di prova' });
    expect(
      (await t.db.select().from(allergyDetail).where(inArray(allergyDetail.entryId, ids)))[0],
    ).toMatchObject({ substance: 'Sostanza di prova', drugRelated: true });
    expect(
      (
        await t.db.select().from(measurementDetail).where(inArray(measurementDetail.entryId, ids))
      )[0],
    ).toMatchObject({ measure: 'Peso', value: '70.5', unit: 'kg' });
    expect(
      (
        await t.db.select().from(vaccinationDetail).where(inArray(vaccinationDetail.entryId, ids))
      )[0],
    ).toMatchObject({ vaccine: 'Vaccino inventato', lot: 'L-1', doseNumber: 2 });
    expect(
      (await t.db.select().from(labResultDetail).where(inArray(labResultDetail.entryId, ids)))[0],
    ).toMatchObject({ analyte: 'Analita inventato', value: '5,4', unit: 'mmol/L' });
    expect(await t.db.select().from(exemption).where(eq(exemption.patientId, rich.id))).toEqual([
      expect.objectContaining({ code: 'P00', validFrom: '2026-01-01' }),
    ]);
    const therapies = await t.db.select().from(therapy).where(eq(therapy.patientId, rich.id));
    expect(therapies.map((x) => [x.drugName, x.reserved]).sort()).toEqual(
      [
        ['Farmaco di prova 5 mg', false],
        ['Farmaco riservato di prova', true],
      ].sort(),
    );
    const past = await t.db
      .select()
      .from(historicalPrescription)
      .where(
        and(
          eq(historicalPrescription.patientId, rich.id),
          eq(historicalPrescription.archiveId, target.archives.titolare),
        ),
      );
    expect(
      past.map((h) => [h.kind, h.drugName ?? h.serviceDescription, h.prescribedOn]).sort(),
    ).toEqual(
      [
        ['farmaco', 'Farmaco di prova 5 mg', '2026-09-15'],
        ['prestazione', 'Prestazione inventata', '2025-05-05'],
      ].sort(),
    );
    expect(past.find((h) => h.kind === 'farmaco')).toMatchObject({
      nre: '000000000000000',
      quantity: 2,
      prescriberName: 'Dott.ssa Elena Marchi',
    });
  });

  it('la stessa esportazione una seconda volta: nulla di nuovo', async () => {
    const before = await t.db.select().from(clinicalEntry);
    const { result } = await importAll(exported);
    expect(result.conteggi).toMatchObject({ scritte: 0, scartate: 0, pazientiNuovi: 0 });
    expect((await t.db.select().from(clinicalEntry)).length).toBe(before.length);
  });

  it('un’esportazione cambiata dopo essere stata creata non entra', async () => {
    const doc = JSON.parse(exported) as { tabelle: { diary_detail: { text: string }[] } };
    doc.tabelle.diary_detail[0]!.text = 'Testo cambiato dopo l’esportazione';
    const res = await target.app.inject({
      method: 'POST',
      url: '/api/importazioni',
      headers: { cookie: doctor },
      payload: {
        nome: 'esportazione.json',
        contenuto: Buffer.from(JSON.stringify(doc)).toString('base64'),
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ errore: string }>().errore).toMatch(/modificata dopo essere stata creata/);
  });
});
