import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMappings } from '@mmg/reference';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { referenceDataset } from '../src/db/schema';
import {
  EXAMPLE_TRANSCRIPTIONS,
  runSyncOnExample,
  serveExampleSite,
} from '../src/reference/example-site';
import { importReferenceData, type ImportLine } from '../src/reference/importer';
import { ReferenceData } from '../src/reference/lookup';
import { createTestDatabase, type TestDatabase } from './helpers/test-db';

/**
 * Atti che modificano il catalogo (D157), nel database: la versione intera si ricostruisce dalla
 * versione in vigore il giorno prima e vale dalla data dell'atto. Dati del catalogo d'esempio
 * (inventati); le righe vere della D.D. 710/2026 sono nelle prove di packages/reference.
 */
describe('atti che modificano il catalogo, nel database (D157)', () => {
  let t: TestDatabase;
  let work: string;
  let syncDir: string;

  beforeAll(async () => {
    t = await createTestDatabase();
    work = mkdtempSync(join(tmpdir(), 'mmg-modifiche-'));
    syncDir = join(work, 'dati-pubblici');
    const site = await serveExampleSite();
    try {
      expect((await runSyncOnExample(site, syncDir)).code).toBe(0);
    } finally {
      await site.close();
    }
  });
  afterAll(async () => {
    await t?.drop();
    if (work) rmSync(work, { recursive: true, force: true });
  });

  const HEADER = 'operazione;codice_regionale;codice_nomenclatore;descrizione;branca;tariffa;note';
  /** Le trascrizioni d'esempio, più gli atti «solo modifiche» della prova. */
  function transcriptions(name: string, acts: { file: string; date: string; csv: string[] }[]) {
    const dir = join(work, name);
    cpSync(EXAMPLE_TRANSCRIPTIONS, dir, { recursive: true });
    for (const a of acts) {
      writeFileSync(join(dir, `${a.file}.csv`), [HEADER, ...a.csv].join('\n') + '\n');
      writeFileSync(
        join(dir, `${a.file}.json`),
        JSON.stringify({
          tipo: 'prestazioni',
          serie: 'catalogo-piemonte',
          fonte: null,
          chiave: null,
          sha256_origine: null,
          atto: `Atto di prova ${a.file}`,
          in_vigore_dal: a.date,
          trascritto_da: 'Persona di prova',
          trascritto_il: '2026-11-18',
          controllato_da: 'Seconda persona di prova',
          solo_modifiche: true,
        }),
      );
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
  const lineOf = (report: ImportLine[], file: string) =>
    report.find((l) => l.file.endsWith(`${file}.json`))!;
  const codesAt = async (date: string) =>
    (await new ReferenceData(t.db, loadMappings()).searchServices('prova', date))
      .map((s) => `${s.regionalCode}${s.fee ? ` ${s.fee}` : ''}`)
      .sort();
  const datasets = async () =>
    (
      await t.db
        .select()
        .from(referenceDataset)
        .where(eq(referenceDataset.series, 'catalogo-piemonte'))
    ).length;

  it('l’atto vale dalla sua data: prima la versione di prima, poi quella ricostruita', async () => {
    // Il nome comincia con «a»: viene prima delle versioni intere nella cartella, ma si applica dopo.
    const dir = transcriptions('base', [
      {
        file: 'a-modifiche-2027',
        date: '2027-01-13',
        csv: [
          'toglie;PROVA.02;;;;;',
          'aggiunge;PROVA.03;;Esame di prova nuovo;Laboratorio di prova;;',
          'aggiunge;89.7;89.7;Visita di prova;Branca di prova;21,00;',
        ],
      },
    ]);
    const report = await load(dir);
    const line = lineOf(report, 'a-modifiche-2027');
    expect(line.outcome, line.notes.join('\n')).toBe('importato');
    expect(line.notes.join(' ')).toMatch(
      /modifiche alla versione del 2026-10-30 \(Catalogo di prova delle prestazioni\): 1 voci aggiunte, 1 sostituite, 1 tolte; 2 voci in tutto/,
    );
    expect(await codesAt('2027-01-12')).toEqual(['89.7 20.66', 'PROVA.02']);
    expect(await codesAt('2027-01-13')).toEqual(['89.7 21.00', 'PROVA.03']);
    // Un secondo giro non cambia nulla.
    const before = await datasets();
    expect(lineOf(await load(dir), 'a-modifiche-2027').outcome).toBe('gia_importato');
    expect(await datasets()).toBe(before);
  });

  it('due atti in fila: si applicano per data, anche se i file sono in un altro ordine', async () => {
    // «b-giugno» viene prima di «c-febbraio» nella cartella, ma giugno si scrive sulla versione di
    // febbraio: applicato prima, troverebbe da togliere una voce che non c'è ancora.
    const dir = transcriptions('fila', [
      {
        file: 'b-giugno',
        date: '2027-06-01',
        csv: [
          'toglie;PROVA.04;;;;;',
          'aggiunge;PROVA.05;;Esame di prova di giugno;Laboratorio di prova;;',
        ],
      },
      {
        file: 'c-febbraio',
        date: '2027-02-01',
        csv: [
          'toglie;PROVA.03;;;;;',
          'aggiunge;PROVA.04;;Esame di prova di febbraio;Laboratorio di prova;;',
        ],
      },
    ]);
    const report = await load(dir);
    expect(lineOf(report, 'c-febbraio').outcome).toBe('importato');
    const june = lineOf(report, 'b-giugno');
    expect(june.outcome, june.notes.join('\n')).toBe('importato');
    expect(await codesAt('2027-02-01')).toEqual(['89.7 21.00', 'PROVA.04']);
    expect(await codesAt('2027-06-01')).toEqual(['89.7 21.00', 'PROVA.05']);
  });

  it('senza una versione prima dell’atto: non si applica e lo dice', async () => {
    const dir = transcriptions('senza-base', [
      { file: 'modifiche-2020', date: '2020-01-01', csv: ['toglie;89.7;;;;;'] },
    ]);
    const line = lineOf(await load(dir), 'modifiche-2020');
    expect(line.outcome).toBe('base_mancante');
    expect(line.notes.join(' ')).toMatch(/serve prima la versione intera/);
  });

  it('un atto che toglie una voce che la base non ha non si applica', async () => {
    const before = await datasets();
    const dir = transcriptions('voce-ignota', [
      {
        file: 'modifiche-sbagliate',
        date: '2027-03-01',
        csv: ['toglie;NON.ESISTE;;;;;', 'aggiunge;PROVA.05;;Esame di prova;Laboratorio di prova;;'],
      },
    ]);
    const line = lineOf(await load(dir), 'modifiche-sbagliate');
    expect(line.outcome).toBe('righe_non_valide');
    expect(line.notes.join(' ')).toMatch(
      /toglie NON\.ESISTE: la voce non c'è nella versione di base/,
    );
    expect(await datasets()).toBe(before);
  });
});
