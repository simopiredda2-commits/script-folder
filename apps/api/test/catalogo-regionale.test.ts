import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMappings, REGIONAL_TRANSCRIPTIONS } from '@mmg/reference';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { referenceDataset } from '../src/db/schema';
import { importReferenceData, type ImportLine } from '../src/reference/importer';
import { ReferenceData } from '../src/reference/lookup';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

/**
 * Il catalogo regionale che il programma porta con sé (D159), nel database: resta fuori finché
 * nessuno l'ha controllato (A8); controllato, vale dalla data di ogni atto. Le trascrizioni sono
 * quelle del repository, copiate in una cartella della prova per scegliere chi le ha controllate.
 */
describe('catalogo regionale in vigore, nel database (D159)', () => {
  let t: TestDatabase;
  let work: string;
  let syncDir: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    work = mkdtempSync(join(tmpdir(), 'mmg-catalogo-'));
    // Nessun file di sync: qui contano solo le trascrizioni.
    syncDir = join(work, 'dati-pubblici');
    mkdirSync(syncDir);
    writeFileSync(join(syncDir, 'stato.json'), JSON.stringify({ versione: 1, file: {} }));
  });
  afterAll(async () => {
    await t?.drop();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  /** Le trascrizioni del repository, con chi le ha controllate. */
  function transcriptions(name: string, checkedBy: string | null) {
    const dir = join(work, name);
    cpSync(REGIONAL_TRANSCRIPTIONS, dir, { recursive: true });
    const sheets = join(dir, 'piemonte_catalogo');
    for (const f of readdirSync(sheets).filter((n) => n.endsWith('.json'))) {
      const sheet = JSON.parse(readFileSync(join(sheets, f), 'utf-8')) as Record<string, unknown>;
      writeFileSync(join(sheets, f), JSON.stringify({ ...sheet, controllato_da: checkedBy }));
    }
    return dir;
  }
  const load = (dir: string) =>
    importReferenceData({
      db: t.db,
      syncDir,
      transcriptionsDir: dir,
      mappings: loadMappings(),
      importedBy: 'prova',
    });
  // Nella stessa cartella ci sono anche le diagnosi ICD-9-CM (D186): qui solo il catalogo regionale.
  const outcomes = (report: ImportLine[]) =>
    report
      .filter((l) => l.file.startsWith('piemonte_catalogo/'))
      .map((l) => [l.file.replace(/^.*\//, ''), l.outcome]);
  const versions = async () =>
    (
      await t.db
        .select({
          validFrom: referenceDataset.validFrom,
          rows: referenceDataset.rows,
          checkedBy: referenceDataset.checkedBy,
        })
        .from(referenceDataset)
        .where(eq(referenceDataset.series, 'catalogo-piemonte'))
    )
      .map((v) => `${v.validFrom} ${v.rows} ${v.checkedBy}`)
      .sort();
  const search = async (q: string, date: string) =>
    (await new ReferenceData(t.db, loadMappings()).searchServices(q, date)).map((s) =>
      `${s.regionalCode} ${s.fee ?? ''}`.trim(),
    );

  it('finché nessuno l’ha controllato non entra in uso, e il rapporto lo dice', async () => {
    const report = await load(transcriptions('da-controllare', null));
    expect(outcomes(report)).toEqual([
      ['dd590-2026-allegato-a.json', 'trascrizione_da_controllare'],
      ['dd710-2026-dal-2026-10-30.json', 'trascrizione_da_controllare'],
      ['dd710-2026-dal-2027-01-13.json', 'trascrizione_da_controllare'],
    ]);
    expect(report.find((l) => l.file.startsWith('piemonte_catalogo/'))!.notes.join(' ')).toMatch(
      /nessuno l'ha ancora controllata/,
    );
    expect(await versions()).toEqual([]);
    expect(await search('luteotropina', '2026-11-19')).toEqual([]);
  });

  it(
    'controllato: una versione per atto, ognuna dalla sua data',
    { timeout: 120_000 },
    async () => {
      const report = await load(transcriptions('controllato', 'Persona di prova'));
      expect(outcomes(report)).toEqual([
        ['dd590-2026-allegato-a.json', 'importato'],
        ['dd710-2026-dal-2026-10-30.json', 'importato'],
        ['dd710-2026-dal-2027-01-13.json', 'importato'],
      ]);
      expect(await versions()).toEqual([
        '2026-09-21 5107 Persona di prova',
        '2026-10-30 5149 Persona di prova',
        '2027-01-13 5093 Persona di prova',
      ]);
      // Prima del 21/09/2026 il catalogo non c'è; poi la tariffa di 90323.0 cambia il 30/10.
      expect(await search('luteotropina', '2026-09-20')).toEqual([]);
      expect(await search('luteotropina lh', '2026-10-29')).toContain('90323.0 7.20');
      expect(await search('luteotropina lh', '2026-10-30')).toContain('90323.0 6.20');
      // Lo stesso esame cambia codice del catalogo il 30/10.
      expect(await search('45.30.1', '2026-10-29')).toContain('45.30.1 220.10');
      expect(await search('45.30.1A', '2026-10-30')).toContain('45.30.1A 220.10');
      expect(await search('45.30.1', '2026-10-30')).not.toContain('45.30.1 220.10');
      // La radioterapia dell'allegato B vale fino al 12/01/2027.
      expect(await search('92241.0', '2027-01-12')).toContain('92241.0 42.00');
      expect(await search('92241.0', '2027-01-13')).not.toContain('92241.0 42.00');
    },
  );
});
