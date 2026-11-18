/**
 * Lettura del testo dei file come fa sync/banche_dati.py, perché l'importazione veda lo stesso file
 * che lo script ha controllato.
 */

/** Byte che la codifica cp1252 di Python non conosce: con uno di questi Python passa a latin-1. */
const CP1252_UNDEFINED = new Set([0x81, 0x8d, 0x8f, 0x90, 0x9d]);

/**
 * Come `ispeziona_csv` in sync: prima utf-8 (con o senza BOM), poi cp1252, infine latin-1.
 */
export function decodeText(bytes: Uint8Array): { text: string; encoding: string } {
  try {
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return { text: text.startsWith('﻿') ? text.slice(1) : text, encoding: 'utf-8' };
  } catch {
    // non è utf-8: si prova la codifica successiva
  }
  if (!bytes.some((b) => CP1252_UNDEFINED.has(b))) {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'cp1252' };
  }
  let text = '';
  for (const b of bytes) text += String.fromCharCode(b);
  return { text, encoding: 'latin-1' };
}

// Le stesse espressioni di sync/banche_dati.py (_DATE_RE e _togli_date): le date nelle intestazioni
// cambiano a ogni pubblicazione, e senza toglierle una colonna sembrerebbe un'altra.
const MONTHS =
  'gennaio|febbraio|marzo|aprile|maggio|giugno|luglio|agosto|settembre|ottobre|novembre|dicembre';
const SEP = '[_\\-. ]';
const DATE_PATTERNS = [
  new RegExp(`${SEP}?\\d{4}[\\-._]\\d{1,2}[\\-._]\\d{1,2}`, 'g'),
  new RegExp(`${SEP}?\\d{1,2}${SEP}?(?:${MONTHS})${SEP}?\\d{4}`, 'gi'),
  new RegExp(`${SEP}?(?:${MONTHS})${SEP}?\\d{4}`, 'gi'),
  new RegExp(`${SEP}?\\d{1,2}[\\-._/]\\d{1,2}[\\-._/]\\d{2,4}`, 'g'),
];

/** Vero se le otto cifre sono una data GGMMAAAA o AAAAMMGG esistente (come strptime in Python). */
function isCompactDate(s: string): boolean {
  const valid = (y: number, m: number, d: number) => {
    if (y < 1 || m < 1 || m > 12 || d < 1) return false;
    return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
  };
  const n = (a: number, b: number) => Number(s.slice(a, b));
  return valid(n(4, 8), n(2, 4), n(0, 2)) || valid(n(0, 4), n(4, 6), n(6, 8));
}

/** Toglie le date da un testo, come `_togli_date` in sync. */
export function stripDates(text: string): string {
  let out = text;
  for (const re of DATE_PATTERNS) out = out.replace(re, '');
  return out.replace(/(?<!\d)\d{8}(?!\d)/g, (m) => (isCompactDate(m) ? '' : m));
}

/** Nome di colonna confrontabile: senza date, minuscolo, spazi compattati (`_norma_cella`). */
export function normalizeHeader(cell: string): string {
  return stripDates(cell).toLowerCase().split(/\s+/).filter(Boolean).join(' ');
}
