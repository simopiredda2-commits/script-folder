import { checkFiscalCode } from '@mmg/domain';
import type { LineContext, RuleContext, SentLineContext, ShortageFacts } from './context';
import { addDays, addMonths, daysBetween, italian } from './dates';
import { codedItems, value, type Rule, type RuleId } from './ruleset';

/**
 * Le regole di prescrizione R1–R17 dei requisiti, R18 (D154), lo stato del paziente R19–R20 (D199),
 * i farmaci carenti R21 (D202), la confezione sospesa R22 (D210), gli stupefacenti R23 (D272), la nota
 * del nomenclatore R24 e le prestazioni della stessa branca R25 (D276), come controlli formali (regola 3:
 * nessun suggerimento diagnostico o terapeutico). Nessun numero è scritto qui: i valori vengono dal file dei dati
 * (packages/rules/data/), e una regola di lint lo controlla.
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
/** Codici confrontati senza punti né spazi: 89.7 e 897 sono lo stesso codice. */
const compactCode = (code: string) => code.replace(/[\s.]/g, '').toUpperCase();
const lineLabel = (l: LineContext) => l.drugName ?? l.drugAic ?? l.serviceCode ?? 'riga';

/** Principio attivo confrontato senza maiuscole né spazi in più: i file di altri programmi variano. */
const ingredientKey = (v: string | null) => v?.trim().toLowerCase().replace(/\s+/g, ' ') || null;

/**
 * Le ricette fatte con altri programmi (D176) contano in R6 e R11 dalle versioni delle regole che
 * lo dicono (D181); prima no, così i controlli di allora restano verificabili.
 */
const countsOtherPrograms = (rule: Rule) => value(rule, 'countOtherPrograms') === 1;

/** «fatta con un altro programma», con il nome se il file lo diceva. */
const otherProgramLabel = (s: SentLineContext) =>
  s.otherProgram?.name
    ? `fatta con un altro programma (${s.otherProgram.name})`
    : 'fatta con un altro programma';

/** La ricetta fatta con un altro programma è dello stesso farmaco della riga: AIC o principio attivo. */
const sameDrugAs = (line: LineContext, s: SentLineContext) =>
  (line.drugAic !== null && s.drugAic === line.drugAic) ||
  (ingredientKey(line.activeIngredient) !== null &&
    ingredientKey(s.activeIngredient) === ingredientKey(line.activeIngredient));

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

/** Una scelta del medico vale alla data: iniziata, non cessata, non scaduta (D199). */
const choiceInForce = (
  c: { chosenOn: string; expiresOn: string | null; endedOn: string | null },
  date: string,
) =>
  c.chosenOn <= date &&
  (c.endedOn === null || c.endedOn > date) &&
  (c.expiresOn === null || date <= c.expiresOn);

/** La data più recente fra quelle date, o null. */
const latestDate = (dates: (string | null)[]) =>
  dates.filter((d): d is string => d !== null).sort((a, b) => b.localeCompare(a))[0] ?? null;

/**
 * R1 per la ricetta specialistica, dalle versioni delle regole che hanno i giorni della Regione
 * (D.D. 710/2026, punto 4; D260): primo accesso o altra tipologia di accesso (successivo o
 * diretto). Per le prestazioni da prenotare il termine è quello della prenotazione, e la ricetta
 * prenotata in tempo vale fino all'erogazione. La fonte mostrata è quella della Regione.
 */
function specialistValidity(rule: Rule, ctx: RuleContext, first: number, other: number): Issue {
  const source = rule.sources.find((s) => s.title.startsWith('Regione'))?.title;
  const booking =
    'se la prestazione si prenota è il termine per prenotare, e la ricetta prenotata in tempo vale fino all’erogazione';
  const type = ctx.prescription.accessType;
  if (type === null)
    return {
      ruleId: 'R1',
      severity: severityOf(rule),
      source,
      message: `La ricetta vale ${first} giorni per il primo accesso e ${other} per gli altri accessi; ${booking}`,
    };
  const days = type === 'first' ? first : other;
  const until = addDays(ctx.date, days - 1);
  const label = type === 'first' ? 'Primo accesso' : 'Altra tipologia di accesso';
  return {
    ruleId: 'R1',
    severity: severityOf(rule),
    source,
    message: `${label}: la ricetta vale ${days} giorni, fino al ${italian(until)} compreso; ${booking}`,
  };
}

const evaluators: Record<RuleId, Evaluator> = {
  R1: (rule, ctx) => {
    if (ctx.prescription.kind === 'specialist_ssn') {
      const first = value(rule, 'specialistFirstAccessDays');
      const other = value(rule, 'specialistOtherAccessDays');
      if (first !== null && other !== null) return [specialistValidity(rule, ctx, first, other)];
    }
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
    const withOthers = countsOtherPrograms(rule);
    for (const line of ctx.prescription.lines) {
      const { valid } = planFor(ctx, line);
      if (!valid || valid.packsAuthorized === null) continue;
      const inPlan = ctx.sentLines.filter(
        (s) =>
          s.sentOn >= valid.grantedOn &&
          s.sentOn <= valid.expiresOn &&
          (s.otherProgram
            ? withOthers && sameDrugAs(line, s)
            : (line.therapy && s.therapyId === line.therapy.id) ||
              (line.drugAic !== null && s.drugAic === line.drugAic) ||
              (line.activeIngredient !== null && s.activeIngredient === line.activeIngredient)),
      );
      const counted = inPlan.filter((s) => s.quantity !== null);
      const used = counted.reduce((n, s) => n + s.quantity!, 0);
      const fromOthers = counted.filter((s) => s.otherProgram).reduce((n, s) => n + s.quantity!, 0);
      const residual = valid.packsAuthorized - used;
      if (line.quantity > residual) {
        const others = fromOthers > 0 ? `, di cui ${fromOthers} con un altro programma` : '';
        issues.push({
          ruleId: 'R6',
          severity: severityOf(rule),
          lineId: line.id,
          message: `${lineLabel(line)}: il piano autorizza ${valid.packsAuthorized} confezioni, già prescritte ${used}${others}; residuo ${Math.max(residual, 0)}`,
        });
      }
      for (const s of inPlan.filter((x) => x.quantity === null)) {
        issues.push({
          ruleId: 'R6',
          severity: 'info',
          lineId: line.id,
          message: `${lineLabel(line)}: la ricetta del ${italian(s.sentOn)} ${otherProgramLabel(s)} non dice quante confezioni: il residuo del piano non la conta`,
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
      // Fuori dagli elenchi di classe A e H in vigore (per esempio classe C o senza obbligo di
      // prescrizione): la classe non si deduce dall'assenza (D59), quindi si informa e non si blocca,
      // come per il farmaco che la banca dati non ha (D42, D261).
      if (facts.listedClass === null) {
        return [
          {
            ruleId: 'R8',
            severity: 'info',
            lineId: line.id,
            message: `${lineLabel(line)}: non è negli elenchi AIFA dei farmaci di classe A e H in vigore; la banca dati non dice se è a carico del SSN. Se non lo è, si prescrive su ricetta bianca`,
          },
        ];
      }
      return [];
    });
  },

  R9: (rule, ctx, all) => {
    const code = ctx.prescription.exemptionCode;
    if (!code || ctx.prescription.kind === 'white') return [];
    // Il codice della terapia del dolore non è un'esenzione del paziente: lo controlla la R23
    // (specifiche del Sistema TS, «Nota STUP»; D272).
    const r23 = all.R23 as Rule | undefined;
    if (
      r23?.status === 'active' &&
      isSsnPharma(ctx) &&
      listOf(r23, 'painTherapyExemptions').some(
        (c) => c.toUpperCase() === code.trim().toUpperCase(),
      )
    )
      return [];
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
      // Dalla versione che lo dice: anche il codice del nomenclatore (codProdPrest), obbligatorio
      // per la specialistica; se la riga non lo porta, quello della voce del catalogo in uso.
      if (isService && line.serviceCode && value(rule, 'requireNationalServiceCode') === 1) {
        const entry = ctx.serviceCatalog?.(line.serviceCode) ?? null;
        const written = line.serviceNationalCode?.trim() || null;
        if (!written && !entry?.nationalCode) {
          block(`${lineLabel(line)}: manca il codice del nomenclatore (codice DM)`, line.id);
        } else if (
          written &&
          entry?.nationalCode &&
          compactCode(written) !== compactCode(entry.nationalCode)
        ) {
          block(
            `${lineLabel(line)}: il codice del nomenclatore ${written} non corrisponde a quello del catalogo in uso (${entry.nationalCode})`,
            line.id,
          );
        }
      }
      // Dalla versione che lo dice (D276): le sedute solo sulle prestazioni a ciclo e non oltre il
      // massimo del catalogo, un ciclo per riga (specifiche del Sistema TS, prescrizione,
      // 08/07/2026, pp. 42–43). Senza la voce nel catalogo in uso le controlla il SAR.
      if (isService && line.serviceCode && value(rule, 'checkCycleSessions') === 1) {
        const entry = ctx.serviceCatalog?.(line.serviceCode) ?? null;
        const sessions = line.sessions ?? null;
        if (entry?.cycle) {
          if (line.quantity !== 1) {
            block(
              `${lineLabel(line)}: prestazione a ciclo: quantità 1, e una riga per ogni ciclo`,
              line.id,
            );
          }
          const max = entry.sessions ?? null;
          if (sessions !== null && (!Number.isInteger(sessions) || sessions < 1)) {
            block(`${lineLabel(line)}: numero di sedute non valido`, line.id);
          } else if (sessions !== null && max !== null && sessions > max) {
            block(
              `${lineLabel(line)}: ${sessions} sedute, oltre le ${max} del ciclo nel catalogo`,
              line.id,
            );
          }
        } else if (entry && sessions !== null) {
          block(
            `${lineLabel(line)}: le sedute si indicano solo per le prestazioni a ciclo`,
            line.id,
          );
        }
      }
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
      // Le ricette di questo programma per la terapia; dalle versioni che lo dicono anche quelle
      // fatte con altri programmi per lo stesso farmaco, che non sono collegate alla terapia.
      const before = ctx.sentLines.filter(
        (s) =>
          s.sentOn <= ctx.date &&
          (s.otherProgram
            ? countsOtherPrograms(rule) && sameDrugAs(line, s)
            : s.therapyId === t.id),
      );
      const last = before
        .filter((s) => s.quantity !== null)
        .sort((a, b) => b.sentOn.localeCompare(a.sentOn))[0];
      // Una ricetta fatta con un altro programma più recente, senza il numero di confezioni: non
      // si sa che cosa copre, e lo si dice.
      for (const s of before.filter(
        (x) => x.quantity === null && (!last || x.sentOn > last.sentOn),
      )) {
        issues.push({
          ruleId: 'R11',
          severity: 'info',
          lineId: line.id,
          message: `${lineLabel(line)}: la ricetta del ${italian(s.sentOn)} ${otherProgramLabel(s)} non dice quante confezioni: il contatore non la conta`,
        });
      }
      if (!last) continue;
      const coverageDays = (unitsPerPack * last.quantity!) / t.unitsPerDay;
      const elapsed = daysBetween(last.sentOn, ctx.date);
      if (elapsed >= coverageDays * threshold) continue;
      const until = addDays(last.sentOn, Math.ceil(coverageDays) - 1);
      const reason = ctx.reasons.R11?.trim();
      // «Avvisa»: serve un motivo per procedere. «Informa» (scelta della seconda fermata): solo
      // l'informazione; un motivo scritto resta comunque registrato.
      const asksReason = severityOf(rule) === 'warn' && !reason;
      const made = last.otherProgram ? `, ${otherProgramLabel(last)},` : '';
      const coverage = `la ricetta del ${italian(last.sentOn)}${made} copre fino al ${italian(until)} compreso`;
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
    // Dalla versione che ha i codici delle linee guida del Sistema TS, la motivazione è il codice
    // (codMotivazione, Prescrizione1 nella ricetta rossa); il testo resta facoltativo (D273).
    const reasons = codedItems(rule.lists?.substitutionReasons).map((r) => r.code);
    return ctx.prescription.lines.flatMap((line): Issue[] => {
      const issues: Issue[] = [];
      const issue = (message: string) =>
        issues.push({ ruleId: 'R13', severity: severityOf(rule), lineId: line.id, message });
      const code = line.notSubstitutableCode?.trim() ?? '';
      if (line.notSubstitutable && reasons.length > 0) {
        if (!code) {
          issue(
            `${lineLabel(line)}: la clausola di non sostituibilità richiede il codice della motivazione (${reasons.join(', ')}), dalle linee guida del Sistema TS`,
          );
        } else if (!reasons.includes(code)) {
          issue(
            `${lineLabel(line)}: il codice della motivazione «${code}» non è fra quelli delle linee guida del Sistema TS (${reasons.join(', ')})`,
          );
        }
        if (line.byActiveIngredient || !line.drugAic?.trim()) {
          issue(
            `${lineLabel(line)}: la non sostituibilità vale per un farmaco indicato con il nome e il codice AIC, non per una prescrizione per principio attivo`,
          );
        }
      } else if (line.notSubstitutable && !line.notSubstitutableReason?.trim()) {
        issue(
          `${lineLabel(line)}: la clausola di non sostituibilità richiede una sintetica motivazione`,
        );
      }
      if (!line.activeIngredient?.trim()) {
        issue(`${lineLabel(line)}: in ricetta va indicato il principio attivo`);
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
    if (!p.accessType)
      block('Manca il tipo di accesso (primo accesso o altra tipologia di accesso)');
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
          'Registra la scelta del paziente (canale, recapito e data) nei «Dati amministrativi» della cartella, in «Canale del promemoria», oppure consegna il promemoria cartaceo',
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

  R18: (rule, ctx) => {
    const p = ctx.prescription;
    const catalog = ctx.serviceCatalog;
    if (p.kind !== 'specialist_ssn' || !catalog) return [];
    const reason = ctx.reasons.R18?.trim();
    const asksReason = severityOf(rule) === 'warn' && !reason;
    return p.lines
      .filter((l) => l.serviceCode && catalog(l.serviceCode) === null)
      .map((l) => ({
        ruleId: 'R18' as const,
        severity: asksReason ? ('warn' as const) : ('info' as const),
        lineId: l.id,
        ...(asksReason ? { needs: 'reason' as const } : {}),
        message: asksReason
          ? `${lineLabel(l)}: codice non presente nel catalogo regionale in uso. Se è un codice nuovo, il SAR lo controlla sul catalogo aggiornato della Regione e rifiuta la ricetta se non lo trova. Serve un motivo per procedere`
          : `${lineLabel(l)}: codice non presente nel catalogo regionale in uso; motivo registrato: ${reason}`,
      }));
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

  // Prestazione con una condizione di erogabilità (DPCM LEA, allegato 4D): in ricetta il numero
  // della nota, come vuole la legenda dell'allegato 4 (D276). L'indicazione di appropriatezza chiede
  // solo il quesito diagnostico, che controlla R14. Una nota che non è quella del codice ferma.
  R24: (rule, ctx) => {
    const p = ctx.prescription;
    const notes = ctx.serviceNotes;
    if (p.kind !== 'specialist_ssn' || !notes) return [];
    const issues: Issue[] = [];
    for (const l of p.lines) {
      const national =
        l.serviceNationalCode?.trim() ||
        (l.serviceCode ? ctx.serviceCatalog?.(l.serviceCode)?.nationalCode : null) ||
        null;
      if (!national) continue;
      const note = notes(national);
      const written = l.serviceNote?.trim() || null;
      const push = (message: string, remedy: string) =>
        issues.push({ ruleId: 'R24', severity: severityOf(rule), lineId: l.id, message, remedy });
      if (note?.kind === 'condizione' && !written) {
        push(
          `${lineLabel(l)}: prestazione con condizione di erogabilità (nota ${note.note}): in ricetta va il numero della nota`,
          `Indica la nota ${note.note} se ricorre la condizione; se non ricorre, la prestazione non è erogabile dal SSN`,
        );
      } else if (written && note && written !== note.note) {
        push(
          `${lineLabel(l)}: la nota ${written} non è quella della prestazione nel nomenclatore (nota ${note.note})`,
          `Indica la nota ${note.note}, quella del codice ${national}`,
        );
      } else if (written && !note) {
        push(
          `${lineLabel(l)}: la prestazione ${national} non ha note nel nomenclatore: la nota ${written} non va in ricetta`,
          'Togli la nota dalla riga',
        );
      }
    }
    return issues;
  },

  // Al più otto prestazioni della stessa branca sulla stessa ricetta (legge 8/1990, come la richiama
  // la legenda dell'allegato 4 del DPCM LEA; D276): si contano le quantità. Una voce che nel catalogo
  // sta in più branche può contare nell'una o nell'altra, e non si conta.
  R25: (rule, ctx) => {
    const max = value(rule, 'maxSameBranch');
    const p = ctx.prescription;
    const catalog = ctx.serviceCatalog;
    if (max === null || p.kind !== 'specialist_ssn' || !catalog) return [];
    const byBranch = new Map<string, number>();
    for (const l of p.lines) {
      const branches = l.serviceCode ? (catalog(l.serviceCode)?.branches ?? []) : [];
      if (branches.length !== 1) continue;
      const branch = branches[0]!;
      byBranch.set(branch, (byBranch.get(branch) ?? 0) + l.quantity);
    }
    return [...byBranch]
      .filter(([, n]) => n > max)
      .map(([branch, n]) => ({
        ruleId: 'R25' as const,
        severity: severityOf(rule),
        message: `${n} prestazioni della branca «${branch}» sulla stessa ricetta: al più ${max}`,
        remedy: `Dividi le prestazioni su più ricette, al più ${max} della stessa branca su ognuna`,
      }));
  },

  // Paziente deceduto nella cartella: la ricetta non si fa (D199).
  R19: (rule, ctx) => {
    if (ctx.patient.status !== 'deceased') return [];
    const on = ctx.patient.deceasedOn;
    return [
      {
        ruleId: 'R19',
        severity: severityOf(rule),
        message: on
          ? `Il paziente risulta deceduto il ${italian(on)}: la ricetta non si fa`
          : 'Il paziente risulta deceduto: la ricetta non si fa',
        remedy: 'Se lo stato è sbagliato, correggilo nei «Dati amministrativi» della cartella',
      },
    ];
  },

  // Paziente revocato, o temporaneo senza una scelta in corso: avviso con un motivo (D199). Il
  // temporaneo con la scelta che vale non dà avvisi.
  R20: (rule, ctx) => {
    const status = ctx.patient.status;
    if (status !== 'revoked' && status !== 'temporary') return [];
    const choices = ctx.choices ?? [];
    if (status === 'temporary' && choices.some((c) => choiceInForce(c, ctx.date))) return [];
    let what: string;
    if (status === 'revoked') {
      const ended = latestDate(
        choices.map((c) => (c.endedOn && c.endedOn <= ctx.date ? c.endedOn : null)),
      );
      what = ended
        ? `Paziente revocato: la scelta del medico è cessata il ${italian(ended)}`
        : 'Paziente revocato: non è più in carico';
    } else {
      const expired = latestDate(
        choices.map((c) => (c.expiresOn && c.expiresOn < ctx.date ? c.expiresOn : null)),
      );
      what = expired
        ? `Paziente temporaneo: la scelta è scaduta il ${italian(expired)}`
        : 'Paziente temporaneo senza una scelta in corso';
    }
    const reason = ctx.reasons.R20?.trim();
    const asksReason = severityOf(rule) === 'warn' && !reason;
    return [
      {
        ruleId: 'R20',
        severity: asksReason ? 'warn' : 'info',
        ...(asksReason ? { needs: 'reason' as const } : {}),
        message: asksReason
          ? `${what}. Serve un motivo per procedere`
          : reason
            ? `${what}; motivo registrato: ${reason}`
            : what,
      },
    ];
  },

  // Farmaco nell'elenco AIFA dei farmaci carenti: solo informazione, con le parole dell'elenco
  // (D202). Vale per ogni ricetta con il farmaco, anche bianca: la carenza non dipende dal SSN.
  R21: (rule, ctx) =>
    ctx.prescription.lines.flatMap((line): Issue[] => {
      const shortage = ctx.drugFacts(line.drugAic)?.shortage;
      if (!shortage) return [];
      return [
        {
          ruleId: 'R21',
          severity: severityOf(rule),
          lineId: line.id,
          message: `${lineLabel(line)}: ${shortageText(shortage, ctx.date)}`,
        },
      ];
    }),

  // Confezione «Sospesa» nell'anagrafica AIFA delle confezioni in vigore alla data della ricetta:
  // solo informazione, con le parole dell'anagrafica (scelta di Simone del 20/11/2026, D210). Come
  // la R21 vale per ogni ricetta con il farmaco, anche bianca: lo stato non dipende dal SSN.
  R22: (rule, ctx) =>
    ctx.prescription.lines.flatMap((line): Issue[] =>
      ctx.drugFacts(line.drugAic)?.suspended === true
        ? [
            {
              ruleId: 'R22',
              severity: severityOf(rule),
              lineId: line.id,
              message: `${lineLabel(line)}: confezione sospesa secondo l’anagrafica AIFA delle confezioni`,
            },
          ]
        : [],
    ),

  // Stupefacenti sulla ricetta farmaceutica del SSN (D272). Fonti: specifiche del Sistema TS,
  // prescrizione, 5/12/2024, «Nota STUP»; circolare MEF e Ministero della Salute del 14/05/2020,
  // con i suoi elenchi di codici AIC. Sul ricettario ministeriale a ricalco (DM 10/3/2006), non
  // con la ricetta del SSN: l'elenco «TAB MED SEZ A», il metadone e ogni confezione a ricalco
  // nell'anagrafica AIFA che non sia prescritta per la terapia del dolore. L'elenco «ALLEGATO
  // III-BIS» va con la ricetta del SSN solo con il codice TDL nell'esenzione, con la posologia e
  // con il telefono del medico nelle note.
  R23: (rule, ctx) => {
    if (!isSsnPharma(ctx)) return [];
    const sectionA = new Set(listOf(rule, 'sectionAAics'));
    const annex = new Set(listOf(rule, 'annexIIIbisAics'));
    const tdl = listOf(rule, 'painTherapyExemptions');
    const padOnly = listOf(rule, 'padOnlyIngredients');
    const exemption = (ctx.prescription.exemptionCode ?? '').trim().toUpperCase();
    const painTherapy = tdl.some((c) => c.toUpperCase() === exemption);
    const codes = tdl.join(' o ');
    const pad =
      'si prescrive sul ricettario ministeriale a ricalco (DM 10/3/2006), non con la ricetta del SSN';
    return ctx.prescription.lines.flatMap((line): Issue[] => {
      const aic = line.drugAic ?? '';
      const inAnnex = annex.has(aic);
      const padRegime = ctx.drugFacts(line.drugAic)?.ministerialPad === true;
      if (!inAnnex && !sectionA.has(aic) && !padRegime) return [];
      const issue = (message: string, severity = severityOf(rule)): Issue => ({
        ruleId: 'R23',
        severity,
        lineId: line.id,
        message: `${lineLabel(line)}: ${message}`,
      });
      const ingredient = (line.activeIngredient ?? '').toUpperCase();
      const padIngredient = padOnly.find((x) => ingredient.includes(x.toUpperCase()));
      if (padIngredient) return [issue(`a base di ${padIngredient.toLowerCase()}: ${pad}`)];
      if (sectionA.has(aic) && !inAnnex)
        return [
          issue(
            `nell'elenco degli stupefacenti della sezione A esclusi dalla ricetta dematerializzata: ${pad}`,
          ),
        ];
      const out: Issue[] = [];
      if (!painTherapy)
        return [
          issue(
            inAnnex
              ? `farmaco dell'allegato III-bis: con la ricetta del SSN solo per la terapia del dolore, con il codice ${codes} nell'esenzione; altrimenti ${pad.replace(', non con la ricetta del SSN', '')}`
              : `stupefacente della sezione A (ricetta ministeriale a ricalco secondo l'anagrafica AIFA): ${pad}; con la ricetta del SSN vanno solo i farmaci dell'allegato III-bis per la terapia del dolore, con il codice ${codes} nell'esenzione`,
          ),
        ];
      if (!inAnnex)
        // Confezione a ricalco che gli elenchi del 2020 non hanno: con il codice TDL la ricetta vale
        // solo se il farmaco è dell'allegato III-bis. Lo controlla il Sistema TS (circolare, punto 2).
        out.push(
          issue(
            "confezione a ricalco che non è negli elenchi del Ministero del 2020: con il codice della terapia del dolore la ricetta del SSN vale solo se il farmaco è dell'allegato III-bis; lo controlla il Sistema TS",
            'info',
          ),
        );
      if (!line.posologyText?.trim())
        out.push(
          issue(
            'per la terapia del dolore la ricetta riporta posologia e modalità di somministrazione (nota STUP): scrivile nella riga',
          ),
        );
      if (ctx.doctorPhone !== undefined && !ctx.doctorPhone?.trim())
        out.push(
          issue(
            'per la terapia del dolore la ricetta riporta il telefono del medico (nota STUP): scrivilo nei dati del medico o dello studio',
          ),
        );
      return out;
    });
  },
};

/** Un elenco della regola, dai dati (D272): vuoto se la versione non lo ha. */
const listOf = (rule: Rule, key: string): string[] => rule.lists?.[key] ?? [];

/**
 * La carenza in parole, alla data: «carente dal …» se è cominciata, «carenza prevista dal …» se
 * comincia dopo; motivo, fine presunta ed equivalente come li dice l'elenco AIFA (D202).
 */
export function shortageText(s: ShortageFacts, date: string): string {
  const when = !s.since
    ? 'nell’elenco AIFA dei farmaci carenti'
    : s.since <= date
      ? `nell’elenco AIFA dei farmaci carenti dal ${italian(s.since)}`
      : `nell’elenco AIFA dei farmaci carenti, carenza prevista dal ${italian(s.since)}`;
  const parts = [`${when}${s.reason ? ` (${s.reason})` : ''}`];
  if (s.expectedEnd) parts.push(`fine presunta ${italian(s.expectedEnd)}`);
  if (s.equivalentAvailable !== null) {
    parts.push(`equivalente secondo l’elenco: ${s.equivalentAvailable ? 'sì' : 'no'}`);
  }
  return parts.join('; ');
}

export function evaluateRule(
  rule: Rule,
  ctx: RuleContext,
  all: Readonly<Record<RuleId, Rule>>,
): Issue[] {
  if (rule.status !== 'active') return [];
  return evaluators[rule.id](rule, ctx, all);
}
