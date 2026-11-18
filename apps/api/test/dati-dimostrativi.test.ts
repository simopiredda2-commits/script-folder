import { ageAt, generatePatients } from '@mmg/fixtures';
import { describe, expect, it } from 'vitest';
import { DEMO_PATIENTS, DRUGS, PROBLEMS } from '../src/db/demo';

/**
 * Dati dimostrativi (D149): finiscono nelle schermate, anche sul sito di SCRIPT. Niente pazienti
 * in età pediatrica e niente nomi di ditte o marchi: le terapie sono per principio attivo.
 */
describe('dati dimostrativi del seed', () => {
  it('tutti i pazienti sono maggiorenni alla data di riferimento', () => {
    const people = generatePatients(DEMO_PATIENTS);
    expect(people).toHaveLength(DEMO_PATIENTS.count);
    const minors = people.filter((p) => ageAt(p.birthDate, '2026-11-18') < 18);
    expect(minors.map((p) => `${p.lastName} ${p.firstName} ${p.birthDate}`)).toEqual([]);
  });

  it('un farmaco per problema, per principio attivo, con la descrizione AIFA del gruppo', () => {
    expect(DRUGS).toHaveLength(PROBLEMS.length);
    for (const d of DRUGS) {
      // Il nome comincia con il principio attivo ed è la descrizione del gruppo di equivalenza
      // («… UNITA' USO …»): nessun nome commerciale e nessuna ditta.
      expect(d.drugName.startsWith(`${d.activeIngredient} `), d.drugName).toBe(true);
      expect(d.drugName).toMatch(/^[A-Z]+ \d+(?:,\d+)?MG \d+ UNITA' USO [A-Z]+$/);
      expect(d.equivalenceGroup).toMatch(/^[A-Z0-9]{3}$/);
    }
  });
});
