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
  TRANSCRIPTION_DIRS,
} from '../src';

/**
 * Il catalogo regionale che il programma porta con sé (D159): l'allegato A della D.D. 590/2026,
 * in vigore per le ricette dal 21/09/2026, e la D.D. 710/2026 come modifiche. Le pagine sono
 * quelle dei PDF mandati da Simone il 18/11/2026 (docs/provenienze.md); che cosa è cambiato
 * rispetto al PDF è in docs/catalogo-regionale.md.
 */
const mapping = mappingForTranscription(loadMappings(), 'prestazioni')!;
// Le cartelle delle trascrizioni, nazionale e dei pacchetti regionali (D292), hanno anche le
// diagnosi ICD-9-CM (D186) e gli allegati dei LEA: qui solo il catalogo regionale.
const scans = TRANSCRIPTION_DIRS.map((d) => findTranscriptions(d));
const all = { found: scans.flatMap((s) => s.found), invalid: scans.flatMap((s) => s.invalid) };
const found = all.found.filter((f) => f.path.startsWith('piemonte_catalogo/'));
const { invalid } = all;
const sheet = (name: string) => {
  const t = found.find((f) => f.path.endsWith(`${name}.json`));
  if (!t) throw new Error(`manca la scheda ${name}`);
  return t;
};
const table = (name: string) => readTable(readFileSync(sheet(name).csvPath), `${name}.csv`);

const CATALOGO = 'dd590-2026-allegato-a';
const DAL_30_OTTOBRE = 'dd710-2026-dal-2026-10-30';
const DAL_13_GENNAIO = 'dd710-2026-dal-2027-01-13';

const full = extractRecords(mapping, table(CATALOGO));
const october = parseChanges(mapping, table(DAL_30_OTTOBRE));
const january = parseChanges(mapping, table(DAL_13_GENNAIO));
const v30ott = applyChanges('prestazioni', full.records, october.changes);
const v13gen = applyChanges('prestazioni', v30ott.records, january.changes);

const find = (records: DataRecord[], code: string, branch?: string) =>
  records.filter((r) => r.regionalCode === code && (!branch || r.branch === branch));
const keys = (records: DataRecord[]) => records.map((r) => `${r.regionalCode} · ${r.branch}`);

describe('catalogo regionale in vigore (D159)', () => {
  it('tre schede valide della stessa serie, con la data di ogni atto', () => {
    expect(invalid).toEqual([]);
    expect(
      found.map((f) => [f.path, f.sheet.serie, f.sheet.in_vigore_dal, f.sheet.solo_modifiche]),
    ).toEqual([
      [`piemonte_catalogo/${CATALOGO}.json`, 'catalogo-piemonte', '2026-09-21', false],
      [`piemonte_catalogo/${DAL_30_OTTOBRE}.json`, 'catalogo-piemonte', '2026-10-30', true],
      [`piemonte_catalogo/${DAL_13_GENNAIO}.json`, 'catalogo-piemonte', '2027-01-13', true],
    ]);
    expect(sheet(CATALOGO).sheet.atto).toMatch(/^D\.D\. 20 settembre 2026, n\. 590\/A1400B\/2026/);
    expect(sheet(DAL_30_OTTOBRE).sheet.atto).toMatch(/^D\.D\. 30 ottobre 2026, n\. 710\/A1400B/);
  });

  it('allegato A della D.D. 590: 5107 voci prescrivibili, 26 branche, nessuna riga scartata', () => {
    expect(full.missingColumns).toEqual([]);
    expect(full.problems).toEqual([]);
    expect(full.records).toHaveLength(5107);
    expect(new Set(full.records.map((r) => r.branch)).size).toBe(26);
    // Codice e branca identificano una voce: gli atti che modificano il catalogo li usano (D157).
    expect(new Set(keys(full.records)).size).toBe(5107);
    // Pagina 1 dell'allegato A.
    expect(find(full.records, '03.91.1')).toEqual([
      {
        regionalCode: '03.91.1',
        nationalCode: '03.91.1',
        description:
          'INIEZIONE DI SOSTANZE TERAPEUTICHE ANALGESICHE NEL CANALE VERTEBRALE CON POSIZ. DI CATETERE PERIDURALE. INCLUSO FARMACO',
        branch: 'Anestesia/Analgesia',
        fee: 157.95,
        notes:
          'PRECISAZIONE: [catetere temporaneo, con pompa infusore, con tunnel sottocutaneo] fino ad un massimo di 10 rifornimenti. ESCLUSO: iniezione di farmaco citotossico nel canale vertebrale (03.8), anestesia effettuata per intervento.',
        cycle: null,
        sessions: null,
      },
    ]);
  });

  it('ciclo e numero di sedute (D276): 52 voci a ciclo, tutte con le sedute', () => {
    const cycles = full.records.filter((r) => r.cycle === true);
    expect(cycles).toHaveLength(52);
    expect(cycles.every((r) => typeof r.sessions === 'number' && r.sessions > 0)).toBe(true);
    // Le sedute solo sulle voci a ciclo, e «no» non si scrive: la colonna stampa solo «S».
    expect(full.records.filter((r) => r.cycle !== true && r.sessions !== null)).toEqual([]);
    expect(full.records.filter((r) => r.cycle === false)).toEqual([]);
    // «Ciclo fino a 4 sedute» nel nomenclatore (allegato 4 del DPCM LEA), in due branche.
    expect(find(full.records, '93.15').map((r) => [r.branch, r.cycle, r.sessions])).toEqual([
      ['Medicina Fisica E Riabilitazione', true, 4],
      ['Ortopedia', true, 4],
    ]);
    expect(find(full.records, '93.11.8')[0]).toMatchObject({ cycle: true, sessions: 10 });
  });

  it('che cosa è cambiato rispetto al PDF, nei casi del documento di controllo', () => {
    // Le voci non prescrivibili restano fuori (pagina 166: test reflex del TSH).
    expect(find(full.records, '90418.1')).toEqual([]);
    expect(find(full.records, '90418.2')).toEqual([]);
    // Una riga ripetuta identica nell'atto (pagina 83, anche nella D.D. 990/2024) c'è una volta.
    expect(find(full.records, 'G101.P018')).toHaveLength(1);
    // Cella tagliata nel PDF (pagina 148: «VISITA ORTOPEDICA MANO DI»), completata con il testo
    // della stessa voce nella D.D. 990/2024.
    expect(find(full.records, '8901.55')[0]!.description).toBe(
      'VISITA ORTOPEDICA MANO DI CONTROLLO',
    );
    // Parola a capo dopo il trattino (pagina 2): senza spazio, come dentro le righe.
    expect(find(full.records, '89.48.1')[0]!.description).toBe(
      'CONTROLLO E PROGRAMMAZIONE PACE-MAKER',
    );
    // Con lo spazio dove le altre voci della stessa famiglia lo hanno (pagina 44).
    expect(find(full.records, '9017C.16')[0]!.description).toBe(
      'FARMACI CON TECNICHE NON CROMATOGRAFICHE- IMMUNOSOPPRESSORI CICLOSPORINA',
    );
  });

  it('D.D. 710 dal 30/10/2026: 27 voci tolte (allegato A), 69 aggiunte (allegato C)', () => {
    expect(october.problems).toEqual([]);
    expect(october.changes.removals).toHaveLength(27);
    expect(october.changes.additions).toHaveLength(69);
    expect(v30ott.problems).toEqual([]);
    expect(v30ott).toMatchObject({ removed: 27, added: 69, replaced: 0 });
    expect(v30ott.records).toHaveLength(5149);
    expect(new Set(keys(v30ott.records)).size).toBe(5149);
    // Lo stesso esame con un altro codice del catalogo (pp. 14 e 23 della D.D. 710).
    expect(find(v30ott.records, '45.30.1')).toEqual([]);
    expect(find(v30ott.records, '45.30.1A')[0]).toMatchObject({
      nationalCode: '45.30.1',
      branch: 'Gastroenterologia',
      fee: 220.1,
    });
    // La stessa voce con la tariffa nuova (pp. 13 e 21): 7,20 nella D.D. 590, 6,20 dal 30/10.
    expect(find(full.records, '90323.0')[0]!.fee).toBe(7.2);
    expect(find(v30ott.records, '90323.0')[0]!.fee).toBe(6.2);
    // Radioterapia: le voci nuove (p. 21) e le vecchie (allegato B) insieme fino al 12/01/2027.
    expect(find(v30ott.records, '92.2A.1')[0]).toMatchObject({
      branch: 'Radioterapia',
      fee: 614.55,
    });
    expect(find(v30ott.records, '92241.0')).toHaveLength(1);
  });

  it('D.D. 710 dal 13/01/2027: tolte le 56 voci di radioterapia dell’allegato B', () => {
    expect(january.problems).toEqual([]);
    expect(january.changes.additions).toEqual([]);
    expect(v13gen.problems).toEqual([]);
    expect(v13gen.removed).toBe(56);
    expect(v13gen.records).toHaveLength(5093);
    expect(find(v13gen.records, '92241.0')).toEqual([]);
    expect(find(v13gen.records, '92.2A.1')).toHaveLength(1);
  });
});
