import {
  MAX_CELL_CHARS,
  MAX_CELLS,
  MAX_COLUMNS,
  MAX_NUMBER_FORMAT_CHARS,
  MAX_ROWS,
  MAX_SHEETS,
  MAX_UNCOMPRESSED_BYTES,
} from './limits';
import { type Deadline, FileRejected, type ImportTable, type TableRecord } from './table';
import { listZip, readZipEntries } from './zip';
import { scanXml, xmlText } from './xml';

/**
 * Lettore XLSX in modalità «file non fidato» (tappa 15): tutti i fogli con i loro nomi, i tipi
 * delle celle (testo, numero, data, sì/no, errore), le date dagli stili, il sistema 1900 o 1904.
 * Il lettore di packages/reference resta com'era per sync: legge il primo foglio come testi.
 *
 * La specifica ECMA-376 non è stata letta. I formati di data predefiniti (14–17 e 22 con il
 * giorno, 18–21 e 45–47 solo orari), il riconoscimento dei formati personalizzati e i numeri
 * seriali (1 = 1/1/1900, 61 = 1/3/1900, 25569 = 1/1/1970; nel sistema 1904, 24107 = 1/1/1970)
 * sono quelli di openpyxl 3.1.5 (`BUILTIN_FORMATS`, `is_date_format`, `from_excel`), un
 * produttore indipendente, letti dal suo sorgente e provati il 19/11/2026.
 */

/** Formati predefiniti con una data e solo con un orario (openpyxl, `BUILTIN_FORMATS`). */
const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 22]);
const BUILTIN_TIME_FORMATS = new Set([18, 19, 20, 21, 45, 46, 47]);

const DAY_MS = 86_400_000;
const EPOCH_1900 = Date.UTC(1899, 11, 30);
const EPOCH_1904 = Date.UTC(1904, 0, 1);

/**
 * Data di un numero seriale di foglio di calcolo, o null se non è una data. Nel sistema 1900 il
 * giorno 60 è il 29/2/1900, che non esiste: non è una data.
 */
export function serialToDate(serial: number, date1904 = false): string | null {
  if (!Number.isFinite(serial)) return null;
  const day = Math.floor(serial);
  if (date1904) {
    if (day < 0) return null;
    return new Date(EPOCH_1904 + day * DAY_MS).toISOString().slice(0, 10);
  }
  if (day < 1 || day === 60) return null;
  // Prima del 60 il conteggio parte un giorno dopo: il 29/2/1900 inesistente sta in mezzo.
  const offset = day < 60 ? day + 1 : day;
  return new Date(EPOCH_1900 + offset * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Un formato numerico mostra una data, un orario o nessuno dei due. Come `is_date_format` di
 * openpyxl: si guarda la prima sezione, senza testi tra virgolette e senza parentesi quadre
 * (tranne gli orari trascorsi [h] [m] [s]); una lettera d, m, y, h o s non preceduta da «_» o
 * «\» rende il formato una data o un orario. È una data se c'è il giorno o l'anno.
 */
export function numberFormatKind(code: string): 'date' | 'time' | null {
  const first = code.slice(0, MAX_NUMBER_FORMAT_CHARS).split(';')[0] ?? '';
  let stripped = '';
  for (let i = 0; i < first.length; i++) {
    const c = first[i]!;
    if (c === '"') {
      const end = first.indexOf('"', i + 1);
      i = end < 0 ? first.length : end;
      continue;
    }
    if (c === '[') {
      const end = first.indexOf(']', i + 1);
      const inner = (end < 0 ? first.slice(i + 1) : first.slice(i + 1, end)).toLowerCase();
      if (/^(h|hh|m|mm|s|ss)$/.test(inner)) stripped += inner;
      i = end < 0 ? first.length : end;
      continue;
    }
    stripped += c;
  }
  let date = false;
  let time = false;
  for (let i = 0; i < stripped.length; i++) {
    const c = stripped[i]!.toLowerCase();
    const prev = stripped[i - 1];
    if (prev === '_' || prev === '\\') continue;
    if (c === 'd' || c === 'y') date = true;
    else if (c === 'h' || c === 's' || c === 'm') time = true;
  }
  return date ? 'date' : time ? 'time' : null;
}

/** «AB12» → colonna 27 (da zero) e riga 12; null se il riferimento non ha questa forma. */
function cellRef(ref: string): { col: number; row: number } | null {
  let i = 0;
  let col = 0;
  while (i < ref.length && i < 4) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break;
    col = col * 26 + (c - 64);
    i++;
  }
  if (i === 0 || i === ref.length) return null;
  const digits = ref.slice(i);
  if (!/^\d{1,10}$/.test(digits)) return null;
  return { col: col - 1, row: Number(digits) };
}

/** Percorso di una relazione: «worksheets/sheet1.xml» rispetto a «xl/», «/xl/…» assoluto. */
function resolveTarget(target: string): string {
  const parts = (target.startsWith('/') ? target.slice(1) : `xl/${target}`).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p && p !== '.') out.push(p);
  }
  return out.join('/');
}

function normalizeNumber(v: string): string {
  const n = Number(v);
  return Number.isFinite(n) && Math.abs(n) < 1e15 ? String(n) : v;
}

interface SheetInfo {
  name: string;
  path: string;
  hidden: boolean;
}

export interface XlsxRead {
  tables: ImportTable[];
  date1904: boolean;
  notes: string[];
}

export function readXlsxStrict(bytes: Uint8Array, deadline: Deadline): XlsxRead {
  const entries = listZip(bytes);
  const names = new Set(entries.map((e) => e.name));
  if (!names.has('xl/workbook.xml')) {
    if (names.has('mimetype') || names.has('content.xml'))
      throw new FileRejected(
        'È un foglio di calcolo OpenDocument (.ods): salvalo come XLSX o CSV e caricalo di nuovo.',
      );
    throw new FileRejected('L’archivio ZIP non è un foglio di calcolo XLSX.');
  }
  const first = readZipEntries(
    bytes,
    entries,
    (n) => n === 'xl/workbook.xml' || n === 'xl/_rels/workbook.xml.rels',
    deadline,
  );
  const used = [...first.values()].reduce((n, b) => n + b.length, 0);

  let date1904 = false;
  const sheetRefs: { name: string; rid: string; hidden: boolean }[] = [];
  scanXml(
    xmlText(first.get('xl/workbook.xml')!),
    {
      start(name, a) {
        if (name === 'workbookPr') date1904 = a.date1904 === '1' || a.date1904 === 'true';
        if (name === 'sheet')
          sheetRefs.push({
            name: (a.name ?? '').slice(0, 100),
            rid: a.id ?? '',
            hidden: a.state === 'hidden' || a.state === 'veryHidden',
          });
      },
    },
    deadline,
  );
  if (sheetRefs.length === 0) throw new FileRejected('Il foglio di calcolo non ha fogli.');
  if (sheetRefs.length > MAX_SHEETS)
    throw new FileRejected(`Il foglio di calcolo ha più di ${MAX_SHEETS} fogli: dividilo.`);

  const targets = new Map<string, { target: string; type: string }>();
  const rels = first.get('xl/_rels/workbook.xml.rels');
  if (rels)
    scanXml(
      xmlText(rels),
      {
        start(name, a) {
          if (name === 'Relationship' && a.Id && a.Target)
            targets.set(a.Id, { target: resolveTarget(a.Target), type: a.Type ?? '' });
        },
      },
      deadline,
    );
  const sheets: SheetInfo[] = sheetRefs.map((s, i) => ({
    name: s.name || `Foglio ${i + 1}`,
    path: targets.get(s.rid)?.target ?? `xl/worksheets/sheet${i + 1}.xml`,
    hidden: s.hidden,
  }));
  const sharedPath =
    [...targets.values()].find((t) => t.type.endsWith('/sharedStrings'))?.target ??
    'xl/sharedStrings.xml';
  const stylesPath =
    [...targets.values()].find((t) => t.type.endsWith('/styles'))?.target ?? 'xl/styles.xml';
  const wanted = new Set([sharedPath, stylesPath, ...sheets.map((s) => s.path)]);
  const declared = entries.filter((e) => wanted.has(e.name)).reduce((n, e) => n + e.size, 0);
  if (used + declared > MAX_UNCOMPRESSED_BYTES)
    throw new FileRejected(
      `Il foglio di calcolo, decompresso, supera ${Math.round(MAX_UNCOMPRESSED_BYTES / 1048576)} MB: dividilo in file più piccoli.`,
      413,
    );
  const parts = readZipEntries(bytes, entries, (n) => wanted.has(n), deadline);

  const styleKinds = readStyles(parts.get(stylesPath), deadline);
  const shared = readSharedStrings(parts.get(sharedPath), deadline);
  const notes: string[] = [];
  if (date1904) notes.push('Date nel sistema 1904 (fogli di calcolo creati su Mac)');
  const budget = { cells: 0 };
  const tables = sheets.map((s) => {
    const content = parts.get(s.path);
    if (!content) throw new FileRejected(`Il foglio «${s.name}» manca nell’archivio.`);
    if (s.hidden) notes.push(`Il foglio «${s.name}» è nascosto nel file`);
    return readSheet(s.name, content, { shared, styleKinds, date1904, budget }, deadline);
  });
  return { tables, date1904, notes };
}

function readStyles(bytes: Uint8Array | undefined, deadline: Deadline): ('d' | 'o' | null)[] {
  if (!bytes) return [];
  const custom = new Map<number, string>();
  const xfFormats: number[] = [];
  let inCellXfs = false;
  scanXml(
    xmlText(bytes),
    {
      start(name, a) {
        if (name === 'numFmt' && a.numFmtId !== undefined)
          custom.set(Number(a.numFmtId), (a.formatCode ?? '').slice(0, MAX_NUMBER_FORMAT_CHARS));
        else if (name === 'cellXfs') inCellXfs = true;
        else if (name === 'xf' && inCellXfs) xfFormats.push(Number(a.numFmtId ?? 0));
      },
      end(name) {
        if (name === 'cellXfs') inCellXfs = false;
      },
    },
    deadline,
  );
  return xfFormats.map((id) => {
    if (custom.has(id)) {
      const k = numberFormatKind(custom.get(id)!);
      return k === 'date' ? 'd' : k === 'time' ? 'o' : null;
    }
    return BUILTIN_DATE_FORMATS.has(id) ? 'd' : BUILTIN_TIME_FORMATS.has(id) ? 'o' : null;
  });
}

function readSharedStrings(bytes: Uint8Array | undefined, deadline: Deadline): string[] {
  if (!bytes) return [];
  const out: string[] = [];
  let current: string[] | null = null;
  let inT = 0;
  let inPhonetic = 0;
  scanXml(
    xmlText(bytes),
    {
      start(name, _a, selfClosing) {
        if (name === 'si') current = [];
        else if (name === 'rPh' && !selfClosing) inPhonetic++;
        else if (name === 't' && !selfClosing) inT++;
      },
      end(name) {
        if (name === 'si' && current) {
          const s = current.join('');
          if (s.length > MAX_CELL_CHARS)
            throw new FileRejected(`Una cella supera ${MAX_CELL_CHARS} caratteri.`);
          if (out.length >= MAX_CELLS)
            throw new FileRejected('Il foglio di calcolo ha troppi testi: dividilo.');
          out.push(s);
          current = null;
        } else if (name === 'rPh' && inPhonetic > 0) inPhonetic--;
        else if (name === 't' && inT > 0) inT--;
      },
      text(t) {
        // Le letture fonetiche (<rPh>) non fanno parte del testo.
        if (current && inT > 0 && inPhonetic === 0) current.push(t);
      },
    },
    deadline,
  );
  return out;
}

interface SheetContext {
  shared: string[];
  styleKinds: ('d' | 'o' | null)[];
  date1904: boolean;
  budget: { cells: number };
}

function readSheet(
  name: string,
  bytes: Uint8Array,
  ctx: SheetContext,
  deadline: Deadline,
): ImportTable {
  const records: TableRecord[] = [];
  let width = 0;
  let inSheetData = false;
  let rowNumber = 0;
  let lastRow = 0;
  let row: Map<number, { v: string; k: string }> | null = null;
  let cell: { col: number; t: string; s: number } | null = null;
  let nextCol = 0;
  let collect: 'v' | 't' | null = null;
  let value = '';
  let inline = '';
  let hasValue = false;
  let inPhonetic = 0;

  const finishCell = () => {
    if (!cell || !row) return;
    const c = cell;
    cell = null;
    if (!hasValue) return;
    let v: string;
    let k: string;
    switch (c.t) {
      case 's': {
        const idx = Number(value);
        if (!Number.isInteger(idx) || idx < 0 || idx >= ctx.shared.length)
          throw new FileRejected(`Il foglio «${name}» rimanda a un testo che non c’è.`);
        v = ctx.shared[idx]!;
        k = 't';
        break;
      }
      case 'inlineStr':
        v = inline;
        k = 't';
        break;
      case 'str':
        v = value;
        k = 't';
        break;
      case 'b':
        v = value.trim() === '1' ? '1' : '0';
        k = 'b';
        break;
      case 'e':
        v = value;
        k = 'e';
        break;
      case 'd': {
        const d = /^\d{4}-\d{2}-\d{2}/.exec(value.trim())?.[0];
        v = d ?? value;
        k = d ? 'd' : 't';
        break;
      }
      default: {
        const raw = value.trim();
        const n = Number(raw);
        if (raw === '' || !Number.isFinite(n)) {
          v = raw;
          k = 't';
          break;
        }
        const style = ctx.styleKinds[c.s] ?? null;
        if (style === 'd') {
          const d = serialToDate(n, ctx.date1904);
          v = d ?? raw;
          k = d ? 'd' : 'e';
        } else if (style === 'o') {
          v = raw;
          k = 'o';
        } else {
          v = normalizeNumber(raw);
          k = 'n';
        }
      }
    }
    if (v === '' && k === 't') return;
    if (v.length > MAX_CELL_CHARS)
      throw new FileRejected(`Nel foglio «${name}» una cella supera ${MAX_CELL_CHARS} caratteri.`);
    // Solo le celle con un valore contano: le coordinate di una cella vuota non allocano nulla.
    if (c.col >= MAX_COLUMNS)
      throw new FileRejected(
        `Il foglio «${name}» ha valori oltre la colonna ${MAX_COLUMNS}: non sembra una tabella da importare.`,
      );
    if (rowNumber > MAX_ROWS + 1)
      throw new FileRejected(
        `Il foglio «${name}» ha valori oltre la riga ${MAX_ROWS + 1}: dividilo in file più piccoli.`,
      );
    if (++ctx.budget.cells > MAX_CELLS)
      throw new FileRejected(
        `Il file ha più di ${MAX_CELLS.toLocaleString('it-IT')} celle piene: dividilo in file più piccoli.`,
      );
    row.set(c.col, { v, k });
    if (c.col + 1 > width) width = c.col + 1;
  };

  scanXml(
    xmlText(bytes),
    {
      start(tag, a, selfClosing) {
        if (tag === 'sheetData') inSheetData = !selfClosing;
        if (!inSheetData) return;
        if (tag === 'row') {
          const r = a.r === undefined ? lastRow + 1 : Number(a.r);
          if (!Number.isInteger(r) || r < 1 || r <= lastRow)
            throw new FileRejected(`Il foglio «${name}» ha righe fuori ordine o numerate male.`);
          rowNumber = r;
          lastRow = r;
          row = new Map();
          nextCol = 0;
        } else if (tag === 'c' && row) {
          const ref = a.r === undefined ? null : cellRef(a.r);
          if (a.r !== undefined && (!ref || ref.row !== rowNumber))
            throw new FileRejected(`Il foglio «${name}» ha una cella con coordinate non valide.`);
          const col = ref ? ref.col : nextCol;
          nextCol = col + 1;
          cell = { col, t: a.t ?? 'n', s: Number(a.s ?? 0) };
          value = '';
          inline = '';
          hasValue = false;
          if (selfClosing) cell = null;
        } else if (cell && tag === 'v' && !selfClosing) {
          collect = 'v';
          hasValue = true;
        } else if (cell && tag === 'is') {
          hasValue = true;
        } else if (cell && tag === 'rPh' && !selfClosing) inPhonetic++;
        else if (cell && tag === 't' && !selfClosing && inPhonetic === 0) collect = 't';
      },
      end(tag) {
        if (tag === 'sheetData') inSheetData = false;
        if (!inSheetData && tag !== 'row') return;
        if (tag === 'v' || tag === 't') collect = null;
        else if (tag === 'rPh' && inPhonetic > 0) inPhonetic--;
        else if (tag === 'c') finishCell();
        else if (tag === 'row' && row) {
          const current: Map<number, { v: string; k: string }> = row;
          row = null;
          if (current.size === 0) return;
          const cells: string[] = [];
          let kinds = '';
          for (const [col, x] of [...current].sort((p, q) => p[0] - q[0])) {
            while (cells.length < col) {
              cells.push('');
              kinds += 't';
            }
            cells[col] = x.v;
            kinds = kinds.slice(0, col) + x.k + kinds.slice(col + 1);
          }
          records.push({ line: rowNumber, cells, kinds });
        }
      },
      text(t) {
        if (collect === 'v') value += t;
        else if (collect === 't') inline += t;
      },
    },
    deadline,
  );
  // Tutte le righe della stessa larghezza.
  for (const r of records) {
    while (r.cells.length < width) r.cells.push('');
    r.kinds = (r.kinds ?? '').padEnd(width, 't');
  }
  return { name, records, width };
}
