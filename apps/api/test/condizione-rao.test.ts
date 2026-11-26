import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMappings } from '@mmg/reference';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prescription } from '../src/db/schema';
import { EXAMPLE_TRANSCRIPTIONS } from '../src/reference/example-site';
import { importReferenceData } from '../src/reference/importer';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

/**
 * La condizione RAO nella ricetta specialistica (D285): le tabelle delle prestazioni della ricetta,
 * la condizione scelta dal medico, la classe della tabella che il medico può cambiare, i controlli
 * del servizio. Catalogo di prova con i codici e le descrizioni del catalogo regionale; lo studio è
 * in Piemonte, quindi per la cardiologia vale la D.D. 973/2019.
 */
describe('condizione RAO nella ricetta specialistica (D285)', () => {
  let t: TestDatabase;
  let work: string;
  let s: Scenario;
  let doctor: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    work = mkdtempSync(join(tmpdir(), 'mmg-rao-'));
    writeFileSync(join(work, 'stato.json'), JSON.stringify({ versione: 1, file: {} }));
    const dir = join(work, 'trascrizioni');
    cpSync(EXAMPLE_TRANSCRIPTIONS, dir, { recursive: true });
    writeFileSync(
      join(dir, 'piemonte_catalogo', 'catalogo-precedente.csv'),
      [
        'codice_regionale;codice_nomenclatore;descrizione;branca;tariffa;note;ciclo;sedute',
        '897.67;89.7A.3;PRIMA VISITA CARDIOLOGICA CON ECG;Cardiologia;30,00;;;',
        '897.66;89.7A.3;PRIMA VISITA CARDIOCHIRURGICA CON ECG;Cardiologia;30,00;;;',
        '897.13;89.7B.7;PRIMA VISITA ORTOPEDICA;Ortopedia;25,00;;;',
        '897.32;89.7;PRIMA VISITA EMATOLOGICA;Altre;25,00;;;',
      ].join('\n') + '\n',
    );
    await importReferenceData({
      db: t.db,
      syncDir: work,
      transcriptionsDir: dir,
      mappings: loadMappings(),
      importedBy: 'prova',
    });
    s = await createScenario(t.db);
    doctor = await login(s, 'titolare');
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  interface Table {
    fonte: string;
    id: string;
    prestazioni: string[];
    controllatoDa: string | null;
    righe: {
      classe: string;
      pediatria: boolean;
      attesa: string;
      indicazioni: { chiave: string; testo: string; altro: boolean }[];
    }[];
  }
  const tables = async (app: Scenario, cookie: string, codes: string) => {
    const res = await app.app.inject({
      method: 'GET',
      url: `/api/rao/tabelle?prestazioni=${encodeURIComponent(codes)}`,
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ tabelle: Table[] }>().tabelle;
  };
  const keyOf = (t: Table, classe: string, testo: RegExp) =>
    t.righe
      .filter((r) => r.classe === classe && !r.pediatria)
      .flatMap((r) => r.indicazioni)
      .find((v) => testo.test(v.testo))!.chiave;
  const draft = (body: object) =>
    s.app.inject({
      method: 'POST',
      url: `/api/pazienti/${s.richPatient}/ricette`,
      headers: { cookie: doctor },
      payload: {
        kind: 'specialist_ssn',
        accessType: 'first',
        diagnosticQuestion: 'Quesito di prova',
        lines: [{ serviceCode: '897.67', quantity: 1 }],
        ...body,
      },
    });
  const rowOf = async (id: string) =>
    (await t.db.select().from(prescription).where(eq(prescription.id, id)))[0]!;

  it('le tabelle delle prestazioni: in Piemonte la determina regionale, poi il manuale di AGENAS', async () => {
    const cardio = await tables(s, doctor, '897.67');
    expect(cardio.map((x) => [x.fonte, x.id, x.prestazioni])).toEqual([
      ['piemonte-dd973-2019', 'dd973-1', ['897.67']],
    ]);
    expect(cardio[0]!.controllatoDa).toBeNull();
    // La riga d'emergenza è nella tabella, come promemoria; la chiave c'è ma non si sceglie.
    expect(cardio[0]!.righe[0]).toMatchObject({ classe: 'emergenza', attesa: 'PS' });
    // Codice della cardiologia, ma la cardiochirurgia: nessuna tabella.
    expect(await tables(s, doctor, '897.66')).toEqual([]);
    expect(await tables(s, doctor, '897.32')).toEqual([]);
    const both = await tables(s, doctor, '897.67,897.13,SCONOSCIUTO');
    expect(both.map((x) => `${x.fonte}/${x.id}`)).toEqual([
      'piemonte-dd973-2019/dd973-1',
      'agenas-2020/041',
    ]);
  });

  it('il medico sceglie la condizione: la ricetta la tiene, con la classe e la fonte', async () => {
    const [cardio] = await tables(s, doctor, '897.67');
    const key = keyOf(cardio!, 'B', /^Bradiaritmie asintomatiche/);
    const res = await draft({ priority: 'B', raoCondition: key });
    expect(res.statusCode, res.body).toBe(201);
    expect(await rowOf(res.json<{ id: string }>().id)).toMatchObject({
      priority: 'B',
      raoConditionKey: key,
      raoConditionPriority: 'B',
      raoConditionText: 'Bradiaritmie asintomatiche',
      raoConditionSource: 'D.D. 973/2019 della Regione Piemonte (cardiologia), tabella dd973-1',
    });
    // Il medico cambia la classe: si può, la condizione resta con la sua.
    const changed = await draft({ priority: 'D', raoCondition: key });
    expect(changed.statusCode, changed.body).toBe(201);
    expect(await rowOf(changed.json<{ id: string }>().id)).toMatchObject({
      priority: 'D',
      raoConditionPriority: 'B',
    });
    // Senza condizione e senza classe la ricetta si prepara; la classe la chiede R14 all'invio.
    const empty = await draft({ priority: null });
    expect(empty.statusCode, empty.body).toBe(201);
    expect(await rowOf(empty.json<{ id: string }>().id)).toMatchObject({
      priority: null,
      raoConditionKey: null,
    });
  });

  it('la condizione deve essere di una prestazione della ricetta, e non una riga d’emergenza', async () => {
    const [ortho] = await tables(s, doctor, '897.13');
    const wrong = await draft({ priority: 'B', raoCondition: keyOf(ortho!, 'B', /./) });
    expect(wrong.statusCode).toBe(400);
    expect(wrong.body).toMatch(/non è di una prestazione della ricetta/);
    const [cardio] = await tables(s, doctor, '897.67');
    const emergency = cardio!.righe[0]!.indicazioni[0]!.chiave;
    const res = await draft({ priority: 'U', raoCondition: emergency });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/non selezionabile/);
    expect((await draft({ priority: 'B', raoCondition: 'agenas-2020:999:1:1' })).statusCode).toBe(
      400,
    );
  });

  it('solo sulla specialistica del primo accesso', async () => {
    const [cardio] = await tables(s, doctor, '897.67');
    const key = keyOf(cardio!, 'D', /^Cardiopalmo extrasistolico/);
    const later = await draft({ accessType: 'subsequent', priority: null, raoCondition: key });
    expect(later.statusCode).toBe(400);
    expect(later.body).toMatch(/primo accesso/);
    const pharma = await draft({
      kind: 'pharma_ssn',
      accessType: null,
      raoCondition: key,
      lines: [{ drugName: 'Farmaco di prova', quantity: 1 }],
    });
    expect(pharma.statusCode).toBe(400);
  });

  it('l’elenco delle ricette del paziente porta la condizione', async () => {
    const res = await s.app.inject({
      method: 'GET',
      url: `/api/pazienti/${s.richPatient}/ricette`,
      headers: { cookie: doctor },
    });
    expect(res.statusCode, res.body).toBe(200);
    const withRao = res
      .json<{
        ricette: { raoConditionText: string | null; raoConditionPriority: string | null }[];
      }>()
      .ricette.filter((r) => r.raoConditionText);
    expect(withRao.length).toBeGreaterThanOrEqual(2);
    expect(withRao[0]).toMatchObject({ raoConditionPriority: 'B' });
  });

  it('nel programma vero le tabelle non controllate non si usano', async () => {
    const prod = await createScenario(t.db, {}, { environment: 'produzione' });
    try {
      const cookie = await login(prod, 'titolare');
      expect(await tables(prod, cookie, '897.67')).toEqual([]);
      const res = await prod.app.inject({
        method: 'POST',
        url: `/api/pazienti/${prod.richPatient}/ricette`,
        headers: { cookie },
        payload: {
          kind: 'specialist_ssn',
          accessType: 'first',
          priority: 'B',
          diagnosticQuestion: 'Quesito di prova',
          raoCondition: 'piemonte-dd973-2019:dd973-1:4:3',
          lines: [{ serviceCode: '897.67', quantity: 1 }],
        },
      });
      expect(res.statusCode).toBe(400);
      expect(res.body).toMatch(/Condizione RAO sconosciuta/);
    } finally {
      await prod.app.close();
    }
  });
});
