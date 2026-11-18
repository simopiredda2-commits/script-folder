import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Ricerca delle prestazioni per parole chiave (D153): il medico scrive le parole che conosce, in
 * qualunque ordine, e trova tutte le prestazioni che le contengono. Funzione pura: la rotta del
 * servizio la usa su un indice in memoria del catalogo in uso.
 */

/** Testo per la ricerca: minuscolo, senza accenti, segni e trattini come spazi. */
export function normalizeSearchText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const words = (text: string) => normalizeSearchText(text).split(' ').filter(Boolean);

const searchDataSchema = z
  .object({
    versione: z.string().min(1),
    nota: z.string().min(1),
    materiali: z.array(
      z
        .object({
          sigla: z.string().min(1),
          significato: z.string().min(1),
          fonte: z.string().min(1),
        })
        .strict(),
    ),
    sinonimi: z.array(
      z
        .object({
          termini: z.array(z.string().min(1)).min(1),
          /** Simboli brevi (K, Na): valgono solo se il medico li scrive. */
          sigle: z.array(z.string().min(1)).default([]),
          nelCatalogo: z.string().min(1),
          fonte: z.string().min(1),
        })
        .refine((g) => g.termini.length + g.sigle.length >= 2, {
          message: 'Un gruppo di sinonimi ha almeno due termini',
        })
        .strict(),
    ),
  })
  .strict();

export type ServiceSearchData = z.infer<typeof searchDataSchema>;

/** Controlla i dati della ricerca: termini già normalizzati, ognuno in un gruppo solo. */
export function parseServiceSearchData(raw: unknown): ServiceSearchData {
  const data = searchDataSchema.parse(raw);
  const seen = new Map<string, number>();
  data.sinonimi.forEach((group, i) => {
    for (const term of [...group.termini, ...group.sigle]) {
      if (normalizeSearchText(term) !== term) {
        throw new Error(
          `Sinonimi, gruppo ${i + 1}: «${term}» va scritto come «${normalizeSearchText(term)}»`,
        );
      }
      if (seen.has(term)) {
        throw new Error(`Sinonimi: «${term}» è in due gruppi (${seen.get(term)! + 1} e ${i + 1})`);
      }
      seen.set(term, i);
    }
  });
  const sigle = data.materiali.map((m) => m.sigla);
  const doppia = sigle.find((s, i) => sigle.indexOf(s) !== i);
  if (doppia) throw new Error(`Materiali: la sigla «${doppia}» è ripetuta`);
  return data;
}

export function loadServiceSearchData(path: string): ServiceSearchData {
  return parseServiceSearchData(JSON.parse(readFileSync(path, 'utf-8')));
}

/** Sigla del materiale tra quadre in fondo alla descrizione, con il significato se è noto. */
export function materialOf(
  description: string,
  data: ServiceSearchData,
): { sigla: string; significato: string } | null {
  const m = /\[([^\]]{1,12})\]\s*$/.exec(description);
  if (!m) return null;
  const sigla = m[1]!.trim().toUpperCase();
  const known = data.materiali.find((x) => x.sigla === sigla);
  return known ? { sigla, significato: known.significato } : null;
}

export interface SearchableService {
  regionalCode: string;
  nationalCode: string | null;
  description: string;
  branch: string | null;
}

interface Entry<T> {
  item: T;
  /** Parole della descrizione e del materiale per esteso. */
  words: string[];
  /** Coppie di parole vicine unite: «lombo sacrale» si trova anche come «lombosacrale». */
  joined: string[];
  /** Parole della branca: trovano la prestazione, ma contano meno. */
  branch: string[];
  /** Codici senza punti né spazi, per la ricerca per codice. */
  codes: string[];
  material: { sigla: string; significato: string } | null;
}

export interface ServiceIndex<T extends SearchableService> {
  entries: Entry<T>[];
  /** Per ogni termine, le alternative del suo gruppo (ognuna una lista di parole). */
  synonyms: Map<string, string[][]>;
  /** Termini di più parole, dal più lungo: si riconoscono anche nella domanda. */
  phrases: string[][];
}

const compactCode = (code: string | null) => (code ?? '').replace(/[\s.]/g, '').toLowerCase();

export function indexServices<T extends SearchableService>(
  items: T[],
  data: ServiceSearchData,
): ServiceIndex<T> {
  const synonyms = new Map<string, string[][]>();
  for (const group of data.sinonimi) {
    const names = group.termini.map((t) => t.split(' '));
    // Un nome trova gli altri nomi; una sigla trova i nomi e le sigle. I nomi non si allargano
    // alle sigle: «potassio» non deve trovare le «CATENE K» delle immunoglobuline.
    for (const term of group.termini) synonyms.set(term, names);
    const all = [...names, ...group.sigle.map((t) => [t])];
    for (const sigla of group.sigle) synonyms.set(sigla, all);
  }
  const phrases = [...synonyms.keys()]
    .filter((t) => t.includes(' '))
    .map((t) => t.split(' '))
    .sort((a, b) => b.length - a.length);
  const entries = items.map((item) => {
    const material = materialOf(item.description, data);
    const w = [...words(item.description), ...(material ? words(material.significato) : [])];
    return {
      item,
      words: w,
      joined: w.slice(1).map((x, i) => w[i] + x),
      branch: words(item.branch ?? ''),
      codes: [compactCode(item.regionalCode), compactCode(item.nationalCode)].filter(Boolean),
      material,
    };
  });
  return { entries, synonyms, phrases };
}

interface QueryToken {
  /** Le parole scritte dal medico per questo pezzo della domanda. */
  text: string;
  /** Modi di trovarlo: la parola stessa, i sinonimi, la radice di «-emia» e «-uria». */
  alternatives: string[][];
}

/** Radice dei nomi in «-emia» (nel sangue) e «-uria» (nelle urine): colesterolemia → colesterol. */
const MIN_STEM = 5;
function stemOf(word: string): string | null {
  const m = /^(.+)(emia|uria)$/.exec(word);
  return m && m[1]!.length >= MIN_STEM ? m[1]! : null;
}

function parseQuery<T extends SearchableService>(
  index: ServiceIndex<T>,
  query: string,
): QueryToken[] {
  const raw = words(query);
  const tokens: QueryToken[] = [];
  for (let i = 0; i < raw.length;) {
    const phrase = index.phrases.find((p) => p.every((w, k) => raw[i + k] === w));
    if (phrase) {
      tokens.push({ text: phrase.join(' '), alternatives: index.synonyms.get(phrase.join(' '))! });
      i += phrase.length;
      continue;
    }
    const w = raw[i]!;
    const alternatives: string[][] = [[w], ...(index.synonyms.get(w) ?? [])];
    const stem = stemOf(w);
    if (stem) alternatives.push([stem]);
    tokens.push({ text: w, alternatives });
    i += 1;
  }
  return tokens;
}

/** Punti di una parola: intera 3, inizio di parola 2, parole unite 1; 0 se non c'è. */
function wordScore(entry: Entry<SearchableService>, w: string): number {
  // Le parole brevi (K, RX, TC, Na) valgono solo intere: «k» non deve trovare ogni parola con la k.
  if (w.length <= 2) return entry.words.includes(w) ? 3 : 0;
  if (entry.words.includes(w)) return 3;
  if (entry.words.some((x) => x.startsWith(w))) return 2;
  if (entry.joined.some((x) => x.startsWith(w))) return 1;
  if (entry.branch.some((x) => x.startsWith(w))) return 1;
  return 0;
}

function tokenScore(entry: Entry<SearchableService>, token: QueryToken): number {
  let best = 0;
  for (const alt of token.alternatives) {
    const scores = alt.map((w) => wordScore(entry, w));
    if (!scores.every((x) => x > 0)) continue;
    // La voce che comincia con la parola cercata viene prima: «glicemia» trova prima «GLUCOSIO [S]»
    // che «DIALISI … CON SOLUZIONI DI GLUCOSIO».
    const first = entry.words[0] ?? '';
    const leads = alt[0]!.length <= 2 ? first === alt[0] : first.startsWith(alt[0]!);
    best = Math.max(best, Math.min(...scores) + (leads ? 2 : 0));
  }
  return best;
}

/**
 * Ricerca per codice, del catalogo regionale o del nomenclatore («codice DM»): l'inizio del codice,
 * senza badare a punti e spazi. Vale per ogni domanda con una cifra, anche se il codice comincia
 * con una lettera (i codici genetici, G9.01).
 */
const codeQuery = (query: string) => (/\d/.test(query) ? compactCode(query) : null);

export interface ServiceHit<T> {
  item: T;
  material: { sigla: string; significato: string } | null;
  score: number;
}

/**
 * Le prestazioni che contengono tutte le parole della domanda, in qualunque ordine. Ogni parola
 * vale se è l'inizio di una parola della descrizione (le parole di una o due lettere solo intere),
 * se è un sinonimo, o se unita alla vicina trova una parola scritta attaccata. Le varianti dello
 * stesso codice del nomenclatore restano vicine.
 */
export function searchServices<T extends SearchableService>(
  index: ServiceIndex<T>,
  query: string,
  limit: number,
): ServiceHit<T>[] {
  if (!normalizeSearchText(query)) return [];
  const hits: ServiceHit<T>[] = [];
  const code = codeQuery(query);
  const tokens = parseQuery(index, query);
  for (const e of index.entries) {
    // Il codice vale più delle parole: chi lo scrive sa che cosa cerca.
    if (code && e.codes.some((c) => c.startsWith(code))) {
      hits.push({ item: e.item, material: e.material, score: 100 });
      continue;
    }
    let total = 0;
    let ok = tokens.length > 0;
    for (let i = 0; i < tokens.length && ok; i++) {
      let s = tokenScore(e, tokens[i]!);
      // «lombo sacrale» scritto staccato, nel catalogo «LOMBOSACRALE»: la parola unita alla precedente.
      if (!s && i > 0) {
        s = wordScore(e, tokens[i - 1]!.text.replace(/ /g, '') + tokens[i]!.text) ? 1 : 0;
      }
      if (!s) ok = false;
      total += s;
    }
    if (ok) hits.push({ item: e.item, material: e.material, score: total });
  }
  // Le varianti dello stesso codice del nomenclatore stanno insieme; a parità di punti, prima il
  // gruppo con la descrizione più corta (la prestazione più generale).
  const group = (h: ServiceHit<T>) => h.item.nationalCode ?? h.item.regionalCode;
  const shortest = new Map<string, number>();
  for (const h of hits) {
    const k = `${h.score}|${group(h)}`;
    shortest.set(k, Math.min(shortest.get(k) ?? Infinity, h.item.description.length));
  }
  const len = (h: ServiceHit<T>) => shortest.get(`${h.score}|${group(h)}`)!;
  return hits
    .sort(
      (a, b) =>
        b.score - a.score ||
        len(a) - len(b) ||
        group(a).localeCompare(group(b), 'it', { numeric: true }) ||
        a.item.description.localeCompare(b.item.description, 'it') ||
        a.item.regionalCode.localeCompare(b.item.regionalCode, 'it', { numeric: true }),
    )
    .slice(0, limit);
}
