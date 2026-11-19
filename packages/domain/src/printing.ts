/**
 * Preferenze di stampa (tappa 14): i documenti che il programma stampa, la carta di ciascuno, le
 * copie, la variante del promemoria e l'ordine in cui valgono: prima la postazione, poi lo studio,
 * poi le predefinite.
 *
 * Che cosa può fare un programma usato dal browser: preparare PDF con misure esatte e ricordare,
 * per postazione e per tipo di documento, la stampante preferita, le copie, la carta (dove il
 * formato non è fissato) e la variante del promemoria. Non può elencare le stampanti del computer,
 * sceglierne una o stampare senza la finestra di stampa: la stampante si sceglie lì, e il
 * programma la suggerisce accanto ai pulsanti di stampa.
 */

/** Formati della carta che il programma sa impaginare. */
export const PAPER_SIZES = ['A4', 'A5'] as const;
export type PaperSize = (typeof PAPER_SIZES)[number];

/** Misure in millimetri, in verticale (ISO 216). */
export const PAPER_SIZE_MM: Record<PaperSize, { width: number; height: number }> = {
  A4: { width: 210, height: 297 },
  A5: { width: 148, height: 210 },
};

export const PAPER_SIZE_LABELS: Record<PaperSize, string> = {
  A4: 'A4 (210 × 297 mm)',
  A5: 'A5 (148 × 210 mm)',
};

/**
 * Che cosa si stampa del promemoria della ricetta SSN (requisiti, «Consegna al paziente»:
 * «promemoria completo, solo NRE, oppure su una stampante scelta»).
 */
export const REMINDER_VARIANTS = ['completo', 'solo_nre'] as const;
export type ReminderVariant = (typeof REMINDER_VARIANTS)[number];

export const REMINDER_VARIANT_LABELS: Record<ReminderVariant, string> = {
  completo: 'Promemoria completo',
  solo_nre: 'Solo NRE e codice fiscale',
};

export const PRINT_DOCUMENT_KEYS = [
  'promemoria',
  'promemoria_bianca',
  'certificato_inps',
  'certificato_modello',
  'schema_orario',
  'profilo_sanitario',
] as const;
export type PrintDocumentKey = (typeof PRINT_DOCUMENT_KEYS)[number];

export interface PrintDocumentKind {
  key: PrintDocumentKey;
  /** Nome nell'interfaccia. */
  label: string;
  /** Che cosa è, detto in breve. */
  description: string;
  /** PDF preparato dal servizio, oppure pagina stampata dal browser. */
  output: 'pdf' | 'pagina';
  /** Formati che si possono scegliere: vuoto se il formato è fissato. */
  paperChoices: readonly PaperSize[];
  /**
   * Il formato di oggi: quello fissato, oppure quello che vale senza preferenza. Null quando non
   * lo decide il programma (il PDF del Sistema TS, la finestra di stampa del browser).
   */
  defaultPaper: PaperSize | null;
  /** Da dove viene il formato, detto in chiaro: l'atto, il programma, o «come oggi». */
  paperBasis: string;
  /** Solo il promemoria della ricetta SSN: completo o solo NRE. */
  reminderVariant: boolean;
}

/**
 * I documenti che il programma stampa, con il formato che hanno oggi nel codice. Nessun formato è
 * ricostruito a memoria: dove un atto non è stato letto per la carta, il formato resta quello di
 * oggi e lo si dice.
 */
export const PRINT_DOCUMENT_KINDS: readonly PrintDocumentKind[] = [
  {
    key: 'promemoria',
    label: 'Promemoria della ricetta SSN',
    description:
      'Dal modello del DM 2 novembre 2011: completo, oppure con il solo numero di ricetta (NRE) e il codice fiscale.',
    output: 'pdf',
    paperChoices: [],
    defaultPaper: 'A4',
    paperBasis:
      'A4, come oggi. Il contenuto segue il modello del DM 2/11/2011 (allegato 2); posizioni e formato della pagina sono nelle «Specifiche tecniche per la stampa del promemoria» (1/3/2016), non trovate sul portale (D97): da verificare.',
    reminderVariant: true,
  },
  {
    key: 'promemoria_bianca',
    label: 'Promemoria della ricetta bianca elettronica',
    description:
      'Il PDF prodotto dal Sistema TS, consegnato così com’è: per il disciplinare è l’unico promemoria ammesso (D93).',
    output: 'pdf',
    paperChoices: [],
    defaultPaper: null,
    paperBasis: 'Quella del PDF del Sistema TS: il programma non lo cambia (D93).',
    reminderVariant: false,
  },
  {
    key: 'certificato_inps',
    label: 'Certificato di malattia INPS',
    description:
      'Copia per il lavoratore e attestato per il datore di lavoro, dai fac-simile del DM 26 febbraio 2010 (allegati A e B).',
    output: 'pdf',
    paperChoices: [],
    defaultPaper: 'A4',
    paperBasis:
      'A4, come oggi, sui fac-simile del DM 26/2/2010 (disciplinare tecnico, 6): il formato non si sceglie.',
    reminderVariant: false,
  },
  {
    key: 'certificato_modello',
    label: 'Certificati dai modelli',
    description:
      'Sportivo non agonistico, porto d’armi, anamnestico per la patente e i modelli dello studio, con l’impaginazione del medico (D145).',
    output: 'pdf',
    paperChoices: ['A4', 'A5'],
    defaultPaper: 'A4',
    paperBasis:
      'Gli atti trascritti danno il testo del modello, non il formato della carta: A4 (come oggi) oppure A5. Il testo non cambia, cambiano solo le pagine.',
    reminderVariant: false,
  },
  {
    key: 'schema_orario',
    label: 'Schema orario della terapia',
    description:
      'Il foglio per il paziente con che cosa prendere, quando e fino a quando, stampato dal browser (D83).',
    output: 'pagina',
    paperChoices: ['A4', 'A5'],
    defaultPaper: null,
    paperBasis:
      'Non è un modulo ufficiale (D83): A4 o A5, da scegliere nella finestra di stampa; senza preferenza, quella proposta dalla finestra.',
    reminderVariant: false,
  },
  {
    key: 'profilo_sanitario',
    label: 'Profilo sanitario sintetico',
    description:
      'Il PDF firmato, lo stesso pubblicato nel Fascicolo, con il documento CDA2 allegato.',
    output: 'pdf',
    paperChoices: [],
    defaultPaper: 'A4',
    paperBasis:
      'A4, come oggi: è il documento firmato e pubblicato nel Fascicolo, che non si rifà per la stampa.',
    reminderVariant: false,
  },
];

/** Copie senza preferenza: una, come propone la finestra di stampa. */
export const DEFAULT_PRINT_COPIES = 1;

/** Variante del promemoria senza preferenza: il completo, che il pannello propone oggi per primo. */
export const DEFAULT_REMINDER_VARIANT: ReminderVariant = 'completo';

/**
 * Limiti di buon senso contro gli errori di battitura, non da una norma: fino a 5 copie, il nome
 * della stampante fino a 100 caratteri.
 */
export const PRINT_SETTING_LIMITS = {
  copies: { min: 1, max: 5 },
  printerName: 100,
} as const;

export const isPrintDocumentKey = (k: unknown): k is PrintDocumentKey =>
  typeof k === 'string' && (PRINT_DOCUMENT_KEYS as readonly string[]).includes(k);

export const isPaperSize = (p: unknown): p is PaperSize =>
  typeof p === 'string' && (PAPER_SIZES as readonly string[]).includes(p);

export const isReminderVariant = (v: unknown): v is ReminderVariant =>
  typeof v === 'string' && (REMINDER_VARIANTS as readonly string[]).includes(v);

export function printDocumentKind(key: PrintDocumentKey): PrintDocumentKind {
  const kind = PRINT_DOCUMENT_KINDS.find((k) => k.key === key);
  if (!kind) throw new Error(`Tipo di documento sconosciuto: ${key}`);
  return kind;
}

/* Preferenze e ordine in cui valgono ------------------------------------------------------- */

/** Da dove viene un valore: la postazione, lo studio, o il valore predefinito. */
export type PrintSettingSource = 'postazione' | 'studio' | 'predefinito';

export const PRINT_SETTING_SOURCE_LABELS: Record<PrintSettingSource, string> = {
  postazione: 'della postazione',
  studio: 'dello studio',
  predefinito: 'predefinita',
};

/** Le preferenze di un livello (studio o postazione): vuoto vuol dire «come il livello sotto». */
export interface PrintSettingValues {
  printer: string | null;
  paper: PaperSize | null;
  copies: number | null;
  reminderVariant: ReminderVariant | null;
}

export const EMPTY_PRINT_SETTING: PrintSettingValues = {
  printer: null,
  paper: null,
  copies: null,
  reminderVariant: null,
};

export interface EffectivePrintSettings {
  kind: PrintDocumentKey;
  /** Null: nessuna stampante consigliata, vale quella proposta dalla finestra di stampa. */
  printer: string | null;
  /** Null: la carta non la decide il programma (PDF del Sistema TS, finestra di stampa). */
  paper: PaperSize | null;
  copies: number;
  /** Solo per il promemoria della ricetta SSN; null per gli altri documenti. */
  reminderVariant: ReminderVariant | null;
  from: Record<'printer' | 'paper' | 'copies' | 'reminderVariant', PrintSettingSource>;
}

const validCopies = (n: number) =>
  Number.isInteger(n) &&
  n >= PRINT_SETTING_LIMITS.copies.min &&
  n <= PRINT_SETTING_LIMITS.copies.max;

/** A capo, tabulazione e gli altri caratteri di controllo (U+0000–U+001F, U+007F). */
const isControl = (c: string) => {
  const n = c.codePointAt(0)!;
  return n < 0x20 || n === 0x7f;
};

/**
 * Le preferenze che valgono per un documento, campo per campo: quella della postazione se c'è,
 * altrimenti quella dello studio, altrimenti la predefinita. Un valore che il documento non ammette
 * (la carta di un formato fissato, la variante fuori dal promemoria) non vale, da qualunque livello
 * venga.
 */
export function resolvePrintSettings(
  key: PrintDocumentKey,
  levels: { workstation?: PrintSettingValues | null; studio?: PrintSettingValues | null },
): EffectivePrintSettings {
  const kind = printDocumentKind(key);
  const order = [
    ['postazione', levels.workstation],
    ['studio', levels.studio],
  ] as const;
  function pick<T>(
    get: (v: PrintSettingValues) => T | null,
    valid: (v: T) => boolean,
    fallback: T,
  ): { value: T; from: PrintSettingSource } {
    for (const [from, values] of order) {
      const v = values ? get(values) : null;
      if (v !== null && valid(v)) return { value: v, from };
    }
    return { value: fallback, from: 'predefinito' };
  }
  const printer = pick(
    (v) => v.printer?.trim() || null,
    () => true,
    null as string | null,
  );
  const paper = pick(
    (v) => v.paper,
    (p) => p !== null && kind.paperChoices.includes(p),
    kind.defaultPaper,
  );
  const copies = pick((v) => v.copies, validCopies, DEFAULT_PRINT_COPIES);
  const variant = kind.reminderVariant
    ? pick(
        (v) => v.reminderVariant,
        (r) => r !== null && isReminderVariant(r),
        DEFAULT_REMINDER_VARIANT as ReminderVariant | null,
      )
    : { value: null, from: 'predefinito' as const };
  return {
    kind: key,
    printer: printer.value,
    paper: paper.value,
    copies: copies.value,
    reminderVariant: variant.value,
    from: {
      printer: printer.from,
      paper: paper.from,
      copies: copies.from,
      reminderVariant: variant.from,
    },
  };
}

/** Quello che arriva da salvare: testi e numeri ancora da controllare. */
export interface PrintSettingInput {
  printer: string | null;
  paper: string | null;
  copies: number | null;
  reminderVariant: string | null;
}

/**
 * Che cosa non va in una preferenza da salvare; vuoto se va bene. La carta si sceglie solo dove il
 * formato non è fissato, e tra i formati ammessi; la variante solo per il promemoria della ricetta
 * SSN; le copie entro i limiti di buon senso.
 */
export function printSettingIssues(key: PrintDocumentKey, v: PrintSettingInput): string[] {
  const kind = printDocumentKind(key);
  const out: string[] = [];
  const { copies, printerName } = PRINT_SETTING_LIMITS;
  if (v.printer !== null) {
    if (v.printer.length > printerName) out.push(`Stampante: al massimo ${printerName} caratteri`);
    if ([...v.printer].some(isControl))
      out.push('Stampante: una riga sola, senza caratteri di controllo');
  }
  if (v.paper !== null) {
    if (kind.paperChoices.length === 0)
      out.push(
        `Carta: per «${kind.label}» il formato è fissato (${kind.defaultPaper ?? 'quello del documento'}), non si sceglie`,
      );
    else if (!(kind.paperChoices as readonly string[]).includes(v.paper))
      out.push(`Carta: per «${kind.label}» ${kind.paperChoices.join(' o ')}`);
  }
  if (v.copies !== null && !validCopies(v.copies))
    out.push(`Copie: un numero intero da ${copies.min} a ${copies.max}`);
  if (v.reminderVariant !== null) {
    if (!kind.reminderVariant)
      out.push('Variante: solo per il promemoria della ricetta SSN (completo o solo NRE)');
    else if (!isReminderVariant(v.reminderVariant))
      out.push('Variante del promemoria: completo oppure solo NRE');
  }
  return out;
}

/**
 * Il suggerimento accanto ai pulsanti di stampa, per esempio «Stampante consigliata: Ambulatorio,
 * 2 copie, carta A5». Null se nessuno ha impostato nulla per quel documento: le predefinite sono
 * quelle della finestra di stampa, e un suggerimento non direbbe niente di nuovo.
 */
export function printHint(e: EffectivePrintSettings): string | null {
  if (Object.values(e.from).every((f) => f === 'predefinito')) return null;
  const parts = [
    e.printer
      ? `Stampante consigliata: ${e.printer}`
      : 'Stampante: quella proposta dalla finestra di stampa',
    `${e.copies} ${e.copies === 1 ? 'copia' : 'copie'}`,
  ];
  if (e.paper) parts.push(`carta ${e.paper}`);
  if (e.reminderVariant)
    parts.push(
      e.reminderVariant === 'solo_nre' ? 'solo NRE e codice fiscale' : 'promemoria completo',
    );
  return parts.join(', ');
}
