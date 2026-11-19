import { ageAt, generatePatients } from '@mmg/fixtures';
import { describe, expect, it } from 'vitest';
import { DEMO_PATIENTS, DEMO_REFERENCE_DATE, PROFILES, profilesFor } from '../src/db/demo';

/**
 * Dati dimostrativi (D149, D150): finiscono nelle schermate, anche sul sito di SCRIPT. Niente
 * pazienti in età pediatrica, niente nomi di ditte o marchi, e quadri clinici credibili per l'età.
 */
describe('dati dimostrativi del seed', () => {
  it('tutti i pazienti sono maggiorenni alla data di riferimento', () => {
    const people = generatePatients(DEMO_PATIENTS);
    expect(people).toHaveLength(DEMO_PATIENTS.count);
    const minors = people.filter((p) => ageAt(p.birthDate, DEMO_REFERENCE_DATE) < 18);
    expect(minors.map((p) => `${p.lastName} ${p.firstName} ${p.birthDate}`)).toEqual([]);
  });

  it('terapie per principio attivo, con la descrizione AIFA del gruppo: nessuna ditta né marchio', () => {
    for (const profile of Object.values(PROFILES)) {
      for (const { therapy: t, problem } of profile.therapies) {
        // Il nome comincia con il principio attivo ed è la descrizione del gruppo di equivalenza
        // («… UNITA' USO …»): nessun nome commerciale e nessuna ditta.
        expect(t.drugName.startsWith(`${t.activeIngredient} `), t.drugName).toBe(true);
        expect(t.drugName).toMatch(/ \d+ UNITA' USO (?:ORALE|PARENTERALE)$/);
        expect(t.equivalenceGroup).toMatch(/^[A-Z0-9]{3}$/);
        expect(profile.problems[problem], profile.key).toBeDefined();
      }
    }
  });

  it('solo codici ICD-9-CM verificati sulla fonte (D150)', () => {
    const verified = ['401.9', '250.00', '272.0', '250.01', '244.9'];
    for (const profile of Object.values(PROFILES))
      for (const p of profile.problems) expect(verified, profile.key).toContain(p.code);
  });

  it('quadri credibili per l’età: sotto i 40 anni niente diabete tipo 2, ipertensione o colesterolo', () => {
    const codes = (age: number, sex: 'F' | 'M') =>
      profilesFor(age, sex).flatMap((p) => p.problems.map((x) => x.code));
    for (let age = 18; age <= 105; age++) {
      for (const sex of ['F', 'M'] as const) {
        const list = codes(age, sex);
        expect(list.length, `${age} ${sex}`).toBeGreaterThan(0);
        if (age < 40) expect(list, `${age} ${sex}`).not.toEqual(expect.arrayContaining(['250.00']));
        if (age < 40) expect(list, `${age} ${sex}`).not.toContain('401.9');
        if (age < 40) expect(list, `${age} ${sex}`).not.toContain('272.0');
        if (age >= 40) expect(list, `${age} ${sex}`).not.toContain('250.01');
      }
    }
    // Un trentenne con il diabete: tipo 1, con l'insulina (la Dr.ssa Rocca).
    expect(codes(30, 'M')).toEqual(['250.01']);
    expect(PROFILES.diabetes1.therapies.map((t) => t.therapy.activeIngredient)).toEqual([
      'INSULINA GLARGINE',
      'INSULINA ASPART',
    ]);
  });
});
