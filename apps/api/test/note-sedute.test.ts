import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SimulatedGateway } from '@mmg/integrations';
import { loadMappings } from '@mmg/reference';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { externalSubmission, prescriptionDocument, prescriptionLine } from '../src/db/schema';
import { specialistPrescription1 } from '../src/prescriptions/dpcm';
import { EXAMPLE_TRANSCRIPTIONS } from '../src/reference/example-site';
import { importReferenceData } from '../src/reference/importer';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

/**
 * Note del nomenclatore, sedute dei cicli e prestazioni della stessa branca nella ricetta
 * specialistica (D276): dalla ricerca alla riga, al SAR e al promemoria. Catalogo e note di prova,
 * scritti qui sopra le trascrizioni d'esempio.
 */
describe('note del nomenclatore, sedute e branca nella ricetta specialistica (D276)', () => {
  let t: TestDatabase;
  let s: Scenario;
  let doctor: string;
  let work: string;
  // Il SAR simulato conosce le coppie di codici del catalogo di prova.
  const sar = new SimulatedGateway('sar', {
    regionalCatalog: (national, catalog) =>
      !!catalog && (national === catalog || catalog === '89.7'),
  });

  beforeAll(async () => {
    t = await createTestDatabase();
    work = mkdtempSync(join(tmpdir(), 'mmg-note-sedute-'));
    writeFileSync(join(work, 'stato.json'), JSON.stringify({ versione: 1, file: {} }));
    const dir = join(work, 'trascrizioni');
    cpSync(EXAMPLE_TRANSCRIPTIONS, dir, { recursive: true });
    // Il catalogo d'esempio senza PDF d'origine: si importa senza lo stato di sync.
    writeFileSync(
      join(dir, 'piemonte_catalogo', 'catalogo-precedente.csv'),
      [
        'codice_regionale;codice_nomenclatore;descrizione;branca;tariffa;note;ciclo;sedute',
        '89.7;89.7;Visita di prova;Branca di prova;20,66;;;',
        'CICLO.1;CICLO.1;Rieducazione di prova, per seduta;Riabilitazione di prova;22,50;;sì;10',
        'COND.1;COND.1;Prestazione di prova con condizione di erogabilità;Laboratorio di prova;30,00;;;',
        'APPR.1;APPR.1;Prestazione di prova con indicazione di appropriatezza;Laboratorio di prova;12,00;;;',
      ].join('\n') + '\n',
    );
    mkdirSync(join(dir, 'lea'));
    writeFileSync(
      join(dir, 'lea', 'note-prova.csv'),
      [
        'codice_nomenclatore;numero_nota;tipo_nota;testo_nota',
        // Il testo con il punto e virgola va tra virgolette, come nella trascrizione vera.
        'COND.1;99;condizione;"A) Prima condizione di prova; B) Seconda condizione di prova"',
        'APPR.1;98;appropriatezza;Indicazione di prova',
      ].join('\n') + '\n',
    );
    writeFileSync(
      join(dir, 'lea', 'note-prova.json'),
      JSON.stringify({
        tipo: 'note_prestazioni',
        serie: 'lea-note-nomenclatore',
        fonte: null,
        chiave: null,
        sha256_origine: null,
        atto: 'Note di prova del nomenclatore',
        in_vigore_dal: '2026-10-30',
        trascritto_da: 'Persona di prova',
        trascritto_il: '2026-11-25',
        controllato_da: 'Seconda persona di prova',
      }),
    );
    await importReferenceData({
      db: t.db,
      syncDir: work,
      transcriptionsDir: dir,
      mappings: loadMappings(),
      importedBy: 'prova',
    });
    s = await createScenario(
      t.db,
      {},
      { gateways: { sar, sistema_ts: new SimulatedGateway('sistema_ts') } },
    );
    doctor = await login(s, 'titolare');
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  const request = (method: 'GET' | 'POST', url: string, payload?: object) =>
    s.app.inject({ method, url, headers: { cookie: doctor }, ...(payload ? { payload } : {}) });
  const draft = async (...lines: object[]) => {
    const res = await request('POST', `/api/pazienti/${s.richPatient}/ricette`, {
      kind: 'specialist_ssn',
      accessType: 'first',
      priority: 'P',
      diagnosticQuestion: 'Quesito di prova',
      lines: lines.map((l) => ({ quantity: 1, ...l })),
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json<{ id: string }>().id;
  };
  const lineOf = async (id: string) =>
    (await t.db.select().from(prescriptionLine).where(eq(prescriptionLine.prescriptionId, id)))[0]!;
  const send = (id: string) => request('POST', `/api/ricette/${id}/firma-e-invia`, {});
  const sentLine = async (id: string) => {
    const [row] = await t.db
      .select()
      .from(externalSubmission)
      .where(
        and(eq(externalSubmission.prescriptionId, id), eq(externalSubmission.operation, 'invio')),
      );
    return (row!.request as { lines: Record<string, unknown>[] }).lines[0]!;
  };
  const promemoriaRow = async (id: string) => {
    const [doc] = await t.db
      .select()
      .from(prescriptionDocument)
      .where(eq(prescriptionDocument.prescriptionId, id));
    const data = JSON.parse(doc!.content) as { righe: { dettagli: string | null; nota: string }[] };
    return data.righe[0]!;
  };

  it('la ricerca dà ciclo, sedute, tariffa e la nota del nomenclatore', async () => {
    const search = async (q: string) =>
      (await request('GET', `/api/prestazioni?q=${encodeURIComponent(q)}`)).json<{
        prestazioni: Record<string, unknown>[];
      }>().prestazioni[0];
    expect(await search('rieducazione di prova')).toMatchObject({
      regionalCode: 'CICLO.1',
      fee: '22.50',
      cycle: true,
      sessions: 10,
      note: null,
    });
    expect(await search('condizione di erogabilità')).toMatchObject({
      regionalCode: 'COND.1',
      cycle: null,
      sessions: null,
      note: {
        note: '99',
        kind: 'condizione',
        text: 'A) Prima condizione di prova; B) Seconda condizione di prova',
      },
    });
  });

  it('condizione di erogabilità: la nota dall’elenco in uso, la lettera del medico, al SAR e sul promemoria', async () => {
    const id = await draft({ serviceCode: 'COND.1', serviceNoteLetter: 'b' });
    expect(await lineOf(id)).toMatchObject({
      serviceNationalCode: 'COND.1',
      serviceNote: '99',
      serviceNoteKind: 'condizione',
      serviceNoteLetter: 'B',
      sessions: null,
    });
    const res = await send(id);
    expect(res.statusCode, res.body).toBe(200);
    expect(sar.received.at(-1)!.lines[0]).toMatchObject({
      serviceNote: '99',
      serviceNoteKind: 'condizione',
      serviceNoteLetter: 'B',
    });
    expect(await sentLine(id)).toMatchObject({ serviceNote: '99', serviceNoteLetter: 'B' });
    // Campo 20: numero della nota, spazio, lettera; 18A: il solo tipo di accesso.
    expect(await promemoriaRow(id)).toMatchObject({ nota: '99 B', dettagli: 'PRIMO ACCESSO' });
  });

  it('condizione di erogabilità senza la nota: R24 ferma l’invio e dice come procedere', async () => {
    const id = await draft({ serviceCode: 'COND.1', serviceNote: null });
    expect(await lineOf(id)).toMatchObject({ serviceNote: null, serviceNoteLetter: null });
    const res = await send(id);
    expect(res.statusCode).toBe(422);
    const r24 = res.json().dettagli.problemi.find((p: { ruleId: string }) => p.ruleId === 'R24');
    expect(r24).toMatchObject({
      severity: 'block',
      message:
        'COND.1: prestazione con condizione di erogabilità (nota 99): in ricetta va il numero della nota',
    });
  });

  it('indicazione di appropriatezza: la nota va con la riga, senza fermare; una nota sbagliata ferma', async () => {
    const id = await draft({ serviceCode: 'APPR.1' });
    expect(await lineOf(id)).toMatchObject({
      serviceNote: '98',
      serviceNoteKind: 'appropriatezza',
    });
    expect((await send(id)).statusCode).toBe(200);
    expect(await promemoriaRow(id)).toMatchObject({ nota: '98' });
    const wrong = await draft({ serviceCode: 'APPR.1', serviceNote: '97' });
    // Una nota che non è quella del codice non prende il tipo della nota del codice.
    expect(await lineOf(wrong)).toMatchObject({ serviceNote: '97', serviceNoteKind: null });
    const res = await send(wrong);
    expect(res.statusCode).toBe(422);
    expect(res.json().errore).toMatch(/la nota 97 non è quella della prestazione/);
  });

  it('ciclo: le sedute vanno al SAR e sul promemoria con «N.SEDUTE:»', async () => {
    const id = await draft({ serviceCode: 'CICLO.1', sessions: 10 });
    expect(await lineOf(id)).toMatchObject({ sessions: 10, serviceNote: null });
    const res = await send(id);
    expect(res.statusCode, res.body).toBe(200);
    expect(sar.received.at(-1)!.lines[0]).toMatchObject({ serviceCode: 'CICLO.1', sessions: 10 });
    expect(await promemoriaRow(id)).toMatchObject({
      dettagli: 'PRIMO ACCESSO-N.SEDUTE:10',
      nota: '---',
    });
  });

  it('sedute oltre il massimo, su una prestazione che non è a ciclo, ciclo con quantità 2: R10 ferma', async () => {
    const over = await send(await draft({ serviceCode: 'CICLO.1', sessions: 11 }));
    expect(over.statusCode).toBe(422);
    expect(over.json().errore).toMatch(/11 sedute, oltre le 10 del ciclo nel catalogo/);
    const notCycle = await send(await draft({ serviceCode: '89.7', sessions: 3 }));
    expect(notCycle.statusCode).toBe(422);
    expect(notCycle.json().errore).toMatch(/le sedute si indicano solo per le prestazioni a ciclo/);
    const two = await send(await draft({ serviceCode: 'CICLO.1', quantity: 2 }));
    expect(two.statusCode).toBe(422);
    expect(two.json().errore).toMatch(/prestazione a ciclo: quantità 1, e una riga per ogni ciclo/);
  });

  it('nove prestazioni della stessa branca: R25 ferma; otto no', async () => {
    const nine = await send(
      await draft({ serviceCode: '89.7', quantity: 5 }, { serviceCode: '89.7', quantity: 4 }),
    );
    expect(nine.statusCode).toBe(422);
    expect(nine.json().errore).toMatch(
      /9 prestazioni della branca «Branca di prova» sulla stessa ricetta: al più 8/,
    );
    const eight = await send(await draft({ serviceCode: '89.7', quantity: 8 }));
    expect(eight.statusCode, eight.body).toBe(200);
  });

  it('la ricetta rossa porta la nota in Prescrizione1, con «*» per i campi che mancano', () => {
    expect(specialistPrescription1({})).toBeNull();
    expect(
      specialistPrescription1({
        serviceNote: '99',
        serviceNoteKind: 'condizione',
        serviceNoteLetter: 'B',
      }),
    ).toBe('#99-B-*-*#');
    expect(specialistPrescription1({ serviceNote: '98', serviceNoteKind: 'appropriatezza' })).toBe(
      '#98-*-*-*#',
    );
    expect(
      specialistPrescription1({
        serviceNote: '98',
        serviceNoteKind: 'appropriatezza',
        serviceNoteLetter: 'A',
      }),
    ).toBe('#98-*-A-*#');
    // Una nota di tipo non noto: la lettera non si sa dove va, e non si scrive.
    expect(specialistPrescription1({ serviceNote: '97', serviceNoteLetter: 'A' })).toBe(
      '#97-*-*-*#',
    );
  });
});
