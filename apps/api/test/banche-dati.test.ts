import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMappings, overrideMappings, readSyncState, sha256 } from '@mmg/reference';
import { eq, sql } from 'drizzle-orm';
import { strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exemption, referenceDataset } from '../src/db/schema';
import { studioDate } from '../src/prescriptions/rules-check';
import {
  EXAMPLE_MAPPINGS,
  EXAMPLE_TRANSCRIPTIONS,
  runSyncOnExample,
  serveExampleSite,
  type ExampleSite,
} from '../src/reference/example-site';
import { importReferenceData, type ImportLine } from '../src/reference/importer';
import { ReferenceData } from '../src/reference/lookup';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

async function rejectsWith(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
  } catch (err) {
    const e = err as { message: string; cause?: { message: string } };
    expect(e.cause?.message ?? e.message).toMatch(pattern);
    return;
  }
  throw new Error(`Doveva fallire con ${pattern}`);
}

const byFile = (report: ImportLine[]) => Object.fromEntries(report.map((r) => [r.file, r]));

describe('banche dati pubbliche: dall’output di sync al database', () => {
  let t: TestDatabase;
  let site: ExampleSite;
  let work: string;
  let syncDir: string;
  const repo = loadMappings();
  const withExamples = overrideMappings(repo, loadMappings(EXAMPLE_MAPPINGS));
  const today = studioDate(new Date());
  const imp = (extra: Partial<Parameters<typeof importReferenceData>[0]> = {}) =>
    importReferenceData({
      db: t.db,
      syncDir,
      mappings: withExamples,
      transcriptionsDir: EXAMPLE_TRANSCRIPTIONS,
      importedBy: 'prova',
      ...extra,
    });

  beforeAll(async () => {
    t = await createTestDatabase();
    site = await serveExampleSite();
    work = mkdtempSync(join(tmpdir(), 'mmg-bd-'));
    syncDir = join(work, 'dati-pubblici');
    const run = await runSyncOnExample(site, syncDir);
    expect(run.code, run.output).toBe(0);
  }, 60_000);
  afterAll(async () => {
    await site?.close();
    await t?.drop();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  it('sync, lanciato davvero sul sito d’esempio, registra i file nello stato che si importa', () => {
    const keys = readSyncState(syncDir).map((e) => `${e.fonte}/${e.chiave}`);
    expect(keys.sort()).toEqual([
      'aifa_liste/3815901_Classe-A_per_principio-attivo.csv',
      'aifa_liste/3815901_Classe-H_per_principio-attivo.csv',
      'aifa_liste/confezioni_fornitura.csv',
      'istat_comuni/Elenco-comuni-italiani.xlsx',
      'piemonte_catalogo/catalogo_prova_allegato_c.pdf',
      'piemonte_dpc/farmaci_pht_dpc.pdf',
      'piemonte_esenzioni_prestazioni/esenzioni_prestazioni_prova.pdf',
    ]);
  });

  it('con le sole mappature del repository: ISTAT entra, AIFA è da completare e mostra le intestazioni, i PDF chiedono una trascrizione', async () => {
    const r = byFile(await imp({ mappings: repo, transcriptionsDir: undefined }));
    expect(r['istat_comuni/Elenco-comuni-italiani.xlsx']).toMatchObject({
      outcome: 'importato',
      rows: 2,
    });
    const aifa = r['aifa_liste/confezioni_fornitura.csv']!;
    expect(aifa.outcome).toBe('mappatura_da_completare');
    expect(aifa.notes.join('\n')).toMatch(
      /intestazione del file: AIC di prova \| Denominazione di prova/,
    );
    expect(r['piemonte_dpc/farmaci_pht_dpc.pdf']!.outcome).toBe('serve_trascrizione');
  });

  it('con le mappature d’esempio e le trascrizioni entra tutto; ISTAT non si importa due volte', async () => {
    const r = byFile(await imp());
    expect(r['istat_comuni/Elenco-comuni-italiani.xlsx']!.outcome).toBe('gia_importato');
    expect(r['aifa_liste/confezioni_fornitura.csv']).toMatchObject({
      outcome: 'importato',
      rows: 5,
    });
    expect(r['aifa_liste/3815901_Classe-A_per_principio-attivo.csv']).toMatchObject({
      outcome: 'importato',
      rows: 3,
    });
    expect(r['piemonte_dpc/farmaci_pht_dpc.json']).toMatchObject({ outcome: 'importato', rows: 1 });
    // Un PDF trascritto non chiede più la trascrizione.
    expect(r['piemonte_dpc/farmaci_pht_dpc.pdf']).toBeUndefined();
    expect(r['esenzioni/catalogo-esenzioni.json']!.notes.join()).toMatch(
      /origine non verificabile/,
    );
    const [dpc] = await t.db
      .select()
      .from(referenceDataset)
      .where(eq(referenceDataset.kind, 'farmaci_dpc'));
    expect(dpc).toMatchObject({
      origin: 'trascrizione',
      validFrom: '2026-07-09',
      validFromBasis: 'atto',
      checkedBy: 'Seconda persona di prova',
      source: 'piemonte_dpc',
    });
    expect(dpc!.originSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('un secondo giro non cambia nulla', async () => {
    const before = await t.db.select().from(referenceDataset);
    const r = await imp();
    expect(r.every((x) => x.outcome === 'gia_importato')).toBe(true);
    expect((await t.db.select().from(referenceDataset)).length).toBe(before.length);
  });

  it('A5: il catalogo in vigore dipende dalla data della ricetta', async () => {
    const ref = new ReferenceData(t.db, withExamples);
    const at = async (d: string) =>
      (await ref.searchServices('visita', d)).map((s) => s.description);
    expect(await at('2024-12-29')).toEqual([]);
    expect(await at('2026-10-29')).toEqual(['Visita di prova (catalogo precedente)']);
    expect(await at('2026-10-30')).toEqual(['Visita di prova']);
    expect((await ref.searchServices('PROVA.0', today))[0]).toMatchObject({
      regionalCode: 'PROVA.02',
      branch: 'Laboratorio di prova',
    });
  });

  it('i fatti per le regole hanno una fonte; l’assenza da un elenco non diventa un «no»', async () => {
    const ref = new ReferenceData(t.db, withExamples);
    const d = await ref.drugs(['900000011', '900000035', '900000047', '999999999'], today);
    expect(d.get('900000011')).toMatchObject({
      name: 'PROVALINA',
      drugClass: 'A',
      price: '5.20',
      equivalenceGroup: 'GP-01',
      dpc: false,
      facts: { reimbursableSsn: true },
    });
    // Classe H: non dice da sola che cosa può prescrivere il medico di famiglia.
    expect(d.get('900000035')!.drugClass).toBe('H');
    expect(d.get('900000035')!.facts).toEqual({});
    // In DPC con piano obbligatorio e nota.
    expect(d.get('900000047')).toMatchObject({
      dpc: true,
      planRequired: true,
      facts: { requiresPlan: true, aifaNote: '13' },
    });
    expect(d.get('900000047')!.facts.reimbursableSsn).toBeUndefined();
    expect(d.get('900000047')!.pack).toBe('20 compresse (più forti)');
    expect(d.has('999999999')).toBe(false);
  });

  it('ricerca per nome, principio attivo, AIC e ATC; equivalenti dal gruppo', async () => {
    const ref = new ReferenceData(t.db, withExamples);
    const aics = async (q: string) => (await ref.searchDrugs(q, today)).map((x) => x.aic);
    expect(await aics('provalina')).toEqual(['900000023', '900000011', '900000059'].sort());
    expect(await aics('Z97')).toEqual(['900000047']);
    expect(await aics('esempio attivo')).toEqual(['900000047']);
    expect((await aics('90000003')).length).toBe(1);
    expect(await aics('100%')).toEqual([]);
    const eq = await ref.equivalents('900000011', today);
    expect(eq.map((x) => [x.aic, x.price])).toEqual([
      ['900000023', '3.10'],
      ['900000059', '4.00'],
    ]);
  });

  it('esenzioni e comuni', async () => {
    const ref = new ReferenceData(t.db, withExamples);
    const ex = await ref.exemptionLookups(today);
    expect(ex.exemptionExists('DEMO')).toBe(true);
    expect(ex.exemptionExists('ZZZ')).toBe(false);
    expect([...ex.exemptionServices('T01')!]).toEqual(['89.7']);
    expect(ex.exemptionServices('T02')).toBeUndefined();
    expect(await ref.municipality('a074', today)).toMatchObject({
      name: 'Agliè',
      provinceAbbr: 'TO',
    });
    expect(await ref.municipality('X001', today)).toBeNull();
    // Prima del download i comuni non c'erano ancora.
    expect(await ref.municipality('A074', '2020-01-01')).toBeUndefined();
  });

  it('A6: ogni versione in uso ha la sua data; la vecchiaia si segnala solo con una soglia', async () => {
    const versions = await new ReferenceData(t.db, withExamples).versions(today);
    const comuni = versions.find((v) => v.kind === 'comuni')!;
    expect(comuni).toMatchObject({
      validFrom: today,
      validFromBasis: 'scaricamento',
      staleAfterDays: null,
      stale: null,
    });
    expect(versions.find((v) => v.series === 'catalogo-piemonte')).toMatchObject({
      validFrom: '2026-10-30',
      act: 'Catalogo di prova delle prestazioni',
    });
    const thirty = {
      ...withExamples,
      mappings: withExamples.mappings.map((m) =>
        m.id === 'istat-comuni' ? { ...m, vecchiaDopoGiorni: 30 } : m,
      ),
    };
    const later = new Date(Date.parse(`${today}T12:00:00Z`) + 31 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const ref = new ReferenceData(t.db, thirty);
    expect((await ref.versions(today, ['comuni']))[0]!.stale).toBe(false);
    expect((await ref.versions(later, ['comuni']))[0]!.stale).toBe(true);
  });

  it('le versioni importate non si modificano, non si cancellano, non si svuotano', async () => {
    await rejectsWith(
      t.db.execute(sql`update reference_dataset set rows = 0`),
      /non si modificano/,
    );
    await rejectsWith(t.db.execute(sql`delete from ref_drug`), /non si modificano/);
    await rejectsWith(t.db.execute(sql`truncate ref_municipality cascade`), /non si svuotano/);
  });

  it('un file in uso che non ha l’impronta registrata da sync non si importa', async () => {
    const copy = join(work, 'manomesso');
    cpSync(syncDir, copy, { recursive: true });
    const p = join(copy, 'correnti', 'aifa_liste', '3815901_Classe-H_per_principio-attivo.csv');
    writeFileSync(p, readFileSync(p, 'utf-8').replace('120,00', '1,00'));
    const r = byFile(await imp({ syncDir: copy }));
    expect(r['aifa_liste/3815901_Classe-H_per_principio-attivo.csv']!.outcome).toBe(
      'impronta_diversa',
    );
  });

  describe('trascrizioni', () => {
    let dir: string;
    const sheet = (over: object = {}) => ({
      tipo: 'farmaci_dpc',
      serie: 'dpc-prova-righe',
      fonte: null,
      chiave: null,
      sha256_origine: null,
      atto: 'Atto di prova',
      in_vigore_dal: '2026-01-01',
      trascritto_da: 'Persona di prova',
      trascritto_il: '2026-11-18',
      controllato_da: 'Seconda persona di prova',
      ...over,
    });
    const write = (name: string, csv: string, s: object) => {
      writeFileSync(join(dir, `${name}.csv`), csv);
      writeFileSync(join(dir, `${name}.json`), JSON.stringify(s));
    };
    beforeAll(() => {
      dir = join(work, 'trascrizioni-prova');
      mkdirSync(dir);
    });

    it('righe non valide: il file non entra; con --accetta-scarti entrano le valide e lo scarto resta registrato', async () => {
      write(
        'righe',
        'principio_attivo;atc;nota_aifa;piano_terapeutico\nvalido;;;no\naltro;;;forse\n',
        sheet(),
      );
      const refused = byFile(await imp({ transcriptionsDir: dir }))['righe.json']!;
      expect(refused.outcome).toBe('righe_non_valide');
      expect(refused.notes.join('\n')).toMatch(/riga 3, planRequired: «forse» non è «sì» o «no»/);
      const accepted = byFile(await imp({ transcriptionsDir: dir, acceptDiscarded: true }))[
        'righe.json'
      ]!;
      expect(accepted).toMatchObject({ outcome: 'importato', rows: 1 });
      const [ds] = await t.db
        .select()
        .from(referenceDataset)
        .where(eq(referenceDataset.series, 'dpc-prova-righe'));
      expect(ds!.discardedRows).toBe(1);
      rmSync(join(dir, 'righe.csv'));
      rmSync(join(dir, 'righe.json'));
    });

    it('scheda incompleta, colonne sbagliate, PDF d’origine sconosciuto', async () => {
      write('senza-controllo', 'principio_attivo\nx\n', { ...sheet(), controllato_da: '' });
      write('colonne', 'principio;atc\nx;\n', sheet({ serie: 'dpc-prova-colonne' }));
      write(
        'origine',
        'principio_attivo\nx\n',
        sheet({ fonte: 'piemonte_dpc', chiave: 'altro.pdf', sha256_origine: 'a'.repeat(64) }),
      );
      write('mezza', 'principio_attivo\nx\n', sheet({ fonte: 'piemonte_dpc' }));
      const r = byFile(await imp({ transcriptionsDir: dir }));
      expect(r['senza-controllo.json']!.outcome).toBe('trascrizione_non_valida');
      expect(r['colonne.json']).toMatchObject({ outcome: 'colonne_mancanti' });
      expect(r['colonne.json']!.notes.join()).toMatch(/principio_attivo/);
      expect(r['origine.json']!.outcome).toBe('origine_non_trovata');
      expect(r['mezza.json']!.notes.join()).toMatch(/tutti e tre/);
    });
  });

  it('D12: un comune reale con la lettera dei luoghi inventati viene segnalato', async () => {
    const copy = join(work, 'comuni-x');
    cpSync(syncDir, copy, { recursive: true });
    const header = [
      'Codice Comune formato alfanumerico',
      'Denominazione in italiano',
      'Denominazione Regione',
      'Sigla automobilistica',
      'Codice Catastale del Comune',
    ];
    const cell = (v: string, i: number) =>
      `<c r="${String.fromCharCode(65 + i)}1" t="inlineStr"><is><t>${v}</t></is></c>`;
    const row = (r: number, values: string[]) =>
      `<row r="${r}">${values.map((v, i) => cell(v, i).replace('1"', `${r}"`)).join('')}</row>`;
    const xlsx = zipSync({
      'xl/worksheets/sheet1.xml': strToU8(
        `<worksheet><sheetData>${row(1, header)}${row(2, ['099001', 'Comune di prova', 'Regione di prova', 'ZZ', 'X999'])}</sheetData></worksheet>`,
      ),
    });
    writeFileSync(join(copy, 'correnti', 'istat_comuni', 'Elenco-comuni-italiani.xlsx'), xlsx);
    const statePath = join(copy, 'stato.json');
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    state.file['istat_comuni/Elenco-comuni-italiani.xlsx'].sha256 = sha256(xlsx);
    writeFileSync(statePath, JSON.stringify(state));
    const r = byFile(await imp({ syncDir: copy, transcriptionsDir: undefined }));
    const line = r['istat_comuni/Elenco-comuni-italiani.xlsx']!;
    expect(line.outcome).toBe('importato');
    expect(line.warnings?.join()).toMatch(/lettera riservata ai luoghi di nascita inventati/);
  });

  it('PDF cambiato dopo la trascrizione: la trascrizione è superata e non entra', async () => {
    const copy = join(work, 'pdf-nuovo');
    cpSync(syncDir, copy, { recursive: true });
    site.override(
      'piemonte/media/57684/download.pdf',
      strToU8('%PDF-1.4\nversione nuova di prova\n%%EOF\n'),
    );
    const run = await runSyncOnExample(site, copy, ['--solo', 'piemonte_dpc', '--forza']);
    expect(run.code, run.output).toBe(0);
    const r = byFile(await imp({ syncDir: copy }));
    expect(r['piemonte_dpc/farmaci_pht_dpc.json']!.outcome).toBe('trascrizione_superata');
  });
});

describe('banche dati via HTTP e nelle regole', () => {
  let t: TestDatabase;
  let s: Scenario;
  let cookie: string;
  let site: ExampleSite;
  let work: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    site = await serveExampleSite();
    work = mkdtempSync(join(tmpdir(), 'mmg-bd-http-'));
    const syncDir = join(work, 'dati-pubblici');
    expect((await runSyncOnExample(site, syncDir)).code).toBe(0);
    await importReferenceData({
      db: t.db,
      syncDir,
      transcriptionsDir: EXAMPLE_TRANSCRIPTIONS,
      mappings: overrideMappings(loadMappings(), loadMappings(EXAMPLE_MAPPINGS)),
      importedBy: 'prova',
    });
    // Senza preSendChecks: le regole vere, con le banche dati importate.
    s = await createScenario(t.db);
    cookie = await login(s, 'titolare');
  }, 60_000);
  afterAll(async () => {
    await s?.app.close();
    await site?.close();
    await t?.drop();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  const get = (url: string, headers: Record<string, string> = { cookie }) =>
    s.app.inject({ method: 'GET', url, headers });
  const post = (url: string, payload: object = {}) =>
    s.app.inject({ method: 'POST', url, payload, headers: { cookie } });

  it('le ricerche rispondono con i risultati e con le versioni in uso (A6)', async () => {
    const res = await get('/api/farmaci?q=provalina');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().farmaci).toHaveLength(3);
    expect(res.json().versioni.map((v: { kind: string }) => v.kind)).toContain('farmaci');
    const one = (await get('/api/farmaci/900000011')).json();
    expect(one.farmaco.name).toBe('PROVALINA');
    expect(one.equivalenti).toHaveLength(2);
    const old = (await get('/api/prestazioni?q=visita&data=2026-10-29')).json();
    expect(old.prestazioni[0].description).toBe('Visita di prova (catalogo precedente)');
    expect((await get('/api/esenzioni?q=T0')).json().esenzioni).toHaveLength(2);
    expect((await get('/api/comuni/A074')).json().comune.name).toBe('Agliè');
    expect((await get('/api/banche-dati')).json().versioni.length).toBeGreaterThan(5);
    expect((await get('/api/farmaci?q=')).statusCode).toBe(400);
  });

  it('servono una sessione', async () => {
    expect((await get('/api/farmaci?q=provalina', {})).statusCode).toBe(401);
    expect((await get('/api/banche-dati', {})).statusCode).toBe(401);
  });

  it('R5 e R7 dalla DPC: piano obbligatorio mancante e nota da confermare', async () => {
    const res = await post(`/api/pazienti/${s.richPatient}/ricette`, {
      kind: 'pharma_ssn',
      lines: [
        {
          drugAic: '900000047',
          drugName: 'ESEMPINA',
          activeIngredient: 'esempio attivo',
          quantity: 1,
        },
      ],
    });
    expect(res.statusCode, res.body).toBe(201);
    const sent = await post(`/api/ricette/${res.json().id}/firma-e-invia`);
    expect(sent.statusCode).toBe(422);
    const rules = sent.json().dettagli.problemi.map((p: { ruleId: string }) => p.ruleId);
    expect(rules).toContain('R5');
    expect(rules).toContain('R7');
  });

  it('R9 dal catalogo: un’esenzione registrata per il paziente ma assente dal catalogo blocca', async () => {
    const res = await post(`/api/pazienti/${s.richPatient}/ricette`, {
      kind: 'pharma_ssn',
      exemptionCode: 'P00',
      lines: [
        { drugName: 'Farmaco di prova', activeIngredient: 'principio di prova', quantity: 1 },
      ],
    });
    const sent = await post(`/api/ricette/${res.json().id}/firma-e-invia`);
    expect(sent.statusCode).toBe(422);
    expect(sent.json().errore).toMatch(/R9: Esenzione P00: non esiste nel catalogo/);
  });

  it('R17 dall’elenco regionale: una prestazione non associata all’esenzione blocca', async () => {
    await t.db
      .insert(exemption)
      .values({ patientId: s.richPatient, code: 'T01', validFrom: '2026-01-01', source: 'manual' });
    const res = await post(`/api/pazienti/${s.richPatient}/ricette`, {
      kind: 'specialist_ssn',
      exemptionCode: 'T01',
      accessType: 'first',
      priority: 'P',
      diagnosticQuestion: 'Quesito di prova',
      lines: [
        { serviceCode: '89.7', serviceDescription: 'Visita di prova', quantity: 1 },
        { serviceCode: 'PROVA.02', serviceDescription: 'Esame di prova', quantity: 1 },
      ],
    });
    const check = (await post(`/api/ricette/${res.json().id}/controlla`)).json();
    const r17 = check.problemi.filter((p: { ruleId: string }) => p.ruleId === 'R17');
    expect(r17).toHaveLength(1);
    expect(r17[0].message).toMatch(/PROVA\.02: non è tra le prestazioni dell'esenzione T01/);
  });
});
