import { RAO_FILES } from '@mmg/reference';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * Tabelle RAO, Raggruppamenti di attesa omogenei (D285): per ogni prestazione, le condizioni
 * cliniche per classe di priorità. Il medico sceglie la condizione del paziente e il programma
 * mette la classe della tabella; il medico la può cambiare. Le tabelle sono trascrizioni (il manuale
 * di AGENAS, le determine della Regione Piemonte), lette dai file e controllate qui. Il legame con
 * il catalogo è il codice del nomenclatore di oggi, con l'inizio della descrizione dove lo stesso
 * codice vale per discipline diverse (per esempio 89.7, «PRIMA VISITA»).
 */

const NATIONAL_CODE = /^\d{2}(\.[0-9A-Z]{1,2}){0,2}$/;

const indication = z
  .object({
    /** Il numero come è stampato: non sempre in ordine, a volte ripetuto (lo dice la nota del file). */
    numero: z.string().min(1),
    testo: z.string().min(1),
    /** «Altro (10%)»: una condizione non descritta dalla tabella, da scrivere nel quesito. */
    altro: z.literal(true).optional(),
  })
  .strict();

const row = z
  .object({
    classe: z.enum(['emergenza', 'U', 'B', 'D', 'P']),
    pediatria: z.boolean(),
    attesa: z.string().min(1),
    /** I pazienti a cui vale la riga, quando la tabella li distingue. */
    gruppo: z.string().min(1).optional(),
    /** Riga che l'atto scrive nelle note sotto la tabella. */
    da_nota: z.literal(true).optional(),
    indicazioni: z.array(indication),
    /** Il testo della cella quando la classe non ha indicazioni («non previste»). */
    non_previste: z.string().min(1).optional(),
  })
  .strict()
  .refine((r) => (r.indicazioni.length === 0) === (r.non_previste !== undefined), {
    message: 'Una riga ha le indicazioni oppure dice che non sono previste',
  });

const link = z
  .object({
    codice: z.string().regex(NATIONAL_CODE),
    /** Inizio della descrizione del catalogo, quando il codice vale anche per altre prestazioni. */
    prefissi: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

const table = z
  .object({
    id: z.string().min(1),
    class_rao: z.string().min(1).nullable(),
    pagine: z.array(z.number().int().positive()).min(1),
    testata: z.string().min(1),
    servizi: z
      .array(
        z
          .object({ nome: z.string().min(1), codici_stampati: z.array(z.string().min(1)).min(1) })
          .strict(),
      )
      .min(1),
    righe: z.array(row).min(1),
    note: z.array(z.string().min(1)),
    legame: z.array(link).min(1),
    nota_legame: z.string().min(1).optional(),
  })
  .strict();

export const raoSourceSchema = z
  .object({
    tipo: z.literal('rao_tabelle'),
    fonte: z.string().regex(/^[a-z0-9-]+$/),
    ambito: z.enum(['nazionale', 'regionale']),
    regione: z.string().min(1).nullable(),
    atto: z.string().min(1),
    titolo_breve: z.string().min(1),
    url: z.string().url(),
    sha256_origine: z.string().regex(/^[0-9a-f]{64}$/),
    trascritto_da: z.string().min(1),
    trascritto_il: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    controllato_da: z.string().min(1).nullable(),
    nota: z.string().min(1),
    note_del_documento: z.record(z.string(), z.string().min(1)).optional(),
    tabelle: z.array(table).min(1),
  })
  .strict()
  .refine((s) => (s.ambito === 'regionale') === (s.regione !== null), {
    message: 'Una fonte regionale dice la regione, una nazionale no',
  })
  .refine((s) => new Set(s.tabelle.map((t) => t.id)).size === s.tabelle.length, {
    message: 'Tabelle ripetute',
  });

export type RaoSource = z.infer<typeof raoSourceSchema>;
export type RaoTable = RaoSource['tabelle'][number];
export type RaoRow = RaoTable['righe'][number];
export type RaoIndication = RaoRow['indicazioni'][number];

let cached: RaoSource[] | undefined;

/** Le fonti dei file, lette e controllate una volta. */
export function raoSources(files: readonly string[] = RAO_FILES): RaoSource[] {
  const read = () => {
    const sources = files.map((f) =>
      raoSourceSchema.parse(JSON.parse(readFileSync(f, 'utf8')) as unknown),
    );
    if (new Set(sources.map((s) => s.fonte)).size !== sources.length)
      throw new Error('Fonti RAO ripetute');
    return sources;
  };
  if (files !== RAO_FILES) return read();
  cached ??= read();
  return cached;
}

const compact = (code: string) => code.replace(/[\s.]/g, '').toUpperCase();
const words = (s: string) => s.toUpperCase().replace(/[’`´]/g, "'").replace(/\s+/g, ' ').trim();

/** La voce del catalogo: il codice del nomenclatore e la descrizione regionale. */
export interface RaoCatalogEntry {
  nationalCode: string | null;
  description: string;
}

/** Quali tabelle il programma usa: della regione dello studio, e controllate fuori dalla prova. */
export interface RaoScope {
  /** La regione dello studio («PIEMONTE»): le tabelle regionali valgono solo lì. */
  region: string | null;
  /**
   * Anche le trascrizioni che nessuno ha ancora controllato: solo nell'ambiente di prova e nella
   * dimostrazione, con l'avviso; nel programma vero entrano dopo il controllo (D159, D285).
   */
  includeUnchecked: boolean;
}

export interface RaoMatch {
  source: RaoSource;
  table: RaoTable;
}

const inScope = (s: RaoSource, scope: RaoScope) =>
  (scope.includeUnchecked || s.controllato_da !== null) &&
  (s.regione === null || (scope.region !== null && words(s.regione) === words(scope.region)));

const linked = (t: RaoTable, entry: RaoCatalogEntry) => {
  if (!entry.nationalCode) return false;
  const code = compact(entry.nationalCode);
  const description = words(entry.description);
  return t.legame.some(
    (l) =>
      compact(l.codice) === code &&
      (!l.prefissi || l.prefissi.some((p) => description.startsWith(words(p)))),
  );
};

/**
 * Le tabelle di una voce del catalogo. Una tabella della regione dello studio vale al posto di quelle
 * nazionali per la stessa prestazione: le determine «devono essere adottate da tutti i soggetti che
 * hanno titolo ad emettere prescrizioni per conto del Servizio Sanitario Regionale».
 */
export function raoTablesFor(
  sources: readonly RaoSource[],
  entry: RaoCatalogEntry,
  scope: RaoScope,
): RaoMatch[] {
  const found = sources
    .filter((s) => inScope(s, scope))
    .flatMap((source) =>
      source.tabelle.filter((t) => linked(t, entry)).map((table) => ({ source, table })),
    );
  const regional = found.filter((m) => m.source.ambito === 'regionale');
  return regional.length ? regional : found;
}

/** La chiave di una condizione: fonte, tabella, riga e indicazione (le ultime due da 1). */
export const raoConditionKey = (fonte: string, tableId: string, row: number, item: number) =>
  `${fonte}:${tableId}:${row}:${item}`;

export interface RaoConditionFacts extends RaoMatch {
  key: string;
  row: RaoRow;
  indication: RaoIndication;
  /** La classe della ricetta: mai «emergenza», che è un promemoria per il pronto soccorso. */
  priority: 'U' | 'B' | 'D' | 'P';
}

/** La condizione di una chiave, o null se non c'è o se è una riga d'emergenza. */
export function raoCondition(
  sources: readonly RaoSource[],
  key: string,
  scope: RaoScope,
): RaoConditionFacts | null {
  const m = /^([a-z0-9-]+):([^:]+):(\d+):(\d+)$/.exec(key);
  if (!m) return null;
  const source = sources.find((s) => s.fonte === m[1] && inScope(s, scope));
  const table = source?.tabelle.find((t) => t.id === m[2]);
  const row = table?.righe[Number(m[3]) - 1];
  const indication = row?.indicazioni[Number(m[4]) - 1];
  if (!source || !table || !row || !indication || row.classe === 'emergenza') return null;
  return { source, table, key, row, indication, priority: row.classe };
}

/** Il testo che la ricetta tiene della condizione: la fonte, la tabella e la condizione. */
export function raoConditionText(c: RaoConditionFacts): string {
  const ped = c.row.pediatria ? ', età pediatrica' : '';
  return `${c.indication.testo} (${c.source.titolo_breve}, tabella ${c.table.id}, classe ${c.priority}${ped})`;
}
