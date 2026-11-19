import type { ServiceResultData } from '../components/ServiceResult';
import { useApi } from './useApi';

/**
 * Elenchi dello studio (tappa 14) come li dà il servizio: medici suggeritori, posologie, pacchetti
 * di prestazioni, contatti utili. I controlli dei campi sono nel dominio (@mmg/domain,
 * studio-lists) e il servizio li ripete; qui ci sono i tipi e i passaggi verso la scheda della
 * terapia e la ricetta.
 */

export type StudioListKind = 'suggeritore' | 'posologia' | 'pacchetto' | 'contatto';

export interface Suggestor {
  nome: string;
  struttura: string | null;
  specialita: string | null;
  telefono: string | null;
}
export interface Posology {
  testo: string;
  dose: string | null;
  unita: string | null;
  frequenza: string | null;
  momento: string | null;
  via: string | null;
}
export interface PackageService {
  codice: string;
  descrizione: string;
}
export interface ServicePackage {
  nome: string;
  prestazioni: PackageService[];
}
export interface UsefulContact {
  nome: string;
  tipo: string;
  telefono: string | null;
  email: string | null;
  indirizzo: string | null;
  note: string | null;
}

export interface ListData {
  suggeritore: Suggestor;
  posologia: Posology;
  pacchetto: ServicePackage;
  contatto: UsefulContact;
}

/** Una prestazione del pacchetto cercata nel catalogo in vigore: null se il catalogo non l'ha. */
export type CatalogCheck = PackageService & { voce: ServiceResultData | null };

export interface ListItem<K extends StudioListKind = StudioListKind> {
  id: string;
  tipo: K;
  etichetta: string;
  dati: ListData[K];
  creataIl: string;
  creataDa: string | null;
  archiviataIl: string | null;
  /** Solo per i pacchetti attivi; null se nessun catalogo delle prestazioni è in uso. */
  catalogo?: { prestazioni: CatalogCheck[] } | null;
}

/** Lunghezze massime e prestazioni per pacchetto, come nel dominio (controlli di buon senso). */
export interface ListLimits {
  name: number;
  facility: number;
  specialty: number;
  phone: number;
  email: number;
  address: number;
  notes: number;
  posologyText: number;
  dose: number;
  posologyPart: number;
  packageServices: number;
}

export interface StudioLists<K extends StudioListKind = StudioListKind> {
  tipo: K | null;
  data: string;
  voci: ListItem<K>[];
  archiviate: ListItem<K>[];
  tipi: { codice: StudioListKind; nome: string; voce: string }[];
  tipiContatto: { codice: string; nome: string }[];
  limiti: ListLimits;
  /** Se c'è un catalogo delle prestazioni in uso (per i pacchetti); null se non chiesto. */
  catalogo: boolean | null;
  puoModificare: boolean;
}

/** Un elenco dello studio; con kind null nessuna richiesta (la pagina non lo usa). */
export function useStudioList<K extends StudioListKind>(kind: K | null) {
  return useApi<StudioLists<K>>(kind ? `/api/studio/elenchi?tipo=${kind}` : null);
}

/** Dove si aggiorna un elenco: Strumenti › Elenchi dello studio, con l'elenco già scelto. */
export const listPath = (kind: StudioListKind) => `/strumenti?sezione=elenchi&elenco=${kind}`;

/** I campi della scheda della terapia che una posologia dello studio riempie (D80). */
export interface PosologyFields {
  dose: string;
  doseUnit: string;
  frequency: string;
  timeOfDay: string;
  route: string;
}

const PARTS: [Exclude<keyof Posology, 'testo'>, keyof PosologyFields][] = [
  ['dose', 'dose'],
  ['unita', 'doseUnit'],
  ['frequenza', 'frequency'],
  ['momento', 'timeOfDay'],
  ['via', 'route'],
];

/** Le parti che la posologia ha: solo queste riempiono la scheda, le altre restano come sono. */
export function posologyPatch(p: Posology): Partial<PosologyFields> {
  const out: Partial<PosologyFields> = {};
  for (const [from, to] of PARTS) {
    const v = (p[from] ?? '').trim();
    if (v) out[to] = v;
  }
  return out;
}

export const hasPosologyParts = (p: Posology) => Object.keys(posologyPatch(p)).length > 0;

/**
 * La posologia dello studio che la scheda ha già: tutte le sue parti uguali ai campi; se più d'una,
 * la più completa. Stringa vuota se nessuna.
 */
export function matchingPosology(items: ListItem<'posologia'>[], fields: PosologyFields): string {
  let best: { id: string; parts: number } | null = null;
  for (const item of items) {
    const patch = posologyPatch(item.dati);
    const keys = Object.keys(patch) as (keyof PosologyFields)[];
    if (!keys.length || !keys.every((k) => patch[k] === fields[k].trim())) continue;
    if (!best || keys.length > best.parts) best = { id: item.id, parts: keys.length };
  }
  return best?.id ?? '';
}

const folded = (s: string | null | undefined) =>
  (s ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('it');

/** Il medico suggeritore che la scheda ha già: stesso nome e stessa struttura. */
export function matchingSuggestor(
  items: ListItem<'suggeritore'>[],
  name: string,
  facility: string,
): string {
  return (
    items.find(
      (s) => folded(s.dati.nome) === folded(name) && folded(s.dati.struttura) === folded(facility),
    )?.id ?? ''
  );
}

/** Come si presenta un medico suggeritore nella scelta: nome, specialità, struttura. */
export const suggestorLabel = (s: Suggestor) =>
  [s.nome, s.specialita, s.struttura].filter(Boolean).join(' · ');

/** Una riga della ricetta specialistica con i due codici del catalogo (D154). */
export interface PackageLine {
  serviceCode: string;
  serviceNationalCode: string | null;
  serviceDescription: string;
  quantity: number;
}

/**
 * Le righe che un pacchetto aggiunge alla ricetta: ogni prestazione cercata nel catalogo in vigore,
 * con i due codici e la descrizione del catalogo, come dalla ricerca delle prestazioni. Quelle che il
 * catalogo in vigore non ha non si aggiungono e si dicono; quelle già in ricetta non si ripetono.
 */
export function packageLines(
  item: ListItem<'pacchetto'>,
  inPrescription: (string | null | undefined)[],
): { add: PackageLine[]; missing: PackageService[]; already: PackageService[] } {
  const code = (c: string) => c.trim().toUpperCase();
  const have = new Set(inPrescription.flatMap((c) => (c ? [code(c)] : [])));
  const services: CatalogCheck[] = item.catalogo
    ? item.catalogo.prestazioni
    : item.dati.prestazioni.map((s) => ({ ...s, voce: null }));
  const add: PackageLine[] = [];
  const missing: PackageService[] = [];
  const already: PackageService[] = [];
  for (const { voce, ...s } of services) {
    if (!voce) {
      missing.push(s);
      continue;
    }
    if (have.has(code(voce.regionalCode))) {
      already.push(s);
      continue;
    }
    have.add(code(voce.regionalCode));
    add.push({
      serviceCode: voce.regionalCode,
      serviceNationalCode: voce.nationalCode,
      serviceDescription: voce.description,
      quantity: 1,
    });
  }
  return { add, missing, already };
}

/** «1 prestazione», «3 prestazioni». */
export const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
