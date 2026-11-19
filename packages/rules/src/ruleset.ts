import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

/**
 * Identificativi delle regole: R1–R17 dei requisiti; R18 chiesta da Simone (D154); R19 e R20 sullo
 * stato del paziente, per scelta di Simone (D199); R21 sui farmaci carenti, dall'elenco AIFA (D202).
 */
export const RULE_IDS = [
  'R1',
  'R2',
  'R3',
  'R4',
  'R5',
  'R6',
  'R7',
  'R8',
  'R9',
  'R10',
  'R11',
  'R12',
  'R13',
  'R14',
  'R15',
  'R16',
  'R17',
  'R18',
  'R19',
  'R20',
  'R21',
] as const;
export type RuleId = (typeof RULE_IDS)[number];

/** Le regole dei requisiti: ci sono in ogni versione. Quelle dopo la R17 dalla loro versione in poi. */
const REQUIRED_RULE_IDS = RULE_IDS.slice(0, RULE_IDS.indexOf('R17') + 1);

const sourceSchema = z
  .object({ title: z.string().trim().min(1), url: z.url().optional() })
  .strict();

const ruleSchema = z
  .object({
    id: z.enum(RULE_IDS),
    text: z.string().trim().min(1),
    /** block: norma, blocca l'invio; warn: buona pratica, serve un motivo; inform: solo informazione. */
    behavior: z.enum(['block', 'warn', 'inform', 'out_of_scope']),
    status: z.enum(['active', 'out_of_scope']),
    sources: z.array(sourceSchema).min(1),
    /** Valori della regola: numeri presi dai requisiti, mai scritti nel codice. */
    values: z.record(z.string(), z.number().nullable()),
    /** Che cosa manca perché la regola sia completa. */
    toComplete: z.array(z.string()),
  })
  .strict();

export const rulesetSchema = z
  .object({
    version: z.string().regex(/^\d{4}-\d{2}-\d{2}\.\d+$/),
    effectiveFrom: z.iso.date(),
    valuesSource: z.string().trim().min(1),
    validated: z.boolean(),
    validationNote: z.string(),
    rules: z.array(ruleSchema),
  })
  .strict()
  .refine(
    (r) =>
      REQUIRED_RULE_IDS.every((id) => r.rules.filter((x) => x.id === id).length === 1) &&
      RULE_IDS.every((id) => r.rules.filter((x) => x.id === id).length <= 1),
    { message: 'Ogni regola da R1 a R17 compare una e una sola volta; le altre al più una volta' },
  );

export type Ruleset = z.infer<typeof rulesetSchema>;
export type Rule = Ruleset['rules'][number];

export const DATA_DIR = join(import.meta.dirname, '..', 'data');

/** Tutte le versioni delle regole, dalla più vecchia alla più recente. */
export function loadRulesets(dir: string = DATA_DIR): Ruleset[] {
  return readdirSync(dir)
    .filter((f) => /^regole-.*\.json$/.test(f))
    .map((f) => rulesetSchema.parse(JSON.parse(readFileSync(join(dir, f), 'utf8'))))
    .sort(compareVersions);
}

/** Ordine delle versioni: data di efficacia, poi numero progressivo (a parità di data vince il più alto). */
function compareVersions(a: Ruleset, b: Ruleset): number {
  const byDate = a.effectiveFrom.localeCompare(b.effectiveFrom);
  if (byDate !== 0) return byDate;
  const n = (v: string) => Number(v.split('.').at(-1));
  return n(a.version) - n(b.version);
}

/**
 * La versione in vigore alla data della ricetta (A5 dei requisiti: si usano i dati in vigore
 * alla data della ricetta, non quelli dell'ultimo aggiornamento).
 */
export function rulesetAt(date: string, rulesets: Ruleset[] = loadRulesets()): Ruleset {
  const valid = [...rulesets].sort(compareVersions).filter((r) => r.effectiveFrom <= date);
  const found = valid.at(-1);
  if (!found) throw new Error(`Nessuna versione delle regole in vigore il ${date}`);
  return found;
}

/** Valore numerico di una regola: se manca, la regola non si può applicare. */
export function value(rule: Rule, key: string): number | null {
  return rule.values[key] ?? null;
}

/**
 * Confezioni per ricetta secondo R2 alla data: serve a raggruppare le ripetizioni senza
 * superare il limite. Null se la regola non ha il valore.
 */
export function basePackLimit(date: string, rulesets: Ruleset[] = loadRulesets()): number | null {
  const r2 = rulesetAt(date, rulesets).rules.find((r) => r.id === 'R2');
  return r2 && r2.status === 'active' ? value(r2, 'maxPacks') : null;
}
