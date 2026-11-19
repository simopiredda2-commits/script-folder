import { buildFiscalCode } from '@mmg/domain';
import { describe, expect, it } from 'vitest';
import {
  checkPrescription,
  loadRulesets,
  RULE_IDS,
  rulesetAt,
  type DrugFacts,
  type LineContext,
  type RuleContext,
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

  it('ogni versione è valida e contiene R1–R17 una volta ciascuna; R18 dalla .3', () => {
    const all = loadRulesets();
    expect(all.map((r) => r.version)).toEqual(['2026-11-18.1', '2026-11-18.2', '2026-11-18.3']);
    const upTo17 = RULE_IDS.filter((id) => id !== 'R18');
    for (const rs of all.slice(0, 2)) {
      expect(rs.rules.map((r) => r.id).sort()).toEqual([...upTo17].sort());
    }
    expect(all[2]!.rules.map((r) => r.id).sort()).toEqual([...RULE_IDS].sort());
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
