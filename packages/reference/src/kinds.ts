/**
 * Tipi di banca dati che il servizio sa importare, con i loro campi. I nomi dei campi sono quelli
 * del database; le colonne dei file d'origine si collegano ai campi nelle mappature (data/).
 */

export type FieldType = 'text' | 'number' | 'boolean';

export interface FieldSpec {
  type: FieldType;
  required?: boolean;
  /** Forma del valore, se il formato è noto (AIC, ATC, codice catastale…). */
  pattern?: RegExp;
  /** Che cosa dice la forma, per i messaggi. */
  patternLabel?: string;
}

// Forme ricavate dai file e dai documenti letti: le fonti sono in docs/banche-dati.md.
const AIC: FieldSpec = { type: 'text', pattern: /^\d{9}$/, patternLabel: '9 cifre' };
const ATC: FieldSpec = {
  type: 'text',
  pattern: /^[A-Z](?:\d{2}(?:[A-Z](?:[A-Z](?:\d{2})?)?)?)?$/,
  patternLabel: 'codice ATC (per esempio N02BE01)',
};

export const KINDS = {
  /** Anagrafica dei farmaci (AIFA): una riga per confezione. */
  farmaci: {
    label: 'Anagrafica dei farmaci',
    fields: {
      aic: { ...AIC, required: true },
      name: { type: 'text' },
      pack: { type: 'text' },
      activeIngredient: { type: 'text' },
      atc: ATC,
      form: { type: 'text' },
      supplyRegime: { type: 'text' },
      /** Ditta titolare dell'AIC: per i generici, il nome del fornitore (D151). */
      holder: { type: 'text' },
    },
  },
  /** Elenchi AIFA dei farmaci di classe A e H, con prezzo e gruppo di equivalenza. */
  farmaci_classe: {
    label: 'Farmaci per classe (A e H)',
    fields: {
      aic: { ...AIC, required: true },
      drugClass: { type: 'text', required: true, pattern: /^(?:A|H)$/, patternLabel: 'A o H' },
      activeIngredient: { type: 'text' },
      price: { type: 'number' },
      equivalenceGroup: { type: 'text' },
      aifaNote: { type: 'text' },
    },
  },
  /** Farmaci PHT in distribuzione per conto (Regione Piemonte), da una trascrizione controllata. */
  farmaci_dpc: {
    label: 'Farmaci in distribuzione per conto (DPC)',
    fields: {
      activeIngredient: { type: 'text', required: true },
      atc: ATC,
      aifaNote: { type: 'text' },
      planRequired: { type: 'boolean' },
    },
  },
  /** Elenco ISTAT dei comuni. */
  comuni: {
    label: 'Comuni e codici catastali',
    fields: {
      istatCode: { type: 'text', required: true, pattern: /^\d{6}$/, patternLabel: '6 cifre' },
      name: { type: 'text', required: true },
      region: { type: 'text' },
      provinceAbbr: { type: 'text', pattern: /^[A-Z]{2}$/, patternLabel: 'due lettere' },
      cadastralCode: {
        type: 'text',
        required: true,
        pattern: /^[A-Z]\d{3}$/,
        patternLabel: 'una lettera e tre cifre',
      },
    },
  },
  /** Catalogo regionale delle prestazioni di specialistica, da una trascrizione controllata. */
  prestazioni: {
    label: 'Catalogo regionale delle prestazioni',
    fields: {
      regionalCode: { type: 'text', required: true },
      nationalCode: { type: 'text' },
      description: { type: 'text', required: true },
      branch: { type: 'text' },
      fee: { type: 'number' },
      notes: { type: 'text' },
    },
  },
  /** Catalogo delle esenzioni, da una trascrizione controllata. */
  esenzioni: {
    label: 'Catalogo delle esenzioni',
    fields: {
      code: { type: 'text', required: true },
      description: { type: 'text', required: true },
    },
  },
  /** Esenzioni e prestazioni associate per il controllo del SAR (R17), da una trascrizione. */
  esenzioni_prestazioni: {
    label: 'Esenzioni e prestazioni associate',
    fields: {
      exemptionCode: { type: 'text', required: true },
      serviceCode: { type: 'text', required: true },
    },
  },
} as const satisfies Record<string, { label: string; fields: Record<string, FieldSpec> }>;

export type DatasetKind = keyof typeof KINDS;
export const DATASET_KINDS = Object.keys(KINDS) as DatasetKind[];

export type FieldValue = string | number | boolean | null;
export type DataRecord = Record<string, FieldValue>;

/** Converte una cella nel valore del campo; restituisce un problema se non va. */
export function convertCell(
  spec: FieldSpec,
  raw: string,
): { value: FieldValue } | { problem: string } {
  const text = raw.trim();
  if (text === '') {
    return spec.required ? { problem: 'valore mancante' } : { value: null };
  }
  switch (spec.type) {
    case 'text':
      if (spec.pattern && !spec.pattern.test(text)) {
        return { problem: `«${text}» non ha la forma attesa (${spec.patternLabel})` };
      }
      return { value: text };
    case 'number': {
      // Scrittura italiana: 1.234,56; oppure 1234.56.
      const normalized = text.includes(',') ? text.replace(/\./g, '').replace(',', '.') : text;
      const n = Number(normalized);
      return Number.isFinite(n) && /^-?\d+(?:\.\d+)?$/.test(normalized)
        ? { value: n }
        : { problem: `«${text}» non è un numero` };
    }
    case 'boolean': {
      const t = text.toLowerCase();
      if (t === 'sì' || t === 'si') return { value: true };
      if (t === 'no') return { value: false };
      return { problem: `«${text}» non è «sì» o «no»` };
    }
  }
}
