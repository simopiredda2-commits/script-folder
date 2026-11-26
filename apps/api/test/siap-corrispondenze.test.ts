import { readCsv, SIAP_DIR, TRANSCRIPTION_DIRS } from '@mmg/reference';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { transcriptionsIn } from '../src/reference/importer';
import { loadPpipMappings, ppipMappings } from '../src/siap/ppip-mapping';

/**
 * Le corrispondenze fra le voci dei cataloghi delle prestazioni aggiuntive e i dettagli della
 * tipologia «PIPP» del SIAP (D291). Le corrispondenze sono fatte per descrizione e restano da
 * controllare (controllato_da vuoto): la prova controlla che siano complete e che i dettagli
 * esistano, non che siano giuste.
 */
describe('corrispondenze delle prestazioni aggiuntive con il SIAP (D291)', () => {
  const m = ppipMappings();
  const tmp = mkdtempSync(join(tmpdir(), 'siap-corrispondenze-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('ogni voce di ogni catalogo trascritto ha la sua corrispondenza, e nessuna voce in più', () => {
    // Le trascrizioni nazionali e quelle dei pacchetti regionali (D292).
    const { found } = transcriptionsIn(TRANSCRIPTION_DIRS);
    const catalogs = found.filter((f) => f.sheet.tipo === 'prestazioni_aggiuntive');
    expect(catalogs.length).toBeGreaterThan(0);
    // Ogni catalogo delle prestazioni aggiuntive ha il suo file, e ogni file un catalogo.
    expect([...new Set(catalogs.map((f) => f.sheet.serie))].sort()).toEqual(
      m.files.map((f) => f.data.serie).sort(),
    );
    for (const c of catalogs) {
      const file = m.files.find((f) => f.data.serie === c.sheet.serie)!;
      const [head, ...body] = readCsv(readFileSync(c.csvPath)).rows;
      const at = head!.indexOf('codice');
      const codes = body.map((r) => r[at]).filter((x): x is string => !!x);
      expect(file.data.voci.map((v) => v.codice).sort(), `${file.name} e ${c.path}`).toEqual(
        codes.sort(),
      );
      // L'ambito del file è quello del catalogo.
      expect(file.data.ambito ?? null, file.name).toEqual(c.sheet.ambito ?? null);
    }
  });

  it('il dettaglio del Ministero per le voci dell’ACN e dell’accordo regionale; senza corrispondenza «Altro»', () => {
    const acn = 'acn-prestazioni-aggiuntive';
    expect(m.other).toBe(47);
    expect(m.detail(acn, 'A1')).toBe(6);
    expect(m.detail(acn, 'A3')).toBe(7);
    // Il Ministero ha un dettaglio solo per il cateterismo uretrale, nell'uomo e nella donna.
    expect(m.detail(acn, 'A5')).toBe(1);
    expect(m.detail(acn, 'A6')).toBe(1);
    expect(m.detail(acn, 'B4')).toBe(14);
    expect(m.detail('piemonte-prestazioni-aggiuntive', 'AIR35.4')).toBe(10);
    // La voce di un'altra serie, o di una serie senza file: «Altro».
    expect(m.detail(acn, 'AIR35.4')).toBe(47);
    expect(m.detail('accordo-di-prova', 'X1')).toBe(47);
  });

  it('un dettaglio che non è della tipologia, voci ripetute, due file per una serie, «Altro» in più file o in nessuno: non vale', () => {
    const national = JSON.parse(
      readFileSync(join(SIAP_DIR, 'corrispondenze-prestazioni-aggiuntive.json'), 'utf8'),
    ) as Record<string, unknown>;
    const write = (name: string, data: object) =>
      writeFileSync(
        join(tmp, `corrispondenze-prestazioni-aggiuntive${name}.json`),
        JSON.stringify(data),
      );
    write('', { ...national, voci: [{ codice: 'A1', dettaglio: 48 }] });
    expect(() => loadPpipMappings(tmp)).toThrow(/il dettaglio 48 non è della tipologia 5/);
    write('', { ...national, altro: 99 });
    expect(() => loadPpipMappings(tmp)).toThrow(/il dettaglio 99 non è della tipologia 5/);
    write('', {
      ...national,
      voci: [
        { codice: 'A1', dettaglio: 6 },
        { codice: 'A1', dettaglio: 7 },
      ],
    });
    expect(() => loadPpipMappings(tmp)).toThrow(/Voci ripetute/);
    write('', national);
    expect(loadPpipMappings(tmp).detail('acn-prestazioni-aggiuntive', 'A2')).toBe(9);
    write('-bis', { ...national, altro: undefined });
    expect(() => loadPpipMappings(tmp)).toThrow(
      /la serie acn-prestazioni-aggiuntive ha già un file/,
    );
    write('-bis', { ...national, serie: 'accordo-di-prova' });
    expect(() => loadPpipMappings(tmp)).toThrow(/lo dicono 2 file/);
    rmSync(join(tmp, 'corrispondenze-prestazioni-aggiuntive-bis.json'));
    write('', { ...national, altro: undefined });
    expect(() => loadPpipMappings(tmp)).toThrow(/lo dicono 0 file/);
  });
});
