import { describe, expect, it } from 'vitest';
import {
  indexServices,
  loadServiceSearchData,
  materialOf,
  normalizeSearchText,
  parseServiceSearchData,
  searchServices,
  SERVICE_SEARCH_DATA,
  type SearchableService,
} from '../src';

/**
 * Ricerca delle prestazioni per parole chiave (D153). Le righe sono copiate parola per parola dal
 * catalogo regionale allegato alla D.D. 990/A1400B/2024 (BUR Piemonte n. 1 del 2/1/2025, PDF della
 * Regione letto il 18/11/2026): codice del catalogo, codice del nomenclatore, branca, descrizione,
 * pagina del PDF.
 */
const CATALOGO: [string, string, string, string, number][] = [
  ['8724.0', '87.24', 'Diagnostica Per Immagini', 'RADIOGRAFIA (RX) DEL RACHIDE LOMBO SACRALE', 19],
  ['88.93.4', '88.93.4', 'Diagnostica Per Immagini', 'RM DEL RACHIDE LOMBOSACRALE.', 30],
  [
    '88.93.9',
    '88.93.9',
    'Diagnostica Per Immagini',
    'RM DEL RACHIDE LOMBO-SACRALE SENZA E CON MDC',
    31,
  ],
  [
    '88381.0',
    '88.38.A',
    'Diagnostica Per Immagini',
    'TC DEL RACHIDE E DELLO SPECO VERTEBRALE CERVICALE.',
    22,
  ],
  [
    '90681.085',
    '90.68.1',
    'Laboratorio',
    'IGE SPECIFICHE ALLERGOLOGICHE: F13 ARACHIDE ARACHIS HYPOGEAE',
    55,
  ],
  [
    '8901.57',
    '89.01.G',
    'Ortopedia',
    'VISITA ORTOPEDICA RACHIDE/COLONNA VERTEBRALE DI CONTROLLO',
    136,
  ],
  ['90374.0', '90.37.4', 'Laboratorio', 'POTASSIO [S]', 47],
  ['90374.3', '90.37.4', 'Laboratorio', 'POTASSIO [(SG)ER]', 47],
  ['90271.0', '90.27.1', 'Laboratorio', 'GLUCOSIO [S]', 46],
  ['90271.1', '90.27.1', 'Laboratorio', 'GLUCOSIO [P]', 45],
  ['90271.2', '90.27.1', 'Laboratorio', 'GLUCOSIO [U]', 46],
  ['90271.3', '90.27.1', 'Laboratorio', 'GLUCOSIO [DU]', 45],
  ['90.28.1', '90.28.1', 'Laboratorio', 'HB - EMOGLOBINA GLICATA', 46],
  ['90435.0', '90.43.5', 'Laboratorio', 'URATO [S]', 50],
  ['90441.0', '90.44.1', 'Laboratorio', 'UREA [S]', 50],
  ['90.75.4', '90.75.4', 'Laboratorio', 'TEMPO DI PROTROMBINA (PT)', 66],
  ['90045.0', '90.04.5', 'Laboratorio', 'ALANINA AMINOTRANSFERASI (ALT) (GPT) [S]', 41],
  ['90.14.3', '90.14.3', 'Laboratorio', 'COLESTEROLO TOTALE', 42],
  ['90055.2', '90.05.5', 'Laboratorio', 'ALFA 1 FETOPROTEINA [ALB]', 41],
  ['90.94.1', '90.94.1', 'Laboratorio', 'ESAME COLTURALE DEL SANGUE [EMOCOLTURA]', 70],
  ['G9.01', 'G9.01', 'Laboratorio', 'CONSULENZA GENETICA ASSOCIATA AL TEST', 117],
  ['90.28.7', '90.28.7', 'Laboratorio', 'IMMUNOGLOBULINE: CATENE K E LAMBDA LIBERE', 46],
  [
    '39.99.1A',
    '39.99.3',
    'Diagnostica Per Immagini',
    'DISOSTRUZIONE DI CATETERE VENOSO CENTRALE O DI DOPPIO CATETERE GIUGULARE O FEMORALE. INCLUSO: SOSTITUZIONE KIT INNESTO',
    17,
  ],
];

const DATA = loadServiceSearchData(SERVICE_SEARCH_DATA);
const items: SearchableService[] = CATALOGO.map(
  ([regionalCode, nationalCode, branch, description]) => ({
    regionalCode,
    nationalCode,
    branch,
    description,
  }),
);
const index = indexServices(items, DATA);
const codes = (query: string) => searchServices(index, query, 50).map((h) => h.item.regionalCode);

describe('ricerca delle prestazioni per parole chiave (D153)', () => {
  it('una parola trova tutte le prestazioni che la contengono, non le parole che la contengono dentro', () => {
    expect(codes('rachide').sort()).toEqual(['8724.0', '88.93.4', '88.93.9', '88381.0', '8901.57']);
    // «ARACHIDE» contiene «rachide», ma non comincia così: non c'entra.
    expect(codes('rachide')).not.toContain('90681.085');
  });

  it('più parole, in qualunque ordine, anche abbreviate e senza accenti', () => {
    expect(codes('rx rachide')).toEqual(['8724.0']);
    expect(codes('rachide RX')).toEqual(['8724.0']);
    expect(codes('rad rach lomb')).toEqual(['8724.0']);
    expect(codes('visita ortopedica rachide')).toEqual(['8901.57']);
  });

  it('parole attaccate o staccate: lombosacrale, lombo sacrale, lombo-sacrale', () => {
    const all = ['8724.0', '88.93.4', '88.93.9'];
    expect(codes('lombosacrale').sort()).toEqual(all);
    expect(codes('lombo sacrale').sort()).toEqual(all);
    expect(codes('lombo-sacrale').sort()).toEqual(all);
  });

  it('simboli chimici e nomi d’uso: K, potassiemia, glicemia, azotemia, uricemia, acido urico', () => {
    // «K» vale solo come parola intera: le catene K sì, «KIT» no; e il potassio viene prima.
    expect(codes('K').sort()).toEqual(['90.28.7', '90374.0', '90374.3']);
    expect(codes('K').slice(0, 2).sort()).toEqual(['90374.0', '90374.3']);
    expect(codes('potassiemia').sort()).toEqual(['90374.0', '90374.3']);
    expect(codes('glicemia').sort()).toEqual(['90271.0', '90271.1', '90271.2', '90271.3']);
    expect(codes('azotemia')).toEqual(['90441.0']);
    expect(codes('uricemia')).toEqual(['90435.0']);
    expect(codes('acido urico')).toEqual(['90435.0']);
  });

  it('i nomi in «-emia» trovano l’analita anche senza sinonimi: colesterolemia', () => {
    expect(codes('colesterolemia')).toEqual(['90.14.3']);
  });

  it('sigle d’uso che il catalogo non scrive: HbA1c, emoglobina glicosilata, INR, transaminasi', () => {
    // TAC e RMN: nel catalogo «TC» e «RM».
    expect(codes('tac rachide')).toEqual(['88381.0']);
    expect(codes('rmn rachide').sort()).toEqual(['88.93.4', '88.93.9']);
    // «potassiemia» trova il potassio, non le «CATENE K».
    expect(codes('potassiemia')).not.toContain('90.28.7');
    expect(codes('HbA1c')).toEqual(['90.28.1']);
    expect(codes('emoglobina glicosilata')).toEqual(['90.28.1']);
    expect(codes('INR')).toEqual(['90.75.4']);
    expect(codes('transaminasi')).toEqual(['90045.0']);
    // Le sigle che il catalogo scrive si trovano da sole.
    expect(codes('GPT')).toEqual(['90045.0']);
  });

  it('il materiale per esteso: si cerca e si vede', () => {
    expect(codes('glucosio urine').sort()).toEqual(['90271.2', '90271.3']);
    expect(codes('glucosio 24 ore')).toEqual(['90271.3']);
    expect(codes('potassio eritrociti')).toEqual(['90374.3']);
    expect(codes('glucosio plasma')).toEqual(['90271.1']);
    const hit = searchServices(index, 'glucosio', 10).find(
      (h) => h.item.regionalCode === '90271.3',
    );
    expect(hit?.material).toEqual({ sigla: 'DU', significato: 'urine 24 ore' });
  });

  it('per codice, del catalogo o del nomenclatore («codice DM»), con o senza punti', () => {
    expect(codes('90271').sort()).toEqual(['90271.0', '90271.1', '90271.2', '90271.3']);
    expect(codes('90.27.1').sort()).toEqual(['90271.0', '90271.1', '90271.2', '90271.3']);
    expect(codes('8724')).toEqual(['8724.0']);
    // Codice del nomenclatore diverso da quello del catalogo: si trova lo stesso.
    expect(codes('88.38.A')).toEqual(['88381.0']);
    expect(codes('8901G')).toEqual(['8901.57']);
    expect(codes('87.24')).toEqual(['8724.0']);
    // Codici che cominciano con una lettera.
    expect(codes('G9')).toEqual(['G9.01']);
  });

  it('le varianti dello stesso codice del nomenclatore restano vicine', () => {
    const found = searchServices(index, 'glucosio', 50).map((h) => h.item.nationalCode);
    const first = found.indexOf('90.27.1');
    expect(found.slice(first, first + 4)).toEqual(Array(4).fill('90.27.1'));
  });

  it('sigle sconosciute restano come sono: nessun significato inventato', () => {
    expect(materialOf('ALFA 1 FETOPROTEINA [ALB]', DATA)).toBeNull();
    expect(materialOf('ESAME COLTURALE DEL SANGUE [EMOCOLTURA]', DATA)).toBeNull();
    expect(materialOf('POTASSIO [(SG)ER]', DATA)).toEqual({
      sigla: '(SG)ER',
      significato: 'eritrociti (sangue)',
    });
  });

  it('prima la voce che comincia con la parola cercata, anche se un’altra è più corta', () => {
    // Una riga inventata per la prova, più corta di «GLUCOSIO [S]», con la parola in fondo.
    const extra = indexServices(
      [
        ...items,
        { regionalCode: 'PROVA.1', nationalCode: null, branch: null, description: 'AL GLUCOSIO' },
      ],
      DATA,
    );
    const first = searchServices(extra, 'glucosio', 10)[0]!.item.nationalCode;
    expect(first).toBe('90.27.1');
  });

  it('una domanda vuota non trova niente', () => {
    expect(codes('')).toEqual([]);
    expect(codes(' - ')).toEqual([]);
  });
});

describe('dati della ricerca', () => {
  it('ogni sigla e ogni termine hanno la fonte; i termini sono scritti come si cercano', () => {
    for (const m of DATA.materiali) expect(m.fonte.length, m.sigla).toBeGreaterThan(0);
    for (const g of DATA.sinonimi) {
      expect(g.fonte.length).toBeGreaterThan(0);
      for (const t of [...g.termini, ...g.sigle]) expect(normalizeSearchText(t)).toBe(t);
    }
  });

  it('dati sbagliati non entrano: termine scritto male, termine in due gruppi, sigla ripetuta', () => {
    const base = { versione: '1', nota: 'prova', materiali: [], sinonimi: [] };
    const group = (termini: string[]) => ({ termini, sigle: [], nelCatalogo: 'X', fonte: 'prova' });
    expect(() => parseServiceSearchData({ ...base, sinonimi: [group(['K', 'potassio'])] })).toThrow(
      /va scritto come «k»/,
    );
    expect(() =>
      parseServiceSearchData({
        ...base,
        sinonimi: [group(['k', 'potassio']), group(['k', 'kappa'])],
      }),
    ).toThrow(/in due gruppi/);
    const material = { sigla: 'S', significato: 'siero', fonte: 'prova' };
    expect(() => parseServiceSearchData({ ...base, materiali: [material, material] })).toThrow(
      /ripetuta/,
    );
  });
});
