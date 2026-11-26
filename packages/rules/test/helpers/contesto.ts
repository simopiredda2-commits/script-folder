import { buildFiscalCode } from '@mmg/domain';
import { checkPrescription, type DrugFacts, type LineContext, type RuleContext } from '../../src';

/**
 * Gli aiuti delle prove delle regole: una riga e un contesto di prova, con un paziente inventato
 * (regola 1), e i risultati del controllo per regola.
 */
export const CF = buildFiscalCode({
  surname: 'Rota',
  name: 'Lina',
  birthDate: '1950-03-14',
  sex: 'F',
  placeCode: 'X101',
});

export function line(extra: Partial<LineContext> = {}): LineContext {
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

export function ctx(
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

export const run = (c: RuleContext) => checkPrescription(c);
export const of = (c: RuleContext, id: string) => run(c).issues.filter((i) => i.ruleId === id);
export const blocks = (c: RuleContext, id: string) =>
  run(c).blocking.filter((i) => i.ruleId === id).length > 0;
