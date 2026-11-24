import { ageAt, generatePatients } from '@mmg/fixtures';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
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

  it('ogni terapia ha la confezione della regola, riletta dai file AIFA della dimostrazione (audit D259)', () => {
    const dir = new URL('../../demo/dati/aifa/', import.meta.url);
    // CSV con il punto e virgola; l'anagrafica ha i campi tra virgolette.
    const fields = (line: string) =>
      [...line.matchAll(/(?:^|;)(?:"((?:[^"]|"")*)"|([^;]*))/g)].map((m) =>
        m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2]!,
      );
    const rows = (name: string, encoding: 'latin1' | 'utf8') =>
      gunzipSync(readFileSync(new URL(name, dir)))
        .toString(encoding)
        .split(/\r?\n/)
        .filter(Boolean)
        .map(fields);
    // Lista di classe A (cp1252: per queste righe è uguale a latin1) e anagrafica delle confezioni.
    const [, ...classA] = rows('Classe-A_per_principio-attivo_30-6-2026.csv.gz', 'latin1');
    const [head, ...packs] = rows('confezioni_fornitura.csv.gz', 'utf8');
    const col = (n: string) => head!.indexOf(n);
    const registry = new Map(packs.map((r) => [r[col('CODICE_AIC')]!, r]));
    const authorized = (aic: string) =>
      registry.get(aic)?.[col('STATO_AMMINISTRATIVO')] === 'Autorizzata';
    for (const profile of Object.values(PROFILES))
      for (const { therapy: t } of profile.therapies) {
        // Colonne della lista: principio attivo, descrizione del gruppo, confezione, prezzo,
        // titolare, AIC, codice del gruppo.
        const group = classA.filter((r) => r[6] === t.equivalenceGroup);
        expect(new Set(group.map((r) => r[1])), t.drugName).toEqual(new Set([t.drugName]));
        const ok = group.filter((r) => authorized(r[5]!)).map((r) => [r[5]!, r[2]!] as const);
        const named = ok.filter(([, name]) => name.startsWith(`${t.activeIngredient}*`));
        const expected = (named.length ? named : ok).map(([aic]) => aic).sort()[0];
        expect(t.drugAic, t.drugName).toBe(expected);
        expect(registry.get(t.drugAic)![col('CODICE_ATC')], t.drugName).toBe(t.atc);
        expect(t.drugClass).toBe('A');
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
