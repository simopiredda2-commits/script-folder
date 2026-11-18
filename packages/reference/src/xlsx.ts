import { unzipSync } from 'fflate';

/**
 * Lettore minimo di file XLSX (Office Open XML, ECMA-376): legge il primo foglio come tabella di
 * testi. Basta per l'elenco ISTAT dei comuni; formule, stili e date non servono.
 */

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith('#')) return String.fromCodePoint(Number(e.slice(1)));
    return ENTITIES[e]!;
  });
}

/** Testo di un elemento con eventuali «run» di testo formattato (<r><t>…</t></r>). */
function textOf(xml: string): string {
  let out = '';
  // <rPh> sono le letture fonetiche: non fanno parte del testo.
  const withoutPhonetic = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  for (const m of withoutPhonetic.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)) {
    out += decodeEntities(m[1] ?? '');
  }
  return out;
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

/** «AB12» → indice di colonna 27 (da zero). */
export function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? '';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function firstSheetPath(
  files: Record<string, Uint8Array>,
  dec: InstanceType<typeof TextDecoder>,
): string {
  const workbook = files['xl/workbook.xml'];
  const rels = files['xl/_rels/workbook.xml.rels'];
  if (workbook && rels) {
    const sheet = /<sheet\b[^>]*>/.exec(dec.decode(workbook))?.[0];
    const rid = sheet ? attr(sheet, 'r:id') : undefined;
    for (const rel of dec.decode(rels).match(/<Relationship\b[^>]*>/g) ?? []) {
      if (attr(rel, 'Id') === rid) {
        const target = attr(rel, 'Target')!;
        return target.startsWith('/') ? target.slice(1) : `xl/${target}`;
      }
    }
  }
  return 'xl/worksheets/sheet1.xml';
}

/** Righe del primo foglio, come testi; le celle vuote sono stringhe vuote. */
export function readXlsx(bytes: Uint8Array): { rows: string[][] } {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error('non è un archivio XLSX valido');
  }
  const dec = new TextDecoder('utf-8');
  const shared: string[] = [];
  const sst = files['xl/sharedStrings.xml'];
  if (sst) {
    for (const m of dec.decode(sst).matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/g)) {
      shared.push(textOf(m[1] ?? ''));
    }
  }
  const sheetPath = firstSheetPath(files, dec);
  const sheet = files[sheetPath];
  if (!sheet) throw new Error(`foglio non trovato nell'archivio: ${sheetPath}`);
  const rows: string[][] = [];
  // Prima la forma vuota <row …/>, perché l'altra non scavalchi la riga successiva.
  for (const rm of dec
    .decode(sheet)
    .matchAll(/<row\b([^>]*?)\/>|<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
    const rowTag = rm[1] ?? rm[2] ?? '';
    const rowNumber = Number(attr(rowTag, 'r') ?? rows.length + 1);
    while (rows.length < rowNumber - 1) rows.push([]);
    const cells: string[] = [];
    for (const cm of (rm[3] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const tag = cm[1]!;
      const body = cm[2] ?? '';
      const ref = attr(tag, 'r');
      const col = ref ? columnIndex(ref) : cells.length;
      const type = attr(tag, 't');
      let value = '';
      if (type === 'inlineStr') value = textOf(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? '');
      else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        if (v !== undefined) {
          value = type === 's' ? (shared[Number(v)] ?? '') : decodeEntities(v);
        }
      }
      while (cells.length < col) cells.push('');
      cells[col] = value;
    }
    rows.push(cells);
  }
  return { rows };
}
