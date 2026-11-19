import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  applyChanges,
  type DataRecord,
  extractRecords,
  findTranscriptions,
  loadMappings,
  mappingForTranscription,
  parseChanges,
  readTable,
  REGIONAL_TRANSCRIPTIONS,
  structureProblems,
} from '../src';

/**
 * Il catalogo ICD-9-CM che il programma porta con sé (D186): la versione italiana 2007, estratta
 * dal PDF del manuale da Simone e controllata da un controllo esterno, con le correzioni e i codici
 * composti dalle legende; poi le aggiunte COVID-19 del DM 28/10/2020. Che cosa è diverso dal PDF:
 * docs/icd9cm.md. Le righe attese sono quelle del documento.
 */
const mapping = mappingForTranscription(loadMappings(), 'diagnosi')!;
const icd = findTranscriptions(REGIONAL_TRANSCRIPTIONS).found.filter((f) =>
  f.path.startsWith('icd9cm/'),
);
const sheet = (name: string) => icd.find((f) => f.path === `icd9cm/${name}.json`)!;
const table = (name: string) => readTable(readFileSync(sheet(name).csvPath), `${name}.csv`);

const ELENCO = 'icd9cm-2007-elenco-sistematico';
const COVID = 'dm-2020-10-28-covid19';
const full = extractRecords(mapping, table(ELENCO));
const covid = parseChanges(mapping, table(COVID));
const since2021 = applyChanges('diagnosi', full.records, covid.changes);

const byCode = (records: DataRecord[], code: string) => records.find((r) => r.code === code);
const title = (code: string, records = since2021.records) => byCode(records, code)?.description;
/** La colonna «origine» del CSV: come stampato, corretto, composto dalla legenda, ricostruito. */
const origins = (() => {
  const rows = table(ELENCO);
  const col = rows[0]!.indexOf('origine');
  const out = new Map<string, number>();
  for (const r of rows.slice(1)) out.set(r[col]!, (out.get(r[col]!) ?? 0) + 1);
  return Object.fromEntries(out);
})();

describe('catalogo ICD-9-CM del programma (D186)', () => {
  it('due schede della stessa serie, da controllare finché nessuno le ha controllate (A8)', () => {
    expect(
      icd.map((f) => [f.path, f.sheet.serie, f.sheet.in_vigore_dal, f.sheet.solo_modifiche]),
    ).toEqual([
      [`icd9cm/${COVID}.json`, 'icd9cm-diagnosi', '2021-02-02', true],
      [`icd9cm/${ELENCO}.json`, 'icd9cm-diagnosi', '2009-01-01', false],
    ]);
    expect(icd.map((f) => f.sheet.controllato_da)).toEqual([null, null]);
    expect(sheet(ELENCO).sheet.atto).toMatch(/versione italiana 2007 della ICD-9-CM/);
  });

  it('l’elenco si legge tutto, con ogni codice una volta e ogni padre al suo posto', () => {
    expect(full.missingColumns).toEqual([]);
    expect(full.problems).toEqual([]);
    expect(full.records).toHaveLength(16293);
    expect(structureProblems('diagnosi', full.records)).toEqual([]);
    expect(origins).toEqual({
      'come stampato': 15854,
      corretto: 41,
      'composto dalla legenda': 395,
      ricostruito: 3,
    });
  });

  it('il DM 28/10/2020 aggiunge 24 codici (17 finali) e note a 18 codici che c’erano', () => {
    expect(covid.problems).toEqual([]);
    expect(since2021).toMatchObject({ added: 24, replaced: 18, removed: 0, problems: [] });
    expect(structureProblems('diagnosi', since2021.records)).toEqual([]);
    expect(title('043.11')).toBe('COVID-19 conclamata, virus identificato');
    expect(byCode(since2021.records, '460')!.notes).toMatch(
      /Escl\.: altra infezione delle vie respiratorie in COVID-19, virus non identificato \(519\.72\) \(DM 28\/10\/2020\)$/,
    );
    // V07.0 diventa una categoria: si codificano V07.00 o V07.08.
    expect(since2021.records.filter((r) => r.parentCode === 'V07.0').map((r) => r.code)).toEqual([
      'V07.00',
      'V07.08',
    ]);
  });

  it('nessun codice dello stesso padre ha il titolo di un fratello', () => {
    const seen = new Map<string, string>();
    const twins: string[] = [];
    for (const r of since2021.records) {
      const key = `${String(r.parentCode)}|${String(r.description).toLowerCase()}`;
      if (seen.has(key)) twins.push(`${seen.get(key)} e ${String(r.code)}`);
      else seen.set(key, String(r.code));
    }
    expect(twins).toEqual([]);
  });

  it('codici stampati male nel PDF, corretti (ipotesi dell’estrazione confermate)', () => {
    expect(title('493.92')).toBe('Asma, tipo non specificato, con riacutizzazione');
    expect(title('493.91')).toBe('Asma, tipo non specificato, con stato asmatico');
    expect(title('965.61')).toBe('Avvelenamento da derivati dall’acido propionico');
    expect(byCode(since2021.records, '942.4')).toMatchObject({ parentCode: '942' });
    expect(title('E999.0')).toBe('Effetti ritardati di traumatismo dovuto ad operazioni di guerra');
    expect(title('E862.9')).toBe('Solventi non specificati');
    // I codici stampati male non ci sono più; il primo E990.0 (p. 882) è quello vero.
    expect(['696.61', '696.69', 'E862.5'].filter((c) => byCode(since2021.records, c))).toEqual([]);
    expect(since2021.records.filter((r) => r.code === 'E990.0').map((r) => r.description)).toEqual([
      'Da bomba a benzina',
    ]);
  });

  it('titoli sbagliati nel PDF, corretti (controllo esterno e simulazione)', () => {
    expect(title('813.9')).toBe('Frattura esposta di parte, non specificata');
    expect(title('813.90')).toBe('Frattura esposta dell’avambraccio, non specificata');
    expect(title('800.99')).toMatch(/^Frattura esposta della volta cranica/);
    expect(title('851.90')).toBe(
      'Altra e non specificata lacerazione cerebrale e contusione con ferita intracranica esposta, stato di coscienza non specificato',
    );
    expect(title('E917.8')).toBe('Altro oggetto stazionario, con conseguente caduta');
    expect(title('E855.9')).toBe(
      'Farmaco non specificato che agisce sul sistema nervoso centrale e autonomo',
    );
    expect(title('V65.40')).toBe('Consigli SAI (non specificati)');
    expect(title('821.33')).toBe('Frattura del femore sopracondilare');
    expect(title('649.5')).toBe('Spotting complicante la gravidanza');
    expect(title('649.03')).toBe(
      'Malattia associata all’uso di tabacco complicanti la gravidanza, il parto o il puerperio, condizione o complicazione antepartum',
    );
    expect(title('900.89')).toBe('Altro traumatismo dei vasi sanguigni della testa e del collo');
    expect(title('E843.4')).toBe(
      'Caduta in, su o da mezzo aereo di occupante di mezzo aereo commerciale (a motore) in superficie per trasporto aereo',
    );
  });

  it('righe che mancavano: ricostruite dal testo dello stesso PDF; E978 resta fuori', () => {
    expect(title('686.01')).toBe('Pioderma gangrenoso');
    expect(String(byCode(since2021.records, '686.00')!.includedTerms ?? '')).not.toMatch(
      /gangrenoso/,
    );
    expect(title('E854.3')).toBe('Da stimolanti del sistema nervoso centrale');
    expect(title('E854.8')).toBe('Da altri agenti psicotropi');
    expect(title('E982.8')).toBe('Altri gas e vapori specificati');
    expect(title('E982.9')).toBe('Gas e vapori non specificati');
    expect(byCode(since2021.records, 'E978')).toBeUndefined();
  });

  it('codici composti dalle legende stampate: quinta cifra di 531–535, quarta di E800–E841', () => {
    expect(title('531.00')).toBe(
      'Ulcera gastrica acuta con emorragia, senza menzione di ostruzione',
    );
    expect(title('535.61')).toBe('Duodenite, con emorragia');
    expect(title('E800.0')).toBe(
      'Incidente ferroviario riguardante la collisione con materiale rotabile di impiegato ferroviario',
    );
    expect(title('E810.7')).toBe(
      'Incidente da traffico di veicolo a motore riguardante collisione con il treno di pedone',
    );
    // Le categorie restano, ma ora hanno sottocodici.
    expect(since2021.records.filter((r) => r.parentCode === '531.0')).toHaveLength(2);
    expect(since2021.records.filter((r) => r.parentCode === 'E830')).toHaveLength(9);
  });
});
