import type { DataRecord, DatasetKind } from './kinds';
import { normalizeSearchText } from './search';

/**
 * Diagnosi ICD-9-CM (D186): gerarchia, controlli sull'elenco intero e ricerca per descrizione o per
 * codice. Il medico scrive le parole che conosce, in qualunque ordine. I titoli brevi dei
 * sottocodici («Altro», «Linfonodi») si capiscono con i titoli dei padri, che valgono anche per la
 * ricerca: «frattura colles esposta» trova 813.51, il cui titolo è solo «Frattura di Colles».
 */

export interface DiagnosisRow {
  code: string;
  description: string;
  parentCode: string | null;
  includedTerms: string | null;
  notes: string | null;
  chapter: string | null;
  section: string | null;
}

export interface DiagnosisHit extends DiagnosisRow {
  /** Ha sottocodici: per codificare si sceglie il codice più specifico. */
  category: boolean;
  /** I padri, dal più generale: danno il senso ai titoli brevi. */
  path: { code: string; description: string }[];
}

/** Il padre di un codice: senza l'ultima cifra (250.00 → 250.0 → 250); null per le categorie. */
export function icd9Parent(code: string): string | null {
  const m = /^([VE]?\d+)\.(\d+)$/.exec(code);
  if (!m) return null;
  return m[2]!.length === 1 ? m[1]! : `${m[1]}.${m[2]!.slice(0, -1)}`;
}

/** Codice per i confronti: maiuscolo, senza punti né spazi (4019 e 401.9 sono lo stesso codice). */
export const icd9Key = (code: string) => code.trim().toUpperCase().replace(/[\s.]/g, '');

/**
 * Ordine della classificazione: prima i codici numerici, poi i V, poi gli E; dentro, la categoria
 * e poi i decimali come testo, così il padre viene prima dei figli (250, 250.0, 250.00, 250.01, 250.1).
 */
export function compareIcd9(a: string, b: string): number {
  const parse = (c: string) => {
    const m = /^([VE]?)(\d+)(?:\.(\d+))?$/.exec(c.trim().toUpperCase());
    return m ? { group: ['', 'V', 'E'].indexOf(m[1]!), n: Number(m[2]), dec: m[3] ?? '' } : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return a.localeCompare(b);
  return x.group - y.group || x.n - y.n || (x.dec < y.dec ? -1 : x.dec > y.dec ? 1 : 0);
}

export interface StructureProblem {
  /** Posizione della voce nell'elenco controllato. */
  index: number;
  field: string;
  problem: string;
}

/**
 * Controlli che guardano l'elenco intero, oltre alla forma di ogni campo: per le diagnosi ogni
 * codice una volta sola, e il padre di ogni sottocodice è il codice senza l'ultima cifra e c'è
 * nell'elenco. Per gli altri tipi nessun controllo.
 */
export function structureProblems(
  kind: DatasetKind,
  records: readonly DataRecord[],
): StructureProblem[] {
  if (kind !== 'diagnosi') return [];
  const codes = new Set(records.map((r) => String(r.code)));
  const seen = new Set<string>();
  const problems: StructureProblem[] = [];
  records.forEach((r, index) => {
    const code = String(r.code);
    const parent = typeof r.parentCode === 'string' ? r.parentCode : '';
    if (seen.has(code)) {
      problems.push({ index, field: 'code', problem: `${code}: codice ripetuto` });
      return;
    }
    seen.add(code);
    const expected = icd9Parent(code);
    if (expected === null && parent) {
      problems.push({
        index,
        field: 'parentCode',
        problem: `${code}: una categoria di tre cifre non ha padre (scritto ${parent})`,
      });
    } else if (expected !== null && parent !== expected) {
      problems.push({
        index,
        field: 'parentCode',
        problem: `${code}: il padre è ${expected}, non ${parent || 'vuoto'}`,
      });
    } else if (expected !== null && !codes.has(expected)) {
      problems.push({
        index,
        field: 'parentCode',
        problem: `${code}: il padre ${expected} non c'è`,
      });
    }
  });
  return problems;
}

/** Parole che non distinguono una diagnosi dall'altra. «con», «senza» e «non» invece sì. */
const STOP_WORDS = new Set([
  'a',
  'ad',
  'agli',
  'ai',
  'al',
  'alla',
  'alle',
  'allo',
  'che',
  'come',
  'da',
  'dagli',
  'dai',
  'dal',
  'dalla',
  'dalle',
  'dei',
  'degli',
  'del',
  'della',
  'delle',
  'dello',
  'di',
  'e',
  'ed',
  'fra',
  'gli',
  'i',
  'il',
  'in',
  'la',
  'le',
  'lo',
  'nei',
  'negli',
  'nel',
  'nella',
  'nelle',
  'o',
  'od',
  'per',
  'su',
  'sul',
  'sulla',
  'tra',
  'un',
  'una',
  'uno',
]);

const words = (text: string | null) =>
  normalizeSearchText(text ?? '')
    .split(' ')
    .filter(Boolean);

interface Entry {
  item: DiagnosisRow;
  order: number;
  key: string;
  title: string[];
  terms: string[];
  /** Titoli dei padri e sezione: trovano la voce, ma contano meno del suo titolo. */
  context: string[];
  path: DiagnosisHit['path'];
}

export interface DiagnosisIndex {
  entries: Entry[];
  byKey: Map<string, Entry>;
  children: Map<string, number>;
}

export function indexDiagnoses(rows: readonly DiagnosisRow[]): DiagnosisIndex {
  const sorted = [...rows].sort((a, b) => compareIcd9(a.code, b.code));
  const byCode = new Map(sorted.map((r) => [r.code, r]));
  const children = new Map<string, number>();
  for (const r of sorted) {
    if (r.parentCode) children.set(r.parentCode, (children.get(r.parentCode) ?? 0) + 1);
  }
  const ancestors = (r: DiagnosisRow) => {
    const out: DiagnosisRow[] = [];
    const seen = new Set<string>();
    for (let p = r.parentCode; p && byCode.has(p) && !seen.has(p); p = byCode.get(p)!.parentCode) {
      seen.add(p);
      out.unshift(byCode.get(p)!);
    }
    return out;
  };
  const entries = sorted.map((item, order) => {
    const up = ancestors(item);
    return {
      item,
      order,
      key: icd9Key(item.code),
      title: words(item.description),
      terms: words(item.includedTerms),
      context: [...up.flatMap((a) => words(a.description)), ...words(item.section)],
      path: up.map((a) => ({ code: a.code, description: a.description })),
    };
  });
  return { entries, byKey: new Map(entries.map((e) => [e.key, e])), children };
}

const toHit = (index: DiagnosisIndex, e: Entry): DiagnosisHit => ({
  ...e.item,
  category: (index.children.get(e.item.code) ?? 0) > 0,
  path: e.path,
});

/** La voce di un codice, scritto con o senza punto; null se non c'è. */
export function diagnosisByCode(index: DiagnosisIndex, code: string): DiagnosisHit | null {
  const e = index.byKey.get(icd9Key(code));
  return e ? toHit(index, e) : null;
}

/** Una domanda che è un codice o il suo inizio: 401, 401.9, 4019, V17, e880. */
const isCodeQuery = (q: string) => /^[EV]?\d[\d.]*$/i.test(q.trim());

/** Una parola della domanda vale se è l'inizio di una parola (quelle di una o due lettere intere). */
const matches = (list: string[], w: string) =>
  w.length <= 2 ? list.includes(w) : list.some((x) => x.startsWith(w));

export interface DiagnosisSearch {
  hits: DiagnosisHit[];
  /** Quante voci rispondono alla domanda, anche oltre il limite. */
  total: number;
}

/**
 * Le diagnosi con tutte le parole della domanda, in qualunque ordine: nel titolo (3 punti), nei
 * termini inclusi (2) o nei titoli dei padri e nella sezione (1). A parità di punti, l'ordine della
 * classificazione: la categoria e poi i suoi sottocodici. Una domanda fatta di cifre cerca il codice.
 */
export function searchDiagnoses(
  index: DiagnosisIndex,
  query: string,
  limit: number,
): DiagnosisSearch {
  const q = query.trim();
  if (!normalizeSearchText(q)) return { hits: [], total: 0 };
  const scored: { e: Entry; score: number }[] = [];
  if (isCodeQuery(q)) {
    const key = icd9Key(q);
    for (const e of index.entries) if (e.key.startsWith(key)) scored.push({ e, score: 0 });
  } else {
    const ws = words(q).filter((w) => !STOP_WORDS.has(w));
    if (!ws.length) return { hits: [], total: 0 };
    for (const e of index.entries) {
      let score = 0;
      for (const w of ws) {
        const s = matches(e.title, w) ? 3 : matches(e.terms, w) ? 2 : matches(e.context, w) ? 1 : 0;
        if (!s) {
          score = 0;
          break;
        }
        score += s;
      }
      if (score) scored.push({ e, score });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.e.order - b.e.order);
  return { hits: scored.slice(0, limit).map(({ e }) => toHit(index, e)), total: scored.length };
}
