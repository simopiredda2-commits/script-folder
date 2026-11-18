import { checkFiscalCode } from '@mmg/domain';
import type { LineContext, RuleContext } from './context';
import { addDays, addMonths, daysBetween, italian } from './dates';
import { value, type Rule, type RuleId } from './ruleset';

/**
 * Le regole di prescrizione R1–R17 dei requisiti, come controlli formali (regola 3: nessun
 * suggerimento diagnostico o terapeutico). Nessun numero è scritto qui: i valori vengono dal
 * file dei dati (packages/rules/data/), e una regola di lint lo controlla.
 */

export interface Issue {
  ruleId: RuleId;
  /** block: ferma l'invio; warn: serve un motivo; info: solo informazione. */
  severity: 'block' | 'warn' | 'info';
  message: string;
  lineId?: string;
  /** Che cosa serve al medico per procedere. */
  needs?: 'reason' | 'aifa_confirmation';
  /** Da dove viene la regola: lo aggiunge il motore dai dati (titolo della prima fonte). */
  source?: string;
  /** Che cosa fare per poter procedere, quando la regola blocca. */
  remedy?: string;
}

type Evaluator = (rule: Rule, ctx: RuleContext, all: Readonly<Record<RuleId, Rule>>) => Issue[];

const severityOf = (rule: Rule): Issue['severity'] =>
  rule.behavior === 'block' ? 'block' : rule.behavior === 'warn' ? 'warn' : 'info';

const isSsnPharma = (ctx: RuleContext) => ctx.prescription.kind === 'pharma_ssn';
const lineLabel = (l: LineContext) => l.drugName ?? l.drugAic ?? l.serviceCode ?? 'riga';

function validExemption(ctx: RuleContext, code: string | null) {
  if (!code) return undefined;
  return ctx.exemptions.find(
    (e) =>
      e.code === code && e.validFrom <= ctx.date && (e.validTo === null || ctx.date <= e.validTo),
  );
}

function planFor(ctx: RuleContext, line: LineContext) {
  const candidates = ctx.plans.filter(
    (p) =>
      p.id === line.therapy?.therapeuticPlanId ||
      (line.drugAic !== null && p.drugAic === line.drugAic) ||
      (line.activeIngredient !== null && p.activeIngredient === line.activeIngredient),
  );
  const valid = candidates.find((p) => p.grantedOn <= ctx.date && ctx.date <= p.expiresOn);
  const expired = candidates
    .filter((p) => p.expiresOn < ctx.date)
    .sort((a, b) => b.expiresOn.localeCompare(a.expiresOn))[0];
  return { valid, expired };
}

/** R4: perché una riga non può arrivare al limite alzato (vuoto = può). */
function chronicRaiseMissing(rule: Rule, ctx: RuleContext, line: LineContext): string[] {
  const missing: string[] = [];
  const t = line.therapy;
  const minMonths = value(rule, 'minTreatmentMonths');
  const maxDays = value(rule, 'maxTherapyDays');
  if (!t || t.kind !== 'chronic') missing.push('terapia cronica');
  if (t && !t.multiPrescription)
    missing.push('opzione «Multiprescrizione» nella scheda della terapia');
  if (!validExemption(ctx, ctx.prescription.exemptionCode))
    missing.push('esenzione valida in ricetta');
  if (minMonths === null || !t || addMonths(t.startOn, minMonths) > ctx.date) {
    missing.push(`trattamento da almeno ${minMonths ?? '?'} mesi`);
  }
  const unitsPerPack = ctx.drugFacts(line.drugAic)?.unitsPerPack;
  if (maxDays === null || !t?.unitsPerDay || !unitsPerPack) {
    missing.push('giorni di terapia calcolabili (unità per confezione e posologia)');
  } else if ((line.quantity * unitsPerPack) / t.unitsPerDay > maxDays) {
    missing.push(`non più di ${maxDays} giorni di terapia`);
  }
  return missing;
}

const evaluators: Record<RuleId, Evaluator> = {
  R1: (rule, ctx) => {
    const days = value(rule, 'validityDays');
    if (ctx.prescription.kind === 'white' || days === null) return [];
    // Conteggio inclusivo: il giorno di compilazione è il primo (come nell'esempio di R11).
    const until = addDays(ctx.date, days - 1);
    return [
      {
        ruleId: 'R1',
        severity: severityOf(rule),
        message: `La ricetta vale ${days} giorni: fino al ${italian(until)} compreso`,
      },
    ];
  },

  R2: (rule, ctx, all) => {
    if (!isSsnPharma(ctx)) return [];
    const base = value(rule, 'maxPacks');
    if (base === null) return [];
    const total = ctx.prescription.lines.reduce((n, l) => n + l.quantity, 0);
    if (total <= base) return [];
    const r3 = all.R3;
    const r4 = all.R4;
    const r3Max = r3.status === 'active' ? value(r3, 'maxPacks') : null;
    const r4Max = r4.status === 'active' ? value(r4, 'maxPacks') : null;
    const lines = ctx.prescription.lines;
    if (
      r3Max !== null &&
      lines.every((l) => ctx.drugFacts(l.drugAic)?.injectableAntibioticOrInfusion)
    ) {
      return total <= r3Max
        ? []
        : [
            {
              ruleId: 'R3',
              severity: severityOf(r3),
              message: `${total} confezioni: anche per antibiotici iniettabili e soluzioni per infusione il limite è ${r3Max}. Dividi in ${Math.ceil(total / r3Max)} ricette`,
            },
          ];
    }
    const missing =
      r4Max === null
        ? ['valori della regola']
        : lines.flatMap((l) => chronicRaiseMissing(r4, ctx, l));
    if (r4Max !== null && missing.length === 0) {
      return total <= r4Max
        ? []
        : [
            {
              ruleId: 'R4',
              severity: severityOf(r4),
              message: `${total} confezioni: anche per le terapie croniche il limite è ${r4Max}. Dividi in ${Math.ceil(total / r4Max)} ricette`,
            },
          ];
    }
    return [
      {
        ruleId: 'R2',
        severity: severityOf(rule),
        message: `${total} confezioni: il limite è ${base}. Dividi in ${Math.ceil(total / base)} ricette. Per arrivare oltre (R4) manca: ${[...new Set(missing)].join('; ')}`,
      },
    ];
  },

  // R3 e R4 alzano il limite di R2: si valutano dentro R2.
  R3: () => [],
  R4: () => [],

  R5: (rule, ctx) => {
    const warnDays = value(rule, 'expiryWarningDays');
    const issues: Issue[] = [];
    for (const line of ctx.prescription.lines) {
      const facts = ctx.drugFacts(line.drugAic);
      const requires = facts?.requiresPlan ?? (line.therapy?.therapeuticPlanId ? true : undefined);
      if (!requires) continue;
      const { valid, expired } = planFor(ctx, line);
      if (!valid) {
        if (ctx.prescription.kind === 'pharma_ssn') {
          issues.push({
            ruleId: 'R5',
            severity: severityOf(rule),
            lineId: line.id,
            message: expired
              ? `${lineLabel(line)}: il piano terapeutico è scaduto il ${italian(expired.expiresOn)}`
              : `${lineLabel(line)}: serve un piano terapeutico valido alla data, che non c'è in cartella`,
          });
        }
        continue;
      }
      if (warnDays !== null && daysBetween(ctx.date, valid.expiresOn) <= warnDays) {
        issues.push({
          ruleId: 'R5',
          severity: 'info',
          lineId: line.id,
          message: `${lineLabel(line)}: il piano terapeutico scade il ${italian(valid.expiresOn)}`,
        });
      }
    }
    return issues;
  },

  R6: (rule, ctx) => {
    const issues: Issue[] = [];
    for (const line of ctx.prescription.lines) {
      const { valid } = planFor(ctx, line);
      if (!valid || valid.packsAuthorized === null) continue;
      const used = ctx.sentLines
        .filter(
          (s) =>
            s.sentOn >= valid.grantedOn &&
            s.sentOn <= valid.expiresOn &&
            ((line.therapy && s.therapyId === line.therapy.id) ||
              (line.drugAic !== null && s.drugAic === line.drugAic) ||
              (line.activeIngredient !== null && s.activeIngredient === line.activeIngredient)),
        )
        .reduce((n, s) => n + s.quantity, 0);
      const residual = valid.packsAuthorized - used;
      if (line.quantity > residual) {
        issues.push({
          ruleId: 'R6',
          severity: severityOf(rule),
          lineId: line.id,
          message: `${lineLabel(line)}: il piano autorizza ${valid.packsAuthorized} confezioni, già prescritte ${used}; residuo ${Math.max(residual, 0)}`,
        });
      }
    }
    return issues;
  },

  R7: (rule, ctx) => {
    if (ctx.prescription.kind !== 'pharma_ssn') return [];
    return ctx.prescription.lines.flatMap((line): Issue[] => {
      const note = line.aifaNote ?? ctx.drugFacts(line.drugAic)?.aifaNote ?? null;
      if (!note || ctx.confirmedAifaNotes.has(line.id)) return [];
      return [
        {
          ruleId: 'R7',
          severity: severityOf(rule),
          lineId: line.id,
          needs: 'aifa_confirmation',
          message: `${lineLabel(line)}: Nota AIFA ${note}. Conferma che il paziente rientra nelle condizioni della nota`,
        },
      ];
    });
  },

  R8: (rule, ctx) => {
    if (ctx.prescription.kind !== 'pharma_ssn') return [];
    return ctx.prescription.lines.flatMap((line): Issue[] => {
      const facts = ctx.drugFacts(line.drugAic);
      if (!facts) {
        return [
          {
            ruleId: 'R8',
            severity: 'info',
            lineId: line.id,
            message: `${lineLabel(line)}: farmaco non presente nella banca dati; classe, regime di fornitura, nota e piano non sono verificabili`,
          },
        ];
      }
      if (facts.reimbursableSsn === false) {
        return [
          {
            ruleId: 'R8',
            severity: severityOf(rule),
            lineId: line.id,
            message: `${lineLabel(line)}: non è a carico del SSN; si prescrive su ricetta bianca`,
          },
        ];
      }
      if (facts.mmgPrescribable === false) {
        return [
          {
            ruleId: 'R8',
            severity: severityOf(rule),
            lineId: line.id,
            message: `${lineLabel(line)}: non è prescrivibile dal medico di medicina generale su ricetta SSN`,
          },
        ];
      }
      return [];
    });
  },

  R9: (rule, ctx) => {
    const code = ctx.prescription.exemptionCode;
    if (!code || ctx.prescription.kind === 'white') return [];
    if (ctx.exemptionExists?.(code) === false) {
      return [
        {
          ruleId: 'R9',
          severity: severityOf(rule),
          message: `Esenzione ${code}: non esiste nel catalogo delle esenzioni`,
        },
      ];
    }
    if (validExemption(ctx, code)) return [];
    const registered = ctx.exemptions.filter((e) => e.code === code);
    const last = registered.sort((a, b) => (b.validTo ?? '').localeCompare(a.validTo ?? ''))[0];
    return [
      {
        ruleId: 'R9',
        severity: severityOf(rule),
        message:
          last?.validTo && last.validTo < ctx.date
            ? `Esenzione ${code}: scaduta il ${italian(last.validTo)}`
            : last
              ? `Esenzione ${code}: non ancora valida alla data`
              : `Esenzione ${code}: non è registrata per il paziente`,
      },
    ];
  },

  R10: (rule, ctx) => {
    const issues: Issue[] = [];
    const block = (message: string, lineId?: string) =>
      issues.push({
        ruleId: 'R10',
        severity: severityOf(rule),
        message,
        ...(lineId ? { lineId } : {}),
      });
    if (!checkFiscalCode(ctx.patient.fiscalCode).valid) {
      block('Codice fiscale del paziente non valido nel formato');
    }
    if (ctx.prescription.lines.length === 0) block('La ricetta non ha righe');
    for (const line of ctx.prescription.lines) {
      if (!Number.isInteger(line.quantity) || line.quantity < 1)
        block(`${lineLabel(line)}: quantità non valida`, line.id);
      const isService = ctx.prescription.kind === 'specialist_ssn';
      if (isService && !line.serviceCode)
        block(`${lineLabel(line)}: manca il codice della prestazione`, line.id);
      if (!isService && !line.drugAic && !line.drugName) block('Riga senza farmaco', line.id);
    }
    return issues;
  },

  R11: (rule, ctx) => {
    const threshold = value(rule, 'coverageThreshold');
    if (threshold === null) return [];
    const issues: Issue[] = [];
    for (const line of ctx.prescription.lines) {
      const t = line.therapy;
      const unitsPerPack = ctx.drugFacts(line.drugAic)?.unitsPerPack;
      if (!t || t.kind !== 'chronic' || !t.unitsPerDay || !unitsPerPack) continue;
      const last = ctx.sentLines
        .filter((s) => s.therapyId === t.id && s.sentOn <= ctx.date)
        .sort((a, b) => b.sentOn.localeCompare(a.sentOn))[0];
      if (!last) continue;
      const coverageDays = (unitsPerPack * last.quantity) / t.unitsPerDay;
      const elapsed = daysBetween(last.sentOn, ctx.date);
      if (elapsed >= coverageDays * threshold) continue;
      const until = addDays(last.sentOn, Math.ceil(coverageDays) - 1);
      const reason = ctx.reasons.R11?.trim();
      // «Avvisa»: serve un motivo per procedere. «Informa» (scelta della seconda fermata): solo
      // l'informazione; un motivo scritto resta comunque registrato.
      const asksReason = severityOf(rule) === 'warn' && !reason;
      const coverage = `la ricetta del ${italian(last.sentOn)} copre fino al ${italian(until)} compreso`;
      issues.push({
        ruleId: 'R11',
        severity: asksReason ? 'warn' : 'info',
        lineId: line.id,
        ...(asksReason ? { needs: 'reason' as const } : {}),
        message: asksReason
          ? `${lineLabel(line)}: ${coverage}. Serve un motivo per procedere`
          : reason
            ? `${lineLabel(line)}: ${coverage}; motivo registrato: ${reason}`
            : `${lineLabel(line)}: ${coverage}`,
      });
    }
    return issues;
  },

  // R12 è fuori perimetro (requisiti): nessun giudizio automatico su dosi, interazioni, allergie.
  R12: () => [],

  R13: (rule, ctx) => {
    if (ctx.prescription.kind !== 'pharma_ssn') return [];
    return ctx.prescription.lines.flatMap((line): Issue[] => {
      const issues: Issue[] = [];
      if (line.notSubstitutable && !line.notSubstitutableReason?.trim()) {
        issues.push({
          ruleId: 'R13',
          severity: severityOf(rule),
          lineId: line.id,
          message: `${lineLabel(line)}: la clausola di non sostituibilità richiede una sintetica motivazione`,
        });
      }
      if (!line.activeIngredient?.trim()) {
        issues.push({
          ruleId: 'R13',
          severity: severityOf(rule),
          lineId: line.id,
          message: `${lineLabel(line)}: in ricetta va indicato il principio attivo`,
        });
      }
      return issues;
    });
  },

  R14: (rule, ctx) => {
    const p = ctx.prescription;
    if (p.kind !== 'specialist_ssn') return [];
    const issues: Issue[] = [];
    const block = (message: string) =>
      issues.push({ ruleId: 'R14', severity: severityOf(rule), message });
    if (!p.accessType) block('Manca il tipo di accesso (primo accesso o accesso successivo)');
    if (p.accessType === 'first' && !p.priority)
      block('Primo accesso: manca la classe di priorità (U, B, D, P)');
    if (!p.diagnosticQuestion?.trim()) block('Manca il quesito diagnostico');
    return issues;
  },

  R15: (rule, ctx) => {
    const channel = ctx.prescription.reminderChannel;
    if (!channel || channel === 'paper') return [];
    const issues: Issue[] = [];
    if (!ctx.prescription.reminderContact?.trim()) {
      issues.push({
        ruleId: 'R15',
        severity: severityOf(rule),
        message:
          'Promemoria su un canale diverso dalla carta senza recapito: il promemoria non arriverebbe al paziente',
        remedy:
          'Indica il recapito del paziente per questo canale, oppure consegna il promemoria cartaceo',
      });
    }
    if (ctx.patient.reminderChannel !== channel || !ctx.patient.reminderChannelChosenOn) {
      issues.push({
        ruleId: 'R15',
        severity: severityOf(rule),
        message:
          'Il paziente non ha registrato la scelta di questo canale: un canale diverso dalla carta si usa solo su sua richiesta',
        remedy:
          'Registra in cartella la scelta del paziente (canale, recapito e data), oppure consegna il promemoria cartaceo',
      });
    }
    return issues;
  },

  R16: (rule, ctx) => {
    const contact = ctx.prescription.reminderContact?.trim().toLowerCase();
    if (!contact) return [];
    const own = [ctx.patient.email, ctx.patient.phone, ctx.patient.reminderContact]
      .filter((x): x is string => !!x)
      .map((x) => x.trim().toLowerCase());
    if (own.includes(contact)) return [];
    const delegate = ctx.delegations.some(
      (d) =>
        !d.revokedOn &&
        d.validFrom <= ctx.date &&
        (d.validTo === null || ctx.date <= d.validTo) &&
        [d.email, d.phone].some((x) => x?.trim().toLowerCase() === contact),
    );
    return delegate
      ? []
      : [
          {
            ruleId: 'R16',
            severity: severityOf(rule),
            message:
              'Il recapito indicato non è del paziente né di un delegato registrato: la ricetta e l’NRE sono dati sanitari del paziente',
            remedy:
              'Usa un recapito del paziente, oppure registra la delega in cartella prima di inviare a un’altra persona',
          },
        ];
  },

  R17: (rule, ctx) => {
    const p = ctx.prescription;
    if (p.kind !== 'specialist_ssn' || !p.exemptionCode) return [];
    const services = ctx.exemptionServices?.(p.exemptionCode);
    if (!services) {
      return [
        {
          ruleId: 'R17',
          severity: 'info',
          message: `Esenzione ${p.exemptionCode}: elenco regionale delle prestazioni non disponibile, R17 non verificabile`,
        },
      ];
    }
    return p.lines
      .filter((l) => !l.serviceCode || !services.has(l.serviceCode))
      .map((l) => ({
        ruleId: 'R17' as const,
        severity: severityOf(rule),
        lineId: l.id,
        message: `${lineLabel(l)}: non è tra le prestazioni dell'esenzione ${p.exemptionCode}. Spostala su una ricetta senza esenzione o usa un'altra esenzione valida`,
      }));
  },
};

export function evaluateRule(
  rule: Rule,
  ctx: RuleContext,
  all: Readonly<Record<RuleId, Rule>>,
): Issue[] {
  if (rule.status !== 'active') return [];
  return evaluators[rule.id](rule, ctx, all);
}
