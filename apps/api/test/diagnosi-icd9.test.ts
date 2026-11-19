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
 * Il catalogo ICD-9-CM che il programma porta con sé (D186), nel database: resta fuori finché
 * nessuno l'ha controllato (A8); controllato, la versione 2007 vale dal 1/1/2009 e le aggiunte
 * COVID-19 dal 2/2/2021. Le trascrizioni sono quelle del repository, copiate per scegliere chi le
 * ha controllate.
 */
describe('catalogo ICD-9-CM nel database (D186)', () => {
  let t: TestDatabase;
  let work: string;
  let syncDir: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    work = mkdtempSync(join(tmpdir(), 'mmg-icd9-'));
    syncDir = join(work, 'dati-pubblici');
    mkdirSync(syncDir);
    writeFileSync(join(syncDir, 'stato.json'), JSON.stringify({ versione: 1, file: {} }));
  });
  afterAll(async () => {
    await t?.drop();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  /** Solo le trascrizioni delle diagnosi, con chi le ha controllate. */
  function transcriptions(name: string, checkedBy: string | null) {
    const dir = join(work, name);
    cpSync(join(REGIONAL_TRANSCRIPTIONS, 'icd9cm'), join(dir, 'icd9cm'), { recursive: true });
    const sheets = join(dir, 'icd9cm');
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
  const outcomes = (report: ImportLine[]) =>
    report.map((l) => [l.file.replace(/^.*\//, ''), l.outcome]);
  const ref = () => new ReferenceData(t.db, loadMappings());

  it('finché nessuno l’ha controllato non entra in uso: la ricerca non trova nulla', async () => {
    const report = await load(transcriptions('da-controllare', null));
    expect(outcomes(report)).toEqual([
      ['icd9cm-2007-elenco-sistematico.json', 'trascrizione_da_controllare'],
      ['dm-2020-10-28-covid19.json', 'trascrizione_da_controllare'],
    ]);
    expect(await ref().searchDiagnoses('asma', '2026-11-19')).toEqual({ hits: [], total: 0 });
    expect(await ref().diagnosis('401.9', '2026-11-19')).toBeUndefined();
  });

  it(
    'controllato: la versione 2007 dal 1/1/2009, le aggiunte COVID-19 dal 2/2/2021',
    { timeout: 120_000 },
    async () => {
      const report = await load(transcriptions('controllato', 'Persona di prova'));
      expect(outcomes(report)).toEqual([
        ['icd9cm-2007-elenco-sistematico.json', 'importato'],
        ['dm-2020-10-28-covid19.json', 'importato'],
      ]);
      const versions = await t.db
        .select({ validFrom: referenceDataset.validFrom, rows: referenceDataset.rows })
        .from(referenceDataset)
        .where(eq(referenceDataset.series, 'icd9cm-diagnosi'));
      expect(versions.map((v) => `${v.validFrom} ${v.rows}`).sort()).toEqual([
        '2009-01-01 16293',
        '2021-02-02 16317',
      ]);
      const r = ref();
      expect((await r.searchDiagnoses('covid', '2021-02-01')).total).toBe(0);
      const covid = await r.searchDiagnoses('covid polmonite identificato', '2021-02-02');
      // «identificato» c'è anche in «non identificato»: escono i due codici, nell'ordine della classificazione.
      expect(covid.hits.map((h) => h.code)).toEqual(['480.41', '480.42']);
      expect((await r.diagnosis('4019', '2026-11-19'))!.description).toBe(
        'Ipertensione essenziale non specificata',
      );
      const asthma = (await r.searchDiagnoses('asma riacutizzazione', '2026-11-19')).hits.map(
        (h) => h.code,
      );
      // Tutte le asme «con riacutizzazione» (quinta cifra 2), 493.92 compreso.
      expect(asthma).toContain('493.92');
      expect(asthma.every((c) => /^493\.\d2$/.test(c))).toBe(true);
      // Le categorie composte dalle legende hanno i sottocodici.
      expect((await r.diagnosis('531.0', '2026-11-19'))!.category).toBe(true);
      expect(await r.diagnosis('E978', '2026-11-19')).toBeNull();
    },
  );
});
