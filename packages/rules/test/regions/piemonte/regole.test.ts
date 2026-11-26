import { describe, expect, it } from 'vitest';
import {
  loadRegionalRulesets,
  loadRulesets,
  rulesetAt,
  specialistValidityDays,
  type Rule,
} from '../../../src';
import { ctx, of, run } from '../../helpers/contesto';

/**
 * Le regole di prescrizione del Piemonte (D260, D288, D296): fino alla versione nazionale
 * 2026-11-25.2 stavano fra quelle nazionali; dalla 2026-11-26 sono le aggiunte del pacchetto della
 * Regione (`packages/regions/piemonte/data/regole/`), per gli studi del Piemonte.
 */
const PIEMONTE = 'piemonte';

/** Una regola senza le notizie delle aggiunte, per confrontarla con quelle di prima. */
const plain = (r: Rule | undefined) => (r ? { ...r, regional: undefined } : r);

describe('aggiunte del Piemonte alle regole (D296)', () => {
  const added = loadRegionalRulesets().filter((r) => r.region === PIEMONTE);
  const before = loadRulesets().find((r) => r.version === '2026-11-25.2')!;
  const now = rulesetAt('2026-11-26', undefined, PIEMONTE);
  const rule = (id: string) => now.rules.find((r) => r.id === id);
  const old = (id: string) => before.rules.find((r) => r.id === id)!;

  it('la prima versione vale dal 26/11/2026, sopra la versione nazionale 2026-11-26.1', () => {
    expect(added.map((r) => [r.version, r.effectiveFrom])).toEqual([
      ['2026-11-26.1', '2026-11-26'],
    ]);
    expect(now.version).toBe('2026-11-26.1+piemonte@2026-11-26.1');
    expect(rulesetAt('2026-11-26').version).toBe('2026-11-26.1');
    // Prima del 26/11/2026 le parti della Regione sono nella versione nazionale di allora.
    expect(rulesetAt('2026-11-25', undefined, PIEMONTE).version).toBe('2026-11-25.2');
    expect(run(ctx({ date: '2026-11-26', region: PIEMONTE })).rulesVersion).toBe(now.version);
  });

  it('per uno studio del Piemonte le regole sono quelle della 2026-11-25.2, salvo quello che D196, D294 e D296 cambiano', () => {
    expect(now.rules.map((r) => r.id)).toEqual(before.rules.map((r) => r.id));
    // Spostate senza cambiarle: testo, fonti nello stesso ordine, valori.
    for (const id of ['R1', 'R5', 'R18']) expect(plain(rule(id)), id).toEqual(old(id));
    // R17: in più l'allegato C della D.D. 1452/2023, che ha sostituito l'elenco della 1167 (D196).
    expect(rule('R17')!.sources.slice(0, -1)).toEqual(old('R17').sources);
    expect(rule('R17')!.sources.at(-1)!.title).toMatch(
      /^Regione Piemonte, D\.D\. 6 luglio 2023, n\. 1452.*D196/,
    );
    // R9: prima l'anagrafe regionale con le parole nazionali, poi AURA.
    expect(rule('R9')!.sources.map((s) => s.title)).toEqual([
      'Anagrafe regionale degli assistiti e catalogo delle esenzioni',
      "AURA, l'anagrafe degli assistiti della Regione Piemonte",
    ]);
    // R11: la fonte senza il consulente regolatorio (D294).
    expect(old('R11').sources[0]!.title).toMatch(/consulente regolatorio \(MDR\)/);
    expect(rule('R11')!.sources[0]!.title).toBe(
      'Buona pratica, da validare con la Dr.ssa Rocca (fuori dal dispositivo medico, D294)',
    );
    // Che cosa manca: le parole della Regione dopo quelle nazionali.
    expect(rule('R4')!.toComplete.at(-1)).toMatch(/regole del Piemonte/);
    expect(rule('R23')!.toComplete.at(-1)).toMatch(/domanda per il CSI/);
    expect(rule('R10')!.toComplete[1]).toMatch(/servizio che riceve la ricetta/);
    for (const r of now.rules) {
      expect(r.behavior, r.id).toBe(old(r.id).behavior);
      expect(r.status, r.id).toBe(old(r.id).status);
      expect(r.values, r.id).toEqual(old(r.id).values);
      expect(r.lists, r.id).toEqual(old(r.id).lists);
      if (!['R4', 'R9', 'R10', 'R11', 'R17', 'R23'].includes(r.id))
        expect(plain(r), r.id).toEqual(old(r.id));
    }
  });

  it('le fonti della Regione portano la versione delle aggiunte', () => {
    expect(rule('R1')!.regional).toEqual({
      region: PIEMONTE,
      version: '2026-11-26.1',
      sources: old('R1').sources.slice(1),
    });
    expect(rule('R2')!.regional).toBeUndefined();
  });
});

describe('R1 · validità della ricetta specialistica (D.D. 710/2026, D260)', () => {
  const specialist = (
    accessType: 'first' | 'subsequent' | null,
    date = '2026-11-24',
    region: string | null = null,
  ) => of(ctx({ date, region, prescription: { kind: 'specialist_ssn', accessType } }), 'R1');

  it('dalla 2026-11-24.1 R1 ha i giorni della specialistica della Regione; il resto come la 2026-11-20.1', () => {
    const all = loadRulesets();
    const v7 = all.find((r) => r.version === '2026-11-20.1')!;
    const v8 = all.find((r) => r.version === '2026-11-24.1')!;
    expect(v8.effectiveFrom).toBe('2026-11-24');
    expect(rulesetAt('2026-11-24').version).toBe('2026-11-24.1');
    expect(rulesetAt('2026-11-23').version).toBe('2026-11-20.1');
    expect(v8.rules).toHaveLength(v7.rules.length);
    for (const r of v8.rules) {
      if (r.id === 'R1') {
        expect(r.values).toEqual({
          validityDays: 30,
          specialistFirstAccessDays: 60,
          specialistOtherAccessDays: 180,
        });
        expect(r.behavior).toBe('inform');
        expect(r.sources[0]).toEqual(v7.rules.find((x) => x.id === 'R1')!.sources[0]);
        expect(r.sources[1]!.title).toMatch(/^Regione Piemonte, D\.D\. 30 ottobre 2026, n\. 710/);
        expect(r.sources[1]!.title).toMatch(/punto 4/);
        expect(r.sources.at(-1)!.title).toMatch(/D260/);
      } else {
        expect(r, r.id).toEqual(v7.rules.find((x) => x.id === r.id));
      }
    }
  });

  it('primo accesso: 60 giorni, contando il giorno di compilazione, con la fonte della Regione', () => {
    const [issue, ...rest] = specialist('first');
    expect(rest).toEqual([]);
    expect(issue!.severity).toBe('info');
    expect(issue!.message).toBe(
      'Primo accesso: la ricetta vale 60 giorni, fino al 22/01/2027 compreso; se la prestazione si prenota è il termine per prenotare, e la ricetta prenotata in tempo vale fino all’erogazione',
    );
    expect(issue!.source).toMatch(/^Regione Piemonte, D\.D\. 30 ottobre 2026, n\. 710.*punto 4/);
  });

  it('dal 26/11/2026 gli stessi giorni e la stessa fonte vengono dalle aggiunte della Regione', () => {
    const [issue, ...rest] = specialist('first', '2026-11-26', PIEMONTE);
    expect(rest).toEqual([]);
    expect(issue!.message).toMatch(
      /^Primo accesso: la ricetta vale 60 giorni, fino al 24\/01\/2027/,
    );
    expect(issue!.source).toMatch(/^Regione Piemonte, D\.D\. 30 ottobre 2026, n\. 710.*punto 4/);
    expect(specialist('subsequent', '2026-11-26', PIEMONTE)[0]!.message).toMatch(
      /^Altra tipologia di accesso: la ricetta vale 180 giorni/,
    );
    // Uno studio di una regione senza pacchetto ha il termine dei requisiti, come prima di D260.
    expect(specialist('first', '2026-11-26')[0]!.message).toBe(
      'La ricetta vale 30 giorni: fino al 25/12/2026 compreso',
    );
  });

  it('altra tipologia di accesso (successivo o diretto): 180 giorni', () => {
    expect(specialist('subsequent')[0]!.message).toMatch(
      /^Altra tipologia di accesso: la ricetta vale 180 giorni, fino al 22\/05\/2027 compreso;/,
    );
  });

  it('senza tipo di accesso dice tutti e due i termini (R14 ferma comunque la ricetta)', () => {
    expect(specialist(null)[0]!.message).toMatch(
      /^La ricetta vale 60 giorni per il primo accesso e 180 per gli altri accessi;/,
    );
  });

  it('la ricetta dei farmaci resta a 30 giorni, con la fonte di prima', () => {
    for (const [date, region, until] of [
      ['2026-11-24', null, '23/12/2026'],
      ['2026-11-26', PIEMONTE, '25/12/2026'],
    ] as const) {
      const [issue] = of(ctx({ date, region }), 'R1');
      expect(issue!.message).toBe(`La ricetta vale 30 giorni: fino al ${until} compreso`);
      expect(issue!.source).toBe('Tabella AIFA di classificazione dei medicinali');
    }
  });

  it('con le versioni di prima anche la specialistica vale 30 giorni', () => {
    expect(specialist('first', '2026-11-23')[0]!.message).toBe(
      'La ricetta vale 30 giorni: fino al 22/12/2026 compreso',
    );
  });

  it('il promemoria prende gli stessi giorni dalla versione in vigore, con la regione dello studio', () => {
    expect(specialistValidityDays('2026-11-24', 'first')).toBe(60);
    expect(specialistValidityDays('2026-11-24', 'subsequent')).toBe(180);
    expect(specialistValidityDays('2026-11-23', 'first')).toBeNull();
    expect(specialistValidityDays('2026-11-26', 'first', PIEMONTE)).toBe(60);
    expect(specialistValidityDays('2026-11-26', 'subsequent', PIEMONTE)).toBe(180);
    expect(specialistValidityDays('2026-11-26', 'first')).toBeNull();
  });
});
