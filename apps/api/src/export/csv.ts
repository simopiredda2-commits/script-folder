import { createHash } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import type { ExportDocument } from './export';

/**
 * Esportazione in CSV, chiesta da Simone alla prima fermata (D32): un archivio ZIP con un file
 * per tabella, apribile in un foglio di calcolo. Separatore «;» e UTF-8 con BOM, come si
 * aspetta un foglio di calcolo in italiano; virgolette secondo la RFC 4180.
 */
export const CSV_SEPARATOR = ';';
const BOM = '﻿';

type Row = Record<string, unknown>;

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text: string;
  if (value instanceof Date) text = value.toISOString();
  else if (typeof value === 'string') text = value;
  else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    text = String(value);
  } else text = JSON.stringify(value);
  return /[";\r\n]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(columns: string[], rows: Row[]): string {
  const lines = [columns.map(cell).join(CSV_SEPARATOR)];
  for (const r of rows) lines.push(columns.map((c) => cell(r[c])).join(CSV_SEPARATOR));
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

const README = `Esportazione completa dei dati dell'archivio, in CSV.

Un file per tabella, con la prima riga di intestazione (nomi delle colonne del database).
Separatore: punto e virgola. Codifica: UTF-8 con BOM. Righe terminate da CRLF.
Valori con punto e virgola, virgolette o a capo tra virgolette doppie (RFC 4180).
Cella vuota = nessun valore. Valori composti (per esempio i dettagli del registro) in JSON.
Date come AAAA-MM-GG; istanti come li scrive il database, in UTC.

allegati.csv elenca i referti e i documenti allegati; i file sono nella cartella allegati/,
così come sono arrivati (PDF o immagini), con l'impronta SHA-256 di ciascuno.

profilo-sanitario.csv elenca i PDF del Profilo Sanitario Sintetico (con il documento CDA2
dentro, da firmare e firmati); i file sono nella cartella profilo-sanitario/.

manifest.json elenca i file con il numero di righe e l'impronta SHA-256 di ciascuno.
Il significato delle tabelle e delle colonne è in docs/modello-dati.md e docs/esportazione.md.
`;

/** Archivio ZIP con i CSV di tutte le sezioni dell'esportazione. */
export function buildCsvZip(doc: ExportDocument): Uint8Array {
  const sections: [string, Row[]][] = [
    ...Object.entries(doc.tabelle),
    ['storico_modifiche', doc.storico_modifiche],
    ['registro_accessi', doc.registro_accessi],
  ];
  const files: Record<string, Uint8Array> = {};
  const manifest: { file: string; righe: number; sha256: string }[] = [];
  for (const [name, rows] of sections) {
    const columns = doc.colonne[name] ?? [...new Set(rows.flatMap((r) => Object.keys(r)))];
    const bytes = strToU8(toCsv(columns, rows));
    const file = `${name}.csv`;
    files[file] = bytes;
    manifest.push({
      file,
      righe: rows.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  // I file degli allegati, così come sono arrivati; un indice in allegati.csv.
  const index: Row[] = [];
  for (const a of doc.allegati) {
    const bytes = Buffer.from(a.contenuto_base64, 'base64');
    const file = `allegati/${a.id}-${a.nome.replace(/[^\p{L}\p{N}._-]+/gu, '_')}`;
    files[file] = new Uint8Array(bytes);
    index.push({ id: a.id, nome: a.nome, tipo: a.tipo, sha256: a.sha256, file });
    manifest.push({ file, righe: 0, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const indexBytes = strToU8(toCsv(['id', 'nome', 'tipo', 'sha256', 'file'], index));
  files['allegati.csv'] = indexBytes;
  manifest.push({
    file: 'allegati.csv',
    righe: index.length,
    sha256: createHash('sha256').update(indexBytes).digest('hex'),
  });
  // I PDF del Profilo Sanitario Sintetico (con il CDA dentro e firmati); indice in un CSV.
  const pssIndex: Row[] = [];
  for (const d of doc.documenti_profilo) {
    const bytes = Buffer.from(d.contenuto_base64, 'base64');
    const file = `profilo-sanitario/${d.documento}-${d.tipo === 'signed_pdf' ? 'firmato' : 'da-firmare'}.pdf`;
    files[file] = new Uint8Array(bytes);
    pssIndex.push({ id: d.id, documento: d.documento, tipo: d.tipo, sha256: d.sha256, file });
    manifest.push({ file, righe: 0, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const pssIndexBytes = strToU8(toCsv(['id', 'documento', 'tipo', 'sha256', 'file'], pssIndex));
  files['profilo-sanitario.csv'] = pssIndexBytes;
  manifest.push({
    file: 'profilo-sanitario.csv',
    righe: pssIndex.length,
    sha256: createHash('sha256').update(pssIndexBytes).digest('hex'),
  });
  files['LEGGIMI.txt'] = strToU8(README);
  files['manifest.json'] = strToU8(
    `${JSON.stringify(
      {
        formato: `${doc.formato}-csv`,
        versione: doc.versione,
        generato_il: doc.generato_il,
        studio: doc.studio,
        archivio: doc.archivio,
        medico: doc.medico,
        separatore: CSV_SEPARATOR,
        file: manifest,
      },
      null,
      2,
    )}\n`,
  );
  return zipSync(files, { level: 6 });
}
