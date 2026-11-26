import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REGIONAL_PACKAGES, regionalDataDir, type RegionalPackage } from '@mmg/regions';
import { z } from 'zod';

/**
 * Identificativi delle regole: R1–R17 dei requisiti; R18 chiesta da Simone (D154); R19 e R20 sullo
 * stato del paziente, per scelta di Simone (D199); R21 sui farmaci carenti, dall'elenco AIFA (D202);
 * R22 sulla confezione sospesa, dall'anagrafica AIFA delle confezioni, per scelta di Simone (D210);
 * R23 sugli stupefacenti (D272); R24 sulla nota del nomenclatore e R25 sulle prestazioni della stessa
 * branca, dal DPCM LEA (D276).
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
  'R22',
  'R23',
  'R24',
  'R25',
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
    /** Elenchi della regola, presi dalle fonti: codici AIC, codici di esenzione, sostanze (D272). */
    lists: z.record(z.string(), z.array(z.string().trim().min(1))).optional(),
    /** Che cosa manca perché la regola sia completa. */
    toComplete: z.array(z.string()),
  })
  .strict();

/** Una versione: la data da cui vale e un numero progressivo, per esempio 2026-11-26.1. */
const versionSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}\.\d+$/);

export const rulesetSchema = z
  .object({
    version: versionSchema,
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

export type Source = z.infer<typeof sourceSchema>;

/** Ciò che la regione dello studio ha aggiunto a una regola (D296). */
export interface RegionalAddition {
  /** La chiave del pacchetto della regione (D288). */
  region: string;
  /** La versione delle aggiunte della regione. */
  version: string;
  /** Le fonti della regione: sono anche in `sources`, dopo quelle nazionali. */
  sources: Source[];
}

type ParsedRuleset = z.infer<typeof rulesetSchema>;
export type Rule = ParsedRuleset['rules'][number] & { regional?: RegionalAddition };
export type Ruleset = Omit<ParsedRuleset, 'rules'> & { rules: Rule[] };

/**
 * Le aggiunte di una regione a una regola nazionale (D288, D296): un testo che prende il posto di
 * quello nazionale, fonti, valori ed elenchi nuovi, cose da completare. Non cambiano che cosa fa la
 * regola (blocca, avvisa o informa) e non toccano i valori nazionali: un valore o un elenco che la
 * versione nazionale ha già è un errore. Un valore o un elenco della regione porta la sua fonte.
 */
const regionalRuleSchema = z
  .object({
    id: z.enum(RULE_IDS),
    text: z.string().trim().min(1).optional(),
    sources: z.array(sourceSchema).optional(),
    values: z.record(z.string(), z.number().nullable()).optional(),
    lists: z.record(z.string(), z.array(z.string().trim().min(1))).optional(),
    toComplete: z.array(z.string().trim().min(1)).optional(),
  })
  .strict()
  .refine(
    (r) =>
      r.text !== undefined ||
      !!r.sources?.length ||
      !!r.toComplete?.length ||
      Object.keys(r.values ?? {}).length + Object.keys(r.lists ?? {}).length > 0,
    { message: 'Un’aggiunta della regione deve aggiungere qualcosa alla regola' },
  )
  .refine(
    (r) =>
      Object.keys(r.values ?? {}).length + Object.keys(r.lists ?? {}).length === 0 ||
      !!r.sources?.length,
    { message: 'I valori e gli elenchi della regione portano la loro fonte' },
  );

/** Le aggiunte di una regione alle regole nazionali, in una versione con la sua data (D296). */
export const regionalRulesetSchema = z
  .object({
    version: versionSchema,
    effectiveFrom: z.iso.date(),
    valuesSource: z.string().trim().min(1),
    rules: z.array(regionalRuleSchema).min(1),
  })
  .strict()
  .refine((r) => RULE_IDS.every((id) => r.rules.filter((x) => x.id === id).length <= 1), {
    message: 'Ogni regola compare al più una volta fra le aggiunte della regione',
  });

export type RegionalRuleset = z.infer<typeof regionalRulesetSchema> & {
  /** La chiave del pacchetto della regione (D288). */
  region: string;
};

export const DATA_DIR = join(import.meta.dirname, '..', 'data');

/** I file delle versioni in una cartella, letti con il loro schema. */
function readVersions<T>(dir: string, schema: z.ZodType<T>): T[] {
  return readdirSync(dir)
    .filter((f) => /^regole-.*\.json$/.test(f))
    .map((f) => schema.parse(JSON.parse(readFileSync(join(dir, f), 'utf8'))));
}

/** Tutte le versioni nazionali delle regole, dalla più vecchia alla più recente. */
export function loadRulesets(dir: string = DATA_DIR): Ruleset[] {
  return readVersions(dir, rulesetSchema).sort(compareVersions);
}

/**
 * Le aggiunte alle regole dei pacchetti regionali (D288, D296), da
 * `packages/regions/<chiave>/data/regole/`: per ogni pacchetto, dalla più vecchia alla più recente.
 */
export function loadRegionalRulesets(
  packages: readonly RegionalPackage[] = REGIONAL_PACKAGES,
): RegionalRuleset[] {
  return packages.flatMap((p) => {
    const dir = regionalDataDir('regole', p);
    if (!dir) return [];
    return readVersions(dir, regionalRulesetSchema)
      .map((r) => ({ ...r, region: p.key }))
      .sort(compareVersions);
  });
}

/** Ordine delle versioni: data di efficacia, poi numero progressivo (a parità di data vince il più alto). */
function compareVersions(
  a: { version: string; effectiveFrom: string },
  b: { version: string; effectiveFrom: string },
): number {
  const byDate = a.effectiveFrom.localeCompare(b.effectiveFrom);
  if (byDate !== 0) return byDate;
  const n = (v: string) => Number(v.split('.').at(-1));
  return n(a.version) - n(b.version);
}

/**
 * La versione in vigore alla data della ricetta (A5 dei requisiti: si usano i dati in vigore
 * alla data della ricetta, non quelli dell'ultimo aggiornamento). Con la regione dello studio
 * (la chiave del suo pacchetto, D288), la versione nazionale porta le aggiunte della regione in
 * vigore alla stessa data (D296); senza, o se la regione non ne ha, è la versione nazionale.
 */
export function rulesetAt(
  date: string,
  rulesets: Ruleset[] = loadRulesets(),
  region: string | null = null,
  regional: RegionalRuleset[] = region ? loadRegionalRulesets() : [],
): Ruleset {
  const valid = [...rulesets].sort(compareVersions).filter((r) => r.effectiveFrom <= date);
  const found = valid.at(-1);
  if (!found) throw new Error(`Nessuna versione delle regole in vigore il ${date}`);
  if (!region) return found;
  const added = regional
    .filter((r) => r.region === region && r.effectiveFrom <= date)
    .sort(compareVersions)
    .at(-1);
  return added ? withRegionalAdditions(found, added) : found;
}

/**
 * La versione nazionale con le aggiunte di una regione (D296). La versione che resta registrata
 * con la ricetta le dice tutte e due: «nazionale+regione@aggiunte», per esempio
 * `2026-11-26.1+chiave@2026-11-26.1`. Le fonti della regione vanno dopo quelle nazionali, e la
 * prima fonte, quella che accompagna i messaggi, resta la nazionale. Un'aggiunta a una regola che
 * la versione nazionale non ha, o a un suo valore o elenco, è un errore dei dati.
 */
export function withRegionalAdditions(national: Ruleset, added: RegionalRuleset): Ruleset {
  const label = `le aggiunte ${added.region}@${added.version}`;
  for (const a of added.rules) {
    if (!national.rules.some((r) => r.id === a.id))
      throw new Error(
        `${label} toccano la regola ${a.id}, che non è nella versione nazionale ${national.version}`,
      );
  }
  return {
    ...national,
    version: `${national.version}+${added.region}@${added.version}`,
    effectiveFrom:
      added.effectiveFrom > national.effectiveFrom ? added.effectiveFrom : national.effectiveFrom,
    valuesSource: `${national.valuesSource}. Aggiunte della regione (${added.region}@${added.version}): ${added.valuesSource}`,
    rules: national.rules.map((r) => {
      const a = added.rules.find((x) => x.id === r.id);
      if (!a) return r;
      const taken = [
        ...Object.keys(a.values ?? {}).filter((k) => k in r.values),
        ...Object.keys(a.lists ?? {}).filter((k) => k in (r.lists ?? {})),
      ];
      if (taken.length)
        throw new Error(
          `${label} cambiano ${taken.join(', ')} di ${r.id}, già nella versione nazionale ${national.version}`,
        );
      const lists = r.lists || a.lists ? { lists: { ...r.lists, ...a.lists } } : {};
      return {
        ...r,
        text: a.text ?? r.text,
        sources: [...r.sources, ...(a.sources ?? [])],
        values: { ...r.values, ...a.values },
        ...lists,
        toComplete: [...r.toComplete, ...(a.toComplete ?? [])],
        regional: { region: added.region, version: added.version, sources: a.sources ?? [] },
      };
    }),
  };
}

/** Valore numerico di una regola: se manca, la regola non si può applicare. */
export function value(rule: Rule, key: string): number | null {
  return rule.values[key] ?? null;
}

/**
 * Giorni di validità della ricetta specialistica secondo R1 alla data, per tipo di accesso: sono
 * della regione dello studio (D260), nelle sue aggiunte alle regole (D296), e li stampa il
 * promemoria. Null se la versione in vigore non li ha: allora vale quello che dicono le
 * specifiche di stampa.
 */
export function specialistValidityDays(
  date: string,
  accessType: 'first' | 'subsequent',
  region: string | null = null,
  rulesets: Ruleset[] = loadRulesets(),
  regional?: RegionalRuleset[],
): number | null {
  const r1 = rulesetAt(date, rulesets, region, regional).rules.find((r) => r.id === 'R1');
  if (!r1 || r1.status !== 'active') return null;
  return value(
    r1,
    accessType === 'first' ? 'specialistFirstAccessDays' : 'specialistOtherAccessDays',
  );
}

/**
 * Confezioni per ricetta secondo R2 alla data: serve a raggruppare le ripetizioni senza
 * superare il limite. Null se la regola non ha il valore.
 */
export function basePackLimit(date: string, rulesets: Ruleset[] = loadRulesets()): number | null {
  const r2 = rulesetAt(date, rulesets).rules.find((r) => r.id === 'R2');
  return r2 && r2.status === 'active' ? value(r2, 'maxPacks') : null;
}

/**
 * Codici di esenzione della terapia del dolore secondo R23 alla data (D272): con questi la
 * ricetta degli stupefacenti dell'allegato III-bis porta posologia e telefono del medico nelle
 * note. Vuoto se la versione in vigore non ha la regola.
 */
export function painTherapyCodes(date: string, rulesets: Ruleset[] = loadRulesets()): string[] {
  const r23 = rulesetAt(date, rulesets).rules.find((r) => r.id === 'R23');
  return r23 && r23.status === 'active' ? (r23.lists?.painTherapyExemptions ?? []) : [];
}

/** Una voce di un elenco codificato nei dati di una regola: «codice=descrizione». */
export interface CodedItem {
  code: string;
  label: string;
}

/** Legge le voci «codice=descrizione» di un elenco dei dati; senza «=» il codice fa da descrizione. */
export function codedItems(items: readonly string[] | undefined): CodedItem[] {
  return (items ?? []).map((item) => {
    const at = item.indexOf('=');
    return at === -1
      ? { code: item.trim(), label: item.trim() }
      : { code: item.slice(0, at).trim(), label: item.slice(at + 1).trim() };
  });
}

/**
 * I codici della motivazione di non sostituibilità della regola R13 in vigore alla data, con la
 * loro descrizione (linee guida del Sistema TS per la prescrizione del principio attivo, D273).
 * Vuoto se la versione in vigore non li ha: allora la motivazione è solo il testo.
 */
export function substitutionReasons(
  date: string,
  rulesets: Ruleset[] = loadRulesets(),
): CodedItem[] {
  const r13 = rulesetAt(date, rulesets).rules.find((r) => r.id === 'R13');
  return r13 && r13.status === 'active' ? codedItems(r13.lists?.substitutionReasons) : [];
}
