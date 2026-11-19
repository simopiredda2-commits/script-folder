import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toCsv } from '../src/export/csv';
import type { ExportDocument } from '../src/export/export';
import { createScenario, login, type Scenario } from './helpers/scenario';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

describe('formato CSV', () => {
  it('separatore punto e virgola, BOM, CRLF e virgolette secondo la RFC 4180', () => {
    const csv = toCsv(
      ['a', 'b', 'c'],
      [
        { a: 'x;y', b: 'dice "ciao"', c: null },
        { a: 'riga\nnuova', b: 1, c: { k: 1 } },
      ],
    );
    expect(csv.startsWith('﻿')).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe('a;b;c');
    expect(lines[1]).toBe('"x;y";"dice ""ciao""";');
    expect(csv).toContain('"riga\nnuova";1;"{""k"":1}"');
  });
});

describe('formule nei testi (D172)', () => {
  it('un testo che comincia con = + - @ prende un apostrofo; numeri, date e altri testi no', () => {
    const csv = toCsv(
      ['a'],
      [
        { a: '=SOMMA(A1:A9)' },
        { a: '+39 000 0000001' },
        { a: '-2+3+cmd' },
        { a: '@SUM(1)' },
        { a: -3.5 },
        { a: 'Nota normale' },
      ],
    );
    expect(csv.split('\r\n').slice(1, 7)).toEqual([
      "'=SOMMA(A1:A9)",
      "'+39 000 0000001",
      "'-2+3+cmd",
      "'@SUM(1)",
      '-3.5',
      'Nota normale',
    ]);
  });
});

describe('esportazione CSV dell’archivio', () => {
  let t: TestDatabase;
  let s: Scenario;
  let files: Record<string, string>;
  let raw: Record<string, Uint8Array>;
  let json: ExportDocument;
  beforeAll(async () => {
    t = await createTestDatabase();
    s = await createScenario(t.db);
    const cookie = await login(s, 'titolare');
    const res = await s.app.inject({
      method: 'GET',
      url: '/api/esportazione?formato=csv',
      headers: { cookie },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toMatch(/esportazione-.*-csv\.zip/);
    raw = unzipSync(new Uint8Array(res.rawPayload));
    // ignoreBOM: il BOM resta nel testo, come nel file.
    const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
    files = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, decoder.decode(v)]));
    json = (
      await s.app.inject({ method: 'GET', url: '/api/esportazione', headers: { cookie } })
    ).json();
  });
  afterAll(async () => {
    await s?.app.close();
    await t?.drop();
  });

  it('ogni CSV comincia con il BOM UTF-8', () => {
    for (const [name, bytes] of Object.entries(raw)) {
      if (name.endsWith('.csv')) expect([...bytes.slice(0, 3)], name).toEqual([0xef, 0xbb, 0xbf]);
    }
  });

  it('ha un file per ogni sezione dell’esportazione JSON, più manifesto e istruzioni', () => {
    const sections = [...Object.keys(json.tabelle), 'storico_modifiche', 'registro_accessi'];
    for (const name of sections) expect(files, name).toHaveProperty(`${name}.csv`);
    expect(files).toHaveProperty('manifest.json');
    expect(files).toHaveProperty('LEGGIMI.txt');
  });

  it('le righe di ogni tabella sono quelle del JSON', () => {
    for (const [name, rows] of Object.entries(json.tabelle)) {
      const csv = files[`${name}.csv`]!;
      // Righe di dati = righe del CSV senza intestazione (i testi qui non hanno a capo).
      const lines = csv.slice(1).split('\r\n').filter(Boolean);
      expect(lines.length - 1, name).toBe(rows.length);
      expect(lines[0], name).toBe(json.colonne[name]!.join(';'));
    }
  });

  it('anche le tabelle vuote hanno l’intestazione', () => {
    const empty = Object.entries(json.tabelle).find(([, rows]) => rows.length === 0)!;
    expect(empty).toBeDefined();
    expect(files[`${empty[0]}.csv`]!.slice(1).split('\r\n')[0]).toBe(
      json.colonne[empty[0]]!.join(';'),
    );
  });

  it('il manifesto riporta righe e impronte giuste', () => {
    const manifest = JSON.parse(files['manifest.json']!) as {
      file: { file: string; righe: number; sha256: string }[];
    };
    for (const f of manifest.file) {
      expect(createHash('sha256').update(raw[f.file]!).digest('hex'), f.file).toBe(f.sha256);
    }
  });

  it('non contiene password né segreti', () => {
    const all = Object.values(files).join('\n');
    for (const secret of ['password_hash', 'totp_secret', 'external_credentials', 'scrypt$']) {
      expect(all).not.toContain(secret);
    }
  });
});
