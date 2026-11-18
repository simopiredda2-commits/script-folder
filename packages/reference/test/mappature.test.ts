import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  extractRecords,
  loadMappings,
  mappingForSyncFile,
  mappingForTranscription,
  missingFields,
  overrideMappings,
  parseMappings,
  pendingColumns,
  readTable,
} from '../src';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const SAMPLES = join(ROOT, 'fixtures', 'banche-dati');
const repo = loadMappings();
const test = overrideMappings(repo, loadMappings(join(SAMPLES, 'mappature-prova.json')));
const table = (...p: string[]) => {
  const path = join(SAMPLES, 'sito', ...p);
  return readTable(new Uint8Array(readFileSync(path)), path);
};

describe('mappature del repository', () => {
  it('ISTAT è completa; AIFA è da completare e lo dice', () => {
    const istat = mappingForSyncFile(repo, 'istat_comuni', 'Elenco-comuni-italiani.xlsx')!;
    expect(missingFields(istat)).toEqual([]);
    const aifa = mappingForSyncFile(repo, 'aifa_liste', 'confezioni_fornitura.csv')!;
    expect(missingFields(aifa)).toEqual(['aic']);
    expect(pendingColumns(aifa)).toContain('name');
    const classA = mappingForSyncFile(
      repo,
      'aifa_liste',
      '3815901_Classe-A_per_principio-attivo.csv',
    )!;
    expect(classA.id).toBe('aifa-classe-a');
    expect(missingFields(classA)).toEqual(['aic']);
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

  it('classe A: costante, prezzo all’italiana e intestazione con una data diversa', () => {
    const m = mappingForSyncFile(test, 'aifa_liste', '3815901_Classe-A_per_principio-attivo.csv')!;
    const out = extractRecords(
      m,
      table('aifa', 'documents', '20142', '3815901', 'Classe-A_per_principio-attivo_30-6-2026.csv'),
    );
    expect(out.missingColumns).toEqual([]);
    expect(out.records[0]).toEqual({
      aic: '900000011',
      drugClass: 'A',
      activeIngredient: 'principio di prova',
      price: 5.2,
      equivalenceGroup: 'GP-01',
      aifaNote: null,
    });
  });

  it('una colonna che manca ferma il file e dice quale', () => {
    const m = mappingForSyncFile(test, 'aifa_liste', 'confezioni_fornitura.csv')!;
    const out = extractRecords({ ...m, colonne: { ...m.colonne, atc: 'Colonna che non c’è' } }, [
      ['AIC di prova', 'Denominazione di prova'],
      ['900000011', 'PROVALINA'],
    ]);
    expect(out.records).toEqual([]);
    expect(out.missingColumns).toContain('Colonna che non c’è');
  });

  it('i valori fuori forma sono segnalati con la riga, il campo e il motivo', () => {
    const m = mappingForSyncFile(test, 'aifa_liste', '3815901_Classe-A_per_principio-attivo.csv')!;
    const header = [
      'AIC di prova',
      'Principio attivo di prova',
      'Prezzo di prova al 1/1/2027',
      'Gruppo di equivalenza di prova',
      'Nota di prova',
    ];
    const out = extractRecords(m, [
      ['Titolo sopra la tabella'],
      header,
      ['12345', 'x', '1,00', '', ''],
      ['900000011', 'x', 'dieci', '', ''],
      ['', '', '', '', ''],
      ['900000023', 'x', '1.234,50', '', ''],
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
});
