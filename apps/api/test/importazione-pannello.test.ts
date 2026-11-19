import { buildFiscalCode } from '@mmg/domain';
import { eq, inArray } from 'drizzle-orm';
import { strToU8 } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { family, importOrigin, patient, patientChoice } from '../src/db/schema';
import { column } from './helpers/importazione-xlsx';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

/**
 * Importazione verso il pannello amministrativo del paziente (tappa 15, D174): scelta del medico
 * e nucleo familiare, con gli stessi controlli del pannello. Pazienti inventati: codice fiscale
 * con la X in dodicesima posizione (D12).
 */

const cf = (surname: string, name: string, birthDate: string, sex: 'M' | 'F') =>
  buildFiscalCode({ surname, name, birthDate, sex, placeCode: 'X101' });

const ANNA = cf('Prova', 'Anna', '1961-03-04', 'F');
const BRUNO = cf('Prova', 'Bruno', '1959-07-08', 'M');
const CARLA = cf('Esempio', 'Carla', '1972-09-10', 'F');
const DARIO = cf('Prova', 'Dario', '1990-11-12', 'M');
const ELENA = cf('Saggio', 'Elena', '1984-01-02', 'F');

const csv = (rows: string[][]) => rows.map((r) => r.join(';')).join('\r\n') + '\r\n';

interface RunResult {
  id: string;
  conteggi: Record<string, number>;
  rapporto: { riga: number; esito: string; motivi: string[]; destinazione: string }[];
}

describe('importazione verso il pannello amministrativo: scelta del medico e nucleo', () => {
  let t: TestDatabase;
  let s: Scenario;
  let doctor: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db);
    doctor = await login(s, 'titolare');
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  const inject = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    s.app.inject({
      method,
      url,
      headers: { cookie: doctor },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  /** Una parte della mappatura: ogni campo dalla colonna con quel nome. */
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

  /** Caricamento, prova senza scrivere e importazione con la stessa mappatura. */
  async function flow(nome: string, content: string, parti: ReturnType<typeof part>[]) {
    const up = await inject('POST', '/api/importazioni', {
      nome,
      contenuto: Buffer.from(strToU8(content)).toString('base64'),
    });
    expect(up.statusCode, up.body).toBe(201);
    const id = up.json<{ id: string }>().id;
    const mappatura = { parti };
    const prova = await inject('POST', `/api/importazioni/${id}/prova`, { mappatura });
    expect(prova.statusCode, prova.body).toBe(200);
    const scrittura = await inject('POST', `/api/importazioni/${id}/importa`, { mappatura });
    expect(scrittura.statusCode, scrittura.body).toBe(200);
    return { id, prova: prova.json<RunResult>(), scrittura: scrittura.json<RunResult>() };
  }

  const patientsHeader = ['Codice fiscale', 'Cognome', 'Nome', 'Sesso', 'Data di nascita'];
  const patientsPart = part('pazienti', patientsHeader, {
    codiceFiscale: 'Codice fiscale',
    cognome: 'Cognome',
    nome: 'Nome',
    sesso: 'Sesso',
    nascita: 'Data di nascita',
  });
  const people: Record<string, [string, string, string, string]> = {
    [ANNA]: ['Prova', 'Anna', 'F', '04/03/1961'],
    [BRUNO]: ['Prova', 'Bruno', 'M', '08/07/1959'],
    [CARLA]: ['Esempio', 'Carla', 'F', '10/09/1972'],
    [DARIO]: ['Prova', 'Dario', 'M', '12/11/1990'],
    [ELENA]: ['Saggio', 'Elena', 'F', '02/01/1984'],
  };
  const patientRows = (codes: string[]) => codes.map((c) => [c, ...people[c]!]);
  const idOf = async (code: string) =>
    (await t.db.select().from(patient).where(eq(patient.fiscalCode, code)))[0]!;

  it('il catalogo ha le due destinazioni nel pannello amministrativo, dopo le esenzioni', async () => {
    const r = await inject('GET', '/api/importazioni/catalogo');
    expect(r.statusCode, r.body).toBe(200);
    const keys = r.json<{ destinazioni: { key: string }[] }>().destinazioni.map((d) => d.key);
    expect(keys.slice(0, 4)).toEqual(['pazienti', 'esenzioni', 'scelte', 'nucleo']);
  });

  describe('scelta del medico', () => {
    const header = [
      'Codice fiscale',
      'Cognome',
      'Nome',
      'Sesso',
      'Data di nascita',
      'Data scelta',
      'Scadenza',
      'Revoca',
      'Motivo revoca',
    ];
    const row = (code: string, scelta: string, scadenza = '', revoca = '', motivo = '') => [
      ...patientRows([code])[0]!,
      scelta,
      scadenza,
      revoca,
      motivo,
    ];
    const file = csv([
      header,
      row(ANNA, '01/01/2020'),
      // Si sovrappone alla scelta della riga precedente, che vale ancora.
      row(ANNA, '01/06/2021'),
      row(BRUNO, '01/01/2019', '', '31/12/2020', 'Trasferimento in altra regione'),
      // Dopo la cessazione della precedente: si può.
      row(BRUNO, '01/01/2021'),
      // Cessazione senza il motivo: lo stesso controllo del pannello.
      row(CARLA, '01/01/2020', '', '01/01/2021'),
    ]);
    const parti = () => [
      part('pazienti', header, {
        codiceFiscale: 'Codice fiscale',
        cognome: 'Cognome',
        nome: 'Nome',
        sesso: 'Sesso',
        nascita: 'Data di nascita',
      }),
      part('scelte', header, {
        codiceFiscale: 'Codice fiscale',
        dal: 'Data scelta',
        scadenza: 'Scadenza',
        cessataIl: 'Revoca',
        motivoCessazione: 'Motivo revoca',
      }),
    ];

    it('scrive le scelte del titolare che importa, con gli stessi controlli del pannello', async () => {
      const { scrittura } = await flow('scelte.csv', file, parti());
      const choices = scrittura.rapporto.filter((r) => r.destinazione === 'scelte');
      expect(choices.map((r) => r.esito)).toEqual([
        'scritta',
        'scartata',
        'scritta',
        'scritta',
        'scartata',
      ]);
      expect(choices[1]!.motivi).toEqual([
        'C’è già una scelta del medico che vale nello stesso periodo: registra prima la sua cessazione',
      ]);
      expect(choices[4]!.motivi).toEqual(['Per la cessazione serve il motivo']);
      // Nel rapporto nessuna data e nessun codice fiscale.
      for (const r of choices) expect(r.motivi.join(' ')).not.toMatch(/\d{2}\/\d{2}|20\d\d|X101/);

      const anna = await idOf(ANNA);
      const bruno = await idOf(BRUNO);
      const rows = await t.db
        .select()
        .from(patientChoice)
        .where(inArray(patientChoice.patientId, [anna.id, bruno.id]));
      expect(rows).toHaveLength(3);
      for (const c of rows) {
        expect(c.doctorUserId).toBe(s.users.titolare.id);
        expect(c.source).toBe('manual');
      }
      const ended = rows.find((c) => c.endedOn)!;
      expect([ended.chosenOn, ended.endedOn, ended.endReason]).toEqual([
        '2019-01-01',
        '2020-12-31',
        'Trasferimento in altra regione',
      ]);
      const carla = await idOf(CARLA);
      expect(
        await t.db.select().from(patientChoice).where(eq(patientChoice.patientId, carla.id)),
      ).toHaveLength(0);

      // Il pannello amministrativo le mostra come importate.
      const admin = await inject('GET', `/api/pazienti/${anna.id}/amministrazione`);
      expect(admin.statusCode, admin.body).toBe(200);
      const scelte = admin.json<{ scelte: { importata: unknown }[] }>().scelte;
      expect(scelte).toHaveLength(1);
      expect(scelte[0]!.importata).not.toBeNull();
    });

    it('la seconda importazione dello stesso file non duplica, e l’importazione non si annulla', async () => {
      const before = (await t.db.select().from(patientChoice)).length;
      const { id, scrittura } = await flow('scelte.csv', file, parti());
      const choices = scrittura.rapporto.filter((r) => r.destinazione === 'scelte');
      expect(choices.map((r) => r.esito)).toEqual([
        'gia_presente',
        'scartata',
        'gia_presente',
        'gia_presente',
        'scartata',
      ]);
      expect((await t.db.select().from(patientChoice)).length).toBe(before);
      // Questa importazione non ha scritto nulla: per l'annullamento conta la prima.
      const first = await t.db
        .select({ batchId: importOrigin.batchId })
        .from(importOrigin)
        .where(eq(importOrigin.tableName, 'patient_choice'));
      const batch = first[0]!.batchId;
      expect(batch).not.toBe(id);
      const undo = await inject('POST', `/api/importazioni/${batch}/annulla`, {
        motivo: 'Prova dell’annullamento',
      });
      expect(undo.statusCode, undo.body).toBe(409);
      expect(undo.json<{ errore: string }>().errore).toContain('scelte del medico');
    });
  });

  describe('nucleo familiare', () => {
    const header = [
      'Codice fiscale',
      'Cognome',
      'Nome',
      'Sesso',
      'Data di nascita',
      'Nucleo',
      'Nome nucleo',
    ];
    const nucleoPart = part('nucleo', header, {
      codiceFiscale: 'Codice fiscale',
      nucleo: 'Nucleo',
      nomeNucleo: 'Nome nucleo',
    });
    const withPatients = [
      part('pazienti', header, {
        codiceFiscale: 'Codice fiscale',
        cognome: 'Cognome',
        nome: 'Nome',
        sesso: 'Sesso',
        nascita: 'Data di nascita',
      }),
      nucleoPart,
    ];
    const row = (code: string, nucleo: string, nome = '') => [
      ...patientRows([code])[0]!,
      nucleo,
      nome,
    ];

    it('lo stesso valore mette i pazienti nello stesso nucleo; l’etichetta è quella del file o il valore', async () => {
      const file = csv([
        header,
        row(ANNA, 'F-1', 'Nucleo di prova uno'),
        row(BRUNO, 'f-1'),
        row(CARLA, 'F-2'),
      ]);
      const { scrittura } = await flow('nuclei.csv', file, withPatients);
      expect(
        scrittura.rapporto.filter((r) => r.destinazione === 'nucleo').map((r) => r.esito),
      ).toEqual(['scritta', 'scritta', 'scritta']);
      const anna = await idOf(ANNA);
      const bruno = await idOf(BRUNO);
      const carla = await idOf(CARLA);
      expect(anna.familyId).not.toBeNull();
      // Maiuscole e minuscole non contano, come in ogni chiave d'origine.
      expect(bruno.familyId).toBe(anna.familyId);
      expect(carla.familyId).not.toBe(anna.familyId);
      const labels = await t.db
        .select({ id: family.id, label: family.label })
        .from(family)
        .where(inArray(family.id, [anna.familyId!, carla.familyId!]));
      expect(Object.fromEntries(labels.map((f) => [f.id, f.label]))).toEqual({
        [anna.familyId!]: 'Nucleo di prova uno',
        [carla.familyId!]: 'F-2',
      });
      // La provenienza del nucleo è un'impronta: il valore del file non c'è in chiaro.
      const origins = await t.db
        .select({ key: importOrigin.sourceKey })
        .from(importOrigin)
        .where(eq(importOrigin.tableName, 'family'));
      for (const o of origins) expect(o.key).not.toMatch(/F-1|F-2|f-1/i);
    });

    it('in un’importazione successiva lo stesso valore ritrova lo stesso nucleo; chi è già in un nucleo resta nel suo', async () => {
      // Elena è già in un nucleo, scritto a mano dal pannello.
      await flow('elena.csv', csv([patientsHeader, ...patientRows([ELENA])]), [patientsPart]);
      const elena = await idOf(ELENA);
      const put = await inject('PUT', `/api/pazienti/${elena.id}/nucleo`, {
        etichetta: 'Nucleo scritto a mano',
      });
      expect(put.statusCode, put.body).toBe(200);
      const elenaFamily = (await idOf(ELENA)).familyId;

      const file = csv([header, row(DARIO, 'F-1'), row(ELENA, 'F-1'), row(ANNA, 'F-1')]);
      const { scrittura } = await flow('nuclei-2.csv', file, withPatients);
      const nuclei = scrittura.rapporto.filter((r) => r.destinazione === 'nucleo');
      expect(nuclei.map((r) => r.esito)).toEqual(['scritta', 'scartata', 'gia_presente']);
      expect(nuclei[1]!.motivi).toEqual([
        'Il paziente è già in un altro nucleo familiare: resta nel suo',
      ]);
      expect((await idOf(DARIO)).familyId).toBe((await idOf(ANNA)).familyId);
      expect((await idOf(ELENA)).familyId).toBe(elenaFamily);
    });
  });
});
