import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  applyChanges,
  compareIcd9,
  type DataRecord,
  type DiagnosisRow,
  diagnosisByCode,
  extractRecords,
  findTranscriptions,
  icd9Parent,
  indexDiagnoses,
  loadMappings,
  mappingForTranscription,
  parseChanges,
  readTable,
  searchDiagnoses,
  structureProblems,
} from '../src';

/**
 * Diagnosi ICD-9-CM (D186). Il catalogo d'esempio ha righe vere della versione italiana 2007
 * (elenco sistematico), copiate dalla trascrizione del programma; le aggiunte COVID-19 sono del
 * DM 28 ottobre 2020 (GU n. 26 dell'1/2/2021, allegato 1, pagine 31, 32 e 35).
 */
const EXAMPLES = join(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'fixtures',
  'banche-dati',
  'trascrizioni',
);
const mapping = mappingForTranscription(loadMappings(), 'diagnosi')!;
const { found, invalid } = findTranscriptions(join(EXAMPLES, 'icd9cm'));
const table = (name: string) => {
  const t = found.find((f) => f.path === `${name}.json`)!;
  return readTable(readFileSync(t.csvPath), `${name}.csv`);
};
const base = extractRecords(mapping, table('diagnosi-prova'));
const covid = parseChanges(mapping, table('covid19-prova'));
const after2021 = applyChanges('diagnosi', base.records, covid.changes);

const asRows = (records: DataRecord[]): DiagnosisRow[] =>
  records.map((r) => ({
    code: String(r.code),
    description: String(r.description),
    parentCode: (r.parentCode as string | null) ?? null,
    includedTerms: (r.includedTerms as string | null) ?? null,
    notes: (r.notes as string | null) ?? null,
    chapter: (r.chapter as string | null) ?? null,
    section: (r.section as string | null) ?? null,
  }));
const index = indexDiagnoses(asRows(after2021.records));
const codes = (q: string, limit = 50) => searchDiagnoses(index, q, limit).hits.map((h) => h.code);

describe('codici ICD-9-CM', () => {
  it('il padre è il codice senza l’ultima cifra; le categorie di tre cifre non ne hanno', () => {
    expect(icd9Parent('250.00')).toBe('250.0');
    expect(icd9Parent('250.0')).toBe('250');
    expect(icd9Parent('V17.3')).toBe('V17');
    expect(icd9Parent('E880.0')).toBe('E880');
    expect(icd9Parent('401')).toBeNull();
    expect(icd9Parent('V07')).toBeNull();
  });

  it('ordine della classificazione: numerici, V, E; il padre prima dei figli', () => {
    const list = ['E880.0', 'V17.3', '250.1', '250.00', '250', '250.01', '250.0', '043.11', '043'];
    expect([...list].sort(compareIcd9)).toEqual([
      '043',
      '043.11',
      '250',
      '250.0',
      '250.00',
      '250.01',
      '250.1',
      'V17.3',
      'E880.0',
    ]);
  });

  it('controlli sull’elenco intero: codici ripetuti, padri sbagliati o mancanti', () => {
    const v = (code: string, parentCode: string | null): DataRecord => ({
      code,
      description: 'Voce di prova',
      parentCode,
    });
    expect(
      structureProblems('diagnosi', [
        v('493', null),
        v('493.9', '493'),
        v('493.91', '493.9'),
        v('493.91', '493.9'),
        v('942.40', '942.4'),
        v('250.0', '250'),
        v('401', '400'),
        v('V07.0', 'V7'),
      ]).map((p) => p.problem),
    ).toEqual([
      '493.91: codice ripetuto',
      "942.40: il padre 942.4 non c'è",
      "250.0: il padre 250 non c'è",
      '401: una categoria di tre cifre non ha padre (scritto 400)',
      'V07.0: il padre è V07, non V7',
    ]);
    // Gli altri tipi non hanno controlli sull'elenco intero.
    expect(structureProblems('esenzioni', [{ code: 'A', description: 'x' }])).toEqual([]);
  });
});

describe('catalogo d’esempio e aggiunte COVID-19 (D186)', () => {
  it('due schede della stessa serie, controllate, con la data dell’atto', () => {
    expect(invalid).toEqual([]);
    expect(
      found.map((f) => [f.path, f.sheet.serie, f.sheet.in_vigore_dal, f.sheet.solo_modifiche]),
    ).toEqual([
      ['covid19-prova.json', 'icd9cm-diagnosi', '2021-02-02', true],
      ['diagnosi-prova.json', 'icd9cm-diagnosi', '2009-01-01', false],
    ]);
  });

  it('il catalogo si legge senza problemi e la struttura è completa', () => {
    expect(base.missingColumns).toEqual([]);
    expect(base.problems).toEqual([]);
    expect(base.records).toHaveLength(72);
    expect(structureProblems('diagnosi', base.records)).toEqual([]);
    expect(base.records.find((r) => r.code === '493.92')).toMatchObject({
      description: 'Asma, tipo non specificato, con riacutizzazione',
      parentCode: '493.9',
    });
  });

  it('il DM 28/10/2020 aggiunge il blocco 043 e i sottocodici di 480.4 e V07.0', () => {
    expect(covid.problems).toEqual([]);
    expect(after2021).toMatchObject({ added: 9, replaced: 0, removed: 0, problems: [] });
    expect(structureProblems('diagnosi', after2021.records)).toEqual([]);
    expect(diagnosisByCode(index, '043.11')).toMatchObject({
      description: 'COVID-19 conclamata, virus identificato',
      category: false,
      path: [
        { code: '043', description: 'Malattia da SARS-CoV-2 (COVID-19)' },
        { code: '043.1', description: 'Malattia da SARS-CoV-2 (COVID-19) conclamata' },
      ],
    });
    // V07.0 diventa una categoria: «non deve essere utilizzato per la codifica» (nota del DM).
    expect(diagnosisByCode(index, 'V07.0')!.category).toBe(true);
    expect(diagnosisByCode(indexDiagnoses(asRows(base.records)), 'V07.0')!.category).toBe(false);
  });
});

describe('ricerca delle diagnosi', () => {
  it('per parole, in qualunque ordine, senza accenti né maiuscole', () => {
    expect(codes('asma riacutizzazione')).toEqual(['493.92']);
    expect(codes('RIACUTIZZAZIONE asma')).toEqual(['493.92']);
    expect(codes('pioderma gangrenoso')).toEqual(['686.01']);
    expect(codes('necessita isolamento sars')).toEqual(['V07.00']);
  });

  it('prima le voci con la parola nel titolo, poi nei padri; a parità, l’ordine della classificazione', () => {
    expect(codes('diabete').slice(0, 6)).toEqual([
      '250',
      '250.0',
      '250.00',
      '250.01',
      '250.02',
      '250.03',
    ]);
    expect(codes('ipertensione')).toEqual(['401', '401.0', '401.1', '401.9']);
  });

  it('i titoli dei padri valgono per la ricerca: «frattura colles esposta» trova solo 813.51', () => {
    expect(codes('frattura colles')).toEqual(['813.41', '813.51']);
    expect(codes('frattura colles esposta')).toEqual(['813.51']);
    const [hit] = searchDiagnoses(index, 'frattura colles esposta', 5).hits;
    expect(hit!.path.map((p) => p.code)).toEqual(['813', '813.5']);
  });

  it('le parole che non distinguono non contano; le parole brevi valgono solo intere', () => {
    expect(codes('di della')).toEqual([]);
    expect(codes('la febbre')).toEqual(['780.6']);
  });

  it('per codice, con o senza punto, anche V ed E', () => {
    expect(codes('4019')).toEqual(['401.9']);
    expect(codes('401')).toEqual(['401', '401.0', '401.1', '401.9']);
    expect(codes('v17.3')).toEqual(['V17.3']);
    expect(codes('e880')).toEqual(['E880', 'E880.0']);
  });

  it('dice quante voci rispondono anche oltre il limite, e quali hanno sottocodici', () => {
    const r = searchDiagnoses(index, 'frattura', 3);
    expect(r.hits).toHaveLength(3);
    expect(r.total).toBeGreaterThan(3);
    expect(r.hits[0]).toMatchObject({ code: '813', category: true });
    expect(diagnosisByCode(index, '813.51')!.category).toBe(false);
    expect(diagnosisByCode(index, '999.99')).toBeNull();
  });
});
