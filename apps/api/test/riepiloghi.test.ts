import { and, desc, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accessLog,
  archiveSecretary,
  clinicalEntry,
  diaryDetail,
  patient,
  prescription,
  prescriptionLine,
  vaccinationDetail,
} from '../src/db/schema';
import { withActor } from '../src/db/tx';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

interface Summary {
  dal: string;
  al: string;
  visite: {
    totale: number;
    telefonici: number;
    perTipo: { tipo: string; nome: string; numero: number }[];
    perMedico: { medico: string; numero: number }[];
  };
  ricette: {
    totale: { inviate: number; cartacee: number; annullate: number; righe: number };
    perTipo: {
      tipo: string;
      nome: string;
      inviate: number;
      cartacee: number;
      annullate: number;
      righe: number;
    }[];
    perMedico: { medico: string; numero: number }[];
  };
  vaccinazioni: {
    totale: number;
    perVaccino: { vaccino: string; campagna: string | null; numero: number }[];
    perMedico: { medico: string; numero: number }[];
  };
}

/**
 * Riepiloghi per periodo (requisiti, «Riepiloghi»; D201): visite e contatti, ricette inviate,
 * cartacee e annullate, vaccinazioni, con l'esportazione in CSV. Dati inventati, in un mese del
 * 2001 in cui lo scenario non ha altro.
 */
describe('riepiloghi dell’archivio per periodo (D201)', () => {
  let t: TestDatabase;
  let s: Scenario;
  const cookies = {
    titolare: '',
    collega: '',
    segreteria: '',
    sostituto: '',
    amministratore: '',
  };
  type Who = keyof typeof cookies;
  const MARCH = '?dal=2001-03-01&al=2001-03-31';
  const SECRET_TEXT = 'Testo clinico inventato da non esportare';
  let first: typeof patient.$inferSelect;
  let second: typeof patient.$inferSelect;

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db);
    for (const who of Object.keys(cookies) as Who[]) cookies[who] = await login(s, who);
    const mine = await t.db
      .select()
      .from(patient)
      .where(eq(patient.archiveId, s.archives.titolare))
      .orderBy(patient.lastName, patient.firstName);
    [first, second] = [mine[0]!, mine[1]!];
    const other = s.patients.collega[0]!;
    const { titolare, sostituto } = s.users;
    await withActor(t.db, titolare.id, async (tx) => {
      const entry = async (
        patientId: string,
        kind: 'diary' | 'vaccination',
        occurredOn: string,
        authorUserId: string,
        annulled = false,
      ) =>
        (
          await tx
            .insert(clinicalEntry)
            .values({
              patientId,
              kind,
              occurredOn,
              authorUserId,
              ...(annulled
                ? {
                    status: 'annulled' as const,
                    annulledAt: new Date('2001-03-16T10:00:00Z'),
                    annulledBy: authorUserId,
                    annulReason: 'Scritta per errore',
                  }
                : {}),
            })
            .returning({ id: clinicalEntry.id })
        )[0]!.id;
      const diary = async (
        patientId: string,
        on: string,
        type: 'office' | 'home' | 'phone' | 'televisit',
        author = titolare.id,
        annulled = false,
      ) =>
        tx.insert(diaryDetail).values({
          entryId: await entry(patientId, 'diary', on, author, annulled),
          contactType: type,
          text: SECRET_TEXT,
        });
      await diary(first.id, '2001-03-05', 'office');
      await diary(second.id, '2001-03-10', 'home', sostituto.id);
      await diary(first.id, '2001-03-12', 'phone');
      await diary(second.id, '2001-03-31', 'televisit');
      // Fuori: il giorno dopo il periodo, annullata, o di un paziente di un altro archivio.
      await diary(first.id, '2001-04-01', 'office');
      await diary(first.id, '2001-03-15', 'office', titolare.id, true);
      await diary(other, '2001-03-06', 'office', s.users.collega.id);

      const vaccine = async (
        patientId: string,
        on: string,
        name: string,
        campaign: string | null,
        author = titolare.id,
        annulled = false,
      ) =>
        tx.insert(vaccinationDetail).values({
          entryId: await entry(patientId, 'vaccination', on, author, annulled),
          vaccine: name,
          doseNumber: 1,
          campaign,
          lot: 'LOTTO-PROVA',
        });
      await vaccine(first.id, '2001-03-07', 'Antinfluenzale', '2000/2001');
      await vaccine(second.id, '2001-03-08', 'Antinfluenzale', '2000/2001');
      await vaccine(second.id, '2001-03-09', 'Antitetanica', null);
      // Fuori: annullata, o di un paziente di un altro archivio.
      await vaccine(first.id, '2001-03-11', 'Antinfluenzale', '2000/2001', titolare.id, true);
      await vaccine(other, '2001-03-07', 'Antinfluenzale', '2000/2001', s.users.collega.id);

      const rx = async (
        values: Partial<typeof prescription.$inferInsert> & { patientId: string },
        lines: number,
      ) => {
        const [r] = await tx
          .insert(prescription)
          .values({
            archiveId: s.archives.titolare,
            kind: 'pharma_ssn',
            status: 'sent',
            preparedBy: titolare.id,
            ...values,
          })
          .returning({ id: prescription.id });
        for (let i = 1; i <= lines; i++)
          await tx.insert(prescriptionLine).values({
            prescriptionId: r!.id,
            position: i,
            drugName: `Farmaco di prova ${i}`,
            activeIngredient: 'principio di prova',
            quantity: 1,
          });
      };
      // Inviata il 5 marzo, due righe.
      await rx(
        {
          patientId: first.id,
          nre: 'NRE-PROVA-1',
          signedBy: titolare.id,
          sentAt: new Date('2001-03-05T10:00:00Z'),
        },
        2,
      );
      // Specialistica inviata alle 23:30 UTC del 20 marzo: a Roma è già il 21.
      await rx(
        {
          patientId: second.id,
          kind: 'specialist_ssn',
          nre: 'NRE-PROVA-2',
          signedBy: titolare.id,
          sentAt: new Date('2001-03-20T23:30:00Z'),
        },
        3,
      );
      // Cartacea il 22 marzo, una riga.
      await rx(
        {
          patientId: first.id,
          status: 'paper',
          paperPrintedBy: titolare.id,
          paperPrintedAt: new Date('2001-03-22T09:00:00Z'),
        },
        1,
      );
      // Inviata il 28 febbraio a Roma (fuori) e annullata il 2 marzo (dentro): conta l'annullamento.
      await rx(
        {
          patientId: second.id,
          status: 'cancelled',
          nre: 'NRE-PROVA-3',
          signedBy: titolare.id,
          sentAt: new Date('2001-02-28T22:30:00Z'),
          cancelledBy: titolare.id,
          cancelledAt: new Date('2001-03-02T08:00:00Z'),
          cancelReason: 'Errore di prescrizione',
        },
        1,
      );
      // Fuori: una bozza; una inviata alle 22:30 UTC del 31 marzo (a Roma, con l'ora legale, è
      // il primo aprile); una bozza annullata nel periodo; una di un altro archivio.
      await rx({ patientId: first.id, kind: 'white', status: 'draft' }, 1);
      await rx(
        {
          patientId: first.id,
          signedBy: titolare.id,
          sentAt: new Date('2001-03-31T22:30:00Z'),
        },
        1,
      );
      await rx(
        {
          patientId: first.id,
          status: 'cancelled',
          cancelledBy: titolare.id,
          cancelledAt: new Date('2001-03-10T08:00:00Z'),
          cancelReason: 'Bozza scartata',
        },
        1,
      );
      await rx(
        {
          patientId: other,
          archiveId: s.archives.collega,
          signedBy: s.users.collega.id,
          sentAt: new Date('2001-03-05T10:00:00Z'),
        },
        1,
      );
    });
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const get = (who: Who, url: string) =>
    s.app.inject({ method: 'GET', url, headers: { cookie: cookies[who] } });
  const lastLog = async (userId: string, action: string) =>
    (
      await t.db
        .select()
        .from(accessLog)
        .where(and(eq(accessLog.userId, userId), eq(accessLog.action, action)))
        .orderBy(desc(accessLog.seq))
        .limit(1)
    )[0];

  it('i conteggi del periodo: visite e contatti per tipo, ricette per tipo ed evento, vaccinazioni per vaccino e campagna', async () => {
    const res = await get('titolare', `/api/archivi/${s.archives.titolare}/riepiloghi${MARCH}`);
    expect(res.statusCode, res.body).toBe(200);
    const r = res.json<Summary>();
    expect(r).toMatchObject({ dal: '2001-03-01', al: '2001-03-31' });
    expect(r.visite.totale).toBe(3);
    expect(r.visite.telefonici).toBe(1);
    expect(r.visite.perTipo).toEqual([
      { tipo: 'office', nome: 'In studio', numero: 1 },
      { tipo: 'home', nome: 'A domicilio', numero: 1 },
      { tipo: 'televisit', nome: 'Televisita', numero: 1 },
      { tipo: 'phone', nome: 'Telefono', numero: 1 },
    ]);
    expect(r.visite.perMedico).toEqual([
      { medico: 'Dott.ssa Elena Marchi', numero: 3 },
      { medico: 'Dott. Marco Fiore', numero: 1 },
    ]);
    expect(r.ricette.totale).toEqual({ inviate: 2, cartacee: 1, annullate: 1, righe: 6 });
    expect(r.ricette.perTipo).toEqual([
      {
        tipo: 'pharma_ssn',
        nome: 'Farmaceutica SSN',
        inviate: 1,
        cartacee: 1,
        annullate: 1,
        righe: 3,
      },
      {
        tipo: 'specialist_ssn',
        nome: 'Specialistica SSN',
        inviate: 1,
        cartacee: 0,
        annullate: 0,
        righe: 3,
      },
      { tipo: 'white', nome: 'Bianca', inviate: 0, cartacee: 0, annullate: 0, righe: 0 },
      { tipo: 'devices', nome: 'Presidi', inviate: 0, cartacee: 0, annullate: 0, righe: 0 },
    ]);
    expect(r.ricette.perMedico).toEqual([{ medico: 'Dott.ssa Elena Marchi', numero: 4 }]);
    expect(r.vaccinazioni).toEqual({
      totale: 3,
      perVaccino: [
        { vaccino: 'Antinfluenzale', campagna: '2000/2001', numero: 2 },
        { vaccino: 'Antitetanica', campagna: null, numero: 1 },
      ],
      perMedico: [{ medico: 'Dott.ssa Elena Marchi', numero: 3 }],
    });
    // I conteggi non hanno pazienti: né codice fiscale, né identificativo, né campi del paziente;
    // una riga nel registro, senza paziente. (Non il cognome: lo scenario genera pazienti diversi a
    // ogni giro, e un paziente può chiamarsi come un medico, che nei conteggi c'è.)
    expect(res.body).not.toContain(first.fiscalCode);
    expect(res.body).not.toContain(first.id);
    expect(res.body).not.toMatch(/"(paziente|pazienteId|cognome|codiceFiscale)"/);
    expect(await lastLog(s.users.titolare.id, 'lettura_riepiloghi')).toMatchObject({
      patientId: null,
      outcome: 'consentito',
      details: { archivio: s.archives.titolare, dal: '2001-03-01', al: '2001-03-31' },
    });
  });

  it('il CSV: una riga per visita, per evento di una ricetta e per vaccinazione, senza testo clinico; una riga di registro per paziente', async () => {
    const res = await get(
      'titolare',
      `/api/archivi/${s.archives.titolare}/riepiloghi/esportazione${MARCH}`,
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv/);
    expect(res.headers['content-disposition']).toBe(
      'attachment; filename="riepilogo-2001-03-01-2001-03-31.csv"',
    );
    const text = res.body;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    const lines = text.slice(1).trimEnd().split('\r\n');
    expect(lines[0]).toBe('Sezione;Data;Tipo;Cognome;Nome;Codice fiscale;Dettaglio;Medico');
    expect(lines).toHaveLength(1 + 4 + 4 + 3);
    expect(lines).toContain(
      `Visite e contatti;2001-03-10;A domicilio;${second.lastName};${second.firstName};${second.fiscalCode};;Dott. Marco Fiore`,
    );
    expect(lines).toContain(
      `Ricette;2001-03-21;Specialistica SSN – inviata;${second.lastName};${second.firstName};${second.fiscalCode};NRE NRE-PROVA-2, 3 righe;Dott.ssa Elena Marchi`,
    );
    expect(lines).toContain(
      `Ricette;2001-03-02;Farmaceutica SSN – annullata;${second.lastName};${second.firstName};${second.fiscalCode};NRE NRE-PROVA-3, 1 riga;Dott.ssa Elena Marchi`,
    );
    expect(lines).toContain(
      `Vaccinazioni;2001-03-07;Antinfluenzale;${first.lastName};${first.firstName};${first.fiscalCode};dose 1, campagna 2000/2001, lotto LOTTO-PROVA;Dott.ssa Elena Marchi`,
    );
    expect(text).not.toContain(SECRET_TEXT);
    const perPatient = await t.db
      .select()
      .from(accessLog)
      .where(
        and(
          eq(accessLog.userId, s.users.titolare.id),
          eq(accessLog.action, 'esportazione_riepiloghi'),
          eq(accessLog.outcome, 'consentito'),
        ),
      );
    expect(perPatient.map((l) => l.patientId).sort()).toEqual([first.id, second.id].sort());
    expect(await lastLog(s.users.titolare.id, 'esportazione_riepiloghi')).toMatchObject({
      patientId: null,
      outcome: 'riuscito',
      details: { righe: 11 },
    });
  });

  it('il titolare e la segreteria confermata (D204); il collega, il sostituto e l’amministratore no, e il no resta nel registro', async () => {
    // La segreteria che il titolare ha confermato legge e scarica, come il titolare (D204); il
    // CSV resta nel registro paziente per paziente.
    const counts = await get(
      'segreteria',
      `/api/archivi/${s.archives.titolare}/riepiloghi${MARCH}`,
    );
    expect(counts.statusCode, counts.body).toBe(200);
    const csv = await get(
      'segreteria',
      `/api/archivi/${s.archives.titolare}/riepiloghi/esportazione${MARCH}`,
    );
    expect(csv.statusCode, csv.body).toBe(200);
    expect(csv.body).toContain(first.fiscalCode);
    expect(await lastLog(s.users.segreteria.id, 'esportazione_riepiloghi')).toMatchObject({
      outcome: 'riuscito',
      details: { archivio: s.archives.titolare },
    });
    const ofPatient = await t.db
      .select()
      .from(accessLog)
      .where(
        and(
          eq(accessLog.userId, s.users.segreteria.id),
          eq(accessLog.patientId, first.id),
          eq(accessLog.action, 'esportazione_riepiloghi'),
        ),
      );
    expect(ofPatient).toHaveLength(1);
    for (const who of ['collega', 'sostituto', 'amministratore'] as const) {
      for (const path of ['riepiloghi', 'riepiloghi/esportazione']) {
        const res = await get(who, `/api/archivi/${s.archives.titolare}/${path}${MARCH}`);
        expect(res.statusCode, `${who} ${path}`).toBe(403);
        expect(res.body).not.toContain(first.fiscalCode);
        expect(res.body).not.toContain(first.id);
      }
      expect(await lastLog(s.users[who].id, 'esportazione_riepiloghi')).toMatchObject({
        outcome: 'negato',
        details: { archivio: s.archives.titolare, permesso: 'reports.read' },
      });
    }
    // Il titolare non legge i riepiloghi dell'archivio di un collega.
    const res = await get('titolare', `/api/archivi/${s.archives.collega}/riepiloghi${MARCH}`);
    expect(res.statusCode).toBe(403);
    // Nessuna riga di registro su pazienti per chi non è passato.
    const leaked = await t.db
      .select()
      .from(accessLog)
      .where(and(eq(accessLog.userId, s.users.collega.id), isNull(accessLog.patientId)));
    expect(
      leaked.every((l) => l.outcome === 'negato' || l.action !== 'esportazione_riepiloghi'),
    ).toBe(true);
  });

  it('il periodo vuole due date vere, la prima non dopo la seconda', async () => {
    const base = `/api/archivi/${s.archives.titolare}/riepiloghi`;
    for (const q of [
      '',
      '?dal=2001-03-01',
      '?dal=2001-02-30&al=2001-03-31',
      '?dal=01/03/2001&al=2001-03-31',
    ])
      expect((await get('titolare', `${base}${q}`)).statusCode, q).toBe(400);
    const swapped = await get('titolare', `${base}?dal=2001-03-31&al=2001-03-01`);
    expect(swapped.statusCode).toBe(400);
    expect(swapped.json<{ errore: string }>().errore).toBe(
      'Nel periodo la data «dal» viene dopo la data «al»',
    );
    // Un giorno solo va bene.
    const one = await get('titolare', `${base}?dal=2001-03-21&al=2001-03-21`);
    expect(one.statusCode).toBe(200);
    expect(one.json<Summary>().ricette.totale.inviate).toBe(1);
  });

  // Ultima del file: toglie alla segreteria la conferma sull'archivio del collega.
  it('la segreteria che un titolare non ha confermato non ha i riepiloghi del suo archivio (D204)', async () => {
    await t.db.insert(archiveSecretary).values({
      archiveId: s.archives.collega,
      userId: s.users.segreteria.id,
      decision: 'rifiutata',
      decidedBy: s.users.collega.id,
      decidedAt: s.clock.now(),
    });
    for (const path of ['riepiloghi', 'riepiloghi/esportazione']) {
      const res = await get('segreteria', `/api/archivi/${s.archives.collega}/${path}${MARCH}`);
      expect(res.statusCode, path).toBe(403);
      expect(res.json().errore).toBe(
        'I riepiloghi dell’archivio li leggono ed esportano il medico titolare e la segreteria che ha confermato',
      );
    }
    // L'elenco degli archivi dei riepiloghi: la segreteria vede quello che l'ha confermata, il
    // titolare il suo, il sostituto e l'amministratore nessuno.
    const archives = async (who: Who) =>
      (await get(who, '/api/riepiloghi/archivi'))
        .json<{ archivi: { id: string }[] }>()
        .archivi.map((a) => a.id);
    expect(await archives('segreteria')).toEqual([s.archives.titolare]);
    expect(await archives('titolare')).toEqual([s.archives.titolare]);
    expect(await archives('sostituto')).toEqual([]);
    expect(await archives('amministratore')).toEqual([]);
  });
});
