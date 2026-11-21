/**
 * Database di partenza della dimostrazione (D221), preparato in Node una volta per costruzione:
 * tutte le migrazioni e le banche dati d'esempio, cioè `sync/` lanciato sul sito d'esempio
 * (fixtures/banche-dati) e importato come fa `pnpm banche-dati:importa -- --esempio`. In più il
 * nomenclatore dei presidi degli allegati 2 e 3 del DPCM LEA (D218, D236), che nel programma entra
 * solo dopo il controllo di una persona (A8): qui si vede prima, e il riquadro lo dice. Nessun
 * paziente: i dati dimostrativi si creano nel browser all'avvio, con le date di quel giorno.
 *
 *   tsx apps/demo/scripts/prepara-database.ts DESTINAZIONE.tar.gz
 */
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { loadMappings, REGIONAL_TRANSCRIPTIONS } from '@mmg/reference';
import { drizzle } from 'drizzle-orm/pglite';
import type { Database } from '../../api/src/db/client';
import { readMigrations } from '../../api/src/db/migrate';
import * as schema from '../../api/src/db/schema';
import {
  EXAMPLE_TRANSCRIPTIONS,
  runSyncOnExample,
  serveExampleSite,
} from '../../api/src/reference/example-site';
import { importReferenceData } from '../../api/src/reference/importer';

const dest = process.argv[2];
if (!dest) throw new Error('Indica il file da scrivere (.tar.gz)');

/** Le trascrizioni dei presidi del DPCM LEA che la dimostrazione mostra prima del controllo. */
const SUPPLY_TRANSCRIPTIONS = ['allegato-2-ausili-monouso', 'allegato-3-presidi'];
/** «Controllato da» nella copia della dimostrazione: dice che nessuno l'ha controllata. */
const DEMO_UNCHECKED = 'nessuno: copia della dimostrazione, ancora da controllare (A8)';

const work = mkdtempSync(join(tmpdir(), 'mmg-dimostrazione-'));
try {
  const syncDir = join(work, 'dati-pubblici');
  const site = await serveExampleSite();
  try {
    const run = await runSyncOnExample(site, syncDir);
    if (run.code !== 0)
      throw new Error(`sync sul sito d'esempio: uscita ${run.code}\n${run.output}`);
  } finally {
    await site.close();
  }

  const pg = await PGlite.create();
  // Le migrazioni come le applica runMigrations: in ordine, ognuna nella sua transazione, con la
  // tabella che ne tiene le impronte.
  await pg.exec(`create table if not exists schema_migrations (
    tag text primary key,
    sha256 text not null,
    applied_at timestamptz not null default now()
  )`);
  for (const m of readMigrations()) {
    await pg.transaction(async (tx) => {
      for (const statement of m.statements) await tx.exec(statement);
      await tx.query('insert into schema_migrations (tag, sha256) values ($1, $2)', [
        m.tag,
        m.sha256,
      ]);
    });
  }
  const db = drizzle(pg, { schema, casing: 'snake_case' }) as unknown as Database;
  const report = await importReferenceData({
    db,
    syncDir,
    transcriptionsDir: EXAMPLE_TRANSCRIPTIONS,
    mappings: loadMappings(),
    importedBy: 'dimostrazione nel browser (banche dati d’esempio)',
  });
  // Il nomenclatore dei presidi: le trascrizioni del programma, copiate con chi le ha controllate.
  // Non vengono da sync (atti non scaricati): una cartella di sync vuota, perché i file d'esempio
  // sono già entrati sopra.
  const supplies = join(work, 'trascrizioni-presidi');
  const noSync = join(work, 'senza-sync');
  mkdirSync(join(supplies, 'lea'), { recursive: true });
  mkdirSync(noSync);
  writeFileSync(join(noSync, 'stato.json'), JSON.stringify({ versione: 1, file: {} }));
  for (const base of SUPPLY_TRANSCRIPTIONS) {
    const from = (ext: string) => join(REGIONAL_TRANSCRIPTIONS, 'lea', `${base}.${ext}`);
    cpSync(from('csv'), join(supplies, 'lea', `${base}.csv`));
    const sheet = JSON.parse(readFileSync(from('json'), 'utf-8')) as Record<string, unknown>;
    writeFileSync(
      join(supplies, 'lea', `${base}.json`),
      JSON.stringify({ ...sheet, controllato_da: DEMO_UNCHECKED }),
    );
  }
  report.push(
    ...(await importReferenceData({
      db,
      syncDir: noSync,
      transcriptionsDir: supplies,
      mappings: loadMappings(),
      importedBy: 'dimostrazione nel browser (presidi del DPCM LEA, da controllare)',
    })),
  );
  const refused = report.filter((r) => r.outcome !== 'importato' && r.outcome !== 'gia_importato');
  for (const r of report)
    console.log(`${r.file}: ${r.outcome}${r.rows ? `, ${r.rows} righe` : ''}`);
  if (refused.length)
    throw new Error(`Importazione non riuscita: ${refused.map((r) => r.file).join(', ')}`);
  // Per il caricamento nel browser: niente da ripulire dopo, tutto già scritto.
  await pg.exec('checkpoint');
  const dump = await pg.dumpDataDir('gzip');
  writeFileSync(dest, new Uint8Array(await dump.arrayBuffer()));
  console.log(`Database di partenza: ${dest}, ${(dump.size / 1e6).toFixed(1)} MB`);
  await pg.close();
} finally {
  rmSync(work, { recursive: true, force: true });
}
