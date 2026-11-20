/**
 * Database di partenza della dimostrazione (D221), preparato in Node una volta per costruzione:
 * tutte le migrazioni e le banche dati d'esempio, cioè `sync/` lanciato sul sito d'esempio
 * (fixtures/banche-dati) e importato come fa `pnpm banche-dati:importa -- --esempio`. Nessun
 * paziente: i dati dimostrativi si creano nel browser all'avvio, con le date di quel giorno.
 *
 *   tsx apps/demo/scripts/prepara-database.ts DESTINAZIONE.tar.gz
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { loadMappings } from '@mmg/reference';
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
