import { type DataRecord, type DatasetKind, type FieldValue, KINDS } from './kinds';
import { extractRecords, type Mapping, type RowProblem } from './mapping';
import { normalizeHeader } from './text';

/**
 * Atti che modificano una tabella (D157). Una regione può non ripubblicare il catalogo intero, ma
 * solo le voci che finiscono e quelle che cominciano, in allegati diversi dello stesso atto. Una
 * trascrizione «solo modifiche» elenca queste voci con l'operazione, e la versione intera si
 * ricostruisce dalla versione in vigore il giorno prima.
 */

export const CHANGE_OPERATIONS = ['aggiunge', 'toglie'] as const;
export type ChangeOperation = (typeof CHANGE_OPERATIONS)[number];

/** Nome della colonna dell'operazione nel CSV. */
export const OPERATION_COLUMN = 'operazione';

/** Campi che identificano una voce, per i tipi che si trascrivono; null per gli altri. */
export function changeKeyOf(kind: DatasetKind): readonly string[] | null {
  const spec = KINDS[kind];
  return 'changeKey' in spec ? spec.changeKey : null;
}

export interface ChangeSet {
  /** Voci da togliere, per i campi della chiave; un campo vuoto vale per qualunque valore. */
  removals: { line: number; key: Record<string, string> }[];
  /** Voci da aggiungere, o da sostituire se la chiave c'è già. */
  additions: { line: number; record: DataRecord }[];
}

/** Confronto delle chiavi: niente maiuscole, accenti e spazi («Gastroentero logia» va a capo nel PDF). */
function keyText(value: FieldValue | undefined): string {
  return value === null || value === undefined
    ? ''
    : String(value).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, '');
}

/** Legge un CSV «solo modifiche»: la colonna dell'operazione, poi le colonne della mappatura. */
export function parseChanges(
  mapping: Mapping,
  table: string[][],
): { changes: ChangeSet; problems: RowProblem[]; missingColumns: string[] } {
  const key = changeKeyOf(mapping.tipo);
  if (!key) throw new Error(`Il tipo ${mapping.tipo} non si aggiorna per modifiche`);
  const header = table[0] ?? [];
  const normalized = header.map(normalizeHeader);
  const opIdx = normalized.indexOf(normalizeHeader(OPERATION_COLUMN));
  const keyIdx = key.map((f) => {
    const h = mapping.colonne[f];
    return h ? normalized.indexOf(normalizeHeader(h)) : -1;
  });
  const missing = [
    ...(opIdx < 0 ? [OPERATION_COLUMN] : []),
    ...key.filter((_, i) => keyIdx[i]! < 0).map((f) => mapping.colonne[f] ?? f),
  ];
  const changes: ChangeSet = { removals: [], additions: [] };
  const problems: RowProblem[] = [];
  if (missing.length) return { changes, problems, missingColumns: missing };
  for (let i = 1; i < table.length; i++) {
    const row = table[i]!;
    if (!row.some((c) => c.trim() !== '')) continue;
    const line = i + 1;
    const op = normalizeHeader(row[opIdx] ?? '');
    if (op === 'toglie') {
      const k = Object.fromEntries(key.map((f, n) => [f, (row[keyIdx[n]!] ?? '').trim()]));
      if (!k[key[0]!]) {
        problems.push({ line, field: key[0]!, problem: 'per togliere una voce serve il codice' });
      } else changes.removals.push({ line, key: k });
    } else if (op === 'aggiunge') {
      const out = extractRecords(mapping, [header, row]);
      for (const p of out.problems) problems.push({ ...p, line });
      if (out.records[0]) changes.additions.push({ line, record: out.records[0] });
    } else {
      problems.push({
        line,
        field: OPERATION_COLUMN,
        problem: `operazione «${row[opIdx] ?? ''}»: si scrive «aggiunge» o «toglie»`,
      });
    }
  }
  return { changes, problems, missingColumns: [] };
}

export interface AppliedChanges {
  records: DataRecord[];
  added: number;
  replaced: number;
  removed: number;
  problems: RowProblem[];
}

/**
 * La versione intera: dalla versione di base si tolgono le voci tolte, poi si aggiungono le voci
 * nuove; una voce aggiunta con la chiave di una voce che c'è la sostituisce. Togliere una voce
 * che la base non ha è un problema: vuol dire che la base non è quella su cui l'atto è scritto.
 */
export function applyChanges(
  kind: DatasetKind,
  base: readonly DataRecord[],
  changes: ChangeSet,
): AppliedChanges {
  const key = changeKeyOf(kind);
  if (!key) throw new Error(`Il tipo ${kind} non si aggiorna per modifiche`);
  let rows = [...base];
  let removed = 0;
  const problems: RowProblem[] = [];
  for (const r of changes.removals) {
    const matches = (rec: DataRecord) =>
      key.every((f) => {
        const want = keyText(r.key[f]);
        return !want || keyText(rec[f]) === want;
      });
    const before = rows.length;
    rows = rows.filter((rec) => !matches(rec));
    if (rows.length === before) {
      problems.push({
        line: r.line,
        field: key[0]!,
        problem: `toglie ${key
          .map((f) => r.key[f])
          .filter(Boolean)
          .join(' · ')}: la voce non c'è nella versione di base`,
      });
    }
    removed += before - rows.length;
  }
  let added = 0;
  let replaced = 0;
  for (const a of changes.additions) {
    const i = rows.findIndex((rec) => key.every((f) => keyText(rec[f]) === keyText(a.record[f])));
    if (i >= 0) {
      rows[i] = a.record;
      replaced++;
    } else {
      rows.push(a.record);
      added++;
    }
  }
  return { records: rows, added, replaced, removed, problems };
}
