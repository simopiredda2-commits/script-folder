/**
 * Dati dimostrativi dello studio inventato (pnpm db:seed): parametri dei pazienti e quadri clinici.
 * Stanno qui, fuori dal seed, perché una prova li controlla (test/dati-dimostrativi.test.ts).
 */

/** Data di riferimento delle età dei pazienti dimostrativi: la stessa del generatore. */
export const DEMO_REFERENCE_DATE = '2026-11-18';

/**
 * Pazienti inventati del seed. Solo maggiorenni: nessun paziente in età pediatrica nello studio
 * dimostrativo di un medico di medicina generale (D149).
 */
export const DEMO_PATIENTS = {
  seed: 'demo',
  count: 40,
  minAge: 18,
  referenceDate: DEMO_REFERENCE_DATE,
} as const;

export interface DemoProblem {
  /** Codice ICD-9-CM, verificato sull'edizione 2007 (D150). */
  code: string;
  /** Come la scriverebbe il medico. */
  description: string;
}

export interface DemoTherapy {
  /**
   * Per principio attivo (D149): la descrizione AIFA del gruppo di equivalenza, letta dalla lista
   * di classe A del 30/6/2026. Non porta il nome di una ditta né un marchio.
   */
  drugName: string;
  activeIngredient: string;
  equivalenceGroup: string;
  dose: string;
  doseUnit: 'compressa' | 'unità';
  frequency: '1 volta al giorno' | '2 volte al giorno' | '3 volte al giorno';
  timeOfDay: 'al mattino' | 'la sera' | null;
  route: 'per bocca' | 'sottocute';
  patientInstructions: string | null;
}

export interface DemoProfile {
  key: string;
  problems: DemoProblem[];
  /** Ogni terapia con l'indice del problema per cui è prescritta. */
  therapies: { therapy: DemoTherapy; problem: number }[];
}

const PROBLEMS = {
  hypertension: { code: '401.9', description: 'Ipertensione essenziale, non specificata' },
  diabetes2: { code: '250.00', description: 'Diabete mellito tipo 2 senza complicanze' },
  hypercholesterolemia: { code: '272.0', description: 'Ipercolesterolemia pura' },
  diabetes1: { code: '250.01', description: 'Diabete mellito tipo 1 senza complicanze' },
  hypothyroidism: { code: '244.9', description: 'Ipotiroidismo' },
} as const satisfies Record<string, DemoProblem>;

const DRUGS = {
  amlodipine: {
    drugName: "AMLODIPINA 5MG 28 UNITA' USO ORALE",
    activeIngredient: 'AMLODIPINA',
    equivalenceGroup: 'DOB',
    dose: '1',
    doseUnit: 'compressa',
    frequency: '1 volta al giorno',
    timeOfDay: 'al mattino',
    route: 'per bocca',
    patientInstructions: null,
  },
  metformin: {
    drugName: "METFORMINA 500MG 30 UNITA' USO ORALE",
    activeIngredient: 'METFORMINA',
    equivalenceGroup: 'A1A',
    dose: '1',
    doseUnit: 'compressa',
    frequency: '2 volte al giorno',
    timeOfDay: null,
    route: 'per bocca',
    patientInstructions: 'Durante i pasti.',
  },
  atorvastatin: {
    drugName: "ATORVASTATINA 20MG 30 UNITA' USO ORALE",
    activeIngredient: 'ATORVASTATINA',
    equivalenceGroup: 'FTB',
    dose: '1',
    doseUnit: 'compressa',
    frequency: '1 volta al giorno',
    timeOfDay: 'la sera',
    route: 'per bocca',
    patientInstructions: null,
  },
  insulinGlargine: {
    drugName: "INSULINA GLARGINE 100U/ML 3ML 5 UNITA' USO PARENTERALE",
    activeIngredient: 'INSULINA GLARGINE',
    equivalenceGroup: 'N4B',
    dose: '14',
    doseUnit: 'unità',
    frequency: '1 volta al giorno',
    timeOfDay: 'la sera',
    route: 'sottocute',
    patientInstructions: null,
  },
  insulinAspart: {
    drugName: "INSULINA ASPART 300U 3ML 5 UNITA' USO PARENTERALE",
    activeIngredient: 'INSULINA ASPART',
    equivalenceGroup: 'N2A',
    dose: '4',
    doseUnit: 'unità',
    frequency: '3 volte al giorno',
    timeOfDay: null,
    route: 'sottocute',
    patientInstructions: 'Ai pasti principali, secondo lo schema concordato.',
  },
  levothyroxine: {
    drugName: "LEVOTIROXINA 50MCG 50 UNITA' USO ORALE",
    activeIngredient: 'LEVOTIROXINA',
    equivalenceGroup: 'BKC',
    dose: '1',
    doseUnit: 'compressa',
    frequency: '1 volta al giorno',
    timeOfDay: 'al mattino',
    route: 'per bocca',
    patientInstructions: 'A digiuno, mezz’ora prima della colazione.',
  },
} as const satisfies Record<string, DemoTherapy>;

/** Quadri clinici dimostrativi: problemi e terapie coerenti fra loro. */
export const PROFILES = {
  diabetes1: {
    key: 'diabete-tipo-1',
    problems: [PROBLEMS.diabetes1],
    therapies: [
      { therapy: DRUGS.insulinGlargine, problem: 0 },
      { therapy: DRUGS.insulinAspart, problem: 0 },
    ],
  },
  hypothyroidism: {
    key: 'ipotiroidismo',
    problems: [PROBLEMS.hypothyroidism],
    therapies: [{ therapy: DRUGS.levothyroxine, problem: 0 }],
  },
  hypertension: {
    key: 'ipertensione',
    problems: [PROBLEMS.hypertension],
    therapies: [{ therapy: DRUGS.amlodipine, problem: 0 }],
  },
  hypercholesterolemia: {
    key: 'ipercolesterolemia',
    problems: [PROBLEMS.hypercholesterolemia],
    therapies: [{ therapy: DRUGS.atorvastatin, problem: 0 }],
  },
  diabetes2: {
    key: 'diabete-tipo-2',
    problems: [PROBLEMS.diabetes2],
    therapies: [{ therapy: DRUGS.metformin, problem: 0 }],
  },
  hypertensionDiabetes2: {
    key: 'ipertensione-e-diabete-tipo-2',
    problems: [PROBLEMS.hypertension, PROBLEMS.diabetes2],
    therapies: [
      { therapy: DRUGS.amlodipine, problem: 0 },
      { therapy: DRUGS.metformin, problem: 1 },
    ],
  },
  hypertensionHypercholesterolemia: {
    key: 'ipertensione-e-ipercolesterolemia',
    problems: [PROBLEMS.hypertension, PROBLEMS.hypercholesterolemia],
    therapies: [
      { therapy: DRUGS.amlodipine, problem: 0 },
      { therapy: DRUGS.atorvastatin, problem: 1 },
    ],
  },
} as const satisfies Record<string, DemoProfile>;

/**
 * I quadri possibili per età e sesso, tra cui il seed sceglie: condizioni probabili a quell'età
 * (la Dr.ssa Rocca: un trentenne con il diabete è più credibilmente di tipo 1, con l'insulina; D150).
 */
export function profilesFor(age: number, sex: 'F' | 'M'): readonly DemoProfile[] {
  if (age < 40) return [sex === 'M' ? PROFILES.diabetes1 : PROFILES.hypothyroidism];
  if (age < 65) return [PROFILES.hypertension, PROFILES.hypercholesterolemia, PROFILES.diabetes2];
  return [PROFILES.hypertensionDiabetes2, PROFILES.hypertensionHypercholesterolemia];
}

/** Pressione sistolica dimostrativa, in mmHg: intervallo plausibile per l'età e il quadro. */
export function systolicRange(age: number): [number, number] {
  if (age < 40) return [110, 130];
  if (age < 65) return [120, 150];
  return [125, 160];
}

/** Posologia per la riga della ricetta, dalla scheda della terapia. */
export function posologyText(t: DemoTherapy): string {
  return [`${t.dose} ${t.doseUnit}`, t.frequency, t.timeOfDay].filter(Boolean).join(', ');
}
