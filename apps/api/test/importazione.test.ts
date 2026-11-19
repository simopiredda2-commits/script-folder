import { buildFiscalCode } from '@mmg/domain';
import { and, eq, sql } from 'drizzle-orm';
import { strToU8 } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accessLog,
  allergyDetail,
  anamnesisDetail,
  clinicalEntry,
  diaryDetail,
  examinationDetail,
  exemption,
  functionalStatusDetail,
  historicalPrescription,
  importBatch,
  importOrigin,
  labResultDetail,
  measurementDetail,
  patient,
  problemDetail,
  riskFactorDetail,
  therapy,
  vaccinationDetail,
} from '../src/db/schema';
import { verifyAccessLog } from '../src/audit/access-log';
import { withActor } from '../src/db/tx';
import { importError } from '../src/import/errors';
import { studioDate } from '../src/prescriptions/rules-check';
import { buildXlsx, column } from './helpers/importazione-xlsx';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { studioDayFrom } from './helpers/dates';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

/**
 * Importazione da altri programmi (tappa 15), dal caricamento alla scrittura, con file inventati
 * costruiti qui. Pazienti inventati: codice fiscale con la X in dodicesima posizione (D12).
 */

const cf = (surname: string, name: string, birthDate: string, sex: 'M' | 'F', place = 'X101') =>
  buildFiscalCode({ surname, name, birthDate, sex, placeCode: place });

// Pazienti nuovi del file dei pazienti.
const ROSSETTI = cf('Rossetti', 'Maria', '1970-02-01', 'F');
const BALDI = cf('Baldi', 'Ugo', '1955-11-30', 'M', 'X102');
// Un codice senza la X: luogo «Y001», che nessun comune né Stato ha (D12): non è di nessuno, ma
// la guardia della regola 1 lo deve rifiutare.
const NOT_FICTITIOUS = cf('Neri', 'Ada', '1980-05-05', 'F', 'Y001');

type FieldMap = Record<
  string,
  | string
  | { costante: string }
  | { colonna: string; corrispondenze?: Record<string, string>; formatoData?: 'testo' | 'seriale' }
>;

function part(
  tabella: string,
  destinazione: string,
  header: string[],
  campi: FieldMap,
  extra: Record<string, unknown> = {},
) {
  const ref = (name: string) => {
    const i = header.indexOf(name);
    if (i < 0) throw new Error(`colonna di prova inesistente: ${name}`);
    return { lettera: column(i), nome: name };
  };
  return {
    tabella,
    intestazione: 1,
    destinazione,
    campi: Object.fromEntries(
      Object.entries(campi).map(([k, v]) =>
        typeof v === 'string'
          ? [k, { colonna: ref(v) }]
          : 'costante' in v
            ? [k, { costante: v.costante }]
            : [k, { ...v, colonna: ref(v.colonna) }],
      ),
    ),
    ...extra,
  };
}

const csv = (rows: string[][]) => rows.map((r) => r.join(';')).join('\r\n') + '\r\n';

interface RunResult {
  id: string;
  stato: string;
  conteggi: Record<string, number>;
  rapporto: {
    riga: number;
    esito: string;
    motivi: string[];
    avvisi: string[];
    destinazione: string;
  }[];
}

describe('importazione da altri programmi', () => {
  let t: TestDatabase;
  let s: Scenario;
  let doctor: string;
  let colleague: string;
  const today = studioDate(new Date());
  const tomorrow = studioDayFrom(new Date(), 1);

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db);
    doctor = await login(s, 'titolare');
    colleague = await login(s, 'collega');
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const inject = (
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    cookie: string,
    payload?: unknown,
  ) =>
    s.app.inject({
      method,
      url,
      headers: { cookie },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
  const upload = (cookie: string, nome: string, content: string | Uint8Array) =>
    inject('POST', '/api/importazioni', cookie, {
      nome,
      contenuto: Buffer.from(typeof content === 'string' ? strToU8(content) : content).toString(
        'base64',
      ),
    });

  async function flow(
    nome: string,
    content: string | Uint8Array,
    parti: ReturnType<typeof part>[],
    programma?: string,
  ): Promise<{ id: string; prova: RunResult; scrittura: RunResult }> {
    const up = await upload(doctor, nome, content);
    expect(up.statusCode, up.body).toBe(201);
    const id = up.json<{ id: string }>().id;
    const mappatura = { parti, ...(programma ? { programma } : {}) };
    const prova = await inject('POST', `/api/importazioni/${id}/prova`, doctor, { mappatura });
    expect(prova.statusCode, prova.body).toBe(200);
    const scrittura = await inject('POST', `/api/importazioni/${id}/importa`, doctor, {
      mappatura,
    });
    expect(scrittura.statusCode, scrittura.body).toBe(200);
    return { id, prova: prova.json<RunResult>(), scrittura: scrittura.json<RunResult>() };
  }

  /** Righe delle tabelle dei pazienti e dello storico (senza quello delle importazioni). */
  async function patientDataCounts() {
    const tables = [
      'patient',
      'clinical_entry',
      'problem_detail',
      'diary_detail',
      'allergy_detail',
      'measurement_detail',
      'exemption',
      'therapy',
      'historical_prescription',
      'vaccination_detail',
      'lab_result_detail',
      'import_origin',
    ];
    const out: Record<string, number> = {};
    for (const name of tables)
      out[name] = Number(
        (await t.db.execute<{ n: string }>(sql`select count(*) as n from ${sql.identifier(name)}`))
          .rows[0]!.n,
      );
    out.change_history = Number(
      (
        await t.db.execute<{ n: string }>(
          sql`select count(*) as n from change_history where table_name <> 'import_batch'`,
        )
      ).rows[0]!.n,
    );
    return out;
  }

  const patientsHeader = [
    'Codice fiscale',
    'Cognome',
    'Nome',
    'Sesso',
    'Data di nascita',
    'Telefono',
    'Email',
    'Indirizzo',
    'CAP',
    'Comune',
    'Provincia',
    'Stato',
  ];
  const patientsFile = csv([
    patientsHeader,
    [
      ROSSETTI,
      'Rossetti',
      'Maria',
      'F',
      '01/02/1970',
      '000 1111111',
      'maria.rossetti@example.org',
      'Via delle Prove',
      '10100',
      'Comune di prova',
      'to',
      'attivo',
    ],
    [
      BALDI,
      'Baldi',
      'Ugo',
      'maschio',
      '1955-11-30',
      '',
      '',
      'Via Inventata',
      '',
      'Comune di prova',
      'TO',
      '',
    ],
    [ROSSETTI.toLowerCase(), 'Rossetti', 'Maria', 'F', '01/02/1970', '', '', '', '', '', '', ''],
    [NOT_FICTITIOUS, 'Neri', 'Ada', 'F', '05/05/1980', '', '', '', '', '', '', ''],
    [
      cf('Galli', 'Rita', '1990-01-10', 'F'),
      'Galli',
      'Rita',
      'F',
      '31/02/1990',
      '',
      '',
      '',
      '',
      '',
      '',
      '',
    ],
  ]);
  const patientsPart = () =>
    part('CSV', 'pazienti', patientsHeader, {
      codiceFiscale: 'Codice fiscale',
      cognome: 'Cognome',
      nome: 'Nome',
      sesso: 'Sesso',
      nascita: 'Data di nascita',
      telefono: 'Telefono',
      email: 'Email',
      residenzaVia: 'Indirizzo',
      residenzaCap: 'CAP',
      residenzaComune: 'Comune',
      residenzaProvincia: 'Provincia',
      stato: 'Stato',
    });

  describe('pazienti', () => {
    let batchId: string;

    it('il caricamento legge il file e suggerisce destinazione e colonne', async () => {
      const res = await upload(doctor, 'assistiti.csv', patientsFile);
      expect(res.statusCode, res.body).toBe(201);
      const a = res.json<{
        id: string;
        formato: string;
        separatore: string;
        giaImportatoIl: string | null;
        tabelle: {
          nome: string;
          righe: number;
          suggerimento: { destinazione: string; campi: Record<string, { lettera: string }> };
        }[];
      }>();
      batchId = a.id;
      expect(a.formato).toBe('csv');
      expect(a.separatore).toBe(';');
      expect(a.giaImportatoIl).toBeNull();
      expect(a.tabelle[0]!.righe).toBe(5);
      expect(a.tabelle[0]!.suggerimento.destinazione).toBe('pazienti');
      expect(a.tabelle[0]!.suggerimento.campi).toMatchObject({
        codiceFiscale: { lettera: 'A' },
        cognome: { lettera: 'B' },
        nascita: { lettera: 'E' },
      });
    });

    it('l’anteprima mostra le righe trasformate e i problemi, senza toccare le cartelle', async () => {
      const res = await inject('POST', `/api/importazioni/${batchId}/anteprima`, doctor, {
        mappatura: { parti: [patientsPart()] },
      });
      expect(res.statusCode, res.body).toBe(200);
      const rows = res.json<{
        parti: {
          totale: number;
          righe: { riga: number; valori: Record<string, unknown>; errori: string[] }[];
        }[];
      }>().parti[0]!;
      expect(rows.totale).toBe(5);
      expect(rows.righe[0]!.valori).toMatchObject({
        nascita: '1970-02-01',
        sesso: 'F',
        residenzaProvincia: 'TO',
      });
      expect(rows.righe[1]!.valori).toMatchObject({ sesso: 'M', nascita: '1955-11-30' });
      expect(rows.righe[3]!.errori.join(' ')).toMatch(/X in dodicesima posizione/);
      expect(rows.righe[4]!.errori.join(' ')).toMatch(/non esiste/);
    });

    it('la prova senza scrivere non scrive nulla e dà il rapporto riga per riga', async () => {
      const before = await patientDataCounts();
      const res = await inject('POST', `/api/importazioni/${batchId}/prova`, doctor, {
        mappatura: { parti: [patientsPart()] },
      });
      expect(res.statusCode, res.body).toBe(200);
      const r = res.json<RunResult>();
      expect(r.stato).toBe('prova');
      expect(r.conteggi).toMatchObject({
        righe: 5,
        scritte: 2,
        doppioni: 1,
        scartate: 2,
        pazientiNuovi: 2,
      });
      expect(r.rapporto.map((x) => [x.riga, x.esito])).toEqual([
        [2, 'scritta'],
        [3, 'scritta'],
        [4, 'doppione'],
        [5, 'scartata'],
        [6, 'scartata'],
      ]);
      expect(await patientDataCounts()).toEqual(before);
      const [b] = await t.db.select().from(importBatch).where(eq(importBatch.id, batchId));
      expect(b!.status).toBe('prova');
      expect(b!.destination).toBe('pazienti');
    });

    it('l’importazione scrive i pazienti nell’archivio del titolare, con la provenienza', async () => {
      const res = await inject('POST', `/api/importazioni/${batchId}/importa`, doctor, {
        mappatura: { parti: [patientsPart()] },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json<RunResult>().conteggi).toMatchObject({ scritte: 2, scartate: 2 });
      const [p] = await t.db.select().from(patient).where(eq(patient.fiscalCode, ROSSETTI));
      expect(p).toMatchObject({
        archiveId: s.archives.titolare,
        lastName: 'Rossetti',
        sex: 'F',
        birthDate: '1970-02-01',
        phone: '000 1111111',
        residencePostalCode: '10100',
        residenceProvince: 'TO',
        status: 'active',
      });
      const origins = await t.db
        .select()
        .from(importOrigin)
        .where(eq(importOrigin.batchId, batchId));
      expect(origins.map((o) => o.tableName)).toEqual(['patient', 'patient']);
      // La provenienza è un'impronta: nessun codice fiscale in chiaro.
      for (const o of origins) expect(o.sourceKey).not.toContain(ROSSETTI);
      expect(
        await t.db.select().from(patient).where(eq(patient.fiscalCode, NOT_FICTITIOUS)),
      ).toEqual([]);
      // Una riga del registro per ogni paziente creato, con l'id dell'importazione.
      const logs = await t.db
        .select()
        .from(accessLog)
        .where(and(eq(accessLog.patientId, p!.id), eq(accessLog.action, 'importazione')));
      expect(logs).toHaveLength(1);
      expect(logs[0]!.details).toMatchObject({ importazione: batchId });
      // Le righe dei pazienti si scrivono in un comando solo: la catena del registro resta intera.
      expect(await verifyAccessLog(t.db)).toBeNull();
    });

    it('la stessa importazione una seconda volta non scrive nulla di nuovo', async () => {
      const before = await patientDataCounts();
      const up = await upload(doctor, 'assistiti.csv', patientsFile);
      expect(up.json<{ giaImportatoIl: string | null }>().giaImportatoIl).not.toBeNull();
      const id = up.json<{ id: string }>().id;
      const mappatura = { parti: [patientsPart()] };
      const prova = await inject('POST', `/api/importazioni/${id}/prova`, doctor, { mappatura });
      expect(prova.json<RunResult>().conteggi).toMatchObject({
        scritte: 0,
        giaPresenti: 2,
        doppioni: 1,
      });
      const scrittura = await inject('POST', `/api/importazioni/${id}/importa`, doctor, {
        mappatura,
      });
      expect(scrittura.statusCode, scrittura.body).toBe(200);
      const after = await patientDataCounts();
      expect(after.patient).toBe(before.patient);
      expect(after.import_origin).toBe(before.import_origin);
    });

    it('un paziente già in cartella: si completano solo i campi vuoti, nulla si sovrascrive', async () => {
      // Un paziente inventato deceduto, nello scenario, non ha la data del decesso: lo stesso
      // completamento non lo deve fermare (il file non tocca il decesso).
      await withActor(t.db, s.users.titolare.id, (tx) =>
        tx
          .update(patient)
          .set({ status: 'deceased', deceasedOn: null })
          .where(eq(patient.id, s.patients.titolare[1]!)),
      );
      const [existing] = await t.db
        .select()
        .from(patient)
        .where(eq(patient.id, s.patients.titolare[1]!));
      const [other] = await t.db
        .select()
        .from(patient)
        .where(eq(patient.id, s.patients.collega[0]!));
      const header = ['CF', 'Cognome', 'Nome', 'Sesso', 'Nato il', 'Telefono', 'CAP', 'ASL'];
      const file = csv([
        header,
        [
          existing!.fiscalCode,
          existing!.lastName,
          existing!.firstName,
          existing!.sex,
          existing!.birthDate,
          '000 9999999',
          '10100',
          'ASL di prova',
        ],
        [
          other!.fiscalCode,
          other!.lastName,
          other!.firstName,
          other!.sex,
          existing!.birthDate,
          '',
          '',
          '',
        ],
      ]);
      const { scrittura } = await flow('completamento.csv', file, [
        part('CSV', 'pazienti', header, {
          codiceFiscale: 'CF',
          cognome: 'Cognome',
          nome: 'Nome',
          sesso: 'Sesso',
          nascita: 'Nato il',
          telefono: 'Telefono',
          residenzaCap: 'CAP',
          asl: 'ASL',
        }),
      ]);
      const [first, second] = scrittura.rapporto;
      expect(first!.esito).toBe('completata');
      expect(first!.motivi.join(' ')).toMatch(/Residenza: CAP, ASL/);
      expect(first!.avvisi.join(' ')).toMatch(/non sovrascritto: Telefono/);
      const [after] = await t.db.select().from(patient).where(eq(patient.id, existing!.id));
      expect(after).toMatchObject({
        phone: existing!.phone,
        residencePostalCode: '10100',
        asl: 'ASL di prova',
      });
      // Il paziente dell'altro archivio non si tocca, e il rapporto non ne dice nulla.
      expect(second!.esito).toBe('scartata');
      expect(second!.motivi.join(' ')).toMatch(/altro archivio/);
      expect(JSON.stringify(scrittura)).not.toContain(other!.lastName);
      const [untouched] = await t.db.select().from(patient).where(eq(patient.id, other!.id));
      expect(untouched).toEqual(other);
      // Il titolare dell'altro archivio vede nel registro del suo paziente il tentativo negato.
      const denied = await t.db
        .select()
        .from(accessLog)
        .where(and(eq(accessLog.patientId, other!.id), eq(accessLog.outcome, 'negato')));
      expect(denied.map((d) => d.action).sort()).toEqual(['importazione', 'prova_importazione']);
    });

    it('il completamento non rende incoerente la cartella: la data del decesso a un paziente in carico no', async () => {
      await withActor(t.db, s.users.titolare.id, (tx) =>
        tx
          .update(patient)
          .set({ status: 'active', deceasedOn: null })
          .where(eq(patient.id, s.patients.titolare[2]!)),
      );
      const [p] = await t.db.select().from(patient).where(eq(patient.id, s.patients.titolare[2]!));
      const header = ['CF', 'Cognome', 'Nome', 'Sesso', 'Nato il', 'Deceduto il'];
      const { scrittura } = await flow(
        'decesso.csv',
        csv([
          header,
          [p!.fiscalCode, p!.lastName, p!.firstName, p!.sex, p!.birthDate, '01/01/2026'],
        ]),
        [
          part('CSV', 'pazienti', header, {
            codiceFiscale: 'CF',
            cognome: 'Cognome',
            nome: 'Nome',
            sesso: 'Sesso',
            nascita: 'Nato il',
            decedutoIl: 'Deceduto il',
          }),
        ],
      );
      expect(scrittura.rapporto[0]!.esito).toBe('scartata');
      expect(scrittura.rapporto[0]!.motivi.join(' ')).toMatch(/solo per un paziente deceduto/);
      const [after] = await t.db.select().from(patient).where(eq(patient.id, p!.id));
      expect(after!.deceasedOn).toBeNull();
    });
  });

  describe('voci cliniche, smistate per valore di una colonna', () => {
    const header = ['CF', 'Data', 'Tipo', 'Testo', 'Codice', 'Contatto'];
    const rows = [
      header,
      [ROSSETTI, '12/03/2024', 'PRO', 'Ipertensione arteriosa', '401.9', ''],
      [ROSSETTI, '12/03/2024', 'PRO', 'Codice senza punto', '4019', ''],
      [ROSSETTI, '01/04/2024', 'ALL', 'Sostanza inventata', '', ''],
      [ROSSETTI, '02/04/2024', 'DIA', 'Visita di controllo inventata', '', 'AMB'],
      [ROSSETTI, '03/04/2024', 'DIA', 'Telefonata inventata', '', 'TEL'],
      [ROSSETTI, '', 'DIA', 'Nota senza data', '', 'AMB'],
      [ROSSETTI, tomorrow.split('-').reverse().join('/'), 'DIA', 'Nota nel futuro', '', 'AMB'],
      [ROSSETTI, '04/04/2024', 'ANA', 'Appendicectomia inventata', '', ''],
      [BALDI, '05/04/2024', 'STV', 'Non fumatore', 'Fumo', ''],
      [BALDI, '06/04/2024', 'EO', 'Obiettività nella norma', '', ''],
      [BALDI, '07/04/2024', 'CAP', 'autonomo', '', ''],
      [BALDI, '08/04/2024', 'XXX', 'Riga che non va da nessuna parte', '', ''],
      [
        cf('Sconosciuto', 'Ignoto', '1960-01-01', 'M'),
        '08/04/2024',
        'DIA',
        'Paziente assente',
        '',
        'AMB',
      ],
    ];
    const filter = (valori: string[]) => ({
      filtro: { colonna: { lettera: 'C', nome: 'Tipo' }, valori },
    });
    const parts = () => [
      part(
        'CSV',
        'problemi',
        header,
        { codiceFiscale: 'CF', data: 'Data', descrizione: 'Testo', codice: 'Codice' },
        filter(['PRO']),
      ),
      part(
        'CSV',
        'allergie',
        header,
        { codiceFiscale: 'CF', data: 'Data', sostanza: 'Testo' },
        filter(['ALL']),
      ),
      part(
        'CSV',
        'diario',
        header,
        {
          codiceFiscale: 'CF',
          data: 'Data',
          testo: 'Testo',
          contatto: { colonna: 'Contatto', corrispondenze: { AMB: 'studio', TEL: 'telefono' } },
        },
        filter(['DIA']),
      ),
      part(
        'CSV',
        'anamnesi',
        header,
        {
          codiceFiscale: 'CF',
          data: 'Data',
          testo: 'Testo',
          sezione: { costante: 'patologica_remota' },
        },
        filter(['ANA']),
      ),
      part(
        'CSV',
        'stili_di_vita',
        header,
        { codiceFiscale: 'CF', data: 'Data', fattore: 'Codice', valore: 'Testo' },
        filter(['STV']),
      ),
      part(
        'CSV',
        'esame_obiettivo',
        header,
        { codiceFiscale: 'CF', data: 'Data', testo: 'Testo' },
        filter(['EO']),
      ),
      part(
        'CSV',
        'capacita_motoria',
        header,
        { codiceFiscale: 'CF', data: 'Data', capacita: 'Testo' },
        filter(['CAP']),
      ),
    ];
    let result: RunResult;

    it('ogni riga va nel suo menu, con autore il titolare e la data del file', async () => {
      result = (await flow('storia-clinica.csv', csv(rows), parts())).scrittura;
      expect(result.conteggi).toMatchObject({ scritte: 8, scartate: 4, escluse: 1 });
      const [rossetti] = await t.db.select().from(patient).where(eq(patient.fiscalCode, ROSSETTI));
      const entries = await t.db
        .select()
        .from(clinicalEntry)
        .where(eq(clinicalEntry.patientId, rossetti!.id));
      expect(entries.map((e) => [e.kind, e.occurredOn]).sort()).toEqual(
        [
          ['allergy', '2024-04-01'],
          ['anamnesis', '2024-04-04'],
          ['diary', '2024-04-02'],
          ['diary', '2024-04-03'],
          ['problem', '2024-03-12'],
        ].sort(),
      );
      for (const e of entries) expect(e.authorUserId).toBe(s.users.titolare.id);
      const ids = entries.map((e) => e.id);
      const problems = await t.db.select().from(problemDetail);
      expect(problems.find((p) => ids.includes(p.entryId))).toMatchObject({
        icdCode: '401.9',
        description: 'Ipertensione arteriosa',
      });
      const diary = (await t.db.select().from(diaryDetail)).filter((d) => ids.includes(d.entryId));
      expect(diary.map((d) => d.contactType).sort()).toEqual(['office', 'phone']);
      const allergy = (await t.db.select().from(allergyDetail)).find((a) =>
        ids.includes(a.entryId),
      );
      expect(allergy).toMatchObject({ substance: 'Sostanza inventata', active: true });
      const anamnesis = (await t.db.select().from(anamnesisDetail)).find((a) =>
        ids.includes(a.entryId),
      );
      expect(anamnesis!.section).toBe('remote_pathological');
      const [baldi] = await t.db.select().from(patient).where(eq(patient.fiscalCode, BALDI));
      const baldiEntries = await t.db
        .select()
        .from(clinicalEntry)
        .where(eq(clinicalEntry.patientId, baldi!.id));
      expect(baldiEntries.map((e) => e.kind).sort()).toEqual([
        'examination',
        'functional_status',
        'risk_factor',
      ]);
      expect((await t.db.select().from(riskFactorDetail)).some((r) => r.factor === 'Fumo')).toBe(
        true,
      );
      expect(
        (await t.db.select().from(examinationDetail)).some(
          (r) => r.text === 'Obiettività nella norma',
        ),
      ).toBe(true);
      expect(
        (await t.db.select().from(functionalStatusDetail)).some(
          (r) => r.motorCapacity === 'LA21285-4',
        ),
      ).toBe(true);
    });

    it('una voce senza data non prende la data dell’importazione; una nel futuro non entra', () => {
      const byLine = (n: number) => result.rapporto.find((r) => r.riga === n)!;
      expect(byLine(7).esito).toBe('scartata');
      expect(byLine(7).motivi.join(' ')).toMatch(/non prende la data dell’importazione/);
      expect(byLine(8).motivi.join(' ')).toMatch(/nel futuro/);
      expect(byLine(14).motivi.join(' ')).toMatch(/importa prima i pazienti/);
    });

    it('gli stessi controlli dell’inserimento a mano, con lo stesso messaggio', async () => {
      const imported = result.rapporto.find((r) => r.riga === 3)!;
      expect(imported.esito).toBe('scartata');
      const [rossetti] = await t.db.select().from(patient).where(eq(patient.fiscalCode, ROSSETTI));
      const manual = await inject('POST', `/api/pazienti/${rossetti!.id}/voci`, doctor, {
        tipo: 'problema',
        data: '2024-03-12',
        descrizione: 'Codice senza punto',
        codice: '4019',
      });
      expect(manual.statusCode).toBe(400);
      const message = manual.json<{ dettagli: { problemi: string[] } }>().dettagli.problemi[0]!;
      expect(imported.motivi).toContain(message);
    });

    it('la stessa storia clinica una seconda volta: tutto «già presente»', async () => {
      const before = await patientDataCounts();
      const again = (await flow('storia-clinica.csv', csv(rows), parts())).scrittura;
      expect(again.conteggi).toMatchObject({ scritte: 0, giaPresenti: 8 });
      expect((await patientDataCounts()).clinical_entry).toBe(before.clinical_entry);
    });
  });

  describe('parametri, esami di laboratorio e vaccinazioni', () => {
    it('una colonna per parametro: una voce per cella piena; un valore sbagliato ferma la riga', async () => {
      const header = [
        'CF',
        'Data',
        'Peso',
        'Altezza',
        'Pressione sistolica',
        'Pressione diastolica',
      ];
      const { scrittura } = await flow(
        'parametri.csv',
        csv([
          header,
          [ROSSETTI, '10/05/2024', '72,5', '165', '130', '80'],
          [ROSSETTI, '11/05/2024', 'abc', '', '', ''],
          [BALDI, '12/05/2024', '', '', '140', ''],
        ]),
        [
          part('CSV', 'parametri', header, {
            codiceFiscale: 'CF',
            data: 'Data',
            valore_peso: 'Peso',
            valore_altezza: 'Altezza',
            valore_pressione_sistolica: 'Pressione sistolica',
            valore_pressione_diastolica: 'Pressione diastolica',
          }),
        ],
      );
      expect(scrittura.conteggi).toMatchObject({ scritte: 2, scartate: 1, voci: 5 });
      const [rossetti] = await t.db.select().from(patient).where(eq(patient.fiscalCode, ROSSETTI));
      const measures = await t.db
        .select({
          measure: measurementDetail.measure,
          value: measurementDetail.value,
          unit: measurementDetail.unit,
          on: clinicalEntry.occurredOn,
        })
        .from(measurementDetail)
        .innerJoin(clinicalEntry, eq(clinicalEntry.id, measurementDetail.entryId))
        .where(eq(clinicalEntry.patientId, rossetti!.id));
      expect(measures).toContainEqual({
        measure: 'Peso',
        value: '72.5',
        unit: 'kg',
        on: '2024-05-10',
      });
      expect(measures).toHaveLength(4);
    });

    it('parametro e valore in due colonne, esami di laboratorio e vaccinazioni', async () => {
      const header = [
        'CF',
        'Data',
        'Parametro',
        'Valore',
        'Esame',
        'Risultato',
        'Unità',
        'Vaccino',
        'Lotto',
        'Dose',
      ];
      const file = csv([
        header,
        [
          BALDI,
          '01/06/2024',
          'Glicemia',
          '98',
          'Emoglobina glicata',
          '6,1',
          '%',
          'Antinfluenzale inventato',
          'LOTTO-1',
          '1',
        ],
      ]);
      const { scrittura } = await flow('vari.csv', file, [
        part('CSV', 'parametri', header, {
          codiceFiscale: 'CF',
          data: 'Data',
          parametro: 'Parametro',
          valore: 'Valore',
        }),
        part('CSV', 'esami_laboratorio', header, {
          codiceFiscale: 'CF',
          data: 'Data',
          analita: 'Esame',
          valore: 'Risultato',
          unita: 'Unità',
        }),
        part('CSV', 'vaccinazioni', header, {
          codiceFiscale: 'CF',
          data: 'Data',
          vaccino: 'Vaccino',
          lotto: 'Lotto',
          dose: 'Dose',
        }),
      ]);
      expect(scrittura.conteggi).toMatchObject({ scritte: 3, scartate: 0 });
      expect(
        (await t.db.select().from(measurementDetail)).some(
          (m) => m.measure === 'Glicemia' && m.value === '98',
        ),
      ).toBe(true);
      const lab = (await t.db.select().from(labResultDetail)).find(
        (l) => l.analyte === 'Emoglobina glicata',
      );
      expect(lab).toMatchObject({ value: '6,1', unit: '%' });
      const vac = (await t.db.select().from(vaccinationDetail)).find((v) => v.lot === 'LOTTO-1');
      expect(vac).toMatchObject({ vaccine: 'Antinfluenzale inventato', doseNumber: 1 });
      const [entry] = await t.db
        .select()
        .from(clinicalEntry)
        .where(eq(clinicalEntry.id, vac!.entryId));
      expect(entry).toMatchObject({
        kind: 'vaccination',
        occurredOn: '2024-06-01',
        authorUserId: s.users.titolare.id,
      });
    });
  });

  describe('esenzioni, terapie e ricette passate da un XLSX con più fogli', () => {
    it('ogni foglio nella sua destinazione, nello stesso giro', async () => {
      const [rich] = await t.db.select().from(patient).where(eq(patient.id, s.richPatient));
      const exHeader = ['CF', 'Codice', 'Dal', 'Al'];
      const thHeader = [
        'CF',
        'Farmaco',
        'AIC',
        'Tipo',
        'Inizio',
        'Fine',
        'Stato',
        'Motivo',
        'Confezioni',
      ];
      const rxHeader = [
        'CF',
        'Data',
        'Tipo',
        'Farmaco',
        'AIC',
        'Quantità',
        'Codice',
        'Prestazione',
      ];
      const bytes = buildXlsx([
        {
          name: 'Esenzioni',
          rows: [
            exHeader,
            [ROSSETTI, '048', { date: 45000 }, null],
            [rich!.fiscalCode, 'P00', { date: 46023 }, null],
            [ROSSETTI, 'E99', { date: 45000 }, { date: 44000 }],
          ],
        },
        {
          name: 'Terapie',
          rows: [
            thHeader,
            [
              ROSSETTI,
              'Farmaco inventato 5 mg',
              38092019,
              'cronica',
              '01/01/2024',
              null,
              'in corso',
              null,
              1,
            ],
            [
              ROSSETTI,
              'Farmaco concluso',
              null,
              'ciclo',
              '01/02/2024',
              '10/02/2024',
              'conclusa',
              null,
              2,
            ],
            [
              ROSSETTI,
              'Farmaco sospeso',
              null,
              'cronica',
              '01/03/2024',
              null,
              'sospesa',
              'Reazione inventata',
              1,
            ],
            [
              ROSSETTI,
              'Conclusa senza fine',
              null,
              'cronica',
              '01/03/2024',
              null,
              'conclusa',
              null,
              1,
            ],
          ],
        },
        {
          name: 'Ricette',
          rows: [
            rxHeader,
            [
              ROSSETTI,
              { date: 45300 },
              'farmaco',
              'Farmaco inventato 5 mg',
              '038092019',
              2,
              null,
              null,
            ],
            [ROSSETTI, { date: 45301 }, 'prestazione', null, null, null, '90.27.1', 'Glucosio'],
            [ROSSETTI, tomorrow, 'farmaco', 'Nel futuro', null, 1, null, null],
          ],
        },
      ]);
      const { id, scrittura } = await flow(
        'archivio.xlsx',
        bytes,
        [
          part('Ricette', 'ricette_passate', rxHeader, {
            codiceFiscale: 'CF',
            data: 'Data',
            tipo: 'Tipo',
            farmaco: 'Farmaco',
            aic: 'AIC',
            quantita: 'Quantità',
            codicePrestazione: 'Codice',
            descrizionePrestazione: 'Prestazione',
          }),
          part('Esenzioni', 'esenzioni', exHeader, {
            codiceFiscale: 'CF',
            codice: 'Codice',
            dal: 'Dal',
            al: 'Al',
          }),
          part('Terapie', 'terapie', thHeader, {
            codiceFiscale: 'CF',
            farmaco: 'Farmaco',
            aic: 'AIC',
            tipo: 'Tipo',
            inizio: 'Inizio',
            fine: 'Fine',
            stato: 'Stato',
            motivoSospensione: 'Motivo',
            confezioni: 'Confezioni',
          }),
        ],
        'Programma di prova',
      );
      const by = (dest: string) => scrittura.rapporto.filter((r) => r.destinazione === dest);
      expect(by('esenzioni').map((r) => r.esito)).toEqual(['scritta', 'gia_presente', 'scartata']);
      expect(by('terapie').map((r) => r.esito)).toEqual([
        'scritta',
        'scritta',
        'scritta',
        'scartata',
      ]);
      expect(by('terapie')[3]!.motivi.join(' ')).toMatch(/manca la data di fine/);
      expect(by('terapie')[0]!.avvisi.join(' ')).toMatch(/zeri iniziali/);
      expect(by('ricette_passate').map((r) => r.esito)).toEqual(['scritta', 'scritta', 'scartata']);
      const [rossetti] = await t.db.select().from(patient).where(eq(patient.fiscalCode, ROSSETTI));
      const ex = await t.db.select().from(exemption).where(eq(exemption.patientId, rossetti!.id));
      // 45000 = 15/3/2023 nel sistema 1900; il codice resta di tre cifre perché la cella è testo.
      expect(ex).toEqual([
        expect.objectContaining({ code: '048', validFrom: '2023-03-15', source: 'manual' }),
      ]);
      const th = await t.db.select().from(therapy).where(eq(therapy.patientId, rossetti!.id));
      expect(th.map((x) => [x.drugName, x.status, x.kind]).sort()).toEqual(
        [
          ['Farmaco concluso', 'ended', 'cycle'],
          ['Farmaco inventato 5 mg', 'active', 'chronic'],
          ['Farmaco sospeso', 'suspended', 'chronic'],
        ].sort(),
      );
      expect(th.find((x) => x.status === 'suspended')!.suspendedReason).toBe('Reazione inventata');
      expect(th.find((x) => x.status === 'active')!.drugAic).toBe('038092019');
      const rx = await t.db
        .select()
        .from(historicalPrescription)
        .where(eq(historicalPrescription.patientId, rossetti!.id));
      expect(rx).toHaveLength(2);
      expect(rx.find((x) => x.kind === 'farmaco')).toMatchObject({
        drugAic: '038092019',
        quantity: 2,
        importBatchId: id,
        recordedBy: s.users.titolare.id,
        sourceProgram: 'Programma di prova',
        archiveId: s.archives.titolare,
      });
      expect(rx.find((x) => x.kind === 'prestazione')).toMatchObject({
        serviceCode: '90.27.1',
        serviceDescription: 'Glucosio',
      });
    });
  });

  describe('file malformati, prova obbligatoria, permessi, registro', () => {
    it('virgolette non chiuse, campi in più, XLSX con coordinate enormi: 400 con un messaggio chiaro', async () => {
      const cases: [string | Uint8Array, RegExp][] = [
        ['a;b\n1;"aperta\n2;3\n', /riga 2.*virgolette/],
        ['a;b\n1;2;3\n4;5\n', /Le righe 2 hanno un numero di campi diverso/],
        [
          buildXlsx([
            {
              name: 'X',
              rows: [],
              xml: '<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="9000000"><c r="A9000000"><v>2</v></c></row></sheetData></worksheet>',
            },
          ]),
          /oltre la riga/,
        ],
      ];
      for (const [content, message] of cases) {
        const res = await upload(doctor, 'guasto.csv', content);
        expect(res.statusCode, res.body).toBe(400);
        expect(res.json<{ errore: string }>().errore).toMatch(message);
      }
      const failed = await t.db
        .select()
        .from(accessLog)
        .where(and(eq(accessLog.action, 'importazione'), eq(accessLog.outcome, 'fallito')));
      expect(failed.length).toBeGreaterThanOrEqual(3);
    });

    it('un corpo oltre il limite della rotta: 413 con un messaggio in italiano', async () => {
      const res = await s.app.inject({
        method: 'POST',
        url: '/api/importazioni',
        headers: { cookie: doctor, 'content-type': 'application/json' },
        payload: `{"nome":"grande.csv","contenuto":"${'A'.repeat(23 * 1024 * 1024)}"}`,
      });
      expect(res.statusCode).toBe(413);
      expect(res.json<{ errore: string }>().errore).toMatch(/supera 16 MB/);
    });

    it('senza prova non si importa; con una mappatura diversa da quella provata nemmeno', async () => {
      const header = ['CF', 'Data', 'Testo'];
      const file = csv([header, [ROSSETTI, '01/07/2024', 'Nota inventata di luglio']]);
      const up = await upload(doctor, 'diario.csv', file);
      const id = up.json<{ id: string }>().id;
      const mapping = (contatto: string) => ({
        parti: [
          part('CSV', 'diario', header, {
            codiceFiscale: 'CF',
            data: 'Data',
            testo: 'Testo',
            contatto: { costante: contatto },
          }),
        ],
      });
      const early = await inject('POST', `/api/importazioni/${id}/importa`, doctor, {
        mappatura: mapping('studio'),
      });
      expect(early.statusCode).toBe(409);
      expect(
        (
          await inject('POST', `/api/importazioni/${id}/prova`, doctor, {
            mappatura: mapping('studio'),
          })
        ).statusCode,
      ).toBe(200);
      const changed = await inject('POST', `/api/importazioni/${id}/importa`, doctor, {
        mappatura: mapping('telefono'),
      });
      expect(changed.statusCode).toBe(409);
      expect(
        (
          await inject('POST', `/api/importazioni/${id}/importa`, doctor, {
            mappatura: mapping('studio'),
          })
        ).statusCode,
      ).toBe(200);
      // Dopo la scrittura il file non c'è più: si dimentica.
      const again = await inject('POST', `/api/importazioni/${id}/prova`, doctor, {
        mappatura: mapping('studio'),
      });
      expect(again.statusCode).toBe(409);
    });

    it('se dalla prova a ora le cartelle cambiano, l’importazione si ferma e chiede un’altra prova', async () => {
      const header = ['CF', 'Data', 'Testo'];
      const file = csv([header, [BALDI, '02/07/2024', 'Nota inventata di luglio, bis']]);
      const parti = [
        part('CSV', 'diario', header, {
          codiceFiscale: 'CF',
          data: 'Data',
          testo: 'Testo',
          contatto: { costante: 'studio' },
        }),
      ];
      const first = (await upload(doctor, 'luglio.csv', file)).json<{ id: string }>().id;
      const tried = await inject('POST', `/api/importazioni/${first}/prova`, doctor, {
        mappatura: { parti },
      });
      expect(tried.statusCode).toBe(200);
      // Nel frattempo la stessa nota entra con un'altra importazione.
      await flow('luglio-bis.csv', file, parti);
      const late = await inject('POST', `/api/importazioni/${first}/importa`, doctor, {
        mappatura: { parti },
      });
      expect(late.statusCode).toBe(409);
      expect(late.json<{ errore: string }>().errore).toMatch(/rifai la prova/);
    });

    it('tutto o niente: un guasto a metà non lascia nulla scritto, e il messaggio non ha valori', async () => {
      const header = ['CF', 'Data', 'Testo'];
      const file = csv([
        header,
        [BALDI, '05/07/2024', 'Prima nota del giro inventata'],
        [BALDI, '06/07/2024', 'GUASTO INVENTATO'],
      ]);
      const parti = [
        part('CSV', 'diario', header, {
          codiceFiscale: 'CF',
          data: 'Data',
          testo: 'Testo',
          contatto: { costante: 'studio' },
        }),
      ];
      const id = (await upload(doctor, 'guasto.csv', file)).json<{ id: string }>().id;
      const tried = await inject('POST', `/api/importazioni/${id}/prova`, doctor, {
        mappatura: { parti },
      });
      expect(tried.statusCode).toBe(200);
      // Un guasto del database alla seconda riga, solo in questo database di prova.
      await t.pool.query(`create function prova_guasto() returns trigger language plpgsql as $$
        begin
          if new.text = 'GUASTO INVENTATO' then raise exception 'guasto di prova: %', new.text; end if;
          return new;
        end $$`);
      await t.pool.query(
        'create trigger prova_guasto before insert on diary_detail for each row execute function prova_guasto()',
      );
      try {
        const res = await inject('POST', `/api/importazioni/${id}/importa`, doctor, {
          mappatura: { parti },
        });
        expect(res.statusCode).toBe(500);
        expect(res.json<{ errore: string }>().errore).toMatch(/nessun dato è stato scritto/);
        expect(res.body).not.toContain('GUASTO');
        expect((await t.db.select().from(diaryDetail)).map((d) => d.text)).not.toContain(
          'Prima nota del giro inventata',
        );
        const [b] = await t.db.select().from(importBatch).where(eq(importBatch.id, id));
        expect(b!.status).toBe('prova');
      } finally {
        await t.pool.query('drop trigger prova_guasto on diary_detail');
        await t.pool.query('drop function prova_guasto()');
      }
    });

    it('un’altra importazione in corso sullo stesso archivio: questa aspetta', async () => {
      const header = ['CF', 'Data', 'Testo'];
      const up = await upload(doctor, 'attesa.csv', csv([header, [BALDI, '03/07/2024', 'Nota']]));
      const id = up.json<{ id: string }>().id;
      const client = await t.pool.connect();
      try {
        await client.query('begin');
        await client.query('select pg_advisory_xact_lock(4620120, hashtext($1))', [
          s.archives.titolare,
        ]);
        const res = await inject('POST', `/api/importazioni/${id}/prova`, doctor, {
          mappatura: {
            parti: [
              part('CSV', 'diario', header, {
                codiceFiscale: 'CF',
                data: 'Data',
                testo: 'Testo',
                contatto: { costante: 'studio' },
              }),
            ],
          },
        });
        expect(res.statusCode).toBe(409);
        expect(res.json<{ errore: string }>().errore).toMatch(/Un’altra importazione è in corso/);
      } finally {
        await client.query('rollback');
        client.release();
      }
    });

    it('una mappatura senza un campo obbligatorio è rifiutata prima di leggere le righe', async () => {
      const id = (await upload(doctor, 'assistiti.csv', patientsFile)).json<{ id: string }>().id;
      const p = patientsPart();
      delete (p.campi as Record<string, unknown>).cognome;
      const res = await inject('POST', `/api/importazioni/${id}/anteprima`, doctor, {
        mappatura: { parti: [p] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json<{ errore: string }>().errore).toMatch(/mancano i campi obbligatori: Cognome/);
    });

    it('un file oltre 1 MiB si carica: il limite del corpo è alzato su questa rotta', async () => {
      const row = `${BALDI};04/07/2024;${'testo inventato '.repeat(20)}\r\n`;
      const big = `CF;Data;Testo\r\n${row.repeat(Math.ceil((1.5 * 1024 * 1024) / row.length))}`;
      const res = await upload(doctor, 'grande.csv', big);
      expect(res.statusCode, res.body.slice(0, 300)).toBe(201);
    });

    it('solo il titolare, sul proprio archivio: sostituto, segreteria e amministratore no', async () => {
      const [b] = await t.db
        .select()
        .from(importBatch)
        .where(eq(importBatch.archiveId, s.archives.titolare))
        .limit(1);
      for (const who of ['sostituto', 'segreteria', 'amministratore'] as const) {
        const cookie = await login(s, who);
        const user = s.users[who];
        const before = (
          await t.db
            .select()
            .from(accessLog)
            .where(and(eq(accessLog.userId, user.id), eq(accessLog.outcome, 'negato')))
        ).length;
        expect((await upload(cookie, 'x.csv', 'a;b\n1;2\n')).statusCode, who).toBe(403);
        expect(
          (
            await inject('POST', `/api/importazioni/${b!.id}/prova`, cookie, {
              mappatura: { parti: [] },
            })
          ).statusCode,
          who,
        ).toBe(403);
        expect(
          (
            await inject('POST', `/api/importazioni/${b!.id}/importa`, cookie, {
              mappatura: { parti: [] },
            })
          ).statusCode,
          who,
        ).toBe(403);
        expect((await inject('GET', '/api/importazioni', cookie)).statusCode, who).toBe(403);
        expect((await inject('GET', `/api/importazioni/${b!.id}`, cookie)).statusCode, who).toBe(
          403,
        );
        expect(
          (await inject('GET', `/api/importazioni/${b!.id}/rapporto`, cookie)).statusCode,
          who,
        ).toBe(403);
        expect((await inject('GET', '/api/importazioni/catalogo', cookie)).statusCode, who).toBe(
          403,
        );
        const after = (
          await t.db
            .select()
            .from(accessLog)
            .where(and(eq(accessLog.userId, user.id), eq(accessLog.outcome, 'negato')))
        ).length;
        expect(after - before, who).toBe(6);
      }
      // Un altro titolare dello studio non vede le importazioni di questo archivio.
      expect((await inject('GET', `/api/importazioni/${b!.id}`, colleague)).statusCode).toBe(404);
    });

    it('storia e rapporto: righe, esiti e motivi, mai valori del file; formule neutralizzate', async () => {
      const list = await inject('GET', '/api/importazioni', doctor);
      expect(list.statusCode).toBe(200);
      const items = list.json<{
        importazioni: { id: string; stato: string; file: { nome: string } }[];
      }>().importazioni;
      expect(items.some((i) => i.stato === 'importato' && i.file.nome === 'assistiti.csv')).toBe(
        true,
      );
      const imported = items.find(
        (i) => i.file.nome === 'storia-clinica.csv' && i.stato === 'importato',
      )!;
      const res = await inject('GET', `/api/importazioni/${imported.id}/rapporto`, doctor);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/csv/);
      expect(res.headers['content-disposition']).toMatch(
        /attachment; filename="rapporto-importazione-/,
      );
      expect(res.body).toMatch(/Destinazione;Foglio;Riga;Esito;Motivi;Avvisi/);
      expect(res.body).toMatch(/Diario clinico;CSV;7;Scartata;/);
      expect(res.body).not.toContain('Telefonata inventata');
      expect(res.body).not.toContain(ROSSETTI);
      const { csvCell } = await import('../src/import/report');
      expect(csvCell('=SOMMA(A1)')).toBe("'=SOMMA(A1)");
      expect(csvCell('-2')).toBe("'-2");
    });

    it('nessun valore dei pazienti nel registro, nella storia delle importazioni, nella provenienza', async () => {
      const secrets = [
        ROSSETTI,
        BALDI,
        NOT_FICTITIOUS,
        'Rossetti',
        'Baldi',
        'Visita di controllo inventata',
        'Sostanza inventata',
        'maria.rossetti@example.org',
      ];
      const logs = JSON.stringify(await t.db.select().from(accessLog));
      const batches = JSON.stringify(await t.db.select().from(importBatch));
      const origins = JSON.stringify(await t.db.select().from(importOrigin));
      for (const secret of secrets) {
        expect(logs, secret).not.toContain(secret);
        expect(batches, secret).not.toContain(secret);
        expect(origins, secret).not.toContain(secret);
      }
    });

    it('gli errori del database arrivano tradotti, senza valori', () => {
      const raw = Object.assign(
        new Error(`Failed query: insert into "patient" params: ${ROSSETTI}`),
        {
          cause: {
            code: '23505',
            detail: `Key (studio_id, fiscal_code)=(x, ${ROSSETTI}) already exists.`,
          },
        },
      );
      const e = importError(raw, 'scrittura');
      expect(e.statusCode).toBe(500);
      expect(e.message).toMatch(/nessun dato è stato scritto.*già presente.*23505/);
      expect(e.message).not.toContain(ROSSETTI);
      expect(importError({ code: '55P03' }, 'prova').statusCode).toBe(409);
    });
  });

  describe('annullamento di un’importazione', () => {
    const header = ['CF', 'Data', 'Testo'];
    const diaryParts = () => [
      part('CSV', 'diario', header, {
        codiceFiscale: 'CF',
        data: 'Data',
        testo: 'Testo',
        contatto: { costante: 'telefono' },
      }),
    ];

    it('le voci importate si annullano con il motivo; nulla si cancella; non due volte', async () => {
      const { id } = await flow(
        'da-annullare.csv',
        csv([header, [BALDI, '10/08/2024', 'Nota inventata da annullare']]),
        diaryParts(),
      );
      const [origin] = await t.db.select().from(importOrigin).where(eq(importOrigin.batchId, id));
      const res = await inject('POST', `/api/importazioni/${id}/annulla`, doctor, {
        motivo: 'Colonne scambiate nel file',
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ stato: 'annullato', voci: 1, pazienti: 1 });
      const [entry] = await t.db
        .select()
        .from(clinicalEntry)
        .where(eq(clinicalEntry.id, origin!.rowId));
      expect(entry).toMatchObject({
        status: 'annulled',
        annulReason: 'Colonne scambiate nel file',
        annulledBy: s.users.titolare.id,
      });
      const [b] = await t.db.select().from(importBatch).where(eq(importBatch.id, id));
      expect(b!.status).toBe('annullato');
      const again = await inject('POST', `/api/importazioni/${id}/annulla`, doctor, {
        motivo: 'Di nuovo',
      });
      expect(again.statusCode).toBe(409);
    });

    it('una voce importata e poi modificata blocca l’annullamento', async () => {
      const { id } = await flow(
        'modificata.csv',
        csv([header, [BALDI, '11/08/2024', 'Nota inventata poi modificata']]),
        diaryParts(),
      );
      const [origin] = await t.db.select().from(importOrigin).where(eq(importOrigin.batchId, id));
      const [baldi] = await t.db.select().from(patient).where(eq(patient.fiscalCode, BALDI));
      const patched = await inject(
        'PATCH',
        `/api/pazienti/${baldi!.id}/voci/${origin!.rowId}`,
        doctor,
        { riservata: true },
      );
      expect(patched.statusCode, patched.body).toBe(200);
      const res = await inject('POST', `/api/importazioni/${id}/annulla`, doctor, {
        motivo: 'Errore',
      });
      expect(res.statusCode).toBe(409);
      expect(res.json<{ errore: string }>().errore).toMatch(/modificate o annullate dopo/);
      const [entry] = await t.db
        .select()
        .from(clinicalEntry)
        .where(eq(clinicalEntry.id, origin!.rowId));
      expect(entry!.status).toBe('active');
    });

    it('un paziente passato nell’archivio di un altro medico blocca l’annullamento (D200)', async () => {
      const { id } = await flow(
        'spostato.csv',
        csv([header, [BALDI, '12/08/2024', 'Nota inventata di un paziente poi spostato']]),
        diaryParts(),
      );
      const [baldi] = await t.db.select().from(patient).where(eq(patient.fiscalCode, BALDI));
      await t.db
        .update(patient)
        .set({ archiveId: s.archives.collega })
        .where(eq(patient.id, baldi!.id));
      try {
        const res = await inject('POST', `/api/importazioni/${id}/annulla`, doctor, {
          motivo: 'Errore',
        });
        expect(res.statusCode).toBe(409);
        expect(res.json<{ errore: string }>().errore).toBe(
          'Un paziente di questa importazione è passato nell’archivio di un altro medico: l’importazione non si annulla più per intero.',
        );
        const [b] = await t.db.select().from(importBatch).where(eq(importBatch.id, id));
        expect(b!.status).toBe('importato');
      } finally {
        await t.db
          .update(patient)
          .set({ archiveId: baldi!.archiveId })
          .where(eq(patient.id, baldi!.id));
      }
      // Di nuovo nell'archivio dell'importazione: si annulla.
      const again = await inject('POST', `/api/importazioni/${id}/annulla`, doctor, {
        motivo: 'Errore',
      });
      expect(again.statusCode, again.body).toBe(200);
    });

    it('un’importazione che ha creato pazienti non si annulla da qui, e lo dice', async () => {
      const [b] = await t.db
        .select()
        .from(importBatch)
        .where(and(eq(importBatch.fileName, 'assistiti.csv'), eq(importBatch.status, 'importato')))
        .limit(1);
      const res = await inject('POST', `/api/importazioni/${b!.id}/annulla`, doctor, {
        motivo: 'Errore',
      });
      expect(res.statusCode).toBe(409);
      expect(res.json<{ errore: string }>().errore).toMatch(/pazienti creati o completati/);
    });
  });

  describe('profili d’importazione', () => {
    it('si salvano, si elencano e si archiviano; dentro solo intestazioni e codici', async () => {
      const mappatura = { parti: [patientsPart()] };
      const saved = await inject('POST', '/api/importazioni/profili', doctor, {
        nome: 'Pazienti dal vecchio archivio',
        programma: 'Programma di prova',
        formato: 'csv',
        mappatura,
      });
      expect(saved.statusCode, saved.body).toBe(201);
      const id = saved.json<{ id: string }>().id;
      const list = await inject('GET', '/api/importazioni/profili', colleague);
      expect(
        list.json<{ profili: { id: string; mappatura: unknown }[] }>().profili.map((p) => p.id),
      ).toContain(id);
      const archived = await inject('POST', `/api/importazioni/profili/${id}/archivia`, doctor);
      expect(archived.statusCode).toBe(200);
      const after = await inject('GET', '/api/importazioni/profili', doctor);
      expect(after.json<{ profili: { id: string }[] }>().profili.map((p) => p.id)).not.toContain(
        id,
      );
      const segreteria = await login(s, 'segreteria');
      expect((await inject('GET', '/api/importazioni/profili', segreteria)).statusCode).toBe(403);
      expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });
});
