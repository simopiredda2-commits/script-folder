import type { RuleContext } from './context';
import { evaluateRule, type Issue } from './rules';
import {
  loadRulesets,
  rulesetAt,
  type RegionalRuleset,
  type Rule,
  type RuleId,
  type Ruleset,
} from './ruleset';

export interface CheckResult {
  /** Versione delle regole usata: resta registrata con la ricetta. */
  rulesVersion: string;
  issues: Issue[];
  /** Ciò che ferma l'invio: blocchi, avvisi senza motivo, note AIFA non confermate. */
  blocking: Issue[];
  /** Motivi dati dal medico per gli avvisi che li chiedevano. */
  reasonsUsed: Record<string, string>;
  /** Note AIFA confermate dal medico (identificativi delle righe). */
  confirmedAifaNotes: string[];
}

/**
 * Controlla una ricetta con le regole in vigore alla sua data: quelle nazionali, con le aggiunte
 * della regione dello studio se il contesto la dice (D296).
 */
export function checkPrescription(
  ctx: RuleContext,
  rulesets: Ruleset[] = loadRulesets(),
  regional?: RegionalRuleset[],
): CheckResult {
  const ruleset = rulesetAt(ctx.date, rulesets, ctx.region ?? null, regional);
  const byId = Object.fromEntries(ruleset.rules.map((r) => [r.id, r])) as Record<RuleId, Rule>;
  // Ogni problema porta la fonte della sua regola: chi è bloccato vede il perché (seconda fermata).
  const issues = ruleset.rules.flatMap((r) =>
    evaluateRule(r, ctx, byId).map((i) => ({ ...i, source: i.source ?? r.sources[0]?.title })),
  );
  const blocking = issues.filter((i) => i.severity === 'block' || i.severity === 'warn');
  const reasonsUsed = Object.fromEntries(
    Object.entries(ctx.reasons).filter(([id, text]) =>
      issues.some((i) => i.ruleId === id && i.severity === 'info' && text.trim()),
    ),
  );
  const confirmedAifaNotes = ctx.prescription.lines
    .filter((l) => ctx.confirmedAifaNotes.has(l.id))
    .map((l) => l.id);
  return { rulesVersion: ruleset.version, issues, blocking, reasonsUsed, confirmedAifaNotes };
}
