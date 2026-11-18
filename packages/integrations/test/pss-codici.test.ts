import {
  ALLERGY_AGENTS,
  ALLERGY_KINDS,
  CRITICALITY_HL7,
  intoleranceType,
  MOTOR_CAPACITIES,
  PSS_LIFESTYLE,
  PSS_VITALS,
  RELATIVES,
  THERAPY_ROUTES,
} from '@mmg/domain';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FSE_DICTIONARIES as D,
  fseDictionary,
  fseDictionaryEntry,
  loincExtract,
} from '../src/fse/dictionaries';

/** Ogni codice scritto nel programma è nel dizionario ufficiale del Ministero (D131). */
describe('codici del Profilo nei dizionari ufficiali', () => {
  it('le vie di somministrazione della scheda della terapia', () => {
    for (const r of THERAPY_ROUTES) {
      const e = fseDictionaryEntry(D.route, r.code);
      expect(e, r.label).toBeDefined();
      expect(e!.description).toBe(r.display);
    }
  });

  it('i tipi di allergia e intolleranza, la criticità', () => {
    for (const k of ALLERGY_KINDS)
      for (const a of ALLERGY_AGENTS) {
        const t = intoleranceType(k, a);
        expect(fseDictionaryEntry(D.actCode, t.code)?.description, `${k} ${a}`).toBe(t.display);
      }
    for (const c of Object.values(CRITICALITY_HL7))
      expect(fseDictionaryEntry(D.observationValue, c), c).toBeDefined();
  });

  it('i parenti e la capacità motoria', () => {
    for (const r of RELATIVES) expect(fseDictionaryEntry(D.roleCode, r.code), r.key).toBeDefined();
    for (const m of MOTOR_CAPACITIES)
      expect(fseDictionaryEntry(D.motorCapacity, m.code)?.description, m.key).toBe(m.label);
  });

  it('i codici LOINC del dominio e del documento sono nell’estratto del dizionario ufficiale', () => {
    const codes = new Set(loincExtract().map((e) => e.code));
    for (const v of Object.values(PSS_VITALS)) expect(codes.has(v.loinc), v.loinc).toBe(true);
    for (const l of PSS_LIFESTYLE) expect(codes.has(l.loinc), l.loinc).toBe(true);
    // Il documento: ogni codice LOINC scritto in cda.ts.
    const cda = readFileSync(join(import.meta.dirname, '..', 'src', 'fse', 'cda.ts'), 'utf8');
    const used = new Set([...cda.matchAll(/'(\d{3,6}-\d)'/g)].map((m) => m[1]!));
    expect(used.size).toBeGreaterThanOrEqual(16);
    for (const c of used) expect(codes.has(c), c).toBe(true);
  });

  it('i dizionari si leggono senza doppioni; le virgolette dei file non entrano nei testi', () => {
    const routes = fseDictionary(D.route);
    expect(new Set(routes.map((r) => r.code)).size).toBe(routes.length);
    expect(fseDictionaryEntry(D.allergens, '288328004')?.description).toBe("Veleno d'api");
    expect(fseDictionaryEntry(D.missingOrgans, 'Z89.0')?.description).toBe(
      'Mancanza acquisita di dito(a) della mano, [compreso il pollice]; unilaterale',
    );
  });
});
