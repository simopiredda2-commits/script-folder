import { describe, expect, it } from 'vitest';
import {
  applyChanges,
  type ChangeSet,
  type DataRecord,
  loadMappings,
  mappingForTranscription,
  parseChanges,
} from '../src';

/**
 * Atti che modificano il catalogo (D157). Righe copiate parola per parola dalla D.D. 30 ottobre
 * 2026, n. 710/A1400B/2026 (BUR Piemonte n. 44 del 5/11/2026; PDF mandato da Simone il
 * 18/11/2026, SHA-256 addd8684…a3d3954, docs/provenienze.md): l'allegato A elenca le voci
 * prescrivibili fino al 29/10/2026, l'allegato C quelle dal 30/10/2026. Codice del catalogo,
 * codice del nomenclatore, descrizione del catalogo, branca, tariffa, pagina del PDF.
 */
const voce = (
  regionalCode: string,
  nationalCode: string,
  description: string,
  branch: string,
  fee: number | null,
): DataRecord => ({ regionalCode, nationalCode, description, branch, fee, notes: null });

// Allegato A (fino al 29/10/2026), pp. 12–14.
const POLIPECTOMIA_DUODENO_A = voce(
  '45.30.1',
  '45.30.1',
  'ASPORTAZIONE O DEMOLIZIONE DI LESIONE DEL DUODENO IN CORSO DI EGDS POLIPECTOMIA E/O MUCOSECTOMIA.',
  'Gastroenterologia',
  220.1,
);
const POLIPECTOMIA_ESOFAGO_A = voce(
  '42.33.1',
  '42.33.1',
  'ASPORTAZIONE O DEMOLIZIONE DI LESIONE O TESSUTO ESOFAGEO IN CORSO DI EGDS: POLIPECTOMIA ESOFAGEA E/O MUCOSECTOMIA.',
  'Gastroenterologia',
  194.4,
);
const LH_A = voce('90323.0', '90.32.3', 'LUTEOTROPINA (LH) [S]', 'Laboratorio', 7.2);
const ECODOPPLER = (branch: string) =>
  voce('88.74.A', '88.74.A', 'ECOCOLORDOPPLER VASI SPLANCNICI', branch, 48.5);
// Una voce che l'atto non tocca: D.D. 990/A1400B/2024, p. 46 (tariffa non riportata qui).
const GLUCOSIO = voce('90271.0', '90.27.1', 'GLUCOSIO [S]', 'Laboratorio', null);

const BASE = [
  POLIPECTOMIA_DUODENO_A,
  POLIPECTOMIA_ESOFAGO_A,
  LH_A,
  ECODOPPLER('Chirurgia Vascolare'),
  ECODOPPLER('Diagnostica Per Immagini'),
  ECODOPPLER('Gastroenterologia'),
  GLUCOSIO,
];

// Allegato C (dal 30/10/2026), pp. 21 e 23.
const POLIPECTOMIA_DUODENO_C = voce(
  '45.30.1A',
  '45.30.1',
  'ASPORTAZIONE O DEMOLIZIONE DI LESIONE DEL DUODENO IN CORSO DI EGDS POLIPECTOMIA',
  'Gastroenterologia',
  220.1,
);
const POLIPECTOMIA_ESOFAGO_C = voce(
  '42.33.1A',
  '42.33.1',
  'ASPORTAZIONE O DEMOLIZIONE DI LESIONE O TESSUTO ESOFAGEO IN CORSO DI EGDS: POLIPECTOMIA ESOFAGEA',
  'Gastroenterologia',
  194.4,
);
const LH_C = voce('90323.0', '90.32.3', 'LUTEOTROPINA (LH) [S]', 'Laboratorio', 6.2);

const DD710: ChangeSet = {
  removals: [
    // Nel PDF la branca va a capo dentro la cella: «Gastroentero logia».
    { line: 2, key: { regionalCode: '45.30.1', branch: 'Gastroentero logia' } },
    { line: 3, key: { regionalCode: '42.33.1', branch: 'Gastroentero logia' } },
    { line: 4, key: { regionalCode: '90323.0', branch: 'Laboratorio' } },
    // Senza branca: tutte le righe del codice (l'allegato A le elenca tutte e tre).
    { line: 5, key: { regionalCode: '88.74.A', branch: '' } },
  ],
  additions: [
    { line: 6, record: POLIPECTOMIA_DUODENO_C },
    { line: 7, record: POLIPECTOMIA_ESOFAGO_C },
    { line: 8, record: LH_C },
  ],
};

const codes = (records: DataRecord[]) => records.map((r) => r.regionalCode).sort();

describe('atti che modificano il catalogo (D157)', () => {
  it('D.D. 710/2026: i codici che cambiano spariscono dal 30/10, al loro posto quelli nuovi', () => {
    const out = applyChanges('prestazioni', BASE, DD710);
    expect(out.problems).toEqual([]);
    expect(codes(out.records)).toEqual(['42.33.1A', '45.30.1A', '90271.0', '90323.0']);
    expect(out).toMatchObject({ removed: 6, added: 3, replaced: 0 });
    // Lo stesso codice del catalogo, con la tariffa nuova.
    expect(out.records.find((r) => r.regionalCode === '90323.0')!.fee).toBe(6.2);
    // Il codice del nomenclatore resta: è il codice del catalogo che cambia.
    expect(out.records.find((r) => r.regionalCode === '45.30.1A')!.nationalCode).toBe('45.30.1');
    // La base non cambia: la versione precedente resta com'era.
    expect(codes(BASE)).toContain('45.30.1');
  });

  it('una voce aggiunta con un codice che c’è già la sostituisce', () => {
    // Riga inventata per la prova: la stessa voce con una tariffa.
    const out = applyChanges('prestazioni', BASE, {
      removals: [],
      additions: [{ line: 2, record: { ...GLUCOSIO, fee: 1.5 } }],
    });
    expect(out).toMatchObject({ added: 0, replaced: 1, removed: 0 });
    expect(out.records).toHaveLength(BASE.length);
    expect(out.records.find((r) => r.regionalCode === '90271.0')!.fee).toBe(1.5);
  });

  it('togliere una voce che la base non ha è un problema: la base non è quella dell’atto', () => {
    const out = applyChanges('prestazioni', BASE, {
      removals: [{ line: 9, key: { regionalCode: '90324.1', branch: 'Laboratorio' } }],
      additions: [],
    });
    expect(out.problems).toEqual([
      expect.objectContaining({
        line: 9,
        problem: expect.stringMatching(/toglie 90324\.1 · Laboratorio: la voce non c'è/),
      }),
    ]);
  });

  it('la branca conta, quando è scritta', () => {
    const out = applyChanges('prestazioni', BASE, {
      removals: [{ line: 2, key: { regionalCode: '88.74.A', branch: 'Chirurgia Vascolare' } }],
      additions: [],
    });
    expect(out.removed).toBe(1);
    expect(out.records.filter((r) => r.regionalCode === '88.74.A')).toHaveLength(2);
  });
});

describe('lettura del CSV «solo modifiche»', () => {
  const mapping = mappingForTranscription(loadMappings(), 'prestazioni')!;
  const HEADER = [
    'operazione',
    'codice_regionale',
    'codice_nomenclatore',
    'descrizione',
    'branca',
    'tariffa',
    'note',
    'ciclo',
    'sedute',
  ];

  it('toglie e aggiunge, con le righe del file', () => {
    const out = parseChanges(mapping, [
      HEADER,
      ['toglie', '45.30.1', '', '', 'Gastroenterologia', '', '', '', ''],
      [
        'aggiunge',
        '45.30.1A',
        '45.30.1',
        'ASPORTAZIONE O DEMOLIZIONE DI LESIONE DEL DUODENO IN CORSO DI EGDS POLIPECTOMIA',
        'Gastroenterologia',
        '220,10',
        '',
        '',
        '',
      ],
    ]);
    expect(out.problems).toEqual([]);
    expect(out.changes.removals).toEqual([
      { line: 2, key: { regionalCode: '45.30.1', branch: 'Gastroenterologia' } },
    ]);
    expect(out.changes.additions[0]).toMatchObject({
      line: 3,
      record: { regionalCode: '45.30.1A', nationalCode: '45.30.1', fee: 220.1 },
    });
  });

  it('operazione sconosciuta, codice mancante, campo obbligatorio vuoto: problemi con la riga', () => {
    const out = parseChanges(mapping, [
      HEADER,
      ['cambia', '45.30.1', '', '', '', '', '', '', ''],
      ['toglie', '', '', '', 'Gastroenterologia', '', '', '', ''],
      ['aggiunge', '45.30.1A', '45.30.1', '', 'Gastroenterologia', '', '', '', ''],
    ]);
    expect(out.problems.map((p) => [p.line, p.field])).toEqual([
      [2, 'operazione'],
      [3, 'regionalCode'],
      [4, 'description'],
    ]);
    expect(out.changes.additions).toEqual([]);
  });

  it('senza la colonna dell’operazione il file non si legge', () => {
    const out = parseChanges(mapping, [HEADER.slice(1)]);
    expect(out.missingColumns).toEqual(['operazione']);
  });
});
