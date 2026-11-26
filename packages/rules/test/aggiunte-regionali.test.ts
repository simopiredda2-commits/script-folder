import { REGIONAL_PACKAGES, type RegionalPackage } from '@mmg/regions';
import { describe, expect, it } from 'vitest';
import {
  checkPrescription,
  loadRegionalRulesets,
  loadRulesets,
  regionalRulesetSchema,
  rulesetAt,
  specialistValidityDays,
  withRegionalAdditions,
  type RegionalRuleset,
} from '../src';
import { ctx } from './helpers/contesto';

/**
 * Le aggiunte delle regioni alle regole nazionali (D288, D296). Le prove usano una regione
 * inventata e non scrivono il nome di nessuna regione vera; il contenuto delle aggiunte di ogni
 * pacchetto si prova nella cartella del pacchetto (`test/regions/<chiave>/`).
 */
const REGION = 'regione-di-prova';

/** Aggiunte inventate, con i giorni della specialistica, come quelle di D260. */
const additions = (over: Partial<RegionalRuleset> = {}): RegionalRuleset => ({
  region: REGION,
  version: '2026-11-26.1',
  effectiveFrom: '2026-11-26',
  valuesSource: 'Atto inventato della regione di prova',
  rules: [
    {
      id: 'R1',
      text: 'La ricetta SSN vale 30 giorni; la specialistica 50 e 150 giorni',
      sources: [{ title: 'Regione di prova, atto inventato n. 1' }],
      values: { specialistFirstAccessDays: 50, specialistOtherAccessDays: 150 },
    },
    { id: 'R5', sources: [{ title: 'Elenco inventato della regione di prova' }] },
    { id: 'R9', toComplete: ['Da verificare con la regione di prova'] },
  ],
  ...over,
});

describe('versione nazionale 2026-11-26.1 (D296)', () => {
  const all = loadRulesets();
  const before = all.find((r) => r.version === '2026-11-25.2')!;
  const v11 = all.find((r) => r.version === '2026-11-26.1')!;
  const rule = (id: string) => v11.rules.find((r) => r.id === id)!;
  const old = (id: string) => before.rules.find((r) => r.id === id)!;

  it('vale dal 26/11/2026; le parti della regione sono tolte, il resto come la 2026-11-25.2', () => {
    expect(v11.effectiveFrom).toBe('2026-11-26');
    expect(rulesetAt('2026-11-26').version).toBe('2026-11-26.1');
    expect(rulesetAt('2026-11-25').version).toBe('2026-11-25.2');
    expect(v11.rules.map((r) => r.id)).toEqual(before.rules.map((r) => r.id));
    // R1: il termine dei requisiti, senza i giorni della specialistica della regione (D260).
    expect(rule('R1')).toEqual({
      ...old('R1'),
      text: 'La ricetta SSN vale 30 giorni',
      sources: old('R1').sources.slice(0, 1),
      values: { validityDays: 30 },
    });
    // R5 e R17: le fonti nazionali, senza quelle della regione, che erano le ultime.
    expect(rule('R5')).toEqual({ ...old('R5'), sources: old('R5').sources.slice(0, 2) });
    expect(rule('R17')).toEqual({ ...old('R17'), sources: old('R17').sources.slice(0, 1) });
    expect(rule('R9').sources).toEqual([
      { title: 'Anagrafe regionale degli assistiti e catalogo delle esenzioni' },
    ]);
    expect(rule('R18').text).toMatch(
      /il controllo finale è del servizio che riceve la ricetta \(della Regione o il Sistema TS\)/,
    );
    // R11: la fonte senza il consulente regolatorio (D294).
    expect(rule('R11').sources[0]!.title).toBe(
      'Buona pratica, da validare con la Dr.ssa Rocca (fuori dal dispositivo medico, D294)',
    );
    expect(rule('R11').sources.slice(1)).toEqual(old('R11').sources.slice(1));
    const changed = ['R1', 'R4', 'R5', 'R9', 'R10', 'R11', 'R17', 'R18', 'R23'];
    for (const r of v11.rules) {
      expect(r.behavior, r.id).toBe(old(r.id).behavior);
      if (r.id !== 'R1') expect(r.values, r.id).toEqual(old(r.id).values);
      expect(r.lists, r.id).toEqual(old(r.id).lists);
      if (!changed.includes(r.id)) expect(r, r.id).toEqual(old(r.id));
    }
  });

  it('senza regione, la ricetta specialistica ha il termine dei requisiti, come prima di D260', () => {
    const [issue] = checkPrescription(
      ctx({ date: '2026-11-26', prescription: { kind: 'specialist_ssn', accessType: 'first' } }),
    ).issues.filter((i) => i.ruleId === 'R1');
    expect(issue!.message).toBe('La ricetta vale 30 giorni: fino al 25/12/2026 compreso');
    expect(specialistValidityDays('2026-11-26', 'first')).toBeNull();
  });
});

describe('aggiunte della regione (D296)', () => {
  const national = rulesetAt('2026-11-26');

  it('si aggiungono alla versione nazionale: testo, fonti dopo le nazionali, valori, cose da completare', () => {
    const merged = withRegionalAdditions(national, additions());
    expect(merged.version).toBe(`2026-11-26.1+${REGION}@2026-11-26.1`);
    const r1 = merged.rules.find((r) => r.id === 'R1')!;
    const n1 = national.rules.find((r) => r.id === 'R1')!;
    expect(r1.text).toBe('La ricetta SSN vale 30 giorni; la specialistica 50 e 150 giorni');
    expect(r1.sources).toEqual([...n1.sources, { title: 'Regione di prova, atto inventato n. 1' }]);
    expect(r1.values).toEqual({
      validityDays: 30,
      specialistFirstAccessDays: 50,
      specialistOtherAccessDays: 150,
    });
    expect(r1.behavior).toBe(n1.behavior);
    expect(r1.regional).toEqual({
      region: REGION,
      version: '2026-11-26.1',
      sources: [{ title: 'Regione di prova, atto inventato n. 1' }],
    });
    const r9 = merged.rules.find((r) => r.id === 'R9')!;
    const n9 = national.rules.find((r) => r.id === 'R9')!;
    expect(r9.text).toBe(n9.text);
    expect(r9.toComplete).toEqual([...n9.toComplete, 'Da verificare con la regione di prova']);
    // Le regole senza aggiunte restano quelle nazionali, e la versione nazionale non cambia.
    expect(merged.rules.find((r) => r.id === 'R2')).toBe(national.rules.find((r) => r.id === 'R2'));
    expect(national.rules.find((r) => r.id === 'R1')!.regional).toBeUndefined();
    expect(merged.valuesSource).toContain('Atto inventato della regione di prova');
  });

  it('un valore o un elenco che la versione nazionale ha già, o una regola che non ha, è un errore', () => {
    const r1 = additions().rules[0]!;
    expect(() =>
      withRegionalAdditions(
        national,
        additions({ rules: [{ ...r1, values: { validityDays: 60 } }] }),
      ),
    ).toThrow(/cambiano validityDays di R1, già nella versione nazionale 2026-11-26\.1/);
    expect(() =>
      withRegionalAdditions(
        national,
        additions({
          rules: [{ id: 'R13', sources: r1.sources, lists: { substitutionReasons: ['9=prova'] } }],
        }),
      ),
    ).toThrow(/cambiano substitutionReasons di R13/);
    const old = rulesetAt('2026-11-24');
    expect(() =>
      withRegionalAdditions(old, additions({ rules: [{ id: 'R25', toComplete: ['prova'] }] })),
    ).toThrow(/toccano la regola R25, che non è nella versione nazionale 2026-11-24\.1/);
  });

  it('valgono dalla loro data, per la loro regione; senza regione restano le regole nazionali', () => {
    const regional = [
      additions(),
      additions({
        version: '2026-12-01.1',
        effectiveFrom: '2026-12-01',
        rules: [additions().rules[2]!],
      }),
    ];
    const at = (date: string, region: string | null) =>
      rulesetAt(date, undefined, region, regional).version;
    expect(at('2026-11-26', REGION)).toBe(`2026-11-26.1+${REGION}@2026-11-26.1`);
    expect(at('2026-11-30', REGION)).toBe(`2026-11-26.1+${REGION}@2026-11-26.1`);
    expect(at('2026-12-01', REGION)).toBe(`2026-11-26.1+${REGION}@2026-12-01.1`);
    // Prima delle aggiunte, per un'altra regione o senza regione: la versione nazionale.
    expect(at('2026-11-25', REGION)).toBe('2026-11-25.2');
    expect(at('2026-11-26', 'altra-regione')).toBe('2026-11-26.1');
    expect(at('2026-11-26', null)).toBe('2026-11-26.1');
  });

  it('il controllo e il promemoria prendono la regione dello studio dal contesto', () => {
    const regional = [additions()];
    const c = ctx({
      date: '2026-11-26',
      region: REGION,
      prescription: { kind: 'specialist_ssn', accessType: 'first' },
    });
    const result = checkPrescription(c, undefined, regional);
    expect(result.rulesVersion).toBe(`2026-11-26.1+${REGION}@2026-11-26.1`);
    const [issue] = result.issues.filter((i) => i.ruleId === 'R1');
    expect(issue!.message).toMatch(
      /^Primo accesso: la ricetta vale 50 giorni, fino al 14\/01\/2027/,
    );
    // La fonte mostrata è quella della regione, anche se non comincia con «Regione».
    const other = additions({
      rules: [{ ...additions().rules[0]!, sources: [{ title: 'Atto inventato n. 2' }] }],
    });
    expect(
      checkPrescription(c, undefined, [other]).issues.find((i) => i.ruleId === 'R1')!.source,
    ).toBe('Atto inventato n. 2');
    expect(specialistValidityDays('2026-11-26', 'subsequent', REGION, undefined, regional)).toBe(
      150,
    );
    expect(
      specialistValidityDays('2026-11-26', 'subsequent', null, undefined, regional),
    ).toBeNull();
  });

  it('lo schema rifiuta un’aggiunta vuota, un valore senza fonte e ciò che cambia il comportamento', () => {
    const base = { version: '2026-11-26.1', effectiveFrom: '2026-11-26', valuesSource: 'prova' };
    const parse = (rules: unknown[]) => regionalRulesetSchema.safeParse({ ...base, rules });
    expect(parse([{ id: 'R1', toComplete: ['prova'] }]).success).toBe(true);
    expect(parse([{ id: 'R1' }]).success).toBe(false);
    expect(parse([{ id: 'R1', values: { giorni: 10 } }]).success).toBe(false);
    expect(parse([{ id: 'R1', lists: { codici: ['A'] } }]).success).toBe(false);
    expect(parse([{ id: 'R1', behavior: 'warn', toComplete: ['prova'] }]).success).toBe(false);
    expect(parse([{ id: 'R1', status: 'out_of_scope', toComplete: ['prova'] }]).success).toBe(
      false,
    );
    expect(parse([{ id: 'R99', toComplete: ['prova'] }]).success).toBe(false);
    expect(
      parse([
        { id: 'R1', toComplete: ['prova'] },
        { id: 'R1', toComplete: ['ancora'] },
      ]).success,
    ).toBe(false);
    expect(parse([]).success).toBe(false);
  });
});

describe('aggiunte dei pacchetti regionali (D296)', () => {
  it('un pacchetto senza aggiunte non ne dà', () => {
    const empty: RegionalPackage = { ...REGIONAL_PACKAGES[0]!, key: 'pacchetto-senza-dati' };
    expect(loadRegionalRulesets([empty])).toEqual([]);
  });

  it('le aggiunte di ogni pacchetto si leggono e si uniscono alla versione nazionale della loro data e di oggi', () => {
    const regional = loadRegionalRulesets();
    expect(regional.length).toBeGreaterThan(0);
    const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(new Date());
    for (const r of regional) {
      expect(REGIONAL_PACKAGES.map((p) => p.key)).toContain(r.region);
      for (const date of [r.effectiveFrom, today]) {
        const merged = rulesetAt(date, undefined, r.region);
        expect(merged.version, `${r.region} ${date}`).toMatch(
          new RegExp(`^\\d{4}-\\d{2}-\\d{2}\\.\\d+\\+${r.region}@\\d{4}-\\d{2}-\\d{2}\\.\\d+$`),
        );
      }
    }
  });
});
