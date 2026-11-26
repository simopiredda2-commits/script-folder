import { REGIONAL_PACKAGES, type RegionalPackage } from '@mmg/regions';
import {
  loadRegionalRulesets,
  loadRulesets,
  type RegionalRuleset,
  type Rule,
  type Ruleset,
  type Source,
} from './ruleset';

const BEHAVIOR: Record<Rule['behavior'], string> = {
  block: 'Blocca',
  warn: 'Avvisa, serve un motivo',
  inform: 'Informa',
  out_of_scope: 'Fuori perimetro',
};

const cellText = (s: string) => s.replace(/\|/g, '\\|');

/** Un elenco non codificato fino a tante voci si scrive per intero; oltre, se ne dà il numero. */
const SHORT_LIST = 5;

const sourcesText = (sources: readonly Source[]) =>
  sources.map((s) => (s.url ? `[${cellText(s.title)}](${s.url})` : cellText(s.title))).join('; ');

/** Valori ed elenchi di una regola, come li scrive la tabella. */
function valuesText(values: Rule['values'] | undefined, lists: Rule['lists']): string {
  // Gli elenchi lunghi (codici AIC) si contano; quelli corti si scrivono (D272).
  // Gli elenchi codificati («codice=descrizione», come i codici della motivazione di R13) si
  // leggono voce per voce; gli altri, se lunghi, con il solo numero delle voci.
  const listed = Object.entries(lists ?? {}).map(([k, v]) =>
    v.length > 0 && v.every((x) => x.includes('='))
      ? `${k}: ${v.map((x) => x.replace('=', ' = ')).join(' · ')}`
      : v.length > SHORT_LIST
        ? `${k}: ${v.length} voci`
        : `${k}: ${v.join(', ')}`,
  );
  return (
    [...Object.entries(values ?? {}).map(([k, v]) => `${k} = ${v ?? 'da completare'}`), ...listed]
      .map(cellText)
      .join('; ') || '—'
  );
}

/**
 * Tabella delle regole per docs/regole.md, generata dai dati: dice ciò che il codice usa. Prima le
 * versioni nazionali, poi le aggiunte di ogni pacchetto regionale (D296), con il nome della regione
 * dal suo pacchetto.
 */
export function renderRulesTable(
  rulesets: Ruleset[] = loadRulesets(),
  packages: readonly RegionalPackage[] = REGIONAL_PACKAGES,
  regional: RegionalRuleset[] = loadRegionalRulesets(packages),
): string {
  const out: string[] = [];
  for (const rs of rulesets) {
    out.push(
      `**Versione ${rs.version}**, in vigore dal ${rs.effectiveFrom}. Valori da: ${rs.valuesSource}. Validata: ${rs.validated ? 'sì' : 'no'}.`,
      '',
    );
    out.push('| ID | Regola | Fonte | Valori | Comportamento | Da completare |');
    out.push('| --- | --- | --- | --- | --- | --- |');
    for (const r of rs.rules) {
      const todo = r.toComplete.map(cellText).join('; ') || '—';
      out.push(
        `| ${r.id} | ${cellText(r.text)} | ${sourcesText(r.sources)} | ${valuesText(r.values, r.lists)} | ${BEHAVIOR[r.behavior]} | ${todo} |`,
      );
    }
    out.push('');
  }
  for (const pkg of packages) {
    for (const rs of regional.filter((r) => r.region === pkg.key)) {
      out.push(
        `**Aggiunte della regione ${pkg.name}** (pacchetto \`${pkg.key}\`), **versione ${rs.version}**, in vigore dal ${rs.effectiveFrom}, sopra la versione nazionale in vigore alla stessa data. Da: ${rs.valuesSource}.`,
        '',
      );
      out.push(
        '| ID | Testo della regione | Fonti della regione | Valori della regione | Da completare |',
      );
      out.push('| --- | --- | --- | --- | --- |');
      for (const r of rs.rules) {
        const todo = (r.toComplete ?? []).map(cellText).join('; ') || '—';
        out.push(
          `| ${r.id} | ${r.text ? cellText(r.text) : '— (quello nazionale)'} | ${sourcesText(r.sources ?? []) || '—'} | ${valuesText(r.values, r.lists)} | ${todo} |`,
        );
      }
      out.push('');
    }
  }
  return out.join('\n').trimEnd();
}
