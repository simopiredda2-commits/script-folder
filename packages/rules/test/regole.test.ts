import { buildFiscalCode } from '@mmg/domain';
import { describe, expect, it } from 'vitest';
import {
  checkPrescription,
  loadRulesets,
  RULE_IDS,
  rulesetAt,
  specialistValidityDays,
  type DrugFacts,
  type LineContext,
  type RuleContext,
  type SentLineContext,
} from '../src';

const CF = buildFiscalCode({
  surname: 'Rota',
  name: 'Lina',
  birthDate: '1950-03-14',
  sex: 'F',
  placeCode: 'X101',
});

function line(extra: Partial<LineContext> = {}): LineContext {
  return {
    id: 'l1',
    drugAic: 'AIC-PROVA-1',
    drugName: 'Farmaco di prova 5 mg',
    activeIngredient: 'principio di prova',
    serviceCode: null,
    quantity: 1,
    aifaNote: null,
    notSubstitutable: false,
    notSubstitutableReason: null,
    therapy: null,
    ...extra,
  };
}

function ctx(
  over: Partial<Omit<RuleContext, 'prescription'>> & {
    prescription?: Partial<RuleContext['prescription']>;
    facts?: DrugFacts;
  } = {},
): RuleContext {
  const { prescription, facts, ...rest } = over;
  return {
    date: '2026-11-18',
    prescription: {
      id: 'p1',
      kind: 'pharma_ssn',
      exemptionCode: null,
      priority: null,
      accessType: null,
      diagnosticQuestion: null,
      reminderChannel: null,
      reminderContact: null,
      lines: [line()],
      ...prescription,
    },
    patient: {
      fiscalCode: CF,
      email: 'lina.rota@example.org',
      phone: '+39 000 1234567',
      reminderChannel: null,
      reminderContact: null,
      reminderChannelChosenOn: null,
    },
    exemptions: [],
    delegations: [],
    plans: [],
    sentLines: [],
    drugFacts: () => facts,
    confirmedAifaNotes: new Set(),
    reasons: {},
    ...rest,
  };
}

const run = (c: RuleContext) => checkPrescription(c);
const of = (c: RuleContext, id: string) => run(c).issues.filter((i) => i.ruleId === id);
const blocks = (c: RuleContext, id: string) =>
  run(c).blocking.filter((i) => i.ruleId === id).length > 0;

describe('dati delle regole', () => {
  const [ruleset] = loadRulesets();

  it('ogni versione è valida e contiene R1–R17 una volta ciascuna; R18 dalla .3, R19 e R20 dalla 2026-11-19.2, R21 dalla 2026-11-19.3, R22 dalla 2026-11-20.1', () => {
    const all = loadRulesets();
    expect(all.map((r) => r.version)).toEqual([
      '2026-11-18.1',
      '2026-11-18.2',
      '2026-11-18.3',
      '2026-11-19.1',
      '2026-11-19.2',
      '2026-11-19.3',
      '2026-11-20.1',
      '2026-11-24.1',
    ]);
    const upTo17 = RULE_IDS.filter((id) => !['R18', 'R19', 'R20', 'R21', 'R22'].includes(id));
    for (const rs of all.slice(0, 2)) {
      expect(rs.rules.map((r) => r.id).sort()).toEqual([...upTo17].sort());
    }
    for (const rs of all.slice(2, 4)) {
      expect(rs.rules.map((r) => r.id).sort(), rs.version).toEqual([...upTo17, 'R18'].sort());
    }
    expect(all[4]!.rules.map((r) => r.id).sort()).toEqual([...upTo17, 'R18', 'R19', 'R20'].sort());
    expect(all[5]!.rules.map((r) => r.id).sort()).toEqual(
      [...upTo17, 'R18', 'R19', 'R20', 'R21'].sort(),
    );
    for (const rs of all.slice(6)) {
      expect(rs.rules.map((r) => r.id).sort(), rs.version).toEqual([...RULE_IDS].sort());
    }
  });

  it('dal 19/11/2026 R6 e R11 contano le ricette di altri programmi (D181); il resto come la .3', () => {
    const all = loadRulesets();
    const v3 = all.find((r) => r.version === '2026-11-18.3')!;
    const v4 = all.find((r) => r.version === '2026-11-19.1')!;
    expect(v4.effectiveFrom).toBe('2026-11-19');
    for (const r of v4.rules) {
      const before = v3.rules.find((x) => x.id === r.id)!;
      if (r.id === 'R6' || r.id === 'R11') {
        expect(r.values, r.id).toEqual({ ...before.values, countOtherPrograms: 1 });
        expect(r.behavior, r.id).toBe(before.behavior);
        expect(r.sources.at(-1)!.title, r.id).toMatch(/D181/);
      } else {
        expect(r, r.id).toEqual(before);
      }
    }
    expect(
      rulesetAt(
        '2026-11-19',
        all.filter((r) => !['2026-11-19.2', '2026-11-19.3'].includes(r.version)),
      ).version,
    ).toBe('2026-11-19.1');
  });

  it('dalla 2026-11-19.2 R19 blocca e R20 avvisa (D199); il resto come la 2026-11-19.1', () => {
    const all = loadRulesets();
    const v4 = all.find((r) => r.version === '2026-11-19.1')!;
    const v5 = all.find((r) => r.version === '2026-11-19.2')!;
    expect(v5.effectiveFrom).toBe('2026-11-19');
    expect(
      rulesetAt(
        '2026-11-19',
        all.filter((r) => r.version !== '2026-11-19.3'),
      ).version,
    ).toBe('2026-11-19.2');
    for (const r of v5.rules) {
      if (r.id === 'R19' || r.id === 'R20') {
        expect(r.behavior, r.id).toBe(r.id === 'R19' ? 'block' : 'warn');
        expect(r.sources[0]!.title, r.id).toMatch(/D199/);
      } else {
        expect(r, r.id).toEqual(v4.rules.find((x) => x.id === r.id));
      }
    }
  });

  it('dalla 2026-11-19.3 R21 informa sui farmaci carenti (D202); il resto come la 2026-11-19.2', () => {
    const all = loadRulesets();
    const v5 = all.find((r) => r.version === '2026-11-19.2')!;
    const v6 = all.find((r) => r.version === '2026-11-19.3')!;
    expect(v6.effectiveFrom).toBe('2026-11-19');
    expect(rulesetAt('2026-11-19').version).toBe('2026-11-19.3');
    expect(
      rulesetAt(
        '2026-11-20',
        all.filter((r) => r.version !== '2026-11-20.1'),
      ).version,
    ).toBe('2026-11-19.3');
    for (const r of v6.rules) {
      if (r.id === 'R21') {
        expect(r.behavior).toBe('inform');
        expect(r.sources[0]!.url).toBe('https://www.aifa.gov.it/liste-dei-farmaci');
        expect(r.sources.at(-1)!.title).toMatch(/D202/);
      } else {
        expect(r, r.id).toEqual(v5.rules.find((x) => x.id === r.id));
      }
    }
  });

  it('dalla 2026-11-20.1 R22 informa sulla confezione sospesa (D210); il resto come la 2026-11-19.3', () => {
    const all = loadRulesets();
    const v6 = all.find((r) => r.version === '2026-11-19.3')!;
    const v7 = all.find((r) => r.version === '2026-11-20.1')!;
    expect(v7.effectiveFrom).toBe('2026-11-20');
    expect(rulesetAt('2026-11-20').version).toBe('2026-11-20.1');
    expect(v7.rules).toHaveLength(v6.rules.length + 1);
    for (const r of v7.rules) {
      if (r.id === 'R22') {
        expect(r.behavior).toBe('inform');
        expect(r.status).toBe('active');
        expect(r.sources[0]!.url).toBe('https://www.aifa.gov.it/liste-dei-farmaci');
        expect(r.sources[0]!.title).toMatch(/STATO_AMMINISTRATIVO/);
        expect(r.sources.at(-1)!.title).toMatch(/D210/);
      } else {
        expect(r, r.id).toEqual(v6.rules.find((x) => x.id === r.id));
      }
    }
  });

  it('dalla 2026-11-24.1 R1 ha i giorni della specialistica della Regione (D260); il resto come la 2026-11-20.1', () => {
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

  it('la versione .2 rende R11 solo informativo (seconda fermata); la .1 resta com’era', () => {
    const [v1, v2] = loadRulesets();
    expect(v1!.rules.find((r) => r.id === 'R11')!.behavior).toBe('warn');
    expect(v2!.rules.find((r) => r.id === 'R11')!.behavior).toBe('inform');
  });

  it('ogni regola ha una fonte; le regole che bloccano hanno valori non vuoti', () => {
    for (const r of ruleset!.rules) {
      expect(r.sources.length, r.id).toBeGreaterThan(0);
      for (const v of Object.values(r.values)) expect(v, r.id).not.toBeNull();
    }
  });

  it('R12 è fuori perimetro, come dicono i requisiti', () => {
    expect(ruleset!.rules.find((r) => r.id === 'R12')!.status).toBe('out_of_scope');
  });

  it('i valori sono quelli della tabella dei requisiti', () => {
    const v = (id: string) => ruleset!.rules.find((r) => r.id === id)!.values;
    expect(v('R1')).toEqual({ validityDays: 30 });
    expect(v('R2')).toEqual({ maxPacks: 2 });
    expect(v('R3')).toEqual({ maxPacks: 6 });
    expect(v('R4')).toEqual({ maxPacks: 6, minTreatmentMonths: 6, maxTherapyDays: 180 });
    expect(v('R5')).toEqual({ expiryWarningDays: 30 });
    expect(v('R11')).toEqual({ coverageThreshold: 0.8 });
  });

  it('si usa la versione in vigore alla data della ricetta', () => {
    // A parità di data vale la versione con il numero più alto.
    expect(rulesetAt('2026-11-18').version).toBe('2026-11-18.3');
    expect(() => rulesetAt('2026-11-17')).toThrow(/Nessuna versione/);
    const later = { ...ruleset!, version: '2027-01-01.1', effectiveFrom: '2027-01-01' };
    expect(rulesetAt('2026-12-31', [ruleset!, later]).version).toBe('2026-11-18.1');
    expect(rulesetAt('2027-01-01', [ruleset!, later]).version).toBe('2027-01-01.1');
  });

  it('la versione usata resta nel risultato', () => {
    expect(run(ctx()).rulesVersion).toBe('2026-11-18.3');
  });
});

describe('R1 · validità di 30 giorni', () => {
  it('indica fino a quando vale, contando il giorno di compilazione', () => {
    expect(of(ctx(), 'R1')[0]!.message).toContain('17/12/2026');
  });
  it('non riguarda la ricetta bianca', () => {
    expect(of(ctx({ prescription: { kind: 'white' } }), 'R1')).toHaveLength(0);
  });
});

describe('R1 · validità della ricetta specialistica (D.D. 710/2026, D260)', () => {
  const specialist = (accessType: 'first' | 'subsequent' | null, date = '2026-11-24') =>
    of(ctx({ date, prescription: { kind: 'specialist_ssn', accessType } }), 'R1');

  it('primo accesso: 60 giorni, contando il giorno di compilazione, con la fonte della Regione', () => {
    const [issue, ...rest] = specialist('first');
    expect(rest).toEqual([]);
    expect(issue!.severity).toBe('info');
    expect(issue!.message).toBe(
      'Primo accesso: la ricetta vale 60 giorni, fino al 22/01/2027 compreso; se la prestazione si prenota è il termine per prenotare, e la ricetta prenotata in tempo vale fino all’erogazione',
    );
    expect(issue!.source).toMatch(/^Regione Piemonte, D\.D\. 30 ottobre 2026, n\. 710.*punto 4/);
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
    const [issue] = of(ctx({ date: '2026-11-24' }), 'R1');
    expect(issue!.message).toBe('La ricetta vale 30 giorni: fino al 23/12/2026 compreso');
    expect(issue!.source).toBe('Tabella AIFA di classificazione dei medicinali');
  });

  it('con le versioni di prima anche la specialistica vale 30 giorni', () => {
    expect(specialist('first', '2026-11-23')[0]!.message).toBe(
      'La ricetta vale 30 giorni: fino al 22/12/2026 compreso',
    );
  });

  it('il promemoria prende gli stessi giorni dalla versione in vigore', () => {
    expect(specialistValidityDays('2026-11-24', 'first')).toBe(60);
    expect(specialistValidityDays('2026-11-24', 'subsequent')).toBe(180);
    expect(specialistValidityDays('2026-11-23', 'first')).toBeNull();
  });
});

describe('R2, R3, R4 · confezioni per ricetta', () => {
  it('2 confezioni passano, 3 bloccano e propongono di dividere', () => {
    expect(blocks(ctx({ prescription: { lines: [line({ quantity: 2 })] } }), 'R2')).toBe(false);
    const c = ctx({ prescription: { lines: [line({ quantity: 3 })] } });
    expect(blocks(c, 'R2')).toBe(true);
    expect(of(c, 'R2')[0]!.message).toMatch(/Dividi in 2 ricette/);
  });
  it('il limite conta tutte le righe della ricetta', () => {
    const c = ctx({ prescription: { lines: [line({ id: 'a' }), line({ id: 'b', quantity: 2 })] } });
    expect(blocks(c, 'R2')).toBe(true);
  });
  it('R3: antibiotici iniettabili e infusioni fino a 6, non 7', () => {
    const facts = { injectableAntibioticOrInfusion: true };
    expect(
      run(ctx({ facts, prescription: { lines: [line({ quantity: 6 })] } })).blocking,
    ).toHaveLength(0);
    expect(blocks(ctx({ facts, prescription: { lines: [line({ quantity: 7 })] } }), 'R3')).toBe(
      true,
    );
  });

  const chronic = (startOn: string, unitsPerDay = 1) =>
    line({
      quantity: 6,
      therapy: {
        id: 't1',
        kind: 'chronic',
        startOn,
        unitsPerDay,
        multiPrescription: true,
        therapeuticPlanId: null,
      },
    });
  const r4 = (l: LineContext, unitsPerPack = 28, exemption = true) =>
    ctx({
      facts: { unitsPerPack },
      prescription: { lines: [l], exemptionCode: exemption ? '0A31' : null },
      exemptions: [{ code: '0A31', validFrom: '2020-01-01', validTo: null }],
    });

  it('R4: cronica da almeno 6 mesi, con esenzione e entro 180 giorni: fino a 6', () => {
    expect(run(r4(chronic('2026-05-18'))).blocking).toHaveLength(0);
  });
  it('R4: 7 confezioni bloccano anche con tutte le condizioni', () => {
    // Due unità al giorno: 7 × 28 / 2 = 98 giorni, entro i 180; supera solo il limite di 6.
    const c = r4({ ...chronic('2026-05-18', 2), quantity: 7 });
    expect(blocks(c, 'R4')).toBe(true);
  });
  it('R4: in trattamento da meno di 6 mesi resta il limite di 2', () => {
    const c = r4(chronic('2026-05-19'));
    expect(blocks(c, 'R2')).toBe(true);
    expect(of(c, 'R2')[0]!.message).toMatch(/almeno 6 mesi/);
  });
  it('R4: oltre 180 giorni di terapia resta il limite di 2', () => {
    // 6 confezioni da 28 unità, mezza unità al giorno: 336 giorni.
    expect(blocks(r4(chronic('2026-01-01', 0.5)), 'R2')).toBe(true);
  });
  it('R4: senza esenzione valida o senza «Multiprescrizione» resta il limite di 2', () => {
    expect(blocks(r4(chronic('2026-01-01'), 28, false), 'R2')).toBe(true);
    const noMulti = chronic('2026-01-01');
    noMulti.therapy!.multiPrescription = false;
    expect(of(r4(noMulti), 'R2')[0]!.message).toMatch(/Multiprescrizione/);
  });
  it('R4: senza unità per confezione (banca dati) i giorni non si calcolano: limite di 2', () => {
    const c = ctx({
      facts: {},
      prescription: { lines: [chronic('2026-01-01')], exemptionCode: '0A31' },
      exemptions: [{ code: '0A31', validFrom: '2020-01-01', validTo: null }],
    });
    expect(of(c, 'R2')[0]!.message).toMatch(/unità per confezione/);
  });
});

describe('R5, R6 · piano terapeutico', () => {
  const plan = (expiresOn: string, packsAuthorized: number | null = null) => ({
    id: 'pt1',
    drugAic: 'AIC-PROVA-1',
    activeIngredient: null,
    grantedOn: '2026-01-01',
    expiresOn,
    packsAuthorized,
  });

  it('farmaco con piano obbligatorio e piano assente: blocca la ricetta SSN', () => {
    expect(blocks(ctx({ facts: { requiresPlan: true } }), 'R5')).toBe(true);
  });
  it('piano che scade oggi: vale, con l’avviso della scadenza', () => {
    const c = ctx({ facts: { requiresPlan: true }, plans: [plan('2026-11-18')] });
    expect(blocks(c, 'R5')).toBe(false);
    expect(of(c, 'R5')[0]!.message).toMatch(/scade il 18\/11\/2026/);
  });
  it('piano scaduto ieri: blocca, con la data', () => {
    const c = ctx({ facts: { requiresPlan: true }, plans: [plan('2026-11-17')] });
    expect(of(c, 'R5')[0]!.message).toMatch(/scaduto il 17\/11\/2026/);
    expect(blocks(c, 'R5')).toBe(true);
  });
  it('avviso 30 giorni prima, non 31', () => {
    expect(
      of(ctx({ facts: { requiresPlan: true }, plans: [plan('2026-12-18')] }), 'R5'),
    ).toHaveLength(1);
    expect(
      of(ctx({ facts: { requiresPlan: true }, plans: [plan('2026-12-19')] }), 'R5'),
    ).toHaveLength(0);
  });
  it('senza banca dati vale il piano collegato alla terapia', () => {
    const l = line({
      therapy: {
        id: 't',
        kind: 'chronic',
        startOn: '2026-01-01',
        unitsPerDay: 1,
        multiPrescription: false,
        therapeuticPlanId: 'pt1',
      },
    });
    expect(blocks(ctx({ prescription: { lines: [l] }, plans: [plan('2026-11-01')] }), 'R5')).toBe(
      true,
    );
  });
  it('sulla ricetta bianca non blocca', () => {
    expect(
      blocks(ctx({ facts: { requiresPlan: true }, prescription: { kind: 'white' } }), 'R5'),
    ).toBe(false);
  });
  it('R6: oltre le confezioni del piano blocca e mostra il residuo', () => {
    const sent = [
      {
        therapyId: null,
        drugAic: 'AIC-PROVA-1',
        activeIngredient: null,
        quantity: 3,
        sentOn: '2026-10-01',
      },
    ];
    const base = { facts: { requiresPlan: true }, plans: [plan('2027-01-01', 4)], sentLines: sent };
    expect(blocks(ctx({ ...base, prescription: { lines: [line({ quantity: 1 })] } }), 'R6')).toBe(
      false,
    );
    const over = ctx({ ...base, prescription: { lines: [line({ quantity: 2 })] } });
    expect(of(over, 'R6')[0]!.message).toMatch(/residuo 1/);
  });

  // Ricette fatte con altri programmi (D176), importate: senza terapia collegata.
  const other = (extra: Partial<SentLineContext> = {}): SentLineContext => ({
    therapyId: null,
    drugAic: 'AIC-PROVA-1',
    activeIngredient: null,
    quantity: 2,
    sentOn: '2026-10-15',
    otherProgram: { name: 'Programma di prova' },
    ...extra,
  });

  it('R6 dalla versione del 19/11/2026: le ricette di altri programmi contano, e il messaggio lo dice', () => {
    const sent = [
      {
        therapyId: null,
        drugAic: 'AIC-PROVA-1',
        activeIngredient: null,
        quantity: 1,
        sentOn: '2026-10-01',
      },
      other(),
    ];
    const c = ctx({
      date: '2026-11-25',
      facts: { requiresPlan: true },
      plans: [plan('2027-01-01', 4)],
      sentLines: sent,
      prescription: { lines: [line({ quantity: 2 })] },
    });
    // In vigore il 25/11/2026: la 2026-11-24.1, con R6 come nella 2026-11-19.1 (D181).
    expect(run(c).rulesVersion).toBe('2026-11-24.1');
    expect(blocks(c, 'R6')).toBe(true);
    expect(of(c, 'R6')[0]!.message).toBe(
      'Farmaco di prova 5 mg: il piano autorizza 4 confezioni, già prescritte 3, di cui 2 con un altro programma; residuo 1',
    );
    // Stesso principio attivo scritto diversamente: è lo stesso farmaco.
    const byIngredient = ctx({
      date: '2026-11-25',
      facts: { requiresPlan: true },
      plans: [{ ...plan('2027-01-01', 4), drugAic: null, activeIngredient: 'principio di prova' }],
      sentLines: [
        other({ drugAic: 'AIC-ALTRO', activeIngredient: ' Principio  di PROVA ', quantity: 3 }),
      ],
      prescription: { lines: [line({ quantity: 2 })] },
    });
    expect(of(byIngredient, 'R6')[0]!.message).toMatch(
      /già prescritte 3, di cui 3 con un altro programma; residuo 1/,
    );
  });

  it('R6 con le versioni di prima: le ricette di altri programmi non contano', () => {
    const c = ctx({
      date: '2026-11-18',
      facts: { requiresPlan: true },
      plans: [plan('2027-01-01', 4)],
      sentLines: [other({ quantity: 3 })],
      prescription: { lines: [line({ quantity: 2 })] },
    });
    expect(run(c).rulesVersion).toBe('2026-11-18.3');
    expect(of(c, 'R6')).toEqual([]);
  });

  it('R6: una ricetta di un altro programma senza confezioni non si conta, e lo si dice', () => {
    const c = ctx({
      date: '2026-11-25',
      facts: { requiresPlan: true },
      plans: [plan('2027-01-01', 4)],
      sentLines: [other({ quantity: null })],
      prescription: { lines: [line({ quantity: 1 })] },
    });
    expect(blocks(c, 'R6')).toBe(false);
    const [info] = of(c, 'R6');
    expect(info!.severity).toBe('info');
    expect(info!.message).toBe(
      'Farmaco di prova 5 mg: la ricetta del 15/10/2026 fatta con un altro programma (Programma di prova) non dice quante confezioni: il residuo del piano non la conta',
    );
  });
});

describe('R7 · nota AIFA', () => {
  it('nota non confermata: blocca e chiede la conferma', () => {
    const c = ctx({ prescription: { lines: [line({ aifaNote: '13' })] } });
    expect(of(c, 'R7')[0]!.needs).toBe('aifa_confirmation');
    expect(blocks(c, 'R7')).toBe(true);
  });
  it('nota confermata dal medico: passa e la conferma resta nel risultato', () => {
    const c = ctx({
      prescription: { lines: [line({ aifaNote: '13' })] },
      confirmedAifaNotes: new Set(['l1']),
    });
    expect(blocks(c, 'R7')).toBe(false);
    expect(run(c).confirmedAifaNotes).toEqual(['l1']);
  });
  it('vale anche la nota della banca dati', () => {
    expect(blocks(ctx({ facts: { aifaNote: '79' } }), 'R7')).toBe(true);
  });
});

describe('R8 · classe e regime di fornitura', () => {
  it('farmaco non in banca dati: non verificabile, senza bloccare', () => {
    const i = of(ctx(), 'R8');
    expect(i[0]!.severity).toBe('info');
  });
  it('non a carico del SSN o non prescrivibile dal medico di famiglia: blocca', () => {
    expect(blocks(ctx({ facts: { reimbursableSsn: false } }), 'R8')).toBe(true);
    expect(blocks(ctx({ facts: { reimbursableSsn: true, mmgPrescribable: false } }), 'R8')).toBe(
      true,
    );
    expect(blocks(ctx({ facts: { reimbursableSsn: true, mmgPrescribable: true } }), 'R8')).toBe(
      false,
    );
  });
  it('fuori dagli elenchi di classe A e H in vigore: informa, senza bloccare (D59, D261)', () => {
    const i = of(ctx({ facts: { listedClass: null } }), 'R8');
    expect(i).toEqual([
      expect.objectContaining({
        severity: 'info',
        lineId: 'l1',
        message: expect.stringMatching(
          /: non è negli elenchi AIFA dei farmaci di classe A e H in vigore; la banca dati non dice se è a carico del SSN\. Se non lo è, si prescrive su ricetta bianca$/,
        ),
      }),
    ]);
    expect(blocks(ctx({ facts: { listedClass: null } }), 'R8')).toBe(false);
    // Classe A o H negli elenchi, o nessun elenco in vigore: niente da dire.
    expect(of(ctx({ facts: { listedClass: 'A', reimbursableSsn: true } }), 'R8')).toEqual([]);
    expect(of(ctx({ facts: { listedClass: 'H' } }), 'R8')).toEqual([]);
    expect(of(ctx({ facts: {} }), 'R8')).toEqual([]);
    // Sulla ricetta bianca la R8 non guarda la classe.
    expect(
      of(ctx({ prescription: { kind: 'white' }, facts: { listedClass: null } }), 'R8'),
    ).toEqual([]);
  });
});

describe('R9 · esenzione valida', () => {
  const ex = (validTo: string | null) => [{ code: '048', validFrom: '2026-01-01', validTo }];
  it('valida fino a oggi: passa; scaduta ieri: blocca', () => {
    expect(
      blocks(ctx({ prescription: { exemptionCode: '048' }, exemptions: ex('2026-11-18') }), 'R9'),
    ).toBe(false);
    const c = ctx({ prescription: { exemptionCode: '048' }, exemptions: ex('2026-11-17') });
    expect(of(c, 'R9')[0]!.message).toMatch(/scaduta il 17\/11\/2026/);
  });
  it('non registrata per il paziente o inesistente nel catalogo: blocca', () => {
    expect(of(ctx({ prescription: { exemptionCode: '048' } }), 'R9')[0]!.message).toMatch(
      /non è registrata/,
    );
    const c = ctx({
      prescription: { exemptionCode: 'XXX' },
      exemptions: [{ code: 'XXX', validFrom: '2020-01-01', validTo: null }],
      exemptionExists: () => false,
    });
    expect(of(c, 'R9')[0]!.message).toMatch(/non esiste/);
  });
});

describe('R10 · controlli formali', () => {
  it('codice fiscale non valido: blocca', () => {
    const c = ctx();
    c.patient.fiscalCode = `${CF.slice(0, 15)}${CF[15] === 'A' ? 'B' : 'A'}`;
    expect(blocks(c, 'R10')).toBe(true);
  });
  it('quantità zero o riga di specialistica senza codice: blocca', () => {
    expect(blocks(ctx({ prescription: { lines: [line({ quantity: 0 })] } }), 'R10')).toBe(true);
    const spec = ctx({
      prescription: {
        kind: 'specialist_ssn',
        accessType: 'subsequent',
        diagnosticQuestion: 'Controllo',
        lines: [line({ serviceCode: null })],
      },
    });
    expect(blocks(spec, 'R10')).toBe(true);
  });
});

describe('R10 e R18 · i due codici della specialistica (D154)', () => {
  // Sistema TS, prescrizione (5/12/2024): codProdPrest (nomenclatore) e codCatalogoPrescr
  // (catalogo regionale) obbligatori; il Sistema TS controlla la coppia sul catalogo della Regione.
  const catalog = new Map([['90271.0', { nationalCode: '90.27.1' }]]);
  const spec = (extra: Partial<LineContext>, over: Partial<RuleContext> = {}) =>
    ctx({
      prescription: {
        kind: 'specialist_ssn',
        accessType: 'subsequent',
        diagnosticQuestion: 'Controllo',
        lines: [line({ drugAic: null, drugName: null, activeIngredient: null, ...extra })],
      },
      serviceCatalog: (code) => catalog.get(code) ?? null,
      ...over,
    });

  it('dal catalogo in uso il codice del nomenclatore si ricava: niente blocco', () => {
    expect(blocks(spec({ serviceCode: '90271.0' }), 'R10')).toBe(false);
    expect(of(spec({ serviceCode: '90271.0' }), 'R18')).toEqual([]);
  });

  it('codice del nomenclatore diverso da quello del catalogo: blocca', () => {
    const c = spec({ serviceCode: '90271.0', serviceNationalCode: '90.27.2' });
    expect(blocks(c, 'R10')).toBe(true);
    expect(of(c, 'R10')[0]!.message).toMatch(
      /non corrisponde a quello del catalogo in uso \(90\.27\.1\)/,
    );
    // Punti e spazi non contano.
    expect(blocks(spec({ serviceCode: '90271.0', serviceNationalCode: '90271' }), 'R10')).toBe(
      false,
    );
  });

  it('codice scritto a mano, fuori dal catalogo in uso: R10 vuole il codice del nomenclatore', () => {
    expect(blocks(spec({ serviceCode: '99999.9' }), 'R10')).toBe(true);
    expect(blocks(spec({ serviceCode: '99999.9', serviceNationalCode: '99.99.9' }), 'R10')).toBe(
      false,
    );
  });

  it('R18: fuori dal catalogo in uso avvisa e chiede un motivo; con il motivo lo registra', () => {
    const manual = { serviceCode: '99999.9', serviceNationalCode: '99.99.9' };
    const warn = of(spec(manual), 'R18');
    expect(warn).toHaveLength(1);
    expect(warn[0]).toMatchObject({ severity: 'warn', needs: 'reason' });
    expect(blocks(spec(manual), 'R18')).toBe(true);
    const ok = spec(manual, {
      reasons: { R18: 'Codice nuovo, catalogo del programma non ancora aggiornato' },
    });
    expect(blocks(ok, 'R18')).toBe(false);
    expect(of(ok, 'R18')[0]!.message).toMatch(/motivo registrato: Codice nuovo/);
  });

  it('senza un catalogo importato R18 tace e R10 vuole il codice sulla riga', () => {
    const none = spec({ serviceCode: '90271.0' }, { serviceCatalog: undefined });
    expect(of(none, 'R18')).toEqual([]);
    expect(blocks(none, 'R10')).toBe(true);
  });

  it('le ricette controllate con la versione precedente restano com’erano', () => {
    const before = rulesetAt(
      '2026-11-18',
      loadRulesets().filter((r) => r.version !== '2026-11-18.3'),
    );
    expect(before.rules.some((r) => r.id === 'R18')).toBe(false);
    expect(before.rules.find((r) => r.id === 'R10')!.values).toEqual({});
  });
});

describe('R11 · contatore delle confezioni (esempio dei requisiti)', () => {
  // 28 compresse, una al giorno, ricetta del 21/10: copre fino al 17/11 compreso. Nel 2027,
  // perché questa versione delle regole vale dal 18/11/2026 (ottobre ha 31 giorni in entrambi).
  const therapy = {
    id: 't1',
    kind: 'chronic' as const,
    startOn: '2026-01-01',
    unitsPerDay: 1,
    multiPrescription: false,
    therapeuticPlanId: null,
  };
  const at = (date: string, reasons: Record<string, string> = {}) =>
    ctx({
      date,
      facts: { unitsPerPack: 28 },
      prescription: { lines: [line({ therapy })] },
      sentLines: [
        {
          therapyId: 't1',
          drugAic: 'AIC-PROVA-1',
          activeIngredient: null,
          quantity: 1,
          sentOn: '2027-10-21',
        },
      ],
      reasons,
    });

  it('in anticipo (prima dell’80% della copertura): informa, senza chiedere un motivo', () => {
    const issue = of(at('2027-11-11'), 'R11')[0]!;
    expect(issue.severity).toBe('info');
    expect(issue.needs).toBeUndefined();
    expect(issue.message).toMatch(/copre fino al 17\/11\/2027 compreso/);
    expect(run(at('2027-11-11')).blocking.filter((i) => i.ruleId === 'R11')).toHaveLength(0);
  });
  it('al giorno 22 (sotto 22,4) informa; al giorno 23 no', () => {
    expect(of(at('2027-11-12'), 'R11')).toHaveLength(1);
    expect(of(at('2027-11-13'), 'R11')).toHaveLength(0);
  });
  it('se il medico scrive un motivo, resta registrato', () => {
    const r = run(at('2027-11-11', { R11: 'Partenza per un viaggio' }));
    expect(r.reasonsUsed).toEqual({ R11: 'Partenza per un viaggio' });
  });
  it('dal 19/11/2026 conta anche una ricetta più recente fatta con un altro programma (D181)', () => {
    const c = ctx({
      date: '2027-11-11',
      facts: { unitsPerPack: 28 },
      prescription: { lines: [line({ therapy })] },
      sentLines: [
        {
          therapyId: 't1',
          drugAic: 'AIC-PROVA-1',
          activeIngredient: null,
          quantity: 1,
          sentOn: '2027-09-01',
        },
        {
          therapyId: null,
          drugAic: 'AIC-PROVA-1',
          activeIngredient: null,
          quantity: 1,
          sentOn: '2027-10-21',
          otherProgram: { name: null },
        },
      ],
    });
    const [issue] = of(c, 'R11');
    expect(issue!.severity).toBe('info');
    expect(issue!.message).toBe(
      'Farmaco di prova 5 mg: la ricetta del 21/10/2027, fatta con un altro programma, copre fino al 17/11/2027 compreso',
    );
    // Con la versione di prima conta solo la ricetta di questo programma, che copre fino al 28/9.
    const v3 = loadRulesets().find((r) => r.version === '2026-11-18.3')!;
    expect(checkPrescription(c, [v3]).issues.filter((i) => i.ruleId === 'R11')).toEqual([]);
  });
  it('una ricetta di un altro programma senza confezioni: il contatore non la conta, e lo dice', () => {
    const c = ctx({
      date: '2027-11-11',
      facts: { unitsPerPack: 28 },
      prescription: { lines: [line({ therapy })] },
      sentLines: [
        {
          therapyId: null,
          drugAic: null,
          activeIngredient: 'Principio di prova',
          quantity: null,
          sentOn: '2027-11-01',
          otherProgram: { name: 'Programma di prova' },
        },
      ],
    });
    expect(of(c, 'R11').map((i) => [i.severity, i.message])).toEqual([
      [
        'info',
        'Farmaco di prova 5 mg: la ricetta del 01/11/2027 fatta con un altro programma (Programma di prova) non dice quante confezioni: il contatore non la conta',
      ],
    ]);
  });
  it('con la versione .1 (avviso) il motivo era obbligatorio: le ricette di allora restano verificabili', () => {
    const [v1] = loadRulesets();
    const r = checkPrescription(at('2027-11-11'), [v1!]);
    expect(r.rulesVersion).toBe('2026-11-18.1');
    expect(r.blocking.find((i) => i.ruleId === 'R11')?.needs).toBe('reason');
  });
});

describe('R12 · fuori perimetro', () => {
  it('nessun giudizio su dosi, interazioni o allergie', () => {
    expect(of(ctx({ prescription: { lines: [line({ quantity: 1 })] } }), 'R12')).toHaveLength(0);
  });
});

describe('R13 · principio attivo e non sostituibilità', () => {
  it('non sostituibile senza motivazione: blocca; con motivazione passa', () => {
    expect(
      blocks(ctx({ prescription: { lines: [line({ notSubstitutable: true })] } }), 'R13'),
    ).toBe(true);
    expect(
      blocks(
        ctx({
          prescription: {
            lines: [
              line({
                notSubstitutable: true,
                notSubstitutableReason: 'Intolleranza a un eccipiente',
              }),
            ],
          },
        }),
        'R13',
      ),
    ).toBe(false);
  });
  it('senza principio attivo: blocca', () => {
    expect(
      blocks(ctx({ prescription: { lines: [line({ activeIngredient: null })] } }), 'R13'),
    ).toBe(true);
  });
});

describe('R14 · ricetta specialistica', () => {
  const spec = (p: Partial<RuleContext['prescription']>) =>
    ctx({ prescription: { kind: 'specialist_ssn', lines: [line({ serviceCode: '89.7' })], ...p } });
  it('tipo di accesso, priorità per il primo accesso e quesito', () => {
    expect(blocks(spec({ diagnosticQuestion: 'Controllo' }), 'R14')).toBe(true);
    expect(blocks(spec({ accessType: 'first', diagnosticQuestion: 'Controllo' }), 'R14')).toBe(
      true,
    );
    expect(
      blocks(spec({ accessType: 'first', priority: 'P', diagnosticQuestion: 'Controllo' }), 'R14'),
    ).toBe(false);
    expect(blocks(spec({ accessType: 'subsequent', diagnosticQuestion: 'Controllo' }), 'R14')).toBe(
      false,
    );
    expect(blocks(spec({ accessType: 'subsequent', diagnosticQuestion: '  ' }), 'R14')).toBe(true);
  });
});

describe('R15, R16 · promemoria al paziente', () => {
  it('canale senza scelta registrata del paziente: blocca', () => {
    const c = ctx({
      prescription: { reminderChannel: 'email', reminderContact: 'lina.rota@example.org' },
    });
    expect(blocks(c, 'R15')).toBe(true);
  });
  it('canale scelto e registrato con recapito: passa; cartaceo: passa sempre', () => {
    const c = ctx({
      prescription: { reminderChannel: 'email', reminderContact: 'lina.rota@example.org' },
    });
    c.patient.reminderChannel = 'email';
    c.patient.reminderChannelChosenOn = '2026-01-10';
    expect(blocks(c, 'R15')).toBe(false);
    expect(blocks(ctx({ prescription: { reminderChannel: 'paper' } }), 'R15')).toBe(false);
  });
  it('R16: recapito di un delegato attivo sì, di uno revocato o di un estraneo no', () => {
    const delegate: RuleContext['delegations'][number] = {
      email: 'figlio@example.org',
      phone: null,
      validFrom: '2026-01-01',
      validTo: null,
      revokedOn: null,
    };
    const send = (to: string, d = [delegate]) =>
      ctx({ prescription: { reminderContact: to }, delegations: d });
    expect(blocks(send('figlio@example.org'), 'R16')).toBe(false);
    expect(
      blocks(send('figlio@example.org', [{ ...delegate, revokedOn: '2026-06-01' }]), 'R16'),
    ).toBe(true);
    expect(blocks(send('altro@example.org'), 'R16')).toBe(true);
    expect(blocks(send('Lina.Rota@example.org'), 'R16')).toBe(false);
  });
});

describe('blocchi spiegati (seconda fermata)', () => {
  it('R15 e R16 dicono perché bloccano, da quale norma e che cosa fare', () => {
    const c = ctx({
      prescription: { reminderChannel: 'email', reminderContact: 'estraneo@example.org' },
    });
    const r15 = of(c, 'R15');
    const r16 = of(c, 'R16')[0]!;
    expect(r15.length).toBeGreaterThan(0);
    for (const i of [...r15, r16]) expect(i.remedy).toMatch(/promemoria|recapito|delega/);
    expect(r15[0]!.source).toBe('DM MEF 25/03/2020 e norme successive');
    expect(r16.source).toMatch(/Privacy \(GDPR\)/);
  });
  it('ogni problema che blocca porta la fonte della sua regola', () => {
    const c = ctx({
      prescription: {
        reminderChannel: 'email',
        reminderContact: 'estraneo@example.org',
        lines: [line({ quantity: 3, activeIngredient: null, aifaNote: '13' })],
      },
    });
    const blocking = run(c).blocking;
    expect(blocking.length).toBeGreaterThan(3);
    for (const i of blocking) expect(i.source, i.ruleId).toBeTruthy();
  });
});

describe('R17 · esenzione e prestazioni', () => {
  const spec = (services?: Set<string>) =>
    ctx({
      prescription: {
        kind: 'specialist_ssn',
        accessType: 'subsequent',
        diagnosticQuestion: 'Controllo',
        exemptionCode: '013',
        lines: [
          line({ id: 'a', serviceCode: '90.27.1' }),
          line({ id: 'b', serviceCode: '88.71.4' }),
        ],
      },
      exemptions: [{ code: '013', validFrom: '2026-01-01', validTo: null }],
      exemptionServices: services ? () => services : undefined,
    });
  it('senza elenco regionale: non verificabile, senza bloccare', () => {
    expect(of(spec(), 'R17')[0]!.severity).toBe('info');
  });
  it('prestazione non coperta dall’esenzione: blocca e propone di spostarla', () => {
    const c = spec(new Set(['90.27.1']));
    const i = of(c, 'R17');
    expect(i).toHaveLength(1);
    expect(i[0]!.lineId).toBe('b');
    expect(i[0]!.message).toMatch(/Spostala/);
  });
});

describe('R19 e R20 · stato del paziente alla ricetta (D199)', () => {
  const withStatus = (
    status: 'active' | 'revoked' | 'deceased' | 'temporary',
    over: Partial<Omit<RuleContext, 'prescription' | 'patient'>> & {
      deceasedOn?: string | null;
    } = {},
  ) => {
    const { deceasedOn = null, ...rest } = over;
    const base = ctx({ date: '2026-11-20', ...rest });
    return { ...base, patient: { ...base.patient, status, deceasedOn } };
  };
  const choice = (chosenOn: string, expiresOn: string | null, endedOn: string | null = null) => ({
    chosenOn,
    expiresOn,
    endedOn,
  });

  it('in carico: nessun problema, con o senza scelte', () => {
    expect(of(withStatus('active'), 'R19')).toEqual([]);
    expect(of(withStatus('active'), 'R20')).toEqual([]);
    expect(
      of(withStatus('active', { choices: [choice('2020-01-01', '2021-01-01')] }), 'R20'),
    ).toEqual([]);
  });

  it('R19: deceduto, la ricetta non si fa, per ogni tipo di ricetta, con la data e il rimedio', () => {
    const dead = withStatus('deceased', { deceasedOn: '2026-11-17' });
    expect(blocks(dead, 'R19')).toBe(true);
    expect(of(dead, 'R19')[0]).toMatchObject({
      severity: 'block',
      message: 'Il paziente risulta deceduto il 17/11/2026: la ricetta non si fa',
    });
    expect(of(dead, 'R19')[0]!.remedy).toMatch(/Dati amministrativi/);
    expect(of(dead, 'R19')[0]!.source).toMatch(/D199/);
    for (const kind of ['specialist_ssn', 'white', 'devices'] as const) {
      const other = withStatus('deceased', { prescription: { kind, lines: [line()] } } as never);
      expect(blocks({ ...other, prescription: { ...other.prescription, kind } }, 'R19'), kind).toBe(
        true,
      );
    }
    // Un motivo non lo supera: è un blocco.
    expect(blocks(withStatus('deceased', { reasons: { R19: 'Prova' } }), 'R19')).toBe(true);
    expect(of(withStatus('deceased'), 'R19')[0]!.message).toBe(
      'Il paziente risulta deceduto: la ricetta non si fa',
    );
  });

  it('R20: revocato, serve un motivo; con il motivo si procede e il motivo resta', () => {
    const revoked = withStatus('revoked', {
      choices: [choice('2020-01-01', null, '2026-11-10'), choice('2026-12-01', null)],
    });
    expect(of(revoked, 'R20')[0]).toMatchObject({
      severity: 'warn',
      needs: 'reason',
      message:
        'Paziente revocato: la scelta del medico è cessata il 10/11/2026. Serve un motivo per procedere',
    });
    expect(blocks(revoked, 'R20')).toBe(true);
    const ok = { ...revoked, reasons: { R20: 'Visita occasionale' } };
    expect(blocks(ok, 'R20')).toBe(false);
    expect(of(ok, 'R20')[0]!.message).toMatch(/motivo registrato: Visita occasionale$/);
    expect(run(ok).reasonsUsed).toEqual({ R20: 'Visita occasionale' });
    expect(of(withStatus('revoked'), 'R20')[0]!.message).toMatch(
      /^Paziente revocato: non è più in carico\./,
    );
  });

  it('R20: temporaneo con la scelta che vale, nessun avviso; fino al giorno della scadenza compreso', () => {
    const valid = withStatus('temporary', { choices: [choice('2026-11-01', '2027-05-01')] });
    expect(of(valid, 'R20')).toEqual([]);
    const lastDay = withStatus('temporary', {
      date: '2027-05-01',
      choices: [choice('2026-11-01', '2027-05-01')],
    });
    expect(of(lastDay, 'R20')).toEqual([]);
  });

  it('R20: temporaneo con la scelta scaduta, cessata, futura o mancante: avviso con il perché', () => {
    const expired = withStatus('temporary', { choices: [choice('2026-05-01', '2026-11-19')] });
    expect(of(expired, 'R20')[0]!.message).toBe(
      'Paziente temporaneo: la scelta è scaduta il 19/11/2026. Serve un motivo per procedere',
    );
    expect(blocks(expired, 'R20')).toBe(true);
    const ended = withStatus('temporary', {
      choices: [choice('2026-05-01', '2027-05-01', '2026-11-15')],
    });
    expect(of(ended, 'R20')[0]!.message).toMatch(/^Paziente temporaneo senza una scelta in corso/);
    const future = withStatus('temporary', { choices: [choice('2026-12-01', '2027-06-01')] });
    expect(blocks(future, 'R20')).toBe(true);
    expect(of(withStatus('temporary'), 'R20')[0]!.message).toBe(
      'Paziente temporaneo senza una scelta in corso. Serve un motivo per procedere',
    );
  });

  it('le ricette controllate con la versione precedente restano com’erano', () => {
    const before = loadRulesets().filter(
      (r) => !['2026-11-19.2', '2026-11-19.3', '2026-11-20.1', '2026-11-24.1'].includes(r.version),
    );
    const dead = withStatus('deceased');
    expect(checkPrescription(dead, before).issues.some((i) => i.ruleId === 'R19')).toBe(false);
  });
});

describe('R21 · farmaco carente secondo l’elenco AIFA (D202)', () => {
  const shortage = (over: Partial<NonNullable<DrugFacts['shortage']>> = {}): DrugFacts => ({
    shortage: {
      since: '2026-10-01',
      expectedEnd: '2027-01-31',
      equivalentAvailable: true,
      reason: 'Problemi produttivi',
      ...over,
    },
  });

  it('farmaco carente: informazione con inizio, motivo, fine presunta ed equivalente, senza fermare', () => {
    const c = ctx({ date: '2026-11-20', facts: shortage() });
    const [i] = of(c, 'R21');
    expect(i).toMatchObject({ severity: 'info', lineId: 'l1' });
    expect(i!.message).toBe(
      'Farmaco di prova 5 mg: nell’elenco AIFA dei farmaci carenti dal 01/10/2026 (Problemi produttivi); fine presunta 31/01/2027; equivalente secondo l’elenco: sì',
    );
    expect(run(c).blocking.some((x) => x.ruleId === 'R21')).toBe(false);
  });

  it('carenza che comincia dopo la data della ricetta: «prevista»; senza fine né equivalente detti', () => {
    const c = ctx({
      date: '2026-11-20',
      facts: shortage({
        since: '2026-12-07',
        expectedEnd: null,
        equivalentAvailable: null,
        reason: null,
      }),
    });
    expect(of(c, 'R21')[0]!.message).toBe(
      'Farmaco di prova 5 mg: nell’elenco AIFA dei farmaci carenti, carenza prevista dal 07/12/2026',
    );
    const sameDay = ctx({
      date: '2026-11-20',
      facts: shortage({ since: '2026-11-20', equivalentAvailable: false }),
    });
    expect(of(sameDay, 'R21')[0]!.message).toMatch(
      /carenti dal 20\/11\/2026 .*equivalente secondo l’elenco: no$/,
    );
  });

  it('vale anche per la ricetta bianca; nessuna informazione se il farmaco non è fra i carenti', () => {
    expect(
      of(ctx({ date: '2026-11-20', facts: shortage(), prescription: { kind: 'white' } }), 'R21'),
    ).toHaveLength(1);
    expect(of(ctx({ date: '2026-11-20', facts: {} }), 'R21')).toEqual([]);
    expect(of(ctx({ date: '2026-11-20', facts: undefined }), 'R21')).toEqual([]);
  });

  it('le ricette controllate con le versioni di prima non hanno la R21', () => {
    const before = loadRulesets().filter(
      (r) => !['2026-11-19.3', '2026-11-20.1'].includes(r.version),
    );
    const c = ctx({ date: '2026-11-20', facts: shortage() });
    expect(checkPrescription(c, before).issues.some((i) => i.ruleId === 'R21')).toBe(false);
  });
});

describe('R22 · confezione sospesa secondo l’anagrafica AIFA (D210)', () => {
  it('confezione sospesa: informazione sulla riga con le parole dell’anagrafica, senza fermare né chiedere un motivo', () => {
    const c = ctx({ date: '2026-11-20', facts: { suspended: true } });
    const [i, ...more] = of(c, 'R22');
    expect(more).toEqual([]);
    expect(i).toEqual({
      ruleId: 'R22',
      severity: 'info',
      lineId: 'l1',
      message:
        'Farmaco di prova 5 mg: confezione sospesa secondo l’anagrafica AIFA delle confezioni',
      source: expect.stringMatching(/^AIFA, anagrafica delle confezioni .*STATO_AMMINISTRATIVO/),
    });
    expect(run(c).blocking.some((x) => x.ruleId === 'R22')).toBe(false);
    expect(run(c).issues.some((x) => x.ruleId === 'R22' && x.needs === 'reason')).toBe(false);
  });

  it('una informazione per ogni riga sospesa; senza nome del farmaco la riga si chiama con l’AIC', () => {
    const c = ctx({
      date: '2026-11-20',
      drugFacts: (aic) => (aic === '012345678' || aic === '011111111' ? { suspended: true } : {}),
      prescription: {
        lines: [
          line({ id: 'l1', drugAic: '012345678', drugName: null }),
          line({ id: 'l2', drugAic: '087654321' }),
          line({ id: 'l3', drugAic: '011111111', drugName: 'Altro farmaco di prova' }),
        ],
      },
    });
    expect(of(c, 'R22').map((i) => [i.lineId, i.message])).toEqual([
      ['l1', '012345678: confezione sospesa secondo l’anagrafica AIFA delle confezioni'],
      [
        'l3',
        'Altro farmaco di prova: confezione sospesa secondo l’anagrafica AIFA delle confezioni',
      ],
    ]);
  });

  it('vale anche per la ricetta bianca; nulla se l’anagrafica non dice «Sospesa»', () => {
    expect(
      of(
        ctx({ date: '2026-11-20', facts: { suspended: true }, prescription: { kind: 'white' } }),
        'R22',
      ),
    ).toHaveLength(1);
    expect(of(ctx({ date: '2026-11-20', facts: { suspended: false } }), 'R22')).toEqual([]);
    expect(of(ctx({ date: '2026-11-20', facts: {} }), 'R22')).toEqual([]);
    expect(of(ctx({ date: '2026-11-20', facts: undefined }), 'R22')).toEqual([]);
  });

  it('le ricette controllate con le versioni di prima non hanno la R22', () => {
    const before = loadRulesets().filter((r) => r.version !== '2026-11-20.1');
    const c = ctx({ date: '2026-11-20', facts: { suspended: true } });
    expect(checkPrescription(c, before).rulesVersion).toBe('2026-11-19.3');
    expect(checkPrescription(c, before).issues.some((i) => i.ruleId === 'R22')).toBe(false);
    expect(
      run(ctx({ date: '2026-11-19', facts: { suspended: true } })).issues.some(
        (i) => i.ruleId === 'R22',
      ),
    ).toBe(false);
  });
});
