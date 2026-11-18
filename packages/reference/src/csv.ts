import { decodeText } from './text';

/** Separatori che sync prova, nell'ordine: a parità di conteggio vince il primo. */
const SEPARATORS = [';', ',', '\t', '|'] as const;

/** Come sync: il separatore più frequente nella prima riga non vuota. */
export function detectSeparator(text: string): string | null {
  const first = text.split(/\r\n|\n|\r/).find((l) => l.trim() !== '');
  if (!first) return null;
  const count = (s: string) => first.split(s).length - 1;
  let best: string = SEPARATORS[0];
  for (const s of SEPARATORS) if (count(s) > count(best)) best = s;
  return count(best) > 0 ? best : null;
}

/**
 * Lettore CSV con le regole del dialetto «excel» del modulo csv di Python, quello che sync usa:
 * virgolette doppie per i campi, virgolette raddoppiate dentro i campi, fine riga \r\n, \n o \r.
 */
export function parseCsv(text: string, separator: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let state: 'start' | 'field' | 'quoted' | 'quote_in_quoted' = 'start';
  const endField = () => {
    row.push(field);
    field = '';
    state = 'start';
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const newline = c === '\n' || c === '\r';
    if (newline && c === '\r' && text[i + 1] === '\n' && state !== 'quoted') i++;
    switch (state) {
      case 'start':
        if (c === '"') state = 'quoted';
        else if (c === separator) endField();
        else if (newline) {
          if (row.length === 0) rows.push([]);
          else endRow();
        } else {
          field += c;
          state = 'field';
        }
        break;
      case 'field':
        if (c === separator) endField();
        else if (newline) endRow();
        else field += c;
        break;
      case 'quoted':
        if (c === '"') state = 'quote_in_quoted';
        else field += c;
        break;
      case 'quote_in_quoted':
        if (c === '"') {
          field += '"';
          state = 'quoted';
        } else if (c === separator) endField();
        else if (newline) endRow();
        else {
          field += c;
          state = 'field';
        }
        break;
    }
  }
  if (state !== 'start' || row.length > 0) endRow();
  return rows;
}

export interface Table {
  rows: string[][];
  encoding?: string;
  separator?: string;
}

/** Legge un CSV come sync: codifica, separatore, righe. */
export function readCsv(bytes: Uint8Array): Table {
  const { text, encoding } = decodeText(bytes);
  const separator = detectSeparator(text);
  if (!separator) throw new Error('nessun separatore riconosciuto nella prima riga');
  return { rows: parseCsv(text, separator), encoding, separator };
}
