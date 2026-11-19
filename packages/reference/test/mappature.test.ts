import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  convertCell,
  extractRecords,
  KINDS,
  loadMappings,
  mappingForSyncFile,
  mappingForTranscription,
  missingFields,
  parseMappings,
  pendingColumns,
  readTable,
} from '../src';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const SAMPLES = join(ROOT, 'fixtures', 'banche-dati');
const repo = loadMappings();
const table = (...p: string[]) => {
  const path = join(SAMPLES, 'sito', ...p);
  return readTable(new Uint8Array(readFileSync(path)), path);
};

describe('mappature del repository', () => {
  it('ISTAT e AIFA sono complete: nessun campo obbligatorio né colonna da completare', () => {
    const files: [string, string, string][] = [
      ['istat_comuni', 'Elenco-comuni-italiani.xlsx', 'istat-comuni'],
      ['aifa_liste', 'confezioni_fornitura.csv', 'aifa-anagrafica'],
      ['aifa_liste', '3815901_Classe-A_per_principio-attivo.csv', 'aifa-classe-a'],
      ['aifa_liste', '4000000_Classe-H_per_principio-attivo.csv', 'aifa-classe-h'],
    ];
    for (const [source, key, id] of files) {
      const m = mappingForSyncFile(repo, source, key)!;
      expect(m.id).toBe(id);
      expect(missingFields(m), id).toEqual([]);
      expect(pendingColumns(m), id).toEqual([]);
    }
  });

  it('una mappatura con colonne nulle è da completare e lo dice', () => {
    const m = mappingForSyncFile(repo, 'aifa_liste', 'confezioni_fornitura.csv')!;
    const pending = { ...m, colonne: { ...m.colonne, aic: null, name: null } };
    expect(missingFields(pending)).toEqual(['aic']);
    expect(pendingColumns(pending)).toEqual(['aic', 'name']);
  });

  it('ogni tipo trascritto da un PDF ha la sua mappatura', () => {
    for (const kind of ['farmaci_dpc', 'prestazioni', 'esenzioni', 'esenzioni_prestazioni']) {
      expect(mappingForTranscription(repo, kind), kind).toBeDefined();
    }
  });

  it('soglia di vecchiaia (A6) solo dove la fonte dichiara una cadenza regolare (D156)', () => {
    // ISTAT: «almeno ogni sei mesi» (sync/fonti.json) → 184 giorni più una notte.
    const soglie = Object.fromEntries(repo.mappings.map((m) => [m.id, m.vecchiaDopoGiorni]));
    expect(soglie['istat-comuni']).toBe(185);
    // Lista di trasparenza AIFA: «ogni mese, il 15» (sync/fonti.json) → 31 giorni più una notte.
    expect(soglie['aifa-trasparenza']).toBe(32);
    // Le altre no: vale il controllo di ogni notte.
    expect(repo.mappings.filter((m) => m.vecchiaDopoGiorni !== null).map((m) => m.id)).toEqual([
      'istat-comuni',
      'aifa-trasparenza',
    ]);
  });
});

describe('estrazione dei record', () => {
  it('ISTAT: i comuni d’esempio con il loro codice catastale', () => {
    const m = mappingForSyncFile(repo, 'istat_comuni', 'Elenco-comuni-italiani.xlsx')!;
    const out = extractRecords(m, table('istat', 'Elenco-comuni-italiani.xlsx'));
    expect(out.problems).toEqual([]);
    expect(out.headerLine).toBe(1);
    expect(out.records).toEqual([
      {
        istatCode: '001001',
        name: 'Agliè',
        region: 'Piemonte',
        provinceAbbr: 'TO',
        cadastralCode: 'A074',
      },
      {
        istatCode: '001002',
        name: 'Airasca',
        region: 'Piemonte',
        provinceAbbr: 'TO',
        cadastralCode: 'A109',
      },
    ]);
  });

  it('anagrafica AIFA: le righe vere con le intestazioni vere', () => {
    const m = mappingForSyncFile(repo, 'aifa_liste', 'confezioni_fornitura.csv')!;
    const out = extractRecords(m, table('aifa', 'farmaci', 'confezioni_fornitura.csv'));
    expect(out.problems).toEqual([]);
    expect(out.records).toHaveLength(11);
    expect(out.records[0]).toEqual({
      aic: '038092019',
      name: 'AMLODIPINA DOC GENERICI',
      pack: '5 MG COMPRESSE- 28 COMPRESSE IN BLISTER AL/PVC/PVDC',
      activeIngredient: 'AMLODIPINA BESILATO',
      atc: 'C08CA01',
      form: 'Compressa',
      supplyRegime: 'Medicinali soggetti a prescrizione medica',
      holder: 'DOC GENERICI SRL',
    });
  });

  it('classe A: costante, prezzo all’italiana, intestazione in cp1252 con il simbolo dell’euro', () => {
    const m = mappingForSyncFile(repo, 'aifa_liste', '3815901_Classe-A_per_principio-attivo.csv')!;
    const out = extractRecords(
      m,
      table('aifa', 'documents', '20142', '3815901', 'Classe-A_per_principio-attivo_30-6-2026.csv'),
    );
    expect(out.missingColumns).toEqual([]);
    expect(out.problems).toEqual([]);
    // Il file non ha la colonna della nota: il campo resta vuoto, non «da completare».
    expect(out.records[0]).toEqual({
      aic: '038092019',
      drugClass: 'A',
      activeIngredient: 'Amlodipina',
      price: 3.74,
      equivalenceGroup: 'DOB',
      aifaNote: null,
    });
  });

  it('classe H: intestazione che va a capo e prezzi che non sono prezzi', () => {
    const m = mappingForSyncFile(repo, 'aifa_liste', '3815901_Classe-H_per_principio-attivo.csv')!;
    const out = extractRecords(
      m,
      table('aifa', 'documents', '20142', '3815901', 'Classe-H_per_principio-attivo_30-6-2026.csv'),
    );
    expect(out.missingColumns).toEqual([]);
    expect(out.problems).toEqual([]);
    expect(out.noValue).toEqual({ price: 2 });
    expect(out.records.map((r) => [r.aic, r.price])).toEqual([
      ['025202096', 9.92],
      ['034330047', null],
      ['038901524', null],
    ]);
  });

  it('lista di trasparenza (D202): zeri davanti all’AIC, prezzi con l’euro, annotazione vuota', () => {
    const m = mappingForSyncFile(repo, 'aifa_liste', '825643_Lista_farmaci_equivalenti.csv')!;
    const out = extractRecords(
      m,
      table('aifa', 'documents', '20142', '825643', 'Lista_farmaci_equivalenti.csv'),
    );
    expect(out.missingColumns).toEqual([]);
    expect(out.problems).toEqual([]);
    expect(out.padded).toEqual({ aic: 8 });
    expect(out.records[0]).toEqual({
      aic: '038092019',
      activeIngredient: 'Amlodipina',
      referencePack: "28 UNITA' 5 MG - USO ORALE",
      atc: 'C08CA01',
      name: 'AMLODIPINA DOC GENERICI',
      pack: '"5 MG COMPRESSE" 28 COMPRESSE IN BLISTER AL/PVC/PVDC',
      holder: 'DOC GENERICI S.R.L.',
      referencePrice: 3.74,
      publicPrice: 3.74,
      priceDifference: 0,
      remark: null,
      equivalenceGroup: 'DOB',
    });
    // Il medicinale di marca costa di più: la differenza la paga l'assistito.
    expect(out.records.find((r) => r.aic === '027428010')).toMatchObject({
      publicPrice: 5.53,
      priceDifference: 1.79,
    });
  });

  it('farmaci carenti (D202): intestazione alla terza riga, date, «Sì», testo che va a capo', () => {
    const m = mappingForSyncFile(repo, 'aifa_liste', '847339_elenco_medicinali_carenti.csv')!;
    const out = extractRecords(
      m,
      table('aifa', 'documents', '20142', '847339', 'elenco_medicinali_carenti.csv'),
    );
    expect(out.missingColumns).toEqual([]);
    expect(out.problems).toEqual([]);
    expect(out.headerLine).toBe(3);
    expect(out.records).toHaveLength(1);
    expect(out.records[0]).toMatchObject({
      aic: '038548032',
      name: 'AMLODIPINA TEVA ITALIA',
      startOn: '2026-11-02',
      expectedEndOn: null,
      equivalentAvailable: true,
      reason: 'Cessata commercializzazione definitiva',
      reimbursementClass: 'A TOTALE CARICO DEL SSN.',
      atc: 'C08CA01',
    });
    expect(String(out.records[0]!.aifaNote).split('\n')).toHaveLength(3);
  });

  it('date e prezzi: GG/MM/AAAA o AAAA-MM-GG, solo date vere; l’euro solo in fondo', () => {
    const date = KINDS.farmaci_carenti.fields.startOn;
    expect(convertCell(date, '02/11/2026')).toEqual({ value: '2026-11-02' });
    expect(convertCell(date, '2/1/2027')).toEqual({ value: '2027-01-02' });
    expect(convertCell(date, '2026-12-31')).toEqual({ value: '2026-12-31' });
    expect(convertCell(date, ' ')).toEqual({ value: null });
    for (const bad of ['31/02/2026', '2026-02-30', '13/13/2026', 'domani', '2026/11/02']) {
      expect(convertCell(date, bad), bad).toEqual({
        problem: `«${bad}» non è una data (GG/MM/AAAA)`,
      });
    }
    const price = KINDS.farmaci_trasparenza.fields.referencePrice;
    expect(convertCell(price, '5,63 €')).toEqual({ value: 5.63 });
    expect(convertCell(price, '1.234,50€')).toEqual({ value: 1234.5 });
    expect(convertCell(price, '€ 5,63')).toEqual({ problem: '«€ 5,63» non è un numero' });
  });

  it('zeri davanti: solo ai codici di sole cifre più corti, solo dove la mappatura li chiede', () => {
    const m = mappingForSyncFile(repo, 'aifa_liste', '825643_Lista_farmaci_equivalenti.csv')!;
    const header = Object.values(m.colonne) as string[];
    const row = (aic: string) => header.map((h) => (h === 'AIC' ? aic : ''));
    const out = extractRecords(m, [header, row('4592103'), row('038092019'), row('A123')]);
    expect(out.records.map((r) => r.aic)).toEqual(['004592103', '038092019']);
    expect(out.padded).toEqual({ aic: 1 });
    expect(out.problems).toEqual([
      { line: 4, field: 'aic', problem: '«A123» non ha la forma attesa (9 cifre)' },
    ]);
    // Senza la richiesta nella mappatura, l'AIC corto resta un errore.
    const strict = extractRecords({ ...m, zeriDavanti: {} }, [header, row('4592103')]);
    expect(strict.problems).toEqual([
      { line: 2, field: 'aic', problem: '«4592103» non ha la forma attesa (9 cifre)' },
    ]);
  });

  it('i valori senza valore valgono solo se la mappatura li dichiara', () => {
    const m = mappingForSyncFile(repo, 'aifa_liste', '3815901_Classe-H_per_principio-attivo.csv')!;
    const header = [
      'Principio attivo',
      'Prezzo al pubblico €',
      'Codice \nAIC',
      'Codice Gruppo Equivalenza',
    ];
    const rows = [
      header,
      ['Antitrombina III Umana', '-', '034330047', 'AEK'],
      ['Ossigeno', '6,55/m³', '038901524', '051'],
    ];
    const lenient = extractRecords(m, rows);
    expect(lenient.missingColumns).toEqual([]);
    expect(lenient.problems).toEqual([]);
    expect(lenient.records.map((r) => r.price)).toEqual([null, null]);
    const strict = extractRecords({ ...m, nessunValore: {} }, rows);
    expect(strict.problems).toEqual([
      { line: 2, field: 'price', problem: '«-» non è un numero' },
      { line: 3, field: 'price', problem: '«6,55/m³» non è un numero' },
    ]);
    // Una cella che assomiglia ma non è uguale resta un errore.
    expect(extractRecords(m, [header, ['x', '- 1', '034330047', '']]).problems).toHaveLength(1);
  });

  it('una colonna che manca ferma il file e dice quale', () => {
    const m = mappingForSyncFile(repo, 'aifa_liste', 'confezioni_fornitura.csv')!;
    const out = extractRecords({ ...m, colonne: { ...m.colonne, atc: 'Colonna che non c’è' } }, [
      ['CODICE_AIC', 'DENOMINAZIONE'],
      ['038092019', 'AMLODIPINA DOC GENERICI'],
    ]);
    expect(out.records).toEqual([]);
    expect(out.missingColumns).toContain('Colonna che non c’è');
  });

  it('i valori fuori forma sono segnalati con la riga, il campo e il motivo', () => {
    const m = mappingForSyncFile(repo, 'aifa_liste', '3815901_Classe-A_per_principio-attivo.csv')!;
    const header = ['Principio attivo', 'Prezzo al pubblico €', 'AIC', 'Codice Gruppo Equivalenza'];
    const out = extractRecords(m, [
      ['Titolo sopra la tabella'],
      header,
      ['x', '1,00', '12345', ''],
      ['x', 'dieci', '038092019', ''],
      ['', '', '', ''],
      ['x', '1.234,50', '037479060', ''],
    ]);
    expect(out.headerLine).toBe(2);
    expect(out.problems).toEqual([
      { line: 3, field: 'aic', problem: '«12345» non ha la forma attesa (9 cifre)' },
      { line: 4, field: 'price', problem: '«dieci» non è un numero' },
    ]);
    expect(out.records).toHaveLength(1);
    expect(out.records[0]!.price).toBe(1234.5);
  });
});

describe('controllo del file delle mappature', () => {
  const base = {
    id: 'x',
    titolo: 'X',
    tipo: 'comuni',
    origine: 'sync',
    fonte: 'f',
    chiave: 'k',
    colonne: {},
    vecchiaDopoGiorni: null,
  };
  it('rifiuta campi inesistenti, id ripetuti e file di sync senza chiave', () => {
    expect(() =>
      parseMappings({ versione: '1', mappature: [{ ...base, colonne: { colore: 'Colore' } }] }),
    ).toThrow(/non ha il campo colore/);
    expect(() => parseMappings({ versione: '1', mappature: [base, base] })).toThrow(/ripetuta/);
    expect(() =>
      parseMappings({ versione: '1', mappature: [{ ...base, chiave: undefined }] }),
    ).toThrow(/fonte e chiave/);
  });

  it('«nessun valore»: solo per campi esistenti e facoltativi, con espressioni valide', () => {
    const one = (nessunValore: object) =>
      parseMappings({ versione: '1', mappature: [{ ...base, nessunValore }] });
    expect(() => one({ region: ['-'] })).not.toThrow();
    expect(() => one({ colore: ['-'] })).toThrow(/non ha il campo colore/);
    expect(() => one({ istatCode: ['-'] })).toThrow(/obbligatorio/);
    expect(() => one({ region: ['('] })).toThrow(/espressione non valida/);
  });

  it('zeri davanti: solo per campi esistenti, con una lunghezza intera positiva', () => {
    const one = (zeriDavanti: object) =>
      parseMappings({ versione: '1', mappature: [{ ...base, zeriDavanti }] });
    expect(() => one({ istatCode: 6 })).not.toThrow();
    expect(() => one({ colore: 6 })).toThrow(/non ha il campo colore/);
    expect(() => one({ istatCode: 0 })).toThrow();
    expect(() => one({ istatCode: 2.5 })).toThrow();
  });
});
