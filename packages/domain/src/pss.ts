/**
 * Profilo Sanitario Sintetico (tappa 11): che cosa contiene, da dove arriva nella cartella, con
 * quali codici. Contenuti dal DM 27/6/2025 (allegato 1), struttura e codici dallo schematron
 * ufficiale 4.0 e dai dizionari del Ministero (`packages/integrations/fse-ufficiale`, D131).
 * Una prova controlla che ogni codice scritto qui sia nel dizionario ufficiale.
 *
 * Solo composizione e controlli formali (regola 3): il programma propone dalla cartella, il
 * medico controlla e decide. Le voci oscurate non entrano mai (DM 7/9/2023, art. 4, c. 3).
 */

/* Problemi ---------------------------------------------------------------------------------- */

/** Che cosa è un problema per il Profilo: i dati obbligatori del DM 27/6/2025, allegato 1. */
export const PROBLEM_CATEGORIES = [
  'diagnosi',
  'organo_mancante',
  'trapianto',
  'malformazione',
] as const;
export type ProblemCategory = (typeof PROBLEM_CATEGORIES)[number];
export const PROBLEM_CATEGORY_KIND = {
  diagnosi: 'diagnosis',
  organo_mancante: 'missing_organ',
  trapianto: 'transplant',
  malformazione: 'malformation',
} as const satisfies Record<ProblemCategory, string>;
export const PROBLEM_CATEGORY_LABELS: Record<ProblemCategory, string> = {
  diagnosi: 'Problema o diagnosi',
  organo_mancante: 'Organo mancante',
  trapianto: 'Trapianto',
  malformazione: 'Malformazione rilevante',
};

/** Codice degli organi mancanti: dal dizionario ufficiale (ICD-10), es. «Z90.4», «Q13.1». */
export const MISSING_ORGAN_CODE_PATTERN = /^[QZ]\d{2}(\.\d)?$/;

/* Codici dei farmaci (stessi formati delle banche dati, packages/reference/src/kinds.ts) ------ */

/** AIC della confezione: 9 cifre. */
export const AIC_PATTERN = /^\d{9}$/;
/** ATC a qualunque livello (per esempio N02BE01). */
export const ATC_PATTERN = /^[A-Z](?:\d{2}(?:[A-Z](?:[A-Z](?:\d{2})?)?)?)?$/;

/* Allergie ---------------------------------------------------------------------------------- */

export const ALLERGY_KINDS = ['allergia', 'intolleranza'] as const;
export type AllergyKind = (typeof ALLERGY_KINDS)[number];
export const ALLERGY_KIND_DB = { allergia: 'allergy', intolleranza: 'intolerance' } as const;

/** Agente: le voci del DM 27/6/2025 (farmaci, alimenti, veleno di imenotteri) e le altre. */
export const ALLERGY_AGENTS = [
  'farmaco',
  'alimento',
  'veleno_imenotteri',
  'ambiente',
  'altro',
] as const;
export type AllergyAgent = (typeof ALLERGY_AGENTS)[number];
export const ALLERGY_AGENT_DB = {
  farmaco: 'drug',
  alimento: 'food',
  veleno_imenotteri: 'hymenoptera_venom',
  ambiente: 'environment',
  altro: 'other',
} as const satisfies Record<AllergyAgent, string>;
export const ALLERGY_AGENT_LABELS: Record<AllergyAgent, string> = {
  farmaco: 'Farmaco',
  alimento: 'Alimento',
  veleno_imenotteri: 'Veleno di imenotteri',
  ambiente: 'Ambiente (pollini, polveri…)',
  altro: 'Altro',
};

export const ALLERGY_CRITICALITIES = ['bassa', 'moderata', 'alta'] as const;
export type AllergyCriticality = (typeof ALLERGY_CRITICALITIES)[number];
export const ALLERGY_CRITICALITY_DB = {
  bassa: 'low',
  moderata: 'moderate',
  alta: 'high',
} as const satisfies Record<AllergyCriticality, string>;
/** Codici HL7 ObservationValue (dizionario 2.16.840.1.113883.5.1063). */
export const CRITICALITY_HL7 = { bassa: 'L', moderata: 'M', alta: 'H' } as const;

/**
 * Tipo HL7 dell'allergia o intolleranza (ActCode, ObservationIntoleranceType). Per il veleno di
 * imenotteri e per «altro» il tipo generico: il dizionario non ha un tipo più preciso.
 */
export function intoleranceType(
  kind: AllergyKind,
  agent: AllergyAgent,
): { code: string; display: string; label: string } {
  if (kind === 'allergia')
    return agent === 'farmaco'
      ? { code: 'DALG', display: 'Drug Allergy', label: 'Allergia a farmaci' }
      : agent === 'alimento'
        ? { code: 'FALG', display: 'Food Allergy', label: 'Allergia ad alimenti' }
        : agent === 'ambiente'
          ? { code: 'EALG', display: 'Environmental Allergy', label: 'Allergia ambientale' }
          : { code: 'ALG', display: 'Allergy', label: 'Allergia' };
  return agent === 'farmaco'
    ? { code: 'DINT', display: 'Drug Intolerance', label: 'Intolleranza a farmaci' }
    : agent === 'alimento'
      ? { code: 'FINT', display: 'Food Intolerance', label: 'Intolleranza ad alimenti' }
      : agent === 'ambiente'
        ? { code: 'EINT', display: 'Environmental Intolerance', label: 'Intolleranza ambientale' }
        : { code: 'OINT', display: 'intolerance', label: 'Intolleranza' };
}

/* Anamnesi familiare ------------------------------------------------------------------------ */

/** Parenti, con il codice RoleCode HL7 (dizionario 2.16.840.1.113883.5.111). */
export const RELATIVES = [
  { key: 'padre', code: 'FTH', label: 'Padre', sex: 'M' },
  { key: 'madre', code: 'MTH', label: 'Madre', sex: 'F' },
  { key: 'fratello', code: 'BRO', label: 'Fratello', sex: 'M' },
  { key: 'sorella', code: 'SIS', label: 'Sorella', sex: 'F' },
  { key: 'figlio', code: 'SONC', label: 'Figlio', sex: 'M' },
  { key: 'figlia', code: 'DAUC', label: 'Figlia', sex: 'F' },
  { key: 'nonno', code: 'GRFTH', label: 'Nonno', sex: 'M' },
  { key: 'nonna', code: 'GRMTH', label: 'Nonna', sex: 'F' },
  { key: 'zio', code: 'UNCLE', label: 'Zio', sex: 'M' },
  { key: 'zia', code: 'AUNT', label: 'Zia', sex: 'F' },
  { key: 'cugino', code: 'COUSN', label: 'Cugino o cugina', sex: null },
  { key: 'altro', code: 'FAMMEMB', label: 'Altro familiare', sex: null },
] as const;
export type RelativeKey = (typeof RELATIVES)[number]['key'];
export const RELATIVE_KEYS = RELATIVES.map((r) => r.key) as [RelativeKey, ...RelativeKey[]];
export const relativeByKey = (key: string) => RELATIVES.find((r) => r.key === key);
export const relativeByCode = (code: string) => RELATIVES.find((r) => r.code === code);

/* Capacità motoria --------------------------------------------------------------------------- */

/** Dal dizionario ufficiale «CapacitàMotoria_PSSIT» (2.16.840.1.113883.2.9.77.22.11.15). */
export const MOTOR_CAPACITIES = [
  { key: 'autonomo', code: 'LA21285-4', label: 'Autonomo' },
  { key: 'assistito', code: 'LA21286-5', label: 'Assistito' },
  { key: 'allettato', code: 'LA4270-0', label: 'Allettato' },
  { key: 'sedia_a_rotelle', code: 'LA6743-4', label: 'Su sedia a rotelle' },
] as const;
export type MotorCapacityKey = (typeof MOTOR_CAPACITIES)[number]['key'];
export const MOTOR_CAPACITY_KEYS = MOTOR_CAPACITIES.map((m) => m.key) as [
  MotorCapacityKey,
  ...MotorCapacityKey[],
];
export const motorCapacityByKey = (key: string) => MOTOR_CAPACITIES.find((m) => m.key === key);

/* Terapie ------------------------------------------------------------------------------------ */

/**
 * Vie di somministrazione della scheda della terapia, con il codice HL7 RouteOfAdministration
 * (dizionario 2.16.840.1.113883.5.112) che il Profilo vuole per ogni terapia (schematron,
 * ERRORE-b112). Una via scritta a mano che non è qui va scelta dall'elenco.
 */
export const THERAPY_ROUTES = [
  { label: 'per bocca', code: 'PO', display: 'Swallow, oral' },
  { label: 'sublinguale', code: 'SL', display: 'Dissolve, sublingual' },
  { label: 'sottocute', code: 'SQ', display: 'Injection, subcutaneous' },
  { label: 'intramuscolare', code: 'IM', display: 'Injection, intramuscular' },
  { label: 'endovenosa', code: 'IVINJ', display: 'Injection, intravenous' },
  { label: 'inalatoria', code: 'RESPINHL', display: 'Inhalation, respiratory' },
  { label: 'cutanea', code: 'SKIN', display: 'Topical application, skin' },
  { label: 'transdermica', code: 'TRNSDERMD', display: 'Diffusion, transdermal' },
  { label: 'oculare', code: 'OPTHALTA', display: 'Topical application, ophthalmic' },
  { label: 'nasale', code: 'NASAL', display: 'Topical application, nasal' },
  { label: 'rettale', code: 'RECTAL', display: 'Topical application, rectal' },
  { label: 'vaginale', code: 'VAGINSI', display: 'Insertion, vaginal' },
] as const;

/** La via della scheda della terapia, se è una di quelle con il codice. */
export function routeFor(text: string | null | undefined) {
  const t = (text ?? '').trim().toLowerCase();
  return THERAPY_ROUTES.find((r) => r.label === t);
}

/* Parametri e stili di vita ------------------------------------------------------------------ */

/**
 * I parametri facoltativi del Profilo (altezza, peso, BMI, ultima pressione), con il codice
 * LOINC e l'unità UCUM. La chiave è il nome del parametro in cartella.
 */
export const PSS_VITALS = {
  Peso: { loinc: '29463-7', unit: 'kg' },
  Altezza: { loinc: '8302-2', unit: 'cm' },
  BMI: { loinc: '39156-5', unit: 'kg/m2' },
  'Pressione sistolica': { loinc: '8480-6', unit: 'mm[Hg]' },
  'Pressione diastolica': { loinc: '8462-4', unit: 'mm[Hg]' },
} as const satisfies Record<string, { loinc: string; unit: string }>;

/** Fattori di rischio del Profilo (fumo, alcol, attività fisica), con il codice LOINC. */
export const PSS_LIFESTYLE = [
  { factor: 'fumo', loinc: '72166-2', label: 'Fumo' },
  { factor: 'alcol', loinc: '11331-6', label: 'Alcol' },
  { factor: 'attività fisica', loinc: '73985-4', label: 'Attività fisica' },
] as const;
export const lifestyleFor = (factor: string) =>
  PSS_LIFESTYLE.find((l) => l.factor === factor.trim().toLowerCase());

/* Stato del documento ------------------------------------------------------------------------ */

/**
 * Bozza → validato dal Gateway → firmato (PAdES) → preso in carico dal Fascicolo regionale →
 * pubblicato. Si valida prima di firmare (domande frequenti del Ministero). Una versione pubblicata
 * resta consultabile e diventa «sostituita» quando se ne pubblica una nuova (DM 7/9/2023, art. 4).
 * Con i servizi regionali (V09, D280): il Profilo firmato che la Regione non prende in carico si
 * può scartare; quello preso in carico può essere scartato dalla Regione («KO»); quello pubblicato
 * il medico che l'ha scritto lo può cancellare dal Fascicolo.
 */
export const PSS_STATUSES = [
  'draft',
  'validated',
  'signed',
  'submitted',
  'published',
  'replaced',
  'discarded',
  'rejected',
  'deleted',
] as const;
export type PssStatus = (typeof PSS_STATUSES)[number];
export const PSS_STATUS_LABELS: Record<PssStatus, string> = {
  draft: 'Bozza',
  validated: 'Validato dal Gateway',
  signed: 'Firmato',
  submitted: 'Preso in carico dal Fascicolo regionale',
  published: 'Pubblicato nel Fascicolo',
  replaced: 'Sostituito da una versione nuova',
  discarded: 'Scartato',
  rejected: 'Scartato dal Fascicolo regionale',
  deleted: 'Cancellato dal Fascicolo',
};

export type PssEvent =
  'validate' | 'sign' | 'submit' | 'publish' | 'replace' | 'discard' | 'reject' | 'delete';

const TRANSITIONS: Record<PssStatus, Partial<Record<PssEvent, PssStatus>>> = {
  draft: { validate: 'validated', discard: 'discarded' },
  validated: { sign: 'signed', discard: 'discarded' },
  signed: { submit: 'submitted', discard: 'discarded' },
  submitted: { publish: 'published', reject: 'rejected' },
  published: { replace: 'replaced', delete: 'deleted' },
  replaced: {},
  discarded: {},
  rejected: {},
  deleted: {},
};

/** Stato dopo l'evento, o null se l'evento non è ammesso in quello stato. */
export function pssTransition(status: PssStatus, event: PssEvent): PssStatus | null {
  return TRANSITIONS[status][event] ?? null;
}

/* Composizione -------------------------------------------------------------------------------- */

/** Voce della cartella proposta per il Profilo. */
export interface PssCandidate {
  /** Voce di origine (cartella o terapia). */
  sourceId: string;
  label: string;
  /** Nel Profilo per difetto: i dati obbligatori sì, i facoltativi a scelta del medico. */
  proposed: boolean;
  /** Che cosa manca perché la voce possa entrare; vuoto se può entrare. */
  missing: string[];
}

export interface PssExclusions {
  /** Voci oscurate dal paziente: non entrano mai. */
  obscured: number;
  /** Voci riservate: non si propongono (il medico può togliere la riservatezza). */
  reserved: number;
}

/** Codice fiscale nel formato dello schematron (ERRORE-52): 16 lettere maiuscole e cifre. */
export const FISCAL_CODE_FORMAT = /^[A-Z0-9]{16}$/;

/** Che cosa manca al medico per firmare il Profilo; vuoto se c'è tutto. */
export function doctorIssues(d: {
  fiscalCode?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  phone?: string | null;
  email?: string | null;
  pec?: string | null;
}): string[] {
  const out: string[] = [];
  if (!d.fiscalCode || !FISCAL_CODE_FORMAT.test(d.fiscalCode))
    out.push('Medico: manca il codice fiscale nel profilo');
  if (!d.firstName || !d.lastName) out.push('Medico: mancano nome e cognome');
  if (!d.phone && !d.email && !d.pec)
    out.push('Medico: serve almeno un recapito di studio (telefono, email o PEC)');
  return out;
}

/** Che cosa manca del paziente; vuoto se c'è tutto. */
export function patientIssues(p: {
  fiscalCode?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  sex?: string | null;
  birthDate?: string | null;
}): string[] {
  const out: string[] = [];
  if (!p.fiscalCode || !FISCAL_CODE_FORMAT.test(p.fiscalCode))
    out.push('Paziente: manca il codice fiscale');
  if (!p.firstName || !p.lastName) out.push('Paziente: mancano nome e cognome');
  if (p.sex !== 'M' && p.sex !== 'F') out.push('Paziente: manca il sesso');
  if (!p.birthDate) out.push('Paziente: manca la data di nascita');
  return out;
}
