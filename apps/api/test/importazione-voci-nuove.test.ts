import { buildFiscalCode } from '@mmg/domain';
import { eq } from 'drizzle-orm';
import { strToU8 } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  clinicalEntry,
  historicalPrescription,
  labResultDetail,
  patient,
  vaccinationDetail,
} from '../src/db/schema';
import { studioDate } from '../src/prescriptions/rules-check';
import { column } from './helpers/importazione-xlsx';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

/**
 * Importazione di vaccinazioni, esami di laboratorio e ricette fatte con altri programmi con gli
 * stessi controlli e la stessa scrittura dell'inserimento a mano (tappa 15): `newEntryBody` e
 * `insertEntry`, `newHistoricalBody` e `insertHistorical`. Pazienti inventati (D12).
 */

const GIULIA = buildFiscalCode({
  surname: 'Esempio',
  name: 'Giulia',
  birthDate: '1966-05-06',
  sex: 'F',
  placeCode: 'X101',
});

const csv = (rows: string[][]) => rows.map((r) => r.join(';')).join('\r\n') + '\r\n';

interface RunResult {
  rapporto: { riga: number; esito: string; motivi: string[]; destinazione: string }[];
}

describe('importazione con gli inserimenti a mano di vaccinazioni, esami e ricette passate', () => {
  let t: TestDatabase;
  let s: Scenario;
  let doctor: string;
  let patientId: string;
  const today = studioDate(new Date());

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db);
    doctor = await login(s, 'titolare');
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const inject = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    s.app.inject({
      method,
      url,
      headers: { cookie: doctor },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  function part(destinazione: string, header: string[], campi: Record<string, string>) {
    return {
      tabella: 'CSV',
      intestazione: 1,
      destinazione,
      campi: Object.fromEntries(
        Object.entries(campi).map(([k, name]) => {
          const i = header.indexOf(name);
          if (i < 0) throw new Error(`colonna di prova inesistente: ${name}`);
          return [k, { colonna: { lettera: column(i), nome: name } }];
        }),
      ),
    };
  }

  /** Il paziente e la destinazione nello stesso file, poi prova e scrittura. */
  async function flow(
    nome: string,
    header: string[],
    rows: string[][],
    destinazione: string,
    campi: Record<string, string>,
    programma?: string,
  ) {
    const fullHeader = ['Codice fiscale', 'Cognome', 'Nome', 'Sesso', 'Data di nascita', ...header];
    const file = csv([
      fullHeader,
      ...rows.map((r) => [GIULIA, 'Esempio', 'Giulia', 'F', '06/05/1966', ...r]),
    ]);
    const up = await inject('POST', '/api/importazioni', {
      nome,
      contenuto: Buffer.from(strToU8(file)).toString('base64'),
    });
    expect(up.statusCode, up.body).toBe(201);
    const id = up.json<{ id: string }>().id;
    const mappatura = {
      parti: [
        part('pazienti', fullHeader, {
          codiceFiscale: 'Codice fiscale',
          cognome: 'Cognome',
          nome: 'Nome',
          sesso: 'Sesso',
          nascita: 'Data di nascita',
        }),
        part(destinazione, fullHeader, { codiceFiscale: 'Codice fiscale', ...campi }),
      ],
      ...(programma ? { programma } : {}),
    };
    const prova = await inject('POST', `/api/importazioni/${id}/prova`, { mappatura });
    expect(prova.statusCode, prova.body).toBe(200);
    const scrittura = await inject('POST', `/api/importazioni/${id}/importa`, { mappatura });
    expect(scrittura.statusCode, scrittura.body).toBe(200);
    const rapporto = scrittura
      .json<RunResult>()
      .rapporto.filter((r) => r.destinazione === destinazione);
    patientId = (await t.db.select().from(patient).where(eq(patient.fiscalCode, GIULIA)))[0]!.id;
    return rapporto;
  }

  it('esami di laboratorio: i campi della voce scritta a mano, e il suo controllo dell’intervallo', async () => {
    const rapporto = await flow(
      'esami.csv',
      ['Data', 'Analita', 'Valore', 'Unità', 'Minimo', 'Massimo', 'Riferimento'],
      [
        ['10/10/2026', 'Esame di prova', '4,2', 'mmol/l', '3,5', '5,5', ''],
        ['10/10/2026', 'Altro esame di prova', 'negativo', '', '', '', 'negativo'],
        // Minimo più grande del massimo: lo stesso controllo del modulo.
        ['10/10/2026', 'Terzo esame di prova', '7', '', '10', '5', ''],
      ],
      'esami_laboratorio',
      {
        data: 'Data',
        analita: 'Analita',
        valore: 'Valore',
        unita: 'Unità',
        minimo: 'Minimo',
        massimo: 'Massimo',
        riferimento: 'Riferimento',
      },
    );
    expect(rapporto.map((r) => r.esito)).toEqual(['scritta', 'scritta', 'scartata']);
    expect(rapporto[2]!.motivi).toEqual(['Intervallo: il minimo è più grande del massimo']);
    const rows = await t.db
      .select({ d: labResultDetail })
      .from(labResultDetail)
      .innerJoin(clinicalEntry, eq(clinicalEntry.id, labResultDetail.entryId))
      .where(eq(clinicalEntry.patientId, patientId));
    const byName = Object.fromEntries(rows.map((r) => [r.d.analyte, r.d]));
    expect(byName['Esame di prova']).toMatchObject({
      value: '4,2',
      unit: 'mmol/l',
      referenceLow: '3,5',
      referenceHigh: '5,5',
    });
    expect(byName['Altro esame di prova']!.referenceText).toBe('negativo');
  });

  it('vaccinazioni: i campi della voce scritta a mano, e il limite della dose', async () => {
    const rapporto = await flow(
      'vaccinazioni.csv',
      ['Data', 'Vaccino', 'Lotto', 'Dose', 'Campagna'],
      [
        ['01/10/2026', 'Vaccino di prova', 'LOTTO-PROVA-1', '2', 'Campagna di prova'],
        ['02/10/2026', 'Vaccino di prova', 'LOTTO-PROVA-2', '0', ''],
      ],
      'vaccinazioni',
      { data: 'Data', vaccino: 'Vaccino', lotto: 'Lotto', dose: 'Dose', campagna: 'Campagna' },
    );
    expect(rapporto.map((r) => r.esito)).toEqual(['scritta', 'scartata']);
    const rows = await t.db
      .select({ d: vaccinationDetail })
      .from(vaccinationDetail)
      .innerJoin(clinicalEntry, eq(clinicalEntry.id, vaccinationDetail.entryId))
      .where(eq(clinicalEntry.patientId, patientId));
    expect(rows.map((r) => r.d)).toEqual([
      expect.objectContaining({
        vaccine: 'Vaccino di prova',
        lot: 'LOTTO-PROVA-1',
        doseNumber: 2,
        campaign: 'Campagna di prova',
      }),
    ]);
  });

  it('terapie concluse: gli stessi controlli della scheda', async () => {
    const rapporto = await flow(
      'terapie.csv',
      ['Farmaco', 'Tipo', 'Inizio', 'Fine', 'Confezioni', 'Stato'],
      [
        ['Farmaco di prova', 'cronica', '01/03/2026', '01/06/2026', '1', 'conclusa'],
        ['Altro farmaco di prova', 'cronica', '01/05/2026', '01/04/2026', '1', 'conclusa'],
        ['Terzo farmaco di prova', 'cronica', '01/05/2026', '', '1', 'conclusa'],
        ['Quarto farmaco di prova', 'cronica', '01/05/2026', '31/12/2099', '1', 'conclusa'],
      ],
      'terapie',
      {
        farmaco: 'Farmaco',
        tipo: 'Tipo',
        inizio: 'Inizio',
        fine: 'Fine',
        confezioni: 'Confezioni',
        stato: 'Stato',
      },
    );
    expect(rapporto.map((r) => r.esito)).toEqual(['scritta', 'scartata', 'scartata', 'scartata']);
    expect(rapporto[1]!.motivi).toEqual(['«Fine»: La fine non può venire prima dell’inizio']);
    expect(rapporto[2]!.motivi).toEqual(['Terapia conclusa: manca la data di fine']);
    expect(rapporto[3]!.motivi).toEqual([
      'Terapia conclusa: la data di fine è nel futuro (una fine prevista va nel campo «Al»)',
    ]);
  });

  it('ricette passate: i controlli della rotta, l’importazione e il programma d’origine nei prescritti', async () => {
    const rapporto = await flow(
      'ricette-passate.csv',
      ['Data', 'Tipo', 'Farmaco', 'AIC', 'Codice', 'Descrizione'],
      [
        // AIC con lo zero iniziale perso da un foglio di calcolo: torna a 9 cifre.
        ['01/09/2026', 'farmaco', 'Farmaco di prova', '12345678', '', ''],
        ['02/09/2026', 'farmaco', 'Farmaco di prova', 'ABC', '', ''],
        ['03/09/2026', 'prestazione', '', '', '', 'Visita di prova'],
        // Una prestazione su una riga di farmaco: errore di smistamento.
        ['04/09/2026', 'farmaco', 'Farmaco di prova', '', '89.7', ''],
      ],
      'ricette_passate',
      {
        data: 'Data',
        tipo: 'Tipo',
        farmaco: 'Farmaco',
        aic: 'AIC',
        codicePrestazione: 'Codice',
        descrizionePrestazione: 'Descrizione',
      },
      'Programma di prova',
    );
    expect(rapporto.map((r) => r.esito)).toEqual(['scritta', 'scartata', 'scritta', 'scartata']);
    expect(rapporto[1]!.motivi).toEqual(['Codice AIC: sono 9 cifre']);
    expect(rapporto[3]!.motivi).toEqual([
      'Una riga di farmaco non ha codice o descrizione di una prestazione',
    ]);
    const rows = await t.db
      .select()
      .from(historicalPrescription)
      .where(eq(historicalPrescription.patientId, patientId));
    expect(rows.map((r) => [r.kind, r.drugAic, r.serviceDescription]).sort()).toEqual([
      ['farmaco', '012345678', null],
      ['prestazione', null, 'Visita di prova'],
    ]);
    for (const r of rows) {
      expect(r.importBatchId).not.toBeNull();
      expect(r.sourceProgram).toBe('Programma di prova');
      expect(r.recordedBy).toBe(s.users.titolare.id);
    }
    // Nei farmaci prescritti la ricetta passata è segnata come importata, con il programma.
    const page = await inject('GET', `/api/pazienti/${patientId}/farmaci-prescritti`);
    expect(page.statusCode, page.body).toBe(200);
    const past = page.json<{ ricettePassate: { importata: boolean; programma: string }[] }>()
      .ricettePassate;
    expect(past).toHaveLength(1);
    expect(past[0]).toMatchObject({ importata: true, programma: 'Programma di prova' });
    expect(today >= '2026-09-04').toBe(true);
  });
});
