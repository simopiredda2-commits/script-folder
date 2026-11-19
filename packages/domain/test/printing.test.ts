import { describe, expect, it } from 'vitest';
import {
  EMPTY_PRINT_SETTING,
  PAPER_SIZES,
  PRINT_DOCUMENT_KEYS,
  PRINT_DOCUMENT_KINDS,
  printDocumentKind,
  printHint,
  printSettingIssues,
  resolvePrintSettings,
  type PrintSettingInput,
  type PrintSettingValues,
} from '../src/printing';

/** Preferenze di stampa (tappa 14): tipi di documento, carta, copie, variante, ordine dei livelli. */
const values = (over: Partial<PrintSettingValues> = {}): PrintSettingValues => ({
  ...EMPTY_PRINT_SETTING,
  ...over,
});
const input = (over: Partial<PrintSettingInput> = {}): PrintSettingInput => ({
  printer: null,
  paper: null,
  copies: null,
  reminderVariant: null,
  ...over,
});

describe('tipi di documento da stampare', () => {
  it('ognuno ha nome, descrizione e da dove viene il formato; le chiavi sono quelle dichiarate', () => {
    expect(PRINT_DOCUMENT_KINDS.map((k) => k.key)).toEqual([...PRINT_DOCUMENT_KEYS]);
    for (const k of PRINT_DOCUMENT_KINDS) {
      expect(k.label, k.key).not.toBe('');
      expect(k.description, k.key).not.toBe('');
      expect(k.paperBasis, k.key).not.toBe('');
      for (const p of k.paperChoices) expect(PAPER_SIZES).toContain(p);
      // Un formato fissato è quello di oggi; dove si sceglie, il predefinito è tra quelli ammessi.
      if (k.paperChoices.length && k.defaultPaper) expect(k.paperChoices).toContain(k.defaultPaper);
    }
  });

  it('la carta si sceglie solo dove nessun atto o documento esterno la fissa', () => {
    const choosable = PRINT_DOCUMENT_KINDS.filter((k) => k.paperChoices.length).map((k) => k.key);
    expect(choosable).toEqual(['certificato_modello', 'schema_orario']);
    // Promemoria, certificato INPS e Profilo: A4 come oggi; ricetta bianca: il PDF del Sistema TS.
    expect(printDocumentKind('promemoria').defaultPaper).toBe('A4');
    expect(printDocumentKind('certificato_inps').defaultPaper).toBe('A4');
    expect(printDocumentKind('profilo_sanitario').defaultPaper).toBe('A4');
    expect(printDocumentKind('promemoria_bianca').defaultPaper).toBeNull();
  });

  it('solo il promemoria della ricetta SSN ha la variante (completo o solo NRE)', () => {
    expect(PRINT_DOCUMENT_KINDS.filter((k) => k.reminderVariant).map((k) => k.key)).toEqual([
      'promemoria',
    ]);
  });
});

describe('ordine delle preferenze: postazione, poi studio, poi predefinite', () => {
  it('senza preferenze valgono le predefinite', () => {
    const e = resolvePrintSettings('promemoria', {});
    expect(e).toMatchObject({
      printer: null,
      paper: 'A4',
      copies: 1,
      reminderVariant: 'completo',
    });
    expect(Object.values(e.from).every((f) => f === 'predefinito')).toBe(true);
  });

  it('campo per campo: la postazione vince sullo studio, lo studio sulle predefinite', () => {
    const e = resolvePrintSettings('certificato_modello', {
      workstation: values({ printer: 'Stampante dell’ambulatorio', copies: null }),
      studio: values({ printer: 'Stampante della segreteria', copies: 2, paper: 'A5' }),
    });
    expect(e).toMatchObject({ printer: 'Stampante dell’ambulatorio', copies: 2, paper: 'A5' });
    expect(e.from).toEqual({
      printer: 'postazione',
      copies: 'studio',
      paper: 'studio',
      reminderVariant: 'predefinito',
    });
    const own = resolvePrintSettings('certificato_modello', {
      workstation: values({ copies: 3, paper: 'A4' }),
      studio: values({ copies: 2, paper: 'A5' }),
    });
    expect(own).toMatchObject({ copies: 3, paper: 'A4', printer: null });
    expect(own.from.printer).toBe('predefinito');
  });

  it('la variante del promemoria segue lo stesso ordine', () => {
    expect(
      resolvePrintSettings('promemoria', {
        workstation: values({ reminderVariant: 'solo_nre' }),
        studio: values({ reminderVariant: 'completo' }),
      }).reminderVariant,
    ).toBe('solo_nre');
    expect(
      resolvePrintSettings('promemoria', { studio: values({ reminderVariant: 'solo_nre' }) }).from
        .reminderVariant,
    ).toBe('studio');
  });

  it('un valore che il documento non ammette non vale, da qualunque livello venga', () => {
    // Carta su un formato fissato, variante fuori dal promemoria, copie fuori dai limiti.
    const inps = resolvePrintSettings('certificato_inps', {
      workstation: values({ paper: 'A5', reminderVariant: 'solo_nre', copies: 9 }),
      studio: values({ copies: 2 }),
    });
    expect(inps).toMatchObject({ paper: 'A4', reminderVariant: null, copies: 2 });
    expect(inps.from.paper).toBe('predefinito');
    expect(resolvePrintSettings('promemoria_bianca', {}).paper).toBeNull();
    // Schema orario: senza preferenza la carta la propone la finestra di stampa.
    expect(resolvePrintSettings('schema_orario', {}).paper).toBeNull();
    expect(resolvePrintSettings('schema_orario', { studio: values({ paper: 'A5' }) }).paper).toBe(
      'A5',
    );
  });

  it('una stampante fatta di soli spazi non conta: vale quella del livello sotto', () => {
    const e = resolvePrintSettings('promemoria', {
      workstation: values({ printer: '   ' }),
      studio: values({ printer: 'Stampante della segreteria' }),
    });
    expect(e.printer).toBe('Stampante della segreteria');
    expect(e.from.printer).toBe('studio');
  });
});

describe('controlli prima di salvare', () => {
  it('carta solo dove è ammessa, e solo tra i formati ammessi', () => {
    expect(printSettingIssues('certificato_modello', input({ paper: 'A5' }))).toEqual([]);
    expect(printSettingIssues('schema_orario', input({ paper: 'A4' }))).toEqual([]);
    expect(printSettingIssues('certificato_modello', input({ paper: 'A3' }))).toEqual([
      'Carta: per «Certificati dai modelli» A4 o A5',
    ]);
    for (const k of ['promemoria', 'certificato_inps', 'profilo_sanitario'] as const)
      expect(printSettingIssues(k, input({ paper: 'A5' }))[0], k).toMatch(
        /il formato è fissato \(A4\), non si sceglie/,
      );
    expect(printSettingIssues('promemoria_bianca', input({ paper: 'A4' }))[0]).toMatch(
      /fissato \(quello del documento\)/,
    );
  });

  it('variante solo per il promemoria della ricetta SSN', () => {
    expect(printSettingIssues('promemoria', input({ reminderVariant: 'solo_nre' }))).toEqual([]);
    expect(printSettingIssues('promemoria', input({ reminderVariant: 'mezzo' }))).toEqual([
      'Variante del promemoria: completo oppure solo NRE',
    ]);
    for (const k of PRINT_DOCUMENT_KEYS.filter((x) => x !== 'promemoria'))
      expect(printSettingIssues(k, input({ reminderVariant: 'completo' })), k).toEqual([
        'Variante: solo per il promemoria della ricetta SSN (completo o solo NRE)',
      ]);
  });

  it('copie da 1 a 5, intere; stampante su una riga, fino a 100 caratteri', () => {
    for (const n of [1, 5])
      expect(printSettingIssues('promemoria', input({ copies: n }))).toEqual([]);
    for (const n of [0, 6, 2.5, -1, Number.NaN])
      expect(printSettingIssues('promemoria', input({ copies: n })), String(n)).toEqual([
        'Copie: un numero intero da 1 a 5',
      ]);
    expect(printSettingIssues('promemoria', input({ printer: 'x'.repeat(100) }))).toEqual([]);
    expect(printSettingIssues('promemoria', input({ printer: 'x'.repeat(101) }))).toEqual([
      'Stampante: al massimo 100 caratteri',
    ]);
    expect(printSettingIssues('promemoria', input({ printer: 'Una\nriga' }))).toEqual([
      'Stampante: una riga sola, senza caratteri di controllo',
    ]);
  });

  it('i problemi si dicono tutti insieme', () => {
    expect(
      printSettingIssues(
        'certificato_inps',
        input({ paper: 'A5', copies: 7, reminderVariant: 'solo_nre' }),
      ),
    ).toHaveLength(3);
  });
});

describe('suggerimento accanto ai pulsanti di stampa', () => {
  it('nessun suggerimento se nessuno ha impostato nulla', () => {
    expect(printHint(resolvePrintSettings('certificato_modello', {}))).toBeNull();
  });

  it('stampante, copie e carta, come nella finestra di stampa', () => {
    expect(
      printHint(
        resolvePrintSettings('certificato_modello', {
          workstation: values({ printer: 'Stampante dell’ambulatorio', paper: 'A5' }),
          studio: values({ copies: 2 }),
        }),
      ),
    ).toBe('Stampante consigliata: Stampante dell’ambulatorio, 2 copie, carta A5');
    expect(
      printHint(
        resolvePrintSettings('promemoria', { studio: values({ reminderVariant: 'solo_nre' }) }),
      ),
    ).toBe(
      'Stampante: quella proposta dalla finestra di stampa, 1 copia, carta A4, solo NRE e codice fiscale',
    );
  });
});
