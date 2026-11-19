import {
  buildFiscalCode,
  IMPORT_DESTINATIONS,
  importDestination,
  type ImportField,
} from '@mmg/domain';
import { createHash } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { entryHandlers } from '../src/import/destinations';
import { convertRow, prepareRow } from '../src/import/engine';
import { resolveMapping } from '../src/import/mapping';
import { readImportFile } from '../src/import/read';
import { Deadline, FileRejected, type ImportTable } from '../src/import/table';
import { convertValue, parseTextDate } from '../src/import/transforms';
import { numberFormatKind, serialToDate } from '../src/import/xlsx';
import { crc32 } from '../src/import/zip';
import { buildXlsx, column, patchCentralDirectory } from './helpers/importazione-xlsx';

/**
 * Lettori dei file da importare in modalità «file non fidato» (tappa 15). Tutti i file sono
 * inventati e costruiti qui: nessun file binario nel repository.
 */

const enc = (s: string) => strToU8(s);
/** Windows-1252: un byte per carattere, € = 0x80 (tabella della codifica in TextDecoder). */
function cp1252(s: string): Uint8Array {
  const table = new TextDecoder('windows-1252');
  const reverse = new Map<string, number>();
  for (let b = 0; b < 256; b++) reverse.set(table.decode(new Uint8Array([b])), b);
  return new Uint8Array([...s].map((ch) => reverse.get(ch) ?? 0x3f));
}
const rejects = (bytes: Uint8Array, pattern: RegExp, options = {}) => {
  let error: unknown;
  try {
    readImportFile(bytes, options);
  } catch (e) {
    error = e;
  }
  expect(error, 'il file doveva essere rifiutato').toBeInstanceOf(FileRejected);
  expect((error as Error).message).toMatch(pattern);
  return error as FileRejected;
};

describe('CSV e TSV in modalità rigorosa', () => {
  it('separatore «;» con virgolette, a capo e virgolette raddoppiate dentro i campi', () => {
    const f = readImportFile(
      enc(
        'cognome;nome;note\r\nRossi;Maria;"una; nota\r\nsu due righe"\r\nBianchi;Anna;"detto ""Nino"""\r\n',
      ),
    );
    expect(f.format).toBe('csv');
    expect(f.separator).toBe(';');
    const t = f.tables[0]!;
    expect(t.records.map((r) => r.line)).toEqual([1, 2, 4]);
    expect(t.records[1]!.cells).toEqual(['Rossi', 'Maria', 'una; nota\r\nsu due righe']);
    expect(t.records[2]!.cells[2]).toBe('detto "Nino"');
  });

  it('separatore «,»; un’intestazione con virgole tra virgolette non inganna la scelta', () => {
    const f = readImportFile(enc('"cognome, nome";"data"\n"Rossi, Maria";"01/02/1970"\n'));
    expect(f.separator).toBe(';');
    expect(f.tables[0]!.records[1]!.cells).toEqual(['Rossi, Maria', '01/02/1970']);
    const g = readImportFile(enc('cognome,nome,nota\nRossi,Maria,"con ; dentro"\nVerdi,Luca,x\n'));
    expect(g.separator).toBe(',');
    expect(g.tables[0]!.records[1]!.cells[2]).toBe('con ; dentro');
  });

  it('TSV, riga «sep=» e separatore scelto a mano', () => {
    expect(readImportFile(enc('a\tb\n1\t2\n')).separator).toBe('\t');
    const hinted = readImportFile(enc('sep=|\na|b\n1|2\n'));
    expect(hinted.separator).toBe('|');
    expect(hinted.tables[0]!.records[0]!.line).toBe(2);
    expect(readImportFile(enc('a,b;c\n1,2;3\n'), { separator: ',' }).tables[0]!.width).toBe(2);
  });

  it('codifica Windows-1252 (accenti ed euro) e UTF-8 con BOM', () => {
    const f = readImportFile(cp1252('cognome;città\nNicolò;Forlì €\n'));
    expect(f.encoding).toBe('cp1252');
    expect(f.tables[0]!.records[1]!.cells).toEqual(['Nicolò', 'Forlì €']);
    const bom = readImportFile(
      new Uint8Array([0xef, 0xbb, 0xbf, ...enc('cognome;nome\nRè;Ugo\n')]),
    );
    expect(bom.encoding).toBe('utf-8');
    expect(bom.tables[0]!.records[0]!.cells[0]).toBe('cognome');
  });

  it('righe di titolo prima dell’intestazione: lasciate fuori, e il rapporto lo dice', () => {
    const f = readImportFile(enc('Elenco degli assistiti\n\ncognome;nome;sesso\nRossi;Maria;F\n'));
    expect(f.tables[0]!.records[0]!.cells).toEqual(['cognome', 'nome', 'sesso']);
    expect(f.notes.join(' ')).toMatch(/Righe prima dell’intestazione.*1/);
  });

  it('virgolette non chiuse: il file è rifiutato con la riga, e il resto non finisce in un campo', () => {
    rejects(
      enc('cognome;note\nRossi;"nota aperta\nBianchi;altra\nVerdi;x\n'),
      /riga 2.*virgolette/,
    );
    rejects(enc('a;b\n1;"chiusa"dopo\n'), /riga 2.*dopo la virgoletta di chiusura/);
  });

  it('una riga con un campo in più o in meno ferma il file e dice quali righe', () => {
    const e = rejects(
      enc(
        'cognome;nome;note\nRossi;Maria;ok\nBianchi;Anna;nota; con separatore\nVerdi;Luca\nNeri;Ada;ok\n',
      ),
      /Le righe 3, 4 hanno un numero di campi diverso/,
    );
    expect(e.statusCode).toBe(400);
  });

  it('separatori in più alla fine, vuoti, si tollerano: nessun valore si sposta', () => {
    const f = readImportFile(enc('a;b\n1;2;\n3;4;;\n'));
    expect(f.tables[0]!.records.map((r) => r.cells)).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('caratteri NUL, file vuoti, PDF e immagini: rifiutati con un messaggio chiaro', () => {
    rejects(new Uint8Array([0x61, 0x3b, 0x00, 0x62]), /non sono testo/);
    rejects(new Uint8Array([]), /vuoto/);
    rejects(enc('%PDF-1.7\n...'), /PDF/);
    rejects(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]), /immagine/);
  });

  it('un file oltre la dimensione massima è rifiutato con il codice 413', () => {
    const e = rejects(new Uint8Array(16 * 1024 * 1024 + 1).fill(0x61), /supera 16 MB/);
    expect(e.statusCode).toBe(413);
  });

  it('il tempo massimo della lettura ferma un file che non finisce mai', () => {
    let t = 0;
    const deadline = new Deadline(10, () => (t += 5));
    expect(() => readImportFile(enc(`a;b\n${'1;2\n'.repeat(5000)}`), {}, deadline)).toThrow(
      /tempo massimo/,
    );
  });
});

describe('XLSX in modalità rigorosa', () => {
  it('tutti i fogli con i nomi, testi condivisi e in linea, numeri, sì/no, righe vuote', () => {
    const bytes = buildXlsx([
      {
        name: 'Pazienti',
        rows: [
          ['Cognome', 'Nome', 'Peso', 'Fumatore'],
          ['Rossi', { inline: 'Maria & Co' }, 72.5, true],
          [],
          ['Bianchi', 'Anna', 61, false],
        ],
      },
      { name: 'Problemi', rows: [['Codice'], ['401.9']] },
    ]);
    const f = readImportFile(bytes);
    expect(f.format).toBe('xlsx');
    expect(f.tables.map((t) => t.name)).toEqual(['Pazienti', 'Problemi']);
    const t = f.tables[0]!;
    expect(t.records.map((r) => r.line)).toEqual([1, 2, 4]);
    expect(t.records[1]!.cells).toEqual(['Rossi', 'Maria & Co', '72.5', '1']);
    expect(t.records[1]!.kinds).toBe('ttnb');
    expect(t.records[2]!.cells[3]).toBe('0');
  });

  it('date dagli stili (formato predefinito 14 e personalizzato) e sistema 1904', () => {
    // 45123 = 16/7/2023 e 46345 = 19/11/2026 nel sistema 1900 (openpyxl 3.1.5, from_excel).
    const f = readImportFile(
      buildXlsx([
        {
          name: 'D',
          rows: [['data'], [{ date: 45123 }], [{ raw: '<c r="A3" s="2"><v>46345</v></c>' }]],
        },
      ]),
    );
    expect(f.tables[0]!.records[1]!.cells[0]).toBe('2023-07-16');
    expect(f.tables[0]!.records[1]!.kinds).toBe('d');
    expect(f.tables[0]!.records[2]!.cells[0]).toBe('2026-11-19');
    // Nel sistema 1904, 44883 = 19/11/2026 (openpyxl, CALENDAR_MAC_1904).
    const m = readImportFile(
      buildXlsx([{ name: 'D', rows: [['data'], [{ date: 44883 }]] }], { date1904: true }),
    );
    expect(m.tables[0]!.records[1]!.cells[0]).toBe('2026-11-19');
    expect(m.notes.join(' ')).toMatch(/1904/);
  });

  it('numeri seriali: gli stessi giorni di openpyxl, e il 29/2/1900 che non esiste', () => {
    // Coppie lette da openpyxl 3.1.5 (to_excel/from_excel) il 19/11/2026.
    expect(serialToDate(1)).toBe('1900-01-01');
    expect(serialToDate(59)).toBe('1900-02-28');
    expect(serialToDate(60)).toBeNull();
    expect(serialToDate(61)).toBe('1900-03-01');
    expect(serialToDate(25569)).toBe('1970-01-01');
    expect(serialToDate(36585)).toBe('2000-02-29');
    expect(serialToDate(46345.75)).toBe('2026-11-19');
    expect(serialToDate(24107, true)).toBe('1970-01-01');
    expect(serialToDate(0)).toBeNull();
  });

  it('formati numerici: date, orari, numeri (come is_date_format di openpyxl)', () => {
    expect(numberFormatKind('dd/mm/yyyy')).toBe('date');
    expect(numberFormatKind('[$-410]d mmmm yyyy;@')).toBe('date');
    expect(numberFormatKind('h:mm:ss')).toBe('time');
    expect(numberFormatKind('[h]:mm')).toBe('time');
    expect(numberFormatKind('0.00')).toBeNull();
    expect(numberFormatKind('"giorni" 0')).toBeNull();
    expect(numberFormatKind('#,##0.00 [$€-410]')).toBeNull();
  });

  it('DOCTYPE in una parte: rifiutato prima di leggere entità', () => {
    const sheet = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>&a;</t></is></c></row></sheetData></worksheet>`;
    rejects(buildXlsx([{ name: 'X', rows: [], xml: sheet }]), /DOCTYPE/);
  });

  it('coordinate enormi con un valore: rifiutate; senza valore: ignorate senza allocare nulla', () => {
    const big = (row: string) =>
      `<worksheet><sheetData><row r="1"><c r="A1"><v>1</v></c></row>${row}</sheetData></worksheet>`;
    rejects(
      buildXlsx([
        { name: 'X', rows: [], xml: big('<row r="5000000"><c r="A5000000"><v>2</v></c></row>') },
      ]),
      /oltre la riga/,
    );
    rejects(
      buildXlsx([{ name: 'X', rows: [], xml: big('<row r="2"><c r="ZZZZ2"><v>2</v></c></row>') }]),
      /oltre la colonna/,
    );
    rejects(
      buildXlsx([
        { name: 'X', rows: [], xml: big('<row r="2"><c r="ZZZZZZ2"><v>2</v></c></row>') },
      ]),
      /coordinate non valide/,
    );
    const empty = readImportFile(
      buildXlsx([
        {
          name: 'X',
          rows: [],
          xml: big('<row r="2000000000"/><row r="2000000001"><c r="ZZZZ2000000001"/></row>'),
        },
      ]),
    );
    expect(empty.tables[0]!.records).toHaveLength(1);
    expect(empty.tables[0]!.width).toBe(1);
  });

  it('dimensione dichiarata falsa o CRC sbagliato: il contenuto troncato non passa', () => {
    const bytes = buildXlsx([
      {
        name: 'X',
        rows: [
          ['a', 'b'],
          ['1', '2'],
        ],
      },
    ]);
    const files = zipSync({ x: strToU8('prova') });
    expect(crc32(strToU8('prova'))).toBe(new DataView(files.buffer).getUint32(14, true));
    rejects(patchCentralDirectory(bytes, 'xl/sharedStrings.xml', 24, 10), /CRC|danneggiato/);
    rejects(patchCentralDirectory(bytes, 'xl/sharedStrings.xml', 16, 12345), /CRC/);
    rejects(
      patchCentralDirectory(bytes, 'xl/worksheets/sheet1.xml', 24, 0x7fffffff),
      /supera|danneggiato/,
    );
  });

  it('un archivio ZIP che non è un XLSX, o un ODS: un messaggio che dice che cosa fare', () => {
    rejects(zipSync({ 'leggimi.txt': strToU8('ciao') }), /non è un foglio di calcolo XLSX/);
    rejects(
      zipSync({
        mimetype: strToU8('application/vnd.oasis.opendocument.spreadsheet'),
        'content.xml': strToU8('<x/>'),
      }),
      /OpenDocument.*XLSX o CSV/,
    );
  });
});

describe('JSON', () => {
  it('un elenco di oggetti diventa una tabella; le chiavi pericolose si scartano', () => {
    const f = readImportFile(
      enc(
        '[{"cognome":"Rossi","eta":50,"attivo":true,"__proto__":{"x":1},"indirizzo":{"via":"Via Uno"}}]',
      ),
    );
    expect(f.format).toBe('json');
    const t = f.tables[0]!;
    expect(t.records[0]!.cells).toEqual(['cognome', 'eta', 'attivo', 'indirizzo.via']);
    expect(t.records[1]!.cells).toEqual(['Rossi', '50', '1', 'Via Uno']);
    expect(t.records[1]!.kinds).toBe('tnbt');
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('la nostra esportazione: impronte verificate, una tabella per menu, mappatura proposta', () => {
    const patient = [
      {
        id: 'p1',
        fiscal_code: buildFiscalCode({
          surname: 'Rossi',
          name: 'Ada',
          birthDate: '1970-01-01',
          sex: 'F',
          placeCode: 'X001',
        }),
        last_name: 'Rossi',
        first_name: 'Ada',
        sex: 'F',
        birth_date: '1970-01-01',
        status: 'active',
      },
    ];
    const digest = (rows: unknown) =>
      createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    const doc = {
      formato: 'mmg-esportazione',
      versione: 1,
      tabelle: { patient, family: [] },
      impronte: { patient: digest(patient), family: digest([]) },
    };
    const f = readImportFile(enc(JSON.stringify(doc)));
    expect(f.format).toBe('mmg-esportazione');
    expect(f.tables.map((t) => t.name)).toEqual(['Pazienti']);
    expect(f.tables[0]!.records[1]!.cells).toContain('attivo');
    expect(f.proposed?.parti[0]).toMatchObject({ tabella: 'Pazienti', destinazione: 'pazienti' });
    // Un valore cambiato dopo l'esportazione: l'impronta non torna e il file non entra.
    const tampered = JSON.stringify(doc).replace('"Rossi"', '"Rosso"');
    rejects(enc(tampered), /modificata dopo essere stata creata/);
    rejects(enc(JSON.stringify({ ...doc, versione: 2 })), /versione/);
    rejects(enc('[{"a":1}'), /non è un JSON valido/);
  });
});

describe('trasformazioni', () => {
  const field = (dest: string, key: string) =>
    importDestination(dest)!.fields.find((f) => f.key === key)!;
  const conv = (dest: string, key: string, raw: string, kind = 't', t = {}) =>
    convertValue(field(dest, key), raw, kind, t, { date1904: false });

  it('date GG/MM/AAAA (anche con «-» e «.») e AAAA-MM-GG; anni a due cifre e date inesistenti no', () => {
    expect(parseTextDate('5/3/2020')).toEqual({ date: '2020-03-05' });
    expect(parseTextDate('05-03-2020 10:30')).toEqual({ date: '2020-03-05' });
    expect(parseTextDate('05.03.2020')).toEqual({ date: '2020-03-05' });
    expect(parseTextDate('2020-03-05')).toEqual({ date: '2020-03-05' });
    expect(parseTextDate('05/03/20')).toHaveProperty('error');
    expect(parseTextDate('31/02/2020')).toHaveProperty('error');
    expect(conv('diario', 'data', '45123', 't', { formatoData: 'seriale' })).toEqual({
      ok: true,
      value: '2023-07-16',
    });
    expect(conv('diario', 'data', '45123', 'n')).toMatchObject({ ok: false });
    expect(conv('diario', 'data', '01/01/1900')).toMatchObject({
      ok: true,
      warning: expect.stringMatching(/segnaposto/),
    });
  });

  it('numeri con la virgola o il punto; niente separatore delle migliaia', () => {
    expect(conv('parametri', 'valore', '72,5')).toEqual({ ok: true, value: '72.5' });
    expect(conv('parametri', 'valore', '72.5')).toEqual({ ok: true, value: '72.5' });
    expect(conv('parametri', 'valore', '1.234,5')).toMatchObject({ ok: false });
    expect(conv('parametri', 'valore', '72.5', 'n')).toEqual({ ok: true, value: '72.5' });
  });

  it('sì/no, sesso con le parole comuni, valori ammessi e tabelle di corrispondenza', () => {
    expect(conv('problemi', 'cronico', 'Sì')).toEqual({ ok: true, value: true });
    expect(conv('problemi', 'cronico', 'x')).toEqual({ ok: true, value: true });
    expect(conv('problemi', 'cronico', 'N')).toEqual({ ok: true, value: false });
    expect(conv('problemi', 'cronico', 'forse')).toMatchObject({ ok: false });
    expect(conv('pazienti', 'sesso', 'femmina')).toEqual({ ok: true, value: 'F' });
    expect(conv('pazienti', 'sesso', 'M')).toEqual({ ok: true, value: 'M' });
    expect(conv('diario', 'contatto', 'AMB')).toMatchObject({ ok: false });
    expect(conv('diario', 'contatto', ' amb ', 't', { corrispondenze: { AMB: 'studio' } })).toEqual(
      { ok: true, value: 'studio' },
    );
    expect(conv('diario', 'contatto', '-', 't', { corrispondenze: { '-': '' } })).toEqual({
      ok: true,
      value: null,
    });
  });

  it('codici: maiuscole, zeri iniziali dell’AIC con un avviso, celle numeriche segnalate', () => {
    expect(conv('terapie', 'aic', '38092019', 'n')).toMatchObject({
      ok: true,
      value: '038092019',
      warning: expect.stringMatching(/zeri iniziali/),
    });
    expect(conv('problemi', 'codice', 'v17.3')).toEqual({ ok: true, value: 'V17.3' });
    expect(conv('problemi', 'codice', '250', 'n')).toMatchObject({
      ok: true,
      warning: expect.stringMatching(/cella numerica/),
    });
    expect(conv('pazienti', 'codiceFiscale', ' rss mra 70a41 x001 a ')).toEqual({
      ok: true,
      value: 'RSSMRA70A41X001A',
    });
    // Un telefono in una cella numerica ha perso lo zero iniziale: avviso; un civico no.
    expect(conv('pazienti', 'telefono', '111234567', 'n')).toMatchObject({
      ok: true,
      warning: expect.stringMatching(/zeri iniziali/),
    });
    expect(conv('pazienti', 'residenzaCivico', '12', 'n')).toEqual({ ok: true, value: '12' });
  });

  it('i messaggi non riportano mai il valore della cella', () => {
    for (const [dest, key, raw] of [
      ['diario', 'data', 'Rossi Maria 1970'],
      ['problemi', 'cronico', 'Rossi Maria'],
      ['parametri', 'valore', 'Rossi Maria'],
      ['diario', 'contatto', 'Rossi Maria'],
    ] as const) {
      const r = conv(dest, key, raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).not.toMatch(/Rossi|Maria/);
    }
  });
});

describe('campi obbligatori del catalogo e controlli dell’inserimento a mano', () => {
  // Valori d'esempio per tipo di campo; un paziente inventato (D12).
  const CF = buildFiscalCode({
    surname: 'Prova',
    name: 'Ugo',
    birthDate: '1960-03-04',
    sex: 'M',
    placeCode: 'X001',
  });
  const sample = (f: ImportField): string => {
    if (f.kind === 'fiscalCode') return CF;
    if (f.kind === 'date') return '02/01/2024';
    if (f.kind === 'choice') return f.choices![0]!.key;
    if (f.kind === 'integer') return '1';
    if (f.kind === 'number') return '1';
    if (f.kind === 'code') return 'E01';
    return 'Testo di prova';
  };
  // Quello che il modulo vuole oltre ai campi obbligatori: un parametro, il nome del farmaco.
  const extra: Record<string, Record<string, string>> = {
    parametri: { parametro: 'peso', valore: '70' },
    ricette_passate: { farmaco: 'Farmaco di prova' },
  };

  for (const d of IMPORT_DESTINATIONS) {
    it(`${d.label}: con i soli obbligatori la riga passa, senza uno di essi no`, () => {
      const required = d.fields.filter((f) => f.required);
      const values: Record<string, string> = Object.fromEntries(
        required.map((f) => [f.key, sample(f)]),
      );
      Object.assign(values, extra[d.key] ?? {});
      const keys = Object.keys(values);
      const table: ImportTable = {
        name: 'CSV',
        width: keys.length,
        records: [
          { line: 1, cells: keys },
          { line: 2, cells: keys.map((k) => values[k]!) },
          ...required.map((f, i) => ({
            line: 3 + i,
            cells: keys.map((k) => (k === f.key ? '' : values[k]!)),
          })),
        ],
      };
      const [p] = resolveMapping([table], {
        parti: [
          {
            tabella: 'CSV',
            intestazione: 1,
            destinazione: d.key,
            campi: Object.fromEntries(
              keys.map((k, i) => [k, { colonna: { lettera: column(i), nome: k } }]),
            ),
          },
        ],
      });
      const prepare = (line: number) => {
        const r = p!.rows.find((x) => x.line === line)!;
        return prepareRow(
          p!,
          convertRow(p!, r.cells, r.kinds, { date1904: false }),
          '2026-11-19',
          entryHandlers(),
        );
      };
      expect(prepare(2), d.key).toMatchObject({ ok: true });
      required.forEach((f, i) => {
        const r = prepare(3 + i);
        expect(r.ok, `${d.key} senza ${f.key}`).toBe(false);
        if (!r.ok) expect(r.errors.join(' '), `${d.key} senza ${f.key}`).toContain(f.label);
      });
    });
  }
});
