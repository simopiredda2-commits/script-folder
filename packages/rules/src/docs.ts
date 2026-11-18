import { loadRulesets, type Rule } from './ruleset';

const BEHAVIOR: Record<Rule['behavior'], string> = {
  block: 'Blocca',
  warn: 'Avvisa, serve un motivo',
  inform: 'Informa',
  out_of_scope: 'Fuori perimetro',
};

const cellText = (s: string) => s.replace(/\|/g, '\\|');

/** Tabella delle regole per docs/regole.md, generata dai dati: dice ciò che il codice usa. */
export function renderRulesTable(): string {
  const rulesets = loadRulesets();
  const out: string[] = [];
  for (const rs of rulesets) {
    out.push(
      `**Versione ${rs.version}**, in vigore dal ${rs.effectiveFrom}. Valori da: ${rs.valuesSource}. Validata: ${rs.validated ? 'sì' : 'no'}.`,
      '',
    );
    out.push('| ID | Regola | Fonte | Valori | Comportamento | Da completare |');
    out.push('| --- | --- | --- | --- | --- | --- |');
    for (const r of rs.rules) {
      const sources = r.sources
        .map((s) => (s.url ? `[${cellText(s.title)}](${s.url})` : cellText(s.title)))
        .join('; ');
      const values =
        Object.entries(r.values)
          .map(([k, v]) => `${k} = ${v ?? 'da completare'}`)
          .join('; ') || '—';
      const todo = r.toComplete.map(cellText).join('; ') || '—';
      out.push(
        `| ${r.id} | ${cellText(r.text)} | ${sources} | ${values} | ${BEHAVIOR[r.behavior]} | ${todo} |`,
      );
    }
    out.push('');
  }
  return out.join('\n').trimEnd();
}
