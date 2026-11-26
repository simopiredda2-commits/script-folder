/**
 * SIAP, Sistema informativo per il monitoraggio dell'assistenza primaria (DM Salute 4/8/2025;
 * D277, D284). Qui le chiavi che il programma usa per i valori dei tracciati. I codici e le
 * descrizioni del Ministero sono un dato (`packages/reference/data/siap`), con la chiave di ogni
 * valore: il legame fra chiave e codice è lì, non nel codice.
 */

/** Modalità del contatto: studio, domicilio, telemedicina, online o telefono, non noto. */
export const CONTACT_MODES = ['office', 'home', 'telemedicine', 'remote', 'unknown'] as const;
export type ContactMode = (typeof CONTACT_MODES)[number];

/** Regime dell'attività del medico: ciclo di scelta, attività oraria, non noto. */
export const ACTIVITY_REGIMES = ['choice', 'hourly', 'unknown'] as const;
export type ActivityRegime = (typeof ACTIVITY_REGIMES)[number];

/** Tipologia di accesso: programmato (con prenotazione), diretto, non noto. */
export const CONTACT_ACCESS_TYPES = ['scheduled', 'direct', 'unknown'] as const;
export type ContactAccessType = (typeof CONTACT_ACCESS_TYPES)[number];

/** Stato del problema del contatto: sospetto, in evoluzione, associato alla cronicità, non noto. */
export const PROBLEM_STATES = ['suspected', 'evolving', 'chronic', 'unknown'] as const;
export type ProblemState = (typeof PROBLEM_STATES)[number];

/** Fumo: sì, no, non noto. */
export const SMOKING_STATUSES = ['yes', 'no', 'unknown'] as const;
export type SmokingStatus = (typeof SMOKING_STATUSES)[number];

/** Tipo di struttura del tracciato dell'organizzazione. */
export const STRUCTURE_TYPES = [
  'gp_office',
  'pediatric_office',
  'aft',
  'uccp',
  'community_house',
  'out_of_hours',
  'tourist_service',
  'semi_residential',
  'residential',
] as const;
export type StructureType = (typeof STRUCTURE_TYPES)[number];

/** La modalità del contatto dal tipo di contatto del diario. */
export const CONTACT_MODE_OF_DIARY = {
  office: 'office',
  home: 'home',
  phone: 'remote',
  televisit: 'telemedicine',
} as const satisfies Record<string, ContactMode>;

/**
 * Codice della struttura del tracciato dell'organizzazione: 6 caratteri, la codifica STS.11, o nel
 * transitorio il codice che dà la Regione (per esempio «MM0001» per uno studio di medicina
 * generale; specifiche funzionali del Ministero, allegato 3).
 */
export const STRUCTURE_CODE_PATTERN = /^[A-Z0-9]{6}$/;
