import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { decodeText, detectSeparator, normalizeHeader, parseCsv, readCsv, readXlsx } from '../src';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const SITE = join(ROOT, 'fixtures', 'banche-dati', 'sito');

/** Esegue una funzione di sync/banche_dati.py su un elenco di argomenti e restituisce i risultati. */
function python(code: string, input: unknown): unknown {
  const out = execFileSync(
    'python3',
    [
      '-I',
      '-c',
      `import sys, json; sys.path.insert(0, ${JSON.stringify(join(ROOT, 'sync'))}); import banche_dati as b\n${code}`,
    ],
    { input: JSON.stringify(input), encoding: 'utf-8' },
  );
  return JSON.parse(out);
}

describe('intestazioni: la stessa normalizzazione di sync', () => {
  const samples = [
    'X=in lista di trasparenza Aifa 15/6/2026',
    'Prezzo al pubblico 30-6-2026',
    'Elenco al 9_luglio_2026',
    'Dati di settembre 2022',
    'Aggiornato 2026-06-26 ore 10',
    'Codice 16022026 e 20260216 e 12345678 e 00000710',
    "Codice dell'Unità territoriale sovracomunale  (valida a fini statistici)",
    '  Spazi   e\tTAB  ',
    'Codice Comune numerico con 107 Province (dal 2017 al 2025)',
    'Data 31022026 non valida',
  ];

  it('normalizeHeader coincide con _norma_cella di sync', () => {
    const expected = python(
      'print(json.dumps([b._norma_cella(s) for s in json.load(sys.stdin)]))',
      samples,
    );
    expect(samples.map(normalizeHeader)).toEqual(expected);
  });
});

describe('CSV: la stessa lettura di sync', () => {
  const files = [
    join(SITE, 'aifa', 'farmaci', 'confezioni_fornitura.csv'),
    join(
      SITE,
      'aifa',
      'documents',
      '20142',
      '3815901',
      'Classe-A_per_principio-attivo_30-6-2026.csv',
    ),
  ];
  // Casi difficili scritti qui: virgolette, separatori dentro i campi, a capo dentro i campi.
  const tricky = [
    'a;b;c\n1;"x;y";3\n',
    'a,b\n"riga\ncon a capo",2\r\n3,"virgolette ""doppie"""\n',
    'a|b|c\n1|2\n\n4|5|6|7\n',
    'campo;altro\r\n"aperto"dopo;x\r\n',
  ];

  it('codifica, separatore, intestazione e righe coincidono con ispeziona_csv', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mmg-csv-'));
    const paths = [
      ...files,
      ...tricky.map((t, i) => {
        const p = join(dir, `caso-${i}.csv`);
        writeFileSync(p, t);
        return p;
      }),
    ];
    const expected = python(
      `out = []
for p in json.load(sys.stdin):
    r = b.ispeziona_csv(b.Path(p))
    out.append({k: r.get(k) for k in ("codifica", "separatore", "intestazione", "righe", "righe_irregolari")})
print(json.dumps(out))`,
      paths,
    ) as {
      codifica: string;
      separatore: string;
      intestazione: string[];
      righe: number;
      righe_irregolari: number;
    }[];
    paths.forEach((p, i) => {
      const t = readCsv(new Uint8Array(readFileSync(p)));
      const rows = t.rows.filter((r) => r.some((c) => c.trim() !== ''));
      const headerIdx = rows.findIndex((r) => r.filter((c) => c.trim()).length >= 2);
      const header = rows[headerIdx]!.map((c) => c.trim());
      const data = rows.slice(headerIdx + 1);
      const e = expected[i]!;
      expect({ file: p, encoding: t.encoding, separator: t.separator }).toEqual({
        file: p,
        encoding: e.codifica === 'utf-8-sig' ? 'utf-8' : e.codifica,
        separator: e.separatore,
      });
      expect(header, p).toEqual(e.intestazione);
      expect(data.length, p).toBe(e.righe);
      expect(data.filter((r) => r.length !== header.length).length, p).toBe(e.righe_irregolari);
    });
  });

  it('ogni cella coincide con csv.reader di Python, anche nei casi difficili', () => {
    const expected = python(
      `import csv, io
print(json.dumps([list(csv.reader(io.StringIO(t), delimiter=s)) for t, s in json.load(sys.stdin)]))`,
      tricky.map((t) => [t, detectSeparator(t)]),
    );
    expect(tricky.map((t) => parseCsv(t, detectSeparator(t)!))).toEqual(expected);
  });

  it('il file in cp1252 si legge con le lettere accentate giuste', () => {
    const t = readCsv(new Uint8Array(readFileSync(files[0]!)));
    expect(t.encoding).toBe('cp1252');
    expect(t.rows.some((r) => r.includes('20 compresse (più forti)'))).toBe(true);
    expect(t.rows.some((r) => r.includes('PROVALINA "FORTE"'))).toBe(true);
  });

  it('il BOM iniziale non entra nel primo nome di colonna', () => {
    const t = readCsv(new Uint8Array(readFileSync(files[1]!)));
    expect(t.rows[0]![0]).toBe('AIC di prova');
  });

  it('con un byte che cp1252 non conosce si passa a latin-1, come Python', () => {
    expect(decodeText(new Uint8Array([0x61, 0x81, 0x80])).encoding).toBe('latin-1');
    expect(decodeText(new Uint8Array([0x61, 0x80])).text).toBe('a€');
  });

  it('separatore: il più frequente nella prima riga; a pari merito vince il primo', () => {
    expect(detectSeparator('a;b,c\n')).toBe(';');
    expect(detectSeparator('\n\na,b,c;d\n')).toBe(',');
    expect(detectSeparator('soltanto testo\n')).toBeNull();
    expect(parseCsv('a;b\n', ';')).toEqual([['a', 'b']]);
  });
});

describe('XLSX', () => {
  it('legge il file ISTAT d’esempio scritto da openpyxl (testi in linea)', () => {
    const { rows } = readXlsx(
      new Uint8Array(readFileSync(join(SITE, 'istat', 'Elenco-comuni-italiani.xlsx'))),
    );
    expect(rows[0]![20]).toBe('Codice Catastale del Comune');
    expect(rows[0]![1]).toContain("Codice dell'Unità territoriale");
    expect(rows[1]![6]).toBe('Agliè');
    expect(rows[1]![4]).toBe('001001');
    expect(rows[1]![7]).toBe('');
    expect(rows[1]![15]).toBe('1001');
    expect(rows[2]![20]).toBe('A109');
  });

  it('legge i testi condivisi, i testi formattati, le righe vuote e le celle mancanti', () => {
    const ns = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
    const bytes = zipSync({
      'xl/workbook.xml': strToU8(
        `<workbook ${ns} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Dati" sheetId="1" r:id="rId7"/></sheets></workbook>`,
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        '<Relationships><Relationship Id="rId7" Type="worksheet" Target="worksheets/foglio.xml"/></Relationships>',
      ),
      'xl/sharedStrings.xml': strToU8(
        `<sst ${ns}><si><t>Codice</t></si><si><r><t>Nome </t></r><r><rPr><b/></rPr><t xml:space="preserve">del comune</t></r><rPh><t>x</t></rPh></si><si><t>A &amp; B &#233;</t></si></sst>`,
      ),
      'xl/worksheets/foglio.xml': strToU8(
        `<worksheet ${ns}><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row><row r="2"/><row r="4"><c r="B4" t="s"><v>2</v></c><c r="C4"><v>42</v></c><c r="D4" s="1"/></row></sheetData></worksheet>`,
      ),
    });
    expect(readXlsx(bytes).rows).toEqual([
      ['Codice', '', 'Nome del comune'],
      [],
      [],
      ['', 'A & B é', '42', ''],
    ]);
  });

  it('un archivio guasto dà un errore chiaro', () => {
    expect(() => readXlsx(new Uint8Array([1, 2, 3]))).toThrow(/XLSX/);
  });
});
