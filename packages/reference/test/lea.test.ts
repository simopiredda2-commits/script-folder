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

/**
 * Allegato 7 del DPCM LEA: malattie rare (D195). Letto dal PDF cella per cella: una riga per
 * codice, con il nome della malattia o del gruppo, esempi, sinonimi e malattie del gruppo con un
 * codice proprio. Da controllare prima dell'uso (A8).
 */
describe('allegato 7 del DPCM LEA: codici di esenzione delle malattie rare (D195)', () => {
  const rare = findTranscriptions(REGIONAL_TRANSCRIPTIONS).found.find(
    (f) => f.path === 'lea/allegato-7-malattie-rare.json',
  )!;
  const rareTable = readTable(readFileSync(rare.csvPath), 'allegato-7-malattie-rare.csv');
  const rareRead = extractRecords(mappingForTranscription(loadMappings(), 'esenzioni')!, rareTable);
  const col = (name: string) => rareTable[0]!.indexOf(name);
  const row = (code: string) => rareTable.slice(1).find((r) => r[0] === code)!;

  it('una scheda intera, da controllare, dal 30/10/2026, in una serie sua', () => {
    expect(rare.sheet).toMatchObject({
      tipo: 'esenzioni',
      serie: 'lea-esenzioni-malattie-rare',
      in_vigore_dal: '2026-10-30',
      controllato_da: null,
    });
    expect(rare.sheet.solo_modifiche ?? false).toBe(false);
  });

  it('370 codici, ognuno una volta: 116 gruppi e 254 malattie, tutti della famiglia delle rare', () => {
    expect(rareRead.missingColumns).toEqual([]);
    expect(rareRead.problems).toEqual([]);
    const codes = rareRead.records.map((r) => String(r.code));
    expect(codes).toHaveLength(370);
    expect(new Set(codes).size).toBe(370);
    for (const c of codes) {
      expect(c, c).toMatch(/^R[A-Z][A-Z0-9]\d{3}$/);
      expect(exemptionFamily(c), c).toBe('rare');
    }
    expect(codes.filter((c) => c[2] === 'G')).toHaveLength(116);
    // Nessun codice è anche delle malattie croniche (allegato 8).
    expect(codes.filter((c) => byCode.has(c))).toEqual([]);
    expect(new Set(rareTable.slice(1).map((r) => r[col('sezione')]))).toHaveProperty('size', 16);
  });

  it('il nome è quello della malattia o del gruppo, non un esempio', () => {
    const name = (code: string) => row(code)[col('descrizione')];
    expect(name('RA0010')).toBe('HANSEN, MALATTIA DI');
    expect(name('RB0020')).toBe('RETINOBLASTOMA (ATTESTATO DI ESENZIONE RINNOVABILE DOPO 5 ANNI)');
    expect(name('RBG021')).toBe('CANCRO NON POLIPOSICO EREDITARIO DEL COLON');
    expect(name('RCG040')).toBe(
      'DIFETTI CONGENITI DEL METABOLISMO E DEL TRASPORTO DEGLI AMINOACIDI',
    );
    expect(row('RA0020')[col('sinonimi')]).toBe('LIPODISTROFIA INTESTINALE');
  });

  it('le malattie del gruppo con un codice proprio, e le lettere spaziate ricomposte', () => {
    expect(row('RCG071')[col('comprende_con_codice_proprio')]).toContain(
      'SMITH-LEMLI-OPITZ, SINDROME DI (codice RN1200)',
    );
    expect(row('RNG262')[col('esempi')]?.split(' | ')[0]).toBe('DISGENESIA GONADICA');
  });
});

/**
 * Allegato 3 del DPCM LEA (D218): il nomenclatore dei presidi per persone affette da patologia
 * diabetica e da malattie rare, dalla Gazzetta del 2017 (i decreti del 2026 non lo toccano, D216).
 * Da controllare prima dell'uso (A8).
 */
describe('allegato 3 del DPCM LEA: presidi per diabete e malattie rare (D218)', () => {
  const sheet3 = findTranscriptions(REGIONAL_TRANSCRIPTIONS).found.find(
    (f) => f.path === 'lea/allegato-3-presidi.json',
  )!;
  const table3 = readTable(readFileSync(sheet3.csvPath), 'allegato-3-presidi.csv');
  const read3 = extractRecords(mappingForTranscription(loadMappings(), 'presidi')!, table3);
  const of = (type: string) => read3.records.filter((r) => r.entryType === type);

  it('una scheda intera, da controllare, in vigore dal giorno dopo la Gazzetta del 2017', () => {
    expect(sheet3.sheet).toMatchObject({
      tipo: 'presidi',
      serie: 'lea-presidi-diabete-malattie-rare',
      in_vigore_dal: '2017-03-19',
      controllato_da: null,
    });
    expect(sheet3.sheet.solo_modifiche ?? false).toBe(false);
  });

  it('il tipo della voce è «presidio» o «malattia_rara»: un altro valore è un problema (D232)', () => {
    const header = 'tipo;codice;descrizione;gruppo;allegato';
    const bad = readTable(
      Buffer.from(`${header}\nmalattia rara;RCG060;Malattia di prova;Malattie rare;3\n`, 'utf8'),
      'prova.csv',
    );
    const read = extractRecords(mappingForTranscription(loadMappings(), 'presidi')!, bad);
    expect(read.records).toEqual([]);
    expect(JSON.stringify(read.problems)).toMatch(/«presidio» o «malattia_rara»/);
  });

  it('18 presidi in 10 gruppi e le 12 malattie rare dell’art. 13, tutti dell’allegato 3', () => {
    expect(read3.missingColumns).toEqual([]);
    expect(read3.problems).toEqual([]);
    expect(read3.records).toHaveLength(30);
    expect(of('presidio')).toHaveLength(18);
    expect(new Set(read3.records.map((r) => r.annex))).toEqual(new Set(['3']));
    expect([...new Set(of('presidio').map((r) => r.group))]).toEqual([
      'Strisce reattive per la determinazione del glucosio e dei corpi chetonici nelle urine',
      'Strisce reattive per la determinazione della glicemia nel sangue',
      'Strisce reattive per la determinazione della chetonemia',
      'Compresse reattive',
      'Lancette pungidito',
      'Penna pungidito',
      'Siringhe',
      'Aghi',
      'Apparecchi per la misurazione della glicemia',
      'Microinfusori per la somministrazione programmata dell’insulina',
    ]);
    expect(of('malattia_rara').map((r) => r.code)).toEqual([
      'RCG060',
      'RCG074',
      'RN1080',
      'RN0710',
      'RCG162',
      'RN0730',
      'RN1380',
      'RN1290',
      'RN1370',
      'RCG061',
      'RNG092',
      'RCG040',
    ]);
    for (const r of of('malattia_rara')) expect(exemptionFamily(String(r.code))).toBe('rare');
  });

  it('i codici come nell’allegato: lo stesso per più presidi, due nella stessa cella', () => {
    const code = (description: string) =>
      of('presidio').find((r) => r.description === description)?.code;
    expect(of('presidio').filter((r) => r.code === 'W0101060201')).toHaveLength(4);
    expect(code('Strisce reattive per determinazione glicemia')).toBe('W0101060101');
    expect(code('Ago per penna da insulina')).toBe('A01010102');
    expect(code('Ago a farfalla per microinfusori')).toBe('A010102');
    expect(code('Apparecchio per la misurazione della glicemia')).toBe('W0201060102 / Z12040115');
    expect(code('Apparecchio per la misurazione della chetonemia')).toBe('W020106019099');
    expect(code('Microinfusori')).toBe('Z1204021601');
  });

  it('il testo come stampato, compresa la parentesi non chiusa di RCG074', () => {
    const rare = (c: string) => of('malattia_rara').find((r) => r.code === c)?.description;
    expect(rare('RCG074')).toMatch(/\(es\. Deficit di 3 Idrossiacil Coa Deidrogenasi a catena$/);
    expect(rare('RN1370')).toBe('ALSTRÖM, SINDROME DI');
    expect(rare('RCG162')).toBe('SINDROMI DA NEOPLASIE ENDOCRINE MULTIPLE (es MEN2)');
  });
});

/**
 * Allegato 2 del DPCM LEA (D236): gli ausili monouso, dal PDF della pagina del Ministero
 * (29/9/2026), con le modifiche dell'allegato M del DM 3/8/2026. Da controllare prima dell'uso (A8).
 */
describe('allegato 2 del DPCM LEA: ausili monouso (D236)', () => {
  const sheet2 = findTranscriptions(REGIONAL_TRANSCRIPTIONS).found.find(
    (f) => f.path === 'lea/allegato-2-ausili-monouso.json',
  )!;
  const table2 = readTable(readFileSync(sheet2.csvPath), 'allegato-2-ausili-monouso.csv');
  const read2 = extractRecords(mappingForTranscription(loadMappings(), 'presidi')!, table2);
  const item = (code: string) => read2.records.find((r) => r.code === code)!;
  const cell = (code: string, name: string) =>
    table2.find((r) => r[1] === code)![table2[0]!.indexOf(name)];

  it('una scheda intera, da controllare, in vigore dal 30/10/2026 come il DM 3/8/2026', () => {
    expect(sheet2.sheet).toMatchObject({
      tipo: 'presidi',
      serie: 'lea-presidi-ausili-monouso',
      in_vigore_dal: '2026-10-30',
      controllato_da: null,
    });
    expect(sheet2.sheet.solo_modifiche ?? false).toBe(false);
    expect(sheet2.sheet.atto).toMatch(
      /allegato 2: ausili monouso, aggiornato dal DM 3 agosto 2026/,
    );
  });

  it('87 presidi dell’allegato 2 in 21 gruppi, nell’ordine dell’allegato, ogni codice una volta', () => {
    expect(read2.missingColumns).toEqual([]);
    expect(read2.problems).toEqual([]);
    expect(read2.records).toHaveLength(87);
    expect(new Set(read2.records.map((r) => r.entryType))).toEqual(new Set(['presidio']));
    expect(new Set(read2.records.map((r) => r.annex))).toEqual(new Set(['2']));
    const codes = read2.records.map((r) => String(r.code));
    expect(new Set(codes).size).toBe(87);
    for (const c of codes) expect(c).toMatch(/^(?:04|09)\.\d{2}\.\d{2}\.\d{3}$/);
    expect([...new Set(read2.records.map((r) => r.group))]).toEqual([
      '09.15 ausili per tracheostomia/laringectomia',
      '09.18.04 sacche per stomia, a un pezzo, a fondo chiuso',
      '09.18.05 sacche per stomia, a più pezzi, a fondo chiuso',
      '09.18.07 sacche per stomia, a un pezzo, a fondo aperto con valvola anti-reflusso',
      '09.18.08 sacche per stomia, a più pezzi, a fondo aperto con valvola anti-reflusso',
      "09.18.24 ausili per l'irrigazione dell'intestino",
      '09.18.30 protettori dello stoma e cute peristomale',
      '04.49 prodotti per il trattamento delle lesioni cutanee',
      'lubrificante per cateterismo',
      '09.24.03 cateteri vescicali a permanenza (o autostatici)',
      '09.24.06 cateteri vescicali a intermittenza',
      '09.24.21 catetere maschile esterno per urina',
      '09.27 raccoglitori di urina',
      "09.30 ausili assorbenti l'urina (ed altre deiezioni)",
      '09.30.12 ausili assorbenti per bambini',
      '09.30.18 ausili assorbenti per adulti',
      '09.30.21 ausili assorbenti da indossare',
      '09.30.24 biancheria monouso protettiva per adulti',
      '09.30.39 sistema di fissaggio per pannolini ed assorbenti',
      '09.30.42 ausili assorbenti monuso non indossabili',
      '09.31.06 ausili per incontinenza fecale',
    ]);
    const count = (group: string) => read2.records.filter((r) => r.group === group).length;
    expect(count('04.49 prodotti per il trattamento delle lesioni cutanee')).toBe(19);
    expect(count('09.24.06 cateteri vescicali a intermittenza')).toBe(8);
  });

  it('le modifiche dell’allegato M del DM 3/8/2026: refusi (M1) e denominazioni (M2)', () => {
    expect(item('09.15.03.021').description).toBe('adesivi stomali per laringectomizzati');
    expect(item('09.15.03.024').description).toBe('filtri umidificatori per laringectomizzati');
    expect(item('09.15.03.003').group).toBe('09.15 ausili per tracheostomia/laringectomia');
    expect(item('09.24.21.003')).toMatchObject({
      description: 'guaina (catetere maschile esterno)',
      group: '09.24.21 catetere maschile esterno per urina',
    });
    const text = read2.records.map((r) => `${r.description} ${r.group}`).join('\n');
    expect(text).not.toMatch(/condom|guaina in materiale ipoallergenico|tracheostomia$/m);
  });

  it('le voci che dicono solo una misura hanno davanti la loro etichetta, senza note', () => {
    expect(item('04.49.03.103').description).toBe(
      'medicazioni in alginato (classe M040402 - Cnd): cm 15 x 15 (corrispondente ad una superficie attiva di 225 cm² +/- 10%)',
    );
    expect(item('09.27.04.003').description).toBe(
      "sacca di raccolta dell'urina, da gamba: monouso",
    );
    expect(item('09.30.39.003').description).toBe(
      'mutanda di fissaggio, elasticizzata, riutilizzabile, priva di lattice: extra-grande',
    );
    expect(item('09.30.18.048').description).toMatch(
      /^assorbente .*\(sagomato, .*\): misura grande$/,
    );
    // Le due serie dei 09.30.21 si distinguono anche nel nome, non solo nel codice.
    for (const c of ['003', '006', '009'])
      expect(item(`09.30.21.${c}`).description).not.toMatch(/più elevata capacità/);
    for (const c of ['012', '015', '018'])
      expect(item(`09.30.21.${c}`).description).toMatch(
        /\) \[…\] allo scopo di realizzare una più elevata capacità di assorbimento: taglia /,
      );
    const descriptions = read2.records.map((r) => String(r.description));
    expect(new Set(descriptions).size).toBe(87);
    // Niente note, righe o spazi doppi; l'esponente è «cm²», non «cm2» o «cm 2».
    for (const d of descriptions) expect(d).not.toMatch(/\bNOTA\b|\n|\s{2}|cm ?2 \+\/-/);
    expect(descriptions.filter((d) => d.includes('cm² +/- 10%'))).toHaveLength(14);
    // Il campo «Prodotto» della prescrizione ne tiene 500: la voce più lunga ne ha 401.
    expect(Math.max(...descriptions.map((d) => d.length))).toBe(401);
    expect(item('09.30.24.063').description).toMatch(/al momento del cambio\.$/);
  });

  it('il testo come stampato, compresi i refusi dell’allegato', () => {
    expect(item('09.30.42.003').group).toMatch(/monuso non indossabili$/);
    expect(item('09.30.24.063').description).toMatch(/morbido e ipoallegenico/);
    expect(item('09.30.04.060').description).toMatch(/con moderate perdita di urina\.$/);
    expect(item('09.18.05.006').description).toMatch(/in una cicatrice \+ sacca a fondo chiuso\)$/);
    expect(item('09.21.18.003')).toMatchObject({
      description: 'lubrificante per cateterismo',
      group: 'lubrificante per cateterismo',
    });
  });

  it('quantità e pagina restano nel CSV come stampate, ma non si importano', () => {
    expect(table2[0]).toEqual([
      'tipo',
      'codice',
      'descrizione',
      'gruppo',
      'allegato',
      'quantita',
      'pagina_pdf',
    ]);
    expect(cell('09.15.03.003', 'quantita')).toBe('4');
    expect(cell('09.15.03.021', 'quantita')).toBe('');
    expect(cell('09.18.05.003', 'quantita')).toBe('20 + 60');
    expect(cell('09.31.06.006', 'quantita')).toBe('2/anno');
    expect(cell('09.30.12.045', 'quantita')).toBe('120');
    expect(cell('09.31.06.009', 'pagina_pdf')).toBe('10');
    expect(Object.keys(item('09.15.03.003')).sort()).toEqual(
      ['annex', 'code', 'description', 'entryType', 'group'].sort(),
    );
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
