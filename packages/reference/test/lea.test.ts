import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  exemptionFamily,
  extractRecords,
  findTranscriptions,
  loadMappings,
  mappingForTranscription,
  readTable,
  REGIONAL_TRANSCRIPTIONS,
} from '../src';

/**
 * Esenzioni del DPCM LEA (D190): l'allegato 8, malattie e condizioni croniche e invalidanti, dal
 * PDF della pagina del Ministero. Da controllare prima dell'uso (A8).
 */
const sheet = findTranscriptions(REGIONAL_TRANSCRIPTIONS).found.find(
  (f) => f.path === 'lea/allegato-8-malattie-croniche.json',
)!;
const table = readTable(readFileSync(sheet.csvPath), 'allegato-8-malattie-croniche.csv');
const { records, problems, missingColumns } = extractRecords(
  mappingForTranscription(loadMappings(), 'esenzioni')!,
  table,
);
const byCode = new Map(records.map((r) => [String(r.code), String(r.description)]));
const column = (name: string) => table.slice(1).map((r) => r[table[0]!.indexOf(name)]!);

describe('allegato 8 del DPCM LEA: codici di esenzione delle malattie croniche (D190)', () => {
  it('una scheda intera, da controllare, dal 30/10/2026', () => {
    expect(sheet.sheet).toMatchObject({
      tipo: 'esenzioni',
      serie: 'lea-esenzioni-malattie-croniche',
      in_vigore_dal: '2026-10-30',
      controllato_da: null,
    });
    expect(sheet.sheet.solo_modifiche ?? false).toBe(false);
  });

  it('247 codici, ognuno una volta: 66 condizioni e 181 malattie della tabella di corrispondenza', () => {
    expect(missingColumns).toEqual([]);
    expect(problems).toEqual([]);
    expect(records).toHaveLength(247);
    expect(new Set(byCode.keys()).size).toBe(247);
    const bare = [...byCode.keys()].filter((c) => !c.includes('.'));
    expect(bare).toHaveLength(66);
    // Ogni codice con la malattia comincia con il codice di una condizione della prima parte.
    for (const c of byCode.keys())
      if (c.includes('.')) expect(bare, c).toContain(c.slice(0, c.indexOf('.')));
    const origins = Object.fromEntries(
      [...new Set(column('origine'))].map((o) => [
        o,
        column('origine').filter((x) => x === o).length,
      ]),
    );
    expect(origins).toEqual({
      'condizione della tabella di corrispondenza': 59,
      'prima parte': 4,
      'prima parte, su più righe': 3,
      'tabella di corrispondenza': 181,
    });
  });

  it('descrizioni ricomposte dalle celle che vanno a capo', () => {
    expect(byCode.get('013.250')).toBe('DIABETE MELLITO');
    expect(byCode.get('0031.402')).toBe(
      'IPERTENSIONE ARTERIOSA CON DANNO D’ORGANO: CARDIOPATIA IPERTENSIVA'.replace('’', "'"),
    );
    expect(byCode.get('016.070.33')).toBe(
      'EPATITE CRONICA (ATTIVA): EPATITE VIRALE B CRONICA SENZA MENZIONE DI COMA EPATICO, CON EPATITE DELTA',
    );
    expect(byCode.get('061.582.1')).toBe(
      'PATOLOGIE RENALI CRONICHE (con valori di cretinina clearance stabilmente inferiori a 85 ml/m): GLOMERULONEFRITE CRONICA CON LESIONI DI GLOMERULONEFRITE MEMBRANOSA (COMPRESA LA GLOMERULOSCLEROSI FOCALE)',
    );
    expect(byCode.get('049')).toMatch(
      /^SOGGETTI AFFETTI DA PLURIPATOLOGIE .* RISULTANTE DALL'APPLICAZIONE DI CONVALIDATE SCALE DI VALUTAZIONE$/,
    );
    expect(byCode.get('050')).toBe(
      'SOGGETTI IN ATTESA DI TRAPIANTO (RENE, CUORE, POLMONE, FEGATO, PANCREAS, CORNEA, MIDOLLO)',
    );
    // Le tre esenzioni nuove della versione 2026.
    expect(['068', '069', '070'].map((c) => byCode.has(c))).toEqual([true, true, true]);
  });

  it('HIV-2 non è un codice a parte: 020.042 con il codice aggiuntivo 079.53', () => {
    expect([...byCode.keys()].filter((c) => c.startsWith('020'))).toEqual([
      '020',
      '020.042',
      '020.V08',
    ]);
    expect(byCode.has('079.53')).toBe(false);
  });
});

describe('famiglie dei codici di esenzione (D190)', () => {
  it('cronici con le cifre, rari con R e una lettera, gli altri per le lettere iniziali', () => {
    expect(
      ['013', '013.250', '0A31', 'RA0010', 'rbg010', 'E01', 'M50', 'T01', 'DEMO'].map(
        exemptionFamily,
      ),
    ).toEqual(['croniche', 'croniche', 'croniche', 'rare', 'rare', 'E', 'M', 'T', 'DEMO']);
  });
});
