import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  extractRecords,
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

  it('le soglie di vecchiaia (A6) non ci sono nei requisiti: restano da completare', () => {
    expect(repo.mappings.every((m) => m.vecchiaDopoGiorni === null)).toBe(true);
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
});
