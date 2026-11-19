import { decodeText } from '@mmg/reference';
import { MAX_CELL_CHARS, MAX_CELLS, MAX_COLUMNS, MAX_ROWS } from './limits';
import { type Deadline, FileRejected, type ImportTable, lineList, type TableRecord } from './table';

/**
 * Lettore CSV e TSV in modalità «file non fidato» (tappa 15). La codifica si riconosce come sync
 * (`decodeText`: UTF-8 con o senza BOM, poi Windows-1252, poi Latin-1); il resto è più severo del
 * lettore di sync, che resta com'era (deve fare come lo script Python):
 * - il separatore si sceglie contando i campi fuori dalle virgolette, su più righe, e vince quello
 *   che dà a tutte le righe lo stesso numero di campi;
 * - virgolette non chiuse, o testo dopo la virgoletta di chiusura, fermano il file con la riga;
 * - una riga con un numero di campi diverso dall'intestazione ferma il file: un separatore non
 *   protetto sposterebbe i valori nella colonna sbagliata, senza che nessuno se ne accorga.
 */

export const CSV_SEPARATORS = [';', ',', '\t', '|'] as const;

/** Righe guardate per scegliere il separatore. */
const SNIFF_RECORDS = 200;

interface Tokenized {
  records: { line: number; cells: string[] }[];
  /** Primo errore di virgolette, con la riga in cui comincia il campo. */
  error?: { line: number; kind: 'aperte' | 'dopo' };
}

/** Divide il testo in righe e campi con le regole delle virgolette doppie (RFC 4180). */
function tokenize(
  text: string,
  sep: string | null,
  firstLine: number,
  deadline: Deadline,
  limit = Infinity,
): Tokenized {
  const records: { line: number; cells: string[] }[] = [];
  let line = firstLine;
  let i = 0;
  const n = text.length;
  while (i < n && records.length < limit) {
    deadline.check();
    const start = line;
    const cells: string[] = [];
    for (;;) {
      let field = '';
      if (text[i] === '"') {
        // Campo tra virgolette: «""» è una virgoletta; va a capo come il testo.
        const fieldLine = line;
        i++;
        for (;;) {
          const q = text.indexOf('"', i);
          if (q < 0) return { records, error: { line: fieldLine, kind: 'aperte' } };
          const chunk = text.slice(i, q);
          for (let k = 0; k < chunk.length; k++) if (chunk[k] === '\n') line++;
          // «\r» da solo vale una riga (vecchi file Mac): si conta come «\n».
          for (let k = 0; k < chunk.length; k++)
            if (chunk[k] === '\r' && chunk[k + 1] !== '\n') line++;
          field += chunk;
          if (text[q + 1] === '"') {
            field += '"';
            i = q + 2;
            continue;
          }
          i = q + 1;
          break;
        }
        const c = text[i];
        if (i < n && c !== sep && c !== '\n' && c !== '\r')
          return { records, error: { line: fieldLine, kind: 'dopo' } };
      } else {
        while (i < n) {
          const c = text[i]!;
          if (c === sep || c === '\n' || c === '\r') break;
          field += c;
          i++;
        }
      }
      if (field.length > MAX_CELL_CHARS)
        throw new FileRejected(`Alla riga ${start} una cella supera ${MAX_CELL_CHARS} caratteri.`);
      cells.push(field);
      if (i < n && text[i] === sep) {
        i++;
        continue;
      }
      // Fine della riga: \r\n, \n o \r.
      if (text[i] === '\r' && text[i + 1] === '\n') i += 2;
      else if (i < n) i++;
      line++;
      break;
    }
    if (cells.length > MAX_COLUMNS)
      throw new FileRejected(`Alla riga ${start} ci sono più di ${MAX_COLUMNS} colonne.`);
    // Le righe vuote non contano (anche una riga di soli separatori).
    if (cells.some((c) => c.trim() !== '')) records.push({ line: start, cells });
  }
  return { records };
}

/** Numero di campi più frequente. */
/** Numero di campi più frequente; a pari merito quello che compare prima nel file. */
function modalWidth(records: { cells: string[] }[]): number {
  const counts = new Map<number, number>();
  for (const r of records) counts.set(r.cells.length, (counts.get(r.cells.length) ?? 0) + 1);
  let best = 0;
  let bestCount = -1;
  for (const [w, c] of counts)
    if (c > bestCount) {
      best = w;
      bestCount = c;
    }
  return best;
}

/** Campi fino all'ultimo non vuoto. */
const filledWidth = (cells: string[]) => {
  let n = cells.length;
  while (n > 0 && cells[n - 1]!.trim() === '') n--;
  return n;
};

/**
 * Riga d'intestazione: la prima con il numero di campi più frequente e almeno due campi pieni
 * (una riga di titolo con i separatori aggiunti dal foglio di calcolo non lo è).
 */
function headerIndex(records: { cells: string[] }[], width: number): number {
  const full = records.findIndex(
    (r) => r.cells.length === width && filledWidth(r.cells) >= Math.min(2, width),
  );
  return full >= 0 ? full : records.findIndex((r) => r.cells.length === width);
}

/** Il separatore che dà a tutte le righe (dopo eventuali righe di titolo) lo stesso numero di campi. */
function detectSeparator(text: string, firstLine: number, deadline: Deadline): string | null {
  // Vince il separatore con la quota più alta di righe della stessa larghezza; a parità, quello
  // senza errori di virgolette, poi quello con più campi. Un errore di virgolette o una riga
  // storta non escludono un separatore: la lettura completa li segnala con il numero di riga.
  let best: { sep: string; width: number; share: number; clean: boolean } | null = null;
  for (const sep of CSV_SEPARATORS) {
    const t = tokenize(text, sep, firstLine, deadline, SNIFF_RECORDS);
    if (t.records.length === 0) continue;
    const width = modalWidth(t.records);
    if (width < 2) continue;
    const headerAt = headerIndex(t.records, width);
    const after = t.records.slice(headerAt);
    const share = after.filter((r) => r.cells.length === width).length / after.length;
    const clean = !t.error;
    const better =
      !best ||
      share > best.share ||
      (share === best.share && clean && !best.clean) ||
      (share === best.share && clean === best.clean && width > best.width);
    if (better) best = { sep, width, share, clean };
  }
  return best?.sep ?? null;
}

export interface CsvRead {
  table: ImportTable;
  encoding: string;
  separator: string | null;
  notes: string[];
}

export function readCsvStrict(
  bytes: Uint8Array,
  options: { separator?: string | null },
  deadline: Deadline,
): CsvRead {
  const decoded = decodeText(bytes);
  let text = decoded.text;
  if (text.includes('\u0000'))
    throw new FileRejected(
      'Il file contiene caratteri che non sono testo: non è un CSV. Se è un foglio di calcolo, salvalo come XLSX o CSV.',
    );
  const notes: string[] = [];
  let firstLine = 1;
  let separator: string | null | undefined = options.separator;
  // «sep=;» in prima riga: l'indicazione del separatore che alcuni fogli di calcolo scrivono.
  const hint = /^sep=(.)(\r\n|\n|\r)/i.exec(text.slice(0, 8));
  if (hint) {
    separator ??= hint[1]!;
    text = text.slice(hint[0].length);
    firstLine = 2;
    notes.push('Separatore indicato nella prima riga del file («sep=»)');
  }
  if (separator === undefined) separator = detectSeparator(text, firstLine, deadline);
  const t = tokenize(text, separator, firstLine, deadline);
  if (t.error)
    throw new FileRejected(
      t.error.kind === 'aperte'
        ? `Alla riga ${t.error.line} si aprono le virgolette di un campo e non si chiudono più: il resto del file finirebbe in un campo solo. Correggi il file e caricalo di nuovo.`
        : `Alla riga ${t.error.line} un campo tra virgolette continua dopo la virgoletta di chiusura. Correggi il file e caricalo di nuovo.`,
    );
  if (t.records.length === 0) throw new FileRejected('Il file non contiene righe con dati.');
  if (t.records.length > MAX_ROWS + 1)
    throw new FileRejected(
      `Il file ha più di ${MAX_ROWS.toLocaleString('it-IT')} righe: dividilo in file più piccoli.`,
    );
  const width = modalWidth(t.records);
  const headerAt = headerIndex(t.records, width);
  if (headerAt > 0)
    notes.push(
      `Righe prima dell’intestazione, con un numero di campi diverso, lasciate fuori: ${lineList(t.records.slice(0, headerAt).map((r) => r.line))}`,
    );
  const records: TableRecord[] = [];
  const wrong: number[] = [];
  let cells = 0;
  for (const r of t.records.slice(headerAt)) {
    let c = r.cells;
    // Separatori in più alla fine, con campi vuoti: nessun valore si sposta, si tollerano.
    if (c.length > width && c.slice(width).every((x) => x.trim() === '')) c = c.slice(0, width);
    if (c.length !== width) {
      wrong.push(r.line);
      continue;
    }
    cells += c.filter((x) => x !== '').length;
    if (cells > MAX_CELLS)
      throw new FileRejected(
        `Il file ha più di ${MAX_CELLS.toLocaleString('it-IT')} celle piene: dividilo in file più piccoli.`,
      );
    records.push({ line: r.line, cells: c });
  }
  if (wrong.length)
    throw new FileRejected(
      `Le righe ${lineList(wrong)} hanno un numero di campi diverso dall’intestazione (${width}). Di solito è un separatore dentro un testo senza virgolette: i valori finirebbero nella colonna sbagliata. Correggi il file e caricalo di nuovo.`,
    );
  return {
    table: { name: 'CSV', records, width },
    encoding: decoded.encoding,
    separator,
    notes,
  };
}
