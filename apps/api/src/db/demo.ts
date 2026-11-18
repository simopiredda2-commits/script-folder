/**
 * Dati dimostrativi dello studio inventato (pnpm db:seed): parametri dei pazienti e dati clinici.
 * Stanno qui, fuori dal seed, perché una prova li controlla (test/dati-dimostrativi.test.ts).
 */

/**
 * Pazienti inventati del seed. Solo maggiorenni: nessun paziente in età pediatrica nello studio
 * dimostrativo di un medico di medicina generale (D149).
 */
export const DEMO_PATIENTS = { seed: 'demo', count: 40, minAge: 18 } as const;

/** Dati clinici inventati, scelti dal generatore deterministico. */
export const PROBLEMS = [
  { code: '401.9', description: 'Ipertensione essenziale, non specificata' },
  { code: '250.00', description: 'Diabete mellito tipo 2 senza complicanze' },
  { code: '272.0', description: 'Ipercolesterolemia pura' },
];
// Un farmaco per problema, nello stesso ordine, prescritto per principio attivo (D149): il nome è
// la descrizione AIFA del gruppo di equivalenza, letta dalla lista di classe A del 30/6/2026, e non
// porta il nome di una ditta; il principio attivo va sempre in ricetta (R13).
export const DRUGS = [
  {
    drugName: "AMLODIPINA 5MG 28 UNITA' USO ORALE",
    activeIngredient: 'AMLODIPINA',
    timeOfDay: 'al mattino',
    equivalenceGroup: 'DOB',
  },
  {
    drugName: "METFORMINA 500MG 30 UNITA' USO ORALE",
    activeIngredient: 'METFORMINA',
    timeOfDay: 'a pranzo',
    equivalenceGroup: 'A1A',
  },
  {
    drugName: "ATORVASTATINA 20MG 30 UNITA' USO ORALE",
    activeIngredient: 'ATORVASTATINA',
    timeOfDay: 'la sera',
    equivalenceGroup: 'FTB',
  },
];
