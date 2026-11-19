import { MAX_CELL_CHARS, MAX_CELLS, MAX_COLUMNS, MAX_ROWS } from './limits';
import { exportTables } from './export-format';
import { type Deadline, FileRejected, type ImportTable, type ReadFile } from './table';

/**
 * JSON in modalità «file non fidato» (tappa 15): un elenco di oggetti diventa una tabella, con
 * una colonna per ogni chiave (le chiavi annidate di un livello diventano «esterna.interna»).
 * Testo in UTF-8 (RFC 8259, par. 8.1). Le chiavi «__proto__», «constructor» e «prototype» si
 * scartano: un oggetto del file non deve poter cambiare gli oggetti del programma.
 *
 * La nostra esportazione completa (`mmg-esportazione`, versione 1) si riconosce: le sue righe
 * diventano una tabella per menu, con la mappatura già proposta (export-format.ts).
 */

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function parse(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new FileRejected('Il file JSON non è in UTF-8.');
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  try {
    return JSON.parse(text, (key, value: unknown) => (FORBIDDEN_KEYS.has(key) ? undefined : value));
  } catch {
    throw new FileRejected('Il file non è un JSON valido: controlla che sia completo.');
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function cellOf(v: unknown): { text: string; kind: string } {
  if (v === null || v === undefined) return { text: '', kind: 't' };
  if (typeof v === 'number') return { text: Number.isFinite(v) ? String(v) : '', kind: 'n' };
  if (typeof v === 'boolean') return { text: v ? '1' : '0', kind: 'b' };
  if (typeof v === 'string') return { text: v, kind: 't' };
  // Elenchi e oggetti più profondi: come testo JSON, con il tetto della cella.
  const s = JSON.stringify(v);
  return { text: s.length > MAX_CELL_CHARS ? s.slice(0, MAX_CELL_CHARS) : s, kind: 't' };
}

/** Un elenco di oggetti come tabella. */
export function objectsToTable(
  name: string,
  list: unknown[],
  deadline: Deadline,
  budget = { cells: 0 },
): ImportTable {
  if (list.length > MAX_ROWS)
    throw new FileRejected(`«${name}» ha più di ${MAX_ROWS.toLocaleString('it-IT')} elementi.`);
  const columns = new Map<string, number>();
  const rows: Map<number, { text: string; kind: string }>[] = [];
  list.forEach((item) => {
    deadline.check();
    if (!isPlainObject(item))
      throw new FileRejected(`«${name}» deve essere un elenco di oggetti con gli stessi campi.`);
    const row = new Map<number, { text: string; kind: string }>();
    const put = (key: string, v: unknown) => {
      let col = columns.get(key);
      if (col === undefined) {
        col = columns.size;
        if (col >= MAX_COLUMNS)
          throw new FileRejected(`«${name}» ha più di ${MAX_COLUMNS} campi diversi.`);
        columns.set(key, col);
      }
      const c = cellOf(v);
      if (c.text.length > MAX_CELL_CHARS)
        throw new FileRejected(`In «${name}» un valore supera ${MAX_CELL_CHARS} caratteri.`);
      if (c.text !== '' && ++budget.cells > MAX_CELLS)
        throw new FileRejected(`Il file ha più di ${MAX_CELLS.toLocaleString('it-IT')} valori.`);
      row.set(col, c);
    };
    for (const [k, v] of Object.entries(item)) {
      if (isPlainObject(v)) for (const [k2, v2] of Object.entries(v)) put(`${k}.${k2}`, v2);
      else put(k, v);
    }
    rows.push(row);
  });
  const width = columns.size;
  const header = [...columns.keys()];
  return {
    name,
    width,
    records: [
      { line: 1, cells: header, kinds: 't'.repeat(width) },
      ...rows.map((r, i) => {
        const cells = Array.from({ length: width }, (_, c) => r.get(c)?.text ?? '');
        const kinds = Array.from({ length: width }, (_, c) => r.get(c)?.kind ?? 't').join('');
        return { line: i + 2, cells, kinds };
      }),
    ],
  };
}

export function readJsonFile(bytes: Uint8Array, deadline: Deadline): ReadFile {
  const doc = parse(bytes);
  if (isPlainObject(doc) && doc.formato === 'mmg-esportazione') {
    if (doc.versione !== 1)
      throw new FileRejected(
        'Esportazione di una versione del programma che questa installazione non conosce.',
      );
    const read = exportTables(doc);
    const cells = read.tables.reduce(
      (n, t) => n + t.records.reduce((m, r) => m + r.cells.filter((c) => c !== '').length, 0),
      0,
    );
    if (cells > MAX_CELLS)
      throw new FileRejected(
        `L’esportazione ha più di ${MAX_CELLS.toLocaleString('it-IT')} valori: si importa a parti.`,
      );
    return {
      format: 'mmg-esportazione',
      tables: read.tables,
      encoding: 'utf-8',
      proposed: read.mapping,
      notes: [
        'Esportazione completa di questo programma (formato mmg-esportazione, versione 1): impronte verificate, destinazioni e colonne già proposte',
        ...read.notes,
      ],
    };
  }
  if (Array.isArray(doc))
    return {
      format: 'json',
      tables: [objectsToTable('JSON', doc, deadline)],
      encoding: 'utf-8',
      notes: [],
    };
  if (isPlainObject(doc)) {
    // Un oggetto con uno o più elenchi di oggetti: una tabella per elenco.
    const budget = { cells: 0 };
    const tables = Object.entries(doc)
      .filter(([, v]) => Array.isArray(v) && v.length > 0 && v.every(isPlainObject))
      .map(([k, v]) => objectsToTable(k.slice(0, 100), v as unknown[], deadline, budget));
    if (tables.length) return { format: 'json', tables, encoding: 'utf-8', notes: [] };
  }
  throw new FileRejected(
    'Il JSON non contiene un elenco di oggetti: si importano elenchi come [{"campo": "valore"}, …].',
  );
}
