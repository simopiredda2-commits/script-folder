import { strToU8, zipSync } from 'fflate';

/**
 * XLSX costruiti nelle prove dell'importazione (tappa 15), come le prove di packages/reference:
 * archivio ZIP scritto da fflate, XML scritto a mano. Nessun file binario nel repository.
 */

export type TestCell =
  string | number | boolean | null | { date: number } | { inline: string } | { raw: string };

const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
const RNS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function column(i: number): string {
  let n = i + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export interface TestSheet {
  name: string;
  rows: TestCell[][];
  /** XML del foglio scritto a mano, al posto delle righe. */
  xml?: string;
}

/**
 * Cartella di lavoro con testi condivisi, numeri, sì/no, date con lo stile 1 (formato predefinito
 * 14) e con lo stile 2 (formato personalizzato «dd/mm/yyyy»).
 */
export function buildXlsx(sheets: TestSheet[], options: { date1904?: boolean } = {}): Uint8Array {
  const shared: string[] = [];
  const sharedIndex = (s: string) => {
    let i = shared.indexOf(s);
    if (i < 0) i = shared.push(s) - 1;
    return i;
  };
  const files: Record<string, Uint8Array> = {};
  sheets.forEach((sheet, si) => {
    const rows = sheet.rows
      .map((row, ri) => {
        const cells = row
          .map((c, ci) => {
            const ref = `${column(ci)}${ri + 1}`;
            if (c === null) return '';
            if (typeof c === 'string') return `<c r="${ref}" t="s"><v>${sharedIndex(c)}</v></c>`;
            if (typeof c === 'number') return `<c r="${ref}"><v>${c}</v></c>`;
            if (typeof c === 'boolean') return `<c r="${ref}" t="b"><v>${c ? 1 : 0}</v></c>`;
            if ('date' in c) return `<c r="${ref}" s="1"><v>${c.date}</v></c>`;
            if ('inline' in c)
              return `<c r="${ref}" t="inlineStr"><is><t>${esc(c.inline)}</t></is></c>`;
            return c.raw;
          })
          .join('');
        return `<row r="${ri + 1}">${cells}</row>`;
      })
      .join('');
    files[`xl/worksheets/sheet${si + 1}.xml`] = strToU8(
      sheet.xml ??
        `<?xml version="1.0" encoding="UTF-8"?><worksheet ${NS}><sheetData>${rows}</sheetData></worksheet>`,
    );
  });
  files['[Content_Types].xml'] = strToU8(
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  );
  files['xl/workbook.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><workbook ${NS} ${RNS}>${options.date1904 ? '<workbookPr date1904="1"/>' : ''}<sheets>${sheets
      .map((s, i) => `<sheet name="${esc(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('')}</sheets></workbook>`,
  );
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
      .map(
        (_, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join(
        '',
      )}<Relationship Id="rIdS" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rIdT" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  );
  files['xl/styles.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><styleSheet ${NS}><numFmts count="1"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/></numFmts><cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/><xf numFmtId="164" applyNumberFormat="1"/></cellXfs></styleSheet>`,
  );
  files['xl/sharedStrings.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><sst ${NS} count="${shared.length}" uniqueCount="${shared.length}">${shared
      .map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`)
      .join('')}</sst>`,
  );
  return zipSync(files);
}

/** Cambia un campo di 4 byte della voce dell'indice centrale con questo nome (per i guasti). */
export function patchCentralDirectory(
  zip: Uint8Array,
  name: string,
  offset: 16 | 20 | 24,
  value: number,
): Uint8Array {
  const out = zip.slice();
  const dv = new DataView(out.buffer);
  const target = strToU8(name);
  for (let i = 0; i + 46 < out.length; i++) {
    if (dv.getUint32(i, true) !== 0x02014b50) continue;
    const nameLength = dv.getUint16(i + 28, true);
    const n = out.subarray(i + 46, i + 46 + nameLength);
    if (n.length === target.length && n.every((b, k) => b === target[k])) {
      dv.setUint32(i + offset, value >>> 0, true);
      return out;
    }
  }
  throw new Error(`voce non trovata: ${name}`);
}
