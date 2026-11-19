import {
  IMPORT_DESTINATION_KEYS,
  importDestination,
  type ImportDestination,
  type ImportField,
} from '@mmg/domain';
import { z } from 'zod';
import { HttpError } from '../http/errors';
import { MAX_DISTINCT_VALUES, MAX_HEADER_ROW, MAX_PARTS } from './limits';
import { columnLetter, type ImportTable, type TableRecord } from './table';
import type { FieldTransform } from './transforms';

/**
 * Smistamento e mappatura (tappa 15): per ogni foglio una o più destinazioni, eventualmente solo
 * per le righe con certi valori in una colonna («TIPO = ALL → Allergie»); per ogni campo una
 * colonna o un valore uguale per tutte le righe, con le trasformazioni. È lo stesso oggetto che si
 * salva in un profilo d'importazione: dentro ci sono intestazioni e codici, mai righe del file.
 */

/** Colonna per lettera e, se il foglio ha un'intestazione, per nome (vince il nome, se unico). */
const columnRef = z
  .object({
    lettera: z.string().regex(/^[A-Z]{1,3}$/, 'lettera di colonna non valida'),
    nome: z.string().max(200).optional(),
  })
  .strict();
export type ColumnRef = z.infer<typeof columnRef>;

/** Tabelle di corrispondenza: al più 200 valori, brevi (codici, non testi dei pazienti). */
const correspondences = z
  .record(z.string().max(100), z.string().max(100))
  .refine(
    (r) => Object.keys(r).length <= 200,
    'Al più 200 valori in una tabella di corrispondenza',
  );

const fieldMapping = z
  .object({
    colonna: columnRef.nullable().optional(),
    /** Valore uguale per tutte le righe (es. il tipo di contatto del diario). */
    costante: z.string().max(200).nullable().optional(),
    formatoData: z.enum(['testo', 'seriale']).optional(),
    corrispondenze: correspondences.optional(),
  })
  .strict()
  .refine(
    (m) => !(m.colonna && m.costante),
    'Per un campo una colonna o un valore fisso, non entrambi',
  );
export type FieldMapping = z.infer<typeof fieldMapping>;

const part = z
  .object({
    /** Nome del foglio (o «CSV», o il nome dell'elenco di un JSON). */
    tabella: z.string().min(1).max(100),
    /** Riga dell'intestazione nel file (da 1); 0 se il foglio non ha intestazione. */
    intestazione: z.number().int().min(0).max(MAX_HEADER_ROW),
    destinazione: z.enum(IMPORT_DESTINATION_KEYS),
    /** Solo le righe con uno di questi valori nella colonna (smistamento per valore). */
    filtro: z
      .object({
        colonna: columnRef,
        valori: z.array(z.string().max(100)).min(1).max(100),
      })
      .strict()
      .nullable()
      .optional(),
    campi: z.record(z.string().max(60), fieldMapping),
  })
  .strict();
export type PartMapping = z.infer<typeof part>;

export const mappingSchema = z
  .object({
    parti: z.array(part).min(1).max(MAX_PARTS),
    /** Programma d'origine, come lo chiama chi importa (facoltativo, va nella storia). */
    programma: z.string().trim().max(100).nullable().optional(),
  })
  .strict();
export type ImportMapping = z.infer<typeof mappingSchema>;

/** Una destinazione pronta per le righe: colonne risolte, campi con le trasformazioni. */
export interface ResolvedPart {
  index: number;
  table: ImportTable;
  destination: ImportDestination;
  header: string[];
  rows: TableRecord[];
  filter: { column: number; values: Set<string> } | null;
  fields: {
    field: ImportField;
    column: number | null;
    constant: string | null;
    transform: FieldTransform;
  }[];
}

/** Intestazioni di una tabella a una riga data (0: nessuna, le colonne si chiamano per lettera). */
export function headerAt(
  table: ImportTable,
  line: number,
): { header: string[]; rows: TableRecord[] } {
  if (line === 0)
    return {
      header: Array.from({ length: table.width }, (_, i) => `Colonna ${columnLetter(i)}`),
      rows: table.records,
    };
  const idx = table.records.findIndex((r) => r.line === line);
  if (idx < 0)
    throw new HttpError(400, `Nel foglio «${table.name}» la riga ${line} è vuota o non c’è`);
  return {
    header: table.records[idx]!.cells.map((c) => c.trim()),
    rows: table.records.slice(idx + 1),
  };
}

function resolveColumn(ref: ColumnRef, header: string[], tableName: string): number {
  if (ref.nome) {
    const found = header.flatMap((h, i) => (h === ref.nome!.trim() ? [i] : []));
    if (found.length === 1) return found[0]!;
  }
  let index = 0;
  for (const ch of ref.lettera) index = index * 26 + (ch.charCodeAt(0) - 64);
  index -= 1;
  if (index < 0 || index >= header.length)
    throw new HttpError(400, `Nel foglio «${tableName}» non c’è la colonna ${ref.lettera}`);
  if (ref.nome && header[index] !== ref.nome.trim())
    throw new HttpError(
      400,
      `Nel foglio «${tableName}» la colonna «${ref.nome}» non c’è più: controlla la mappatura`,
    );
  return index;
}

/** Risolve la mappatura sulle tabelle del file; un errore della mappatura ferma tutto (400). */
export function resolveMapping(tables: ImportTable[], mapping: ImportMapping): ResolvedPart[] {
  return mapping.parti.map((p, index) => {
    const table = tables.find((t) => t.name === p.tabella);
    if (!table) throw new HttpError(400, `Il file non ha il foglio «${p.tabella}»`);
    const destination = importDestination(p.destinazione)!;
    const { header, rows } = headerAt(table, p.intestazione);
    const unknown = Object.keys(p.campi).filter(
      (k) => !destination.fields.some((f) => f.key === k),
    );
    if (unknown.length)
      throw new HttpError(400, `«${destination.label}» non ha i campi: ${unknown.join(', ')}`);
    const fields = destination.fields.flatMap((field) => {
      const m = p.campi[field.key];
      const constant = m?.costante?.trim() ? m.costante : null;
      const column = m?.colonna ? resolveColumn(m.colonna, header, table.name) : null;
      if (column === null && constant === null) return [];
      const transform: FieldTransform = {
        ...(m?.formatoData ? { formatoData: m.formatoData } : {}),
        ...(m?.corrispondenze ? { corrispondenze: m.corrispondenze } : {}),
      };
      return [{ field, column, constant, transform }];
    });
    const missing = destination.fields.filter(
      (f) => f.required && !fields.some((x) => x.field.key === f.key),
    );
    // I parametri hanno due modi: «parametro» con «valore», oppure una colonna per parametro.
    if (destination.key === 'parametri') {
      const long =
        fields.some((x) => x.field.key === 'parametro') &&
        fields.some((x) => x.field.key === 'valore');
      const wide = fields.some((x) => x.field.key.startsWith('valore_'));
      if (!long && !wide)
        throw new HttpError(
          400,
          `Per «${destination.label}» indica le colonne «Parametro» e «Valore», oppure una colonna per parametro`,
        );
    }
    if (missing.length)
      throw new HttpError(
        400,
        `Per «${destination.label}» mancano i campi obbligatori: ${missing.map((f) => f.label).join(', ')}`,
      );
    const filter = p.filtro
      ? {
          column: resolveColumn(p.filtro.colonna, header, table.name),
          values: new Set(p.filtro.valori.map((v) => v.trim().toLowerCase())),
        }
      : null;
    return { index, table, destination, header, rows, filter, fields };
  });
}

/** Colonne di una tabella per l'interfaccia: nome, lettera, quanto è piena, pochi valori distinti. */
export function describeColumns(header: string[], rows: TableRecord[]) {
  return header.map((name, i) => {
    let filled = 0;
    const distinct = new Map<string, number>();
    for (const r of rows) {
      const v = (r.cells[i] ?? '').trim();
      if (v === '') continue;
      filled++;
      if (distinct.size <= MAX_DISTINCT_VALUES) distinct.set(v, (distinct.get(v) ?? 0) + 1);
    }
    // Pochi valori che si ripetono: codici, tipi, sì/no, per le tabelle di corrispondenza. Una
    // colonna di valori tutti diversi (nomi, codici fiscali, testi) non si elenca.
    const repetitive = distinct.size <= MAX_DISTINCT_VALUES && distinct.size < filled;
    return {
      lettera: columnLetter(i),
      nome: name,
      piene: filled,
      valori: repetitive ? [...distinct.keys()].sort((a, b) => a.localeCompare(b, 'it')) : null,
    };
  });
}
