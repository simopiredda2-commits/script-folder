import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMappings, readSyncState, sha256 } from '@mmg/reference';
import { eq, sql } from 'drizzle-orm';
import { strToU8, zipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  exemption,
  refDrugShortage,
  refDrugTransparency,
  referenceDataset,
} from '../src/db/schema';
import { studioDate } from '../src/prescriptions/rules-check';
import {
  EXAMPLE_TRANSCRIPTIONS,
  runSyncOnExample,
  serveExampleSite,
  type ExampleSite,
} from '../src/reference/example-site';
import { importReferenceData, type ImportLine } from '../src/reference/importer';
import { compareEquivalents, ReferenceData, shortageAt } from '../src/reference/lookup';
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
  // Il sito d'esempio ha le intestazioni vere AIFA: valgono le mappature del repository.
  const repo = loadMappings();
  const today = studioDate(new Date());
  const imp = (extra: Partial<Parameters<typeof importReferenceData>[0]> = {}) =>
    importReferenceData({
      db: t.db,
      syncDir,
      mappings: repo,
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
      'aifa_liste/825643_Lista_farmaci_equivalenti.csv',
      'aifa_liste/847339_elenco_medicinali_carenti.csv',
      'aifa_liste/confezioni_fornitura.csv',
      'istat_comuni/Elenco-comuni-italiani.xlsx',
      'piemonte_catalogo/catalogo_prova_allegato_c.pdf',
      'piemonte_dpc/farmaci_pht_dpc.pdf',
      'piemonte_esenzioni_prestazioni/esenzioni_prestazioni_prova.pdf',
    ]);
  });

  it('con le mappature del repository entrano ISTAT e AIFA; i PDF chiedono una trascrizione', async () => {
    const r = byFile(await imp({ transcriptionsDir: undefined }));
    expect(r['istat_comuni/Elenco-comuni-italiani.xlsx']).toMatchObject({
      outcome: 'importato',
      rows: 2,
    });
    expect(r['aifa_liste/confezioni_fornitura.csv']).toMatchObject({
      outcome: 'importato',
      rows: 11,
    });
    expect(r['aifa_liste/3815901_Classe-A_per_principio-attivo.csv']).toMatchObject({
      outcome: 'importato',
      rows: 9,
    });
    // Classe H: «-» e il prezzo dell'ossigeno a metro cubo non sono prezzi; il rapporto lo dice.
    const h = r['aifa_liste/3815901_Classe-H_per_principio-attivo.csv']!;
    expect(h).toMatchObject({ outcome: 'importato', rows: 3 });
    expect(h.notes.join('\n')).toMatch(
      /price: 2 celle senza valore secondo la mappatura aifa-classe-h/,
    );
    expect(r['piemonte_dpc/farmaci_pht_dpc.pdf']!.outcome).toBe('serve_trascrizione');
    // Lista di trasparenza (D202): l'AIC senza gli zeri davanti, rimessi dalla mappatura.
    const tr = r['aifa_liste/825643_Lista_farmaci_equivalenti.csv']!;
    expect(tr).toMatchObject({ outcome: 'importato', rows: 8 });
    expect(tr.notes.join('\n')).toMatch(
      /aic: 8 valori con gli zeri davanti secondo la mappatura aifa-trasparenza/,
    );
    // Farmaci carenti: l'intestazione alla terza riga, un testo che va a capo nelle virgolette.
    expect(r['aifa_liste/847339_elenco_medicinali_carenti.csv']).toMatchObject({
      outcome: 'importato',
      rows: 1,
    });
  });

  it('una mappatura da completare ferma il file e il rapporto mostra le intestazioni vere', async () => {
    const pending = {
      ...repo,
      mappings: repo.mappings.map((m) =>
        m.id === 'aifa-anagrafica'
          ? { ...m, colonne: Object.fromEntries(Object.keys(m.colonne).map((k) => [k, null])) }
          : m,
      ),
    };
    const r = byFile(await imp({ mappings: pending, transcriptionsDir: undefined }));
    const aifa = r['aifa_liste/confezioni_fornitura.csv']!;
    expect(aifa.outcome).toBe('mappatura_da_completare');
    expect(aifa.notes.join('\n')).toMatch(
      /intestazione del file: CODICE_AIC \| COD_FARMACO \| COD_CONFEZIONE \| DENOMINAZIONE/,
    );
  });

  it('con le trascrizioni entrano anche i PDF trascritti; ISTAT e AIFA non si importano due volte', async () => {
    const r = byFile(await imp());
    expect(r['istat_comuni/Elenco-comuni-italiani.xlsx']!.outcome).toBe('gia_importato');
    expect(r['aifa_liste/confezioni_fornitura.csv']!.outcome).toBe('gia_importato');
    expect(r['aifa_liste/3815901_Classe-A_per_principio-attivo.csv']!.outcome).toBe(
      'gia_importato',
    );
    expect(r['piemonte_dpc/farmaci_pht_dpc.json']).toMatchObject({ outcome: 'importato', rows: 1 });
    // Un PDF trascritto non chiede più la trascrizione.
    expect(r['piemonte_dpc/farmaci_pht_dpc.pdf']).toBeUndefined();
    expect(r['esenzioni/catalogo-esenzioni.json']!.notes.join()).toMatch(
      /origine non verificabile/,
    );
    // D152: a ogni catalogo nuovo il rapporto ripete la prova della regola delle visite.
    expect(r['piemonte_catalogo/catalogo_prova_allegato_c.json']!.notes).toContain(
      'visite secondo la regola di D152: 1 su 2 voci',
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

  it('diagnosi ICD-9-CM (D186): il catalogo e poi le aggiunte COVID-19 del DM 28/10/2020', async () => {
    const r = byFile(await imp());
    // Già importati dal giro di prima (stessa impronta): le note dicono quando.
    expect(r['icd9cm/diagnosi-prova.json']!.outcome).toBe('gia_importato');
    expect(r['icd9cm/covid19-prova.json']!.outcome).toBe('gia_importato');
    const versions = await t.db
      .select()
      .from(referenceDataset)
      .where(eq(referenceDataset.kind, 'diagnosi'));
    expect(
      versions
        .map((v) => [v.series, v.validFrom, v.rows, v.checkedBy])
        .sort((a, b) => String(a[1]).localeCompare(String(b[1]))),
    ).toEqual([
      ['icd9cm-diagnosi', '2009-01-01', 72, 'Seconda persona di prova'],
      ['icd9cm-diagnosi', '2021-02-02', 81, 'Seconda persona di prova'],
    ]);
    // A5: la versione dipende dalla data; prima del 2/2/2021 la COVID-19 non c'è.
    const ref = new ReferenceData(t.db, repo);
    const covid = async (d: string) =>
      (await ref.searchDiagnoses('covid', d)).hits.map((h) => h.code);
    expect(await covid('2021-02-01')).toEqual([]);
    expect(await covid('2021-02-02')).toEqual([
      '043',
      '043.1',
      '043.11',
      '043.12',
      '480.4',
      '480.41',
      '480.42',
    ]);
    expect((await ref.diagnosis('V07.0', '2021-02-02'))!.category).toBe(true);
    expect((await ref.diagnosis('V07.0', '2021-02-01'))!.category).toBe(false);
    // Prima del catalogo nessuna versione: «non noto», non «codice sconosciuto».
    expect(await ref.diagnosis('401.9', '2008-12-31')).toBeUndefined();
    expect(await ref.diagnosis('999.99', '2026-11-19')).toBeNull();
  });

  it('un secondo giro non cambia nulla', async () => {
    const before = await t.db.select().from(referenceDataset);
    const r = await imp();
    expect(r.every((x) => x.outcome === 'gia_importato')).toBe(true);
    expect((await t.db.select().from(referenceDataset)).length).toBe(before.length);
  });

  it('A5: il catalogo in vigore dipende dalla data della ricetta', async () => {
    const ref = new ReferenceData(t.db, repo);
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

  it('D153: parole in qualunque ordine, codice senza punti, materiale per esteso', async () => {
    const ref = new ReferenceData(t.db, repo);
    const codes = async (q: string) =>
      (await ref.searchServices(q, today)).map((s) => s.regionalCode);
    expect(await codes('prova esame')).toEqual(['PROVA.02']);
    expect(await codes('esame di prova')).toEqual(['PROVA.02']);
    expect(await codes('897')).toEqual(['89.7']);
    // Nessuna sigla di materiale nel catalogo d'esempio: niente per esteso.
    expect((await ref.searchServices('visita', today))[0]).toMatchObject({ material: null });
  });

  it('i fatti per le regole hanno una fonte; l’assenza da un elenco non diventa un «no»', async () => {
    const ref = new ReferenceData(t.db, repo);
    const d = await ref.drugs(
      ['038092019', '025202096', '034330047', '043783075', '012745093', '999999999'],
      today,
    );
    expect(d.get('038092019')).toMatchObject({
      name: 'AMLODIPINA DOC GENERICI',
      pack: '5 MG COMPRESSE- 28 COMPRESSE IN BLISTER AL/PVC/PVDC',
      activeIngredient: 'AMLODIPINA BESILATO',
      atc: 'C08CA01',
      // La ditta del generico, dall'anagrafica AIFA (D151).
      holder: 'DOC GENERICI SRL',
      drugClass: 'A',
      price: '3.74',
      equivalenceGroup: 'DOB',
      dpc: false,
      facts: { reimbursableSsn: true },
    });
    // Classe H: non dice da sola che cosa può prescrivere il medico di famiglia.
    expect(d.get('025202096')).toMatchObject({ drugClass: 'H', price: '9.92', facts: {} });
    // «-» al posto del prezzo: nessun prezzo, non zero.
    expect(d.get('034330047')).toMatchObject({ drugClass: 'H', price: null });
    // In DPC (elenco della Regione) con nota AIFA e piano terapeutico obbligatorio.
    expect(d.get('043783075')).toMatchObject({
      activeIngredient: 'DULAGLUTIDE',
      dpc: true,
      planRequired: true,
      aifaNote: '100',
      facts: { reimbursableSsn: true, requiresPlan: true, aifaNote: '100' },
    });
    // Fuori dalle liste di classe A e H: nessun fatto, nemmeno «non a carico del SSN».
    expect(d.get('012745093')).toMatchObject({ drugClass: null, facts: {} });
    expect(d.has('999999999')).toBe(false);
  });

  it('lista di trasparenza e farmaci carenti (D202): prezzo di riferimento, differenza, carenza', async () => {
    const ref = new ReferenceData(t.db, repo);
    const d = await ref.drugs(['027428010', '038548032', '038092019'], today);
    // Il medicinale di marca: 5,53 € al pubblico, 3,74 € di riferimento, 1,79 € di differenza.
    expect(d.get('027428010')).toMatchObject({
      price: '5.53',
      referencePrice: '3.74',
      priceDifference: '1.79',
      transparencyRemark: null,
      shortage: null,
    });
    expect(d.get('027428010')!.facts.shortage).toBeUndefined();
    // AMLODIPINA TEVA ITALIA, nell'elenco dei carenti del 17/11/2026, con le parole dell'elenco.
    const teva = d.get('038548032')!;
    expect(teva.shortage).toEqual({
      since: '2026-11-02',
      expectedEnd: null,
      equivalentAvailable: true,
      reason: 'Cessata commercializzazione definitiva',
      aifaAdvice:
        'Per trattamento alternativo si consiglia di rivolgersi allo specialista o al M.M.G',
      aifaNote: expect.stringMatching(
        /^cessata commercializzazione definitiva relativa sia al canale retail che al canale ospedaliero:\n- canale retail/,
      ),
      text: 'nell’elenco AIFA dei farmaci carenti dal 02/11/2026 (Cessata commercializzazione definitiva); equivalente secondo l’elenco: sì',
    });
    expect(teva.facts.shortage).toEqual({
      since: '2026-11-02',
      expectedEnd: null,
      equivalentAvailable: true,
      reason: 'Cessata commercializzazione definitiva',
    });
    expect(d.get('038092019')!.shortage).toBeNull();
  });

  it('la carenza che vale alla data: la più recente cominciata, se no la prima prevista', () => {
    const rows = [
      { id: 1, startOn: '2026-12-21' },
      { id: 2, startOn: '2026-10-01' },
      { id: 3, startOn: '2026-12-18' },
      { id: 4, startOn: '2026-11-02' },
    ];
    expect(shortageAt(rows, '2026-11-19')!.id).toBe(4);
    expect(shortageAt(rows, '2026-12-19')!.id).toBe(3);
    expect(shortageAt(rows.slice(0, 1).concat(rows[2]!), '2026-11-19')!.id).toBe(3);
    expect(shortageAt([], '2026-11-19')).toBeNull();
  });

  it('ricerca per nome, principio attivo, AIC e ATC; equivalenti dal gruppo', async () => {
    const ref = new ReferenceData(t.db, repo);
    const aics = async (q: string) => (await ref.searchDrugs(q, today)).map((x) => x.aic);
    // Per nome: prima i generici, poi il medicinale di marca.
    expect(await aics('amlodipina')).toEqual(['038092019', '037479060', '038548032', '027428010']);
    expect(await aics('norvasc')).toEqual(['027428010']);
    expect(await aics('C10AA05')).toEqual(['048247023', '033007042']);
    expect(await aics('dulaglutide')).toEqual(['043783075']);
    // Solo nelle liste di classe (nessuna riga in anagrafica): si trova lo stesso.
    expect(await aics('ossigeno')).toEqual(['038901524']);
    expect(await aics('02742')).toEqual(['027428010']);
    expect(await aics('100%')).toEqual([]);
    const eq = await ref.equivalents('038092019', today);
    expect(eq.map((x) => [x.aic, x.price, x.holder, x.priceDifference])).toEqual([
      ['037479060', '3.74', 'EG S.P.A.', '0.00'],
      ['038548032', '3.74', 'TEVA ITALIA S.R.L.', '0.00'],
      ['027428010', '5.53', 'VIATRIS PHARMA S.R.L.', '1.79'],
    ]);
  });

  it('equivalenti: prima il prezzo, poi il nome, poi l’AIC, qualunque sia l’ordine di partenza', () => {
    const list = [
      { aic: '000000003', name: 'B', price: '3.74' },
      { aic: '000000002', name: 'A', price: '3.74' },
      { aic: '000000004', name: 'A', price: '10.51' },
      { aic: '000000001', name: 'A', price: '3.74' },
      { aic: '000000005', name: 'C', price: null },
    ];
    const order = (l: typeof list) => [...l].sort(compareEquivalents).map((x) => x.aic);
    const expected = ['000000005', '000000001', '000000002', '000000003', '000000004'];
    expect(order(list)).toEqual(expected);
    expect(order([...list].reverse())).toEqual(expected);
  });

  it('esenzioni e comuni', async () => {
    const ref = new ReferenceData(t.db, repo);
    const ex = await ref.exemptionLookups(today);
    expect(ex.exemptionExists('DEMO')).toBe(true);
    // Inesistente solo nelle famiglie che il catalogo contiene (D190).
    expect(ex.exemptionExists('T99')).toBe(false);
    expect(ex.exemptionExists('ZZZ')).toBeUndefined();
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

  it('A6: ogni versione in uso ha la sua data; la vecchiaia si segnala con la soglia della fonte', async () => {
    const versions = await new ReferenceData(t.db, repo).versions(today);
    const comuni = versions.find((v) => v.kind === 'comuni')!;
    expect(comuni).toMatchObject({
      validFrom: today,
      validFromBasis: 'scaricamento',
      staleAfterDays: 185,
      stale: false,
      staleReasons: [],
    });
    // Senza soglia e senza aggiornamenti registrati non si sa: nessun avviso, né falso né vero.
    expect(versions.find((v) => v.series === 'aifa-anagrafica')).toMatchObject({
      staleAfterDays: null,
      stale: null,
    });
    expect(versions.find((v) => v.series === 'catalogo-piemonte')).toMatchObject({
      validFrom: '2026-10-30',
      act: 'Catalogo di prova delle prestazioni',
    });
    const thirty = {
      ...repo,
      mappings: repo.mappings.map((m) =>
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
    writeFileSync(p, readFileSync(p, 'latin1').replace('9,92', '1,00'), 'latin1');
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

    it('diagnosi: codice ripetuto o padre che manca, il file non entra; con --accetta-scarti solo le voci buone', async () => {
      const header = 'codice;descrizione;codice_padre;termini_inclusi;note;capitolo;sezione\n';
      write(
        'diagnosi-doppie',
        `${header}493;Asma;;;;;\n493.9;Asma, non specificata;493;;;;\n493.91;Asma, tipo non specificato, con stato asmatico;493.9;;;;\n493.91;Asma, tipo non specificato, con riacutizzazione;493.9;;;;\n942.40;Ustione del tronco, sede non specificata;942.4;;;;\n`,
        sheet({ tipo: 'diagnosi', serie: 'diagnosi-prova-doppie' }),
      );
      const refused = byFile(await imp({ transcriptionsDir: dir }))['diagnosi-doppie.json']!;
      expect(refused.outcome).toBe('righe_non_valide');
      expect(refused.notes).toEqual(
        expect.arrayContaining([
          'voce 493.91: codice ripetuto',
          "voce 942.40: il padre 942.4 non c'è",
        ]),
      );
      const accepted = byFile(await imp({ transcriptionsDir: dir, acceptDiscarded: true }))[
        'diagnosi-doppie.json'
      ]!;
      expect(accepted).toMatchObject({ outcome: 'importato', rows: 3 });
      const [ds] = await t.db
        .select()
        .from(referenceDataset)
        .where(eq(referenceDataset.series, 'diagnosi-prova-doppie'));
      expect(ds!.discardedRows).toBe(2);
      rmSync(join(dir, 'diagnosi-doppie.csv'));
      rmSync(join(dir, 'diagnosi-doppie.json'));
    });

    it('diagnosi: un atto che lascia un sottocodice senza padre non si applica', async () => {
      const header = 'codice;descrizione;codice_padre;termini_inclusi;note;capitolo;sezione\n';
      const serie = 'diagnosi-prova-atto';
      write(
        'diagnosi-base',
        `${header}480;Polmonite virale;;;;;\n480.9;Polmonite virale, non specificata;480;;;;\n`,
        sheet({ tipo: 'diagnosi', serie, in_vigore_dal: '2009-01-01' }),
      );
      write(
        'diagnosi-atto',
        `operazione;${header}aggiunge;480.41;Polmonite in COVID-19, virus identificato;480.4;;;;\n`,
        sheet({ tipo: 'diagnosi', serie, in_vigore_dal: '2021-02-02', solo_modifiche: true }),
      );
      const r = byFile(await imp({ transcriptionsDir: dir }));
      expect(r['diagnosi-base.json']).toMatchObject({ outcome: 'importato', rows: 2 });
      expect(r['diagnosi-atto.json']!.outcome).toBe('righe_non_valide');
      expect(r['diagnosi-atto.json']!.notes).toContain("voce 480.41: il padre 480.4 non c'è");
      for (const f of ['diagnosi-base', 'diagnosi-atto'])
        for (const ext of ['csv', 'json']) rmSync(join(dir, `${f}.${ext}`));
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

  // Ultima del gruppo: aggiunge righe alle versioni importate (si possono aggiungere, non cambiare).
  it('D202: prezzo più recente, equivalenti e ricerca anche da chi è solo nella lista di trasparenza o fra i carenti', async () => {
    const datasetOf = async (kind: string) => {
      const [d] = await t.db
        .select({ id: referenceDataset.id })
        .from(referenceDataset)
        .where(eq(referenceDataset.kind, kind));
      return d!.id;
    };
    await t.db.insert(refDrugTransparency).values([
      // TRULICITY: 153,48 € nella lista di classe A del 30/6; qui un prezzo più recente.
      {
        datasetId: await datasetOf('farmaci_trasparenza'),
        aic: '043783075',
        publicPrice: '150.00',
      },
      // Un equivalente che è solo nella lista di trasparenza.
      {
        datasetId: await datasetOf('farmaci_trasparenza'),
        aic: '099999990',
        name: 'EQUIVALENTE DI PROVA',
        activeIngredient: 'Principio di prova',
        publicPrice: '3.74',
        referencePrice: '3.74',
        priceDifference: '0.00',
        equivalenceGroup: 'DOB',
      },
    ]);
    // Un farmaco che è solo nell'elenco dei carenti.
    await t.db.insert(refDrugShortage).values({
      datasetId: await datasetOf('farmaci_carenti'),
      aic: '099999991',
      name: 'CARENTE DI PROVA',
      startOn: '2026-10-01',
      equivalentAvailable: false,
      reason: 'Problemi produttivi',
    });
    const ref = new ReferenceData(t.db, repo);
    const d = await ref.drugs(['043783075', '099999990', '099999991'], today);
    expect(d.get('043783075')!.price).toBe('150.00');
    expect(d.get('099999990')).toMatchObject({ name: 'EQUIVALENTE DI PROVA', price: '3.74' });
    expect(d.get('099999991')).toMatchObject({
      name: 'CARENTE DI PROVA',
      shortage: { since: '2026-10-01', equivalentAvailable: false },
      facts: { shortage: { since: '2026-10-01', reason: 'Problemi produttivi' } },
    });
    expect((await ref.equivalents('038092019', today)).map((x) => x.aic)).toContain('099999990');
    expect((await ref.searchDrugs('equivalente di prova', today)).map((x) => x.aic)).toEqual([
      '099999990',
    ]);
    expect([...(await ref.shortages(['099999991', '038092019'], today)).keys()]).toEqual([
      '099999991',
    ]);
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
      mappings: loadMappings(),
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
    const res = await get('/api/farmaci?q=amlodipina');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().farmaci).toHaveLength(4);
    // Tutte le banche dati che i dati del farmaco usano, anche le liste di trasparenza e dei carenti.
    expect(
      res
        .json()
        .versioni.map((v: { kind: string }) => v.kind)
        .sort(),
    ).toEqual([
      'farmaci',
      'farmaci_carenti',
      'farmaci_classe',
      'farmaci_classe',
      'farmaci_dpc',
      'farmaci_trasparenza',
    ]);
    const one = (await get('/api/farmaci/038092019')).json();
    expect(one.farmaco.name).toBe('AMLODIPINA DOC GENERICI');
    expect(one.equivalenti).toHaveLength(3);
    const old = (await get('/api/prestazioni?q=visita&data=2026-10-29')).json();
    expect(old.prestazioni[0].description).toBe('Visita di prova (catalogo precedente)');
    expect((await get('/api/esenzioni?q=T0')).json().esenzioni).toHaveLength(2);
    expect((await get('/api/comuni/A074')).json().comune.name).toBe('Agliè');
    expect((await get('/api/banche-dati')).json().versioni.length).toBeGreaterThan(5);
    expect((await get('/api/farmaci?q=')).statusCode).toBe(400);
  });

  it('diagnosi ICD-9-CM (D186): ricerca per descrizione o codice, e la voce di un codice', async () => {
    const found = (
      await get(`/api/diagnosi?q=${encodeURIComponent('asma riacutizzazione')}`)
    ).json();
    expect(found.diagnosi).toEqual([
      expect.objectContaining({
        code: '493.92',
        description: 'Asma, tipo non specificato, con riacutizzazione',
        category: false,
        path: [
          { code: '493', description: 'Asma' },
          { code: '493.9', description: 'Asma, non specificata' },
        ],
      }),
    ]);
    expect(found.totale).toBe(1);
    expect(found.versioni.map((v: { kind: string }) => v.kind)).toEqual(['diagnosi']);
    const one = (await get('/api/diagnosi/4019')).json();
    expect(one).toMatchObject({ disponibile: true, diagnosi: { code: '401.9' } });
    expect((await get('/api/diagnosi/999.99')).json()).toMatchObject({
      disponibile: true,
      diagnosi: null,
    });
    expect((await get('/api/diagnosi/401.9?data=2008-12-31')).json()).toMatchObject({
      disponibile: false,
      diagnosi: null,
    });
    expect((await get('/api/diagnosi?q=')).statusCode).toBe(400);
    expect((await get('/api/diagnosi?q=asma', {})).statusCode).toBe(401);
  });

  it('servono una sessione', async () => {
    expect((await get('/api/farmaci?q=amlodipina', {})).statusCode).toBe(401);
    expect((await get('/api/banche-dati', {})).statusCode).toBe(401);
  });

  it('R5 e R7 dalla DPC: piano obbligatorio mancante e nota da confermare', async () => {
    const res = await post(`/api/pazienti/${s.richPatient}/ricette`, {
      kind: 'pharma_ssn',
      lines: [
        {
          drugAic: '043783075',
          drugName: 'TRULICITY',
          activeIngredient: 'DULAGLUTIDE',
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

  it('R9 dal catalogo: un’esenzione assente dal catalogo blocca, se il catalogo copre la sua famiglia (D190)', async () => {
    const send = async (exemptionCode: string) => {
      const res = await post(`/api/pazienti/${s.richPatient}/ricette`, {
        kind: 'pharma_ssn',
        exemptionCode,
        lines: [
          { drugName: 'Farmaco di prova', activeIngredient: 'principio di prova', quantity: 1 },
        ],
      });
      return post(`/api/ricette/${res.json().id}/firma-e-invia`);
    };
    // Il catalogo d'esempio ha T01 e T02: T99 è della stessa famiglia, quindi non esiste.
    const covered = await send('T99');
    expect(covered.statusCode, covered.body).toBe(422);
    expect(covered.json().errore).toMatch(/R9: Esenzione T99: non esiste nel catalogo/);
    // P00, registrata per il paziente, è di una famiglia che il catalogo non contiene: non è
    // «inesistente», e la ricetta parte.
    const uncovered = await send('P00');
    expect(uncovered.statusCode, uncovered.body).toBe(200);
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

  it('R21 dall’elenco dei carenti (D202): informa con le parole dell’elenco, senza fermare', async () => {
    const res = await post(`/api/pazienti/${s.richPatient}/ricette`, {
      kind: 'pharma_ssn',
      lines: [
        {
          drugAic: '038548032',
          drugName: 'AMLODIPINA TEVA ITALIA',
          activeIngredient: 'AMLODIPINA BESILATO',
          quantity: 1,
        },
      ],
    });
    expect(res.statusCode, res.body).toBe(201);
    const check = (await post(`/api/ricette/${res.json().id}/controlla`)).json();
    const r21 = check.problemi.filter((p: { ruleId: string }) => p.ruleId === 'R21');
    expect(r21).toEqual([
      expect.objectContaining({
        severity: 'info',
        message:
          'AMLODIPINA TEVA ITALIA: nell’elenco AIFA dei farmaci carenti dal 02/11/2026 (Cessata commercializzazione definitiva); equivalente secondo l’elenco: sì',
      }),
    ]);
    const sent = await post(`/api/ricette/${res.json().id}/firma-e-invia`);
    expect(sent.statusCode, sent.body).toBe(200);
  });
});
