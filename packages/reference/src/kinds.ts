/**
 * Tipi di banca dati che il servizio sa importare, con i loro campi. I nomi dei campi sono quelli
 * del database; le colonne dei file d'origine si collegano ai campi nelle mappature (data/).
 */

export type FieldType = 'text' | 'number' | 'boolean' | 'date';

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
/**
 * Codice ICD-9-CM delle diagnosi come lo scrive l'elenco sistematico: categorie di tre cifre (001–999),
 * codici V di due cifre (V01–V91) ed E di tre (E800–E999), con al più due decimali (uno per i codici
 * E). Più stretto dello schema del certificato (sick-leave), che accetta anche forme che la
 * classificazione non usa.
 */
const ICD9: FieldSpec = {
  type: 'text',
  pattern: /^(?:\d{3}(?:\.\d{1,2})?|V\d{2}(?:\.\d{1,2})?|E\d{3}(?:\.\d)?)$/,
  patternLabel: 'codice ICD-9-CM (per esempio 401.9, 250.00, V17.3, E880.0)',
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
      /**
       * Stato amministrativo della confezione (D205): nel file del 20/11/2026 «Autorizzata» o
       * «Sospesa». Le confezioni revocate nel file non ci sono.
       */
      adminState: { type: 'text' },
    },
  },
  /**
   * Registri di monitoraggio e piani terapeutici AIFA attivi (D206): una riga per farmaco e
   * indicazione. Il file non ha l'AIC: i registri si collegano ai farmaci per ATC.
   */
  registri_aifa: {
    label: 'Registri e piani terapeutici AIFA',
    fields: {
      /** Il farmaco del registro, come lo scrive AIFA. */
      name: { type: 'text', required: true },
      activeIngredient: { type: 'text' },
      atc: ATC,
      /** «Indicazione rimborsata», con le parole dell'elenco. */
      reimbursedIndication: { type: 'text' },
      condition: { type: 'text' },
      /** «Tipologia di Monitoraggio»: Registro, Piano Terapeutico, Registro semplificato… */
      monitoringType: { type: 'text' },
      monitoringState: { type: 'text' },
      therapeuticArea: { type: 'text' },
      monitoringStart: { type: 'date' },
      /** Indirizzo della scheda sul sito di AIFA, come lo scrive l'elenco. */
      sheetUrl: { type: 'text' },
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
    /** Campi che identificano una voce negli atti che aggiungono e tolgono voci (D157). */
    changeKey: ['activeIngredient', 'atc'],
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
    /** Campi che identificano una voce negli atti che aggiungono e tolgono voci (D157). */
    changeKey: ['regionalCode', 'branch'],
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
    /** Campi che identificano una voce negli atti che aggiungono e tolgono voci (D157). */
    changeKey: ['code'],
    fields: {
      code: { type: 'text', required: true },
      description: { type: 'text', required: true },
    },
  },
  /**
   * Diagnosi ICD-9-CM, versione italiana 2007 (elenco sistematico delle malattie e dei
   * traumatismi), da una trascrizione controllata del PDF del Ministero (D186). Il codice del padre
   * dà la gerarchia: un codice con sottocodici è una categoria.
   */
  diagnosi: {
    label: 'Diagnosi ICD-9-CM',
    /** Il codice identifica una voce negli atti che aggiungono e tolgono voci (D157). */
    changeKey: ['code'],
    fields: {
      code: { ...ICD9, required: true },
      description: { type: 'text', required: true },
      parentCode: ICD9,
      includedTerms: { type: 'text' },
      notes: { type: 'text' },
      chapter: { type: 'text' },
      section: { type: 'text' },
    },
  },
  /**
   * Lista di trasparenza AIFA (farmaci equivalenti): per ogni confezione il prezzo di riferimento
   * del SSN, il prezzo al pubblico e la differenza (D202). La colonna «Nota» del file è
   * un'annotazione in parole, non il numero della nota AIFA: si chiama `remark`.
   */
  farmaci_trasparenza: {
    label: 'Lista di trasparenza AIFA',
    fields: {
      aic: { ...AIC, required: true },
      activeIngredient: { type: 'text' },
      referencePack: { type: 'text' },
      atc: ATC,
      name: { type: 'text' },
      pack: { type: 'text' },
      holder: { type: 'text' },
      referencePrice: { type: 'number' },
      publicPrice: { type: 'number' },
      priceDifference: { type: 'number' },
      remark: { type: 'text' },
      equivalenceGroup: { type: 'text' },
    },
  },
  /**
   * Farmaci temporaneamente carenti (AIFA), con la motivazione e le indicazioni dell'AIFA (D202).
   * Un farmaco resta nell'elenco finché il titolare non comunica la fine della carenza, anche
   * oltre la data di fine presunta (avvertenza in testa al file).
   */
  farmaci_carenti: {
    label: 'Farmaci carenti (AIFA)',
    fields: {
      aic: { ...AIC, required: true },
      name: { type: 'text' },
      activeIngredient: { type: 'text' },
      formStrength: { type: 'text' },
      holder: { type: 'text' },
      startOn: { type: 'date' },
      expectedEndOn: { type: 'date' },
      equivalentAvailable: { type: 'boolean' },
      reason: { type: 'text' },
      aifaAdvice: { type: 'text' },
      aifaNote: { type: 'text' },
      reimbursementClass: { type: 'text' },
      atc: ATC,
    },
  },
  /** Esenzioni e prestazioni associate per il controllo del SAR (R17), da una trascrizione. */
  esenzioni_prestazioni: {
    label: 'Esenzioni e prestazioni associate',
    /** Campi che identificano una voce negli atti che aggiungono e tolgono voci (D157). */
    changeKey: ['exemptionCode', 'serviceCode'],
    fields: {
      exemptionCode: { type: 'text', required: true },
      serviceCode: { type: 'text', required: true },
    },
  },
} as const satisfies Record<
  string,
  { label: string; changeKey?: readonly string[]; fields: Record<string, FieldSpec> }
>;

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
      // Scrittura italiana: 1.234,56; oppure 1234.56. Il simbolo dell'euro in fondo (lista di
      // trasparenza AIFA, «5,63 €») non fa parte del numero.
      const amount = text.replace(/\s*€$/u, '');
      const normalized = amount.includes(',')
        ? amount.replace(/\./g, '').replace(',', '.')
        : amount;
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
    case 'date': {
      // GG/MM/AAAA (elenco dei farmaci carenti) o AAAA-MM-GG; sempre una data vera.
      const it = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(text);
      const iso = it
        ? `${it[3]}-${it[2]!.padStart(2, '0')}-${it[1]!.padStart(2, '0')}`
        : /^\d{4}-\d{2}-\d{2}$/.test(text)
          ? text
          : null;
      const d = iso ? new Date(`${iso}T00:00:00Z`) : null;
      return iso && d && !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso
        ? { value: iso }
        : { problem: `«${text}» non è una data (GG/MM/AAAA)` };
    }
  }
}
