/**
 * Importa nel database le banche dati scaricate da sync/.
 *
 *   pnpm banche-dati:importa -- --dati ~/dati-pubblici --trascrizioni ~/trascrizioni
 *   pnpm banche-dati:importa -- --esempio
 *
 * --dati           cartella di sync (quella del suo --dest)
 * --trascrizioni   cartella delle trascrizioni dei PDF (schede .json con il CSV accanto); per
 *                  difetto quelle del programma (packages/reference/data/trascrizioni, D159)
 * --mappature      file di mappature in più: sostituisce quelle con lo stesso id (ripetibile)
 * --accetta-scarti importa le righe valide anche se alcune sono state scartate
 * --esempio        lancia sync sul sito d'esempio (fixtures/banche-dati) e importa quello
 *
 * Codici d'uscita come sync: 0 tutto a posto, 1 almeno un errore, 2 qualcosa da completare o
 * verificare a mano.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { loadMappings, overrideMappings, TRANSCRIPTION_DIRS } from '@mmg/reference';
import { createDatabase, createPool } from '../db/client';
import { runMigrations } from '../db/migrate';
import { EXAMPLE_TRANSCRIPTIONS, runSyncOnExample, serveExampleSite } from './example-site';
import { ERRORS, importReferenceData, NEEDS_ATTENTION, type ImportLine } from './importer';

const LABELS: Record<ImportLine['outcome'], string> = {
  importato: 'importato',
  gia_importato: 'già importato',
  senza_mappatura: 'senza mappatura (ignorato)',
  mappatura_da_completare: 'mappatura da completare',
  serve_trascrizione: 'serve una trascrizione',
  in_attesa_in_sync: 'in attesa di verifica in sync',
  impronta_diversa: 'ERRORE: impronta diversa',
  colonne_mancanti: 'colonne mancanti',
  righe_non_valide: 'righe non valide',
  trascrizione_superata: 'trascrizione superata',
  trascrizione_non_valida: 'ERRORE: trascrizione non valida',
  origine_non_trovata: 'ERRORE: PDF d’origine non trovato',
  base_mancante: 'manca la versione su cui l’atto è scritto',
  ambito_diverso: 'ambito diverso da quello della serie',
  trascrizione_da_controllare: 'trascrizione da controllare: non ancora in uso',
};

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    dati: { type: 'string' },
    trascrizioni: { type: 'string' },
    mappature: { type: 'string', multiple: true },
    'accetta-scarti': { type: 'boolean', default: false },
    esempio: { type: 'boolean', default: false },
  },
});

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL mancante');
if (!values.esempio && !values.dati)
  throw new Error('Indica --dati (la cartella di sync) oppure --esempio');

let mappings = loadMappings();
for (const f of values.mappature ?? []) mappings = overrideMappings(mappings, loadMappings(f));

let syncDir = values.dati;
let transcriptionsDir: string | readonly string[] | undefined = values.trascrizioni;
if (values.esempio) {
  const site = await serveExampleSite();
  try {
    syncDir = join(mkdtempSync(join(tmpdir(), 'mmg-banche-dati-')), 'dati-pubblici');
    const run = await runSyncOnExample(site, syncDir);
    console.log(`sync sul sito d'esempio: uscita ${run.code}`);
  } finally {
    await site.close();
  }
  // Il sito d'esempio ha le intestazioni vere AIFA: valgono le mappature del repository.
  transcriptionsDir ??= EXAMPLE_TRANSCRIPTIONS;
}
transcriptionsDir ??= TRANSCRIPTION_DIRS;

const pool = createPool(databaseUrl);
try {
  await runMigrations(pool);
  const report = await importReferenceData({
    db: createDatabase(pool),
    syncDir: syncDir!,
    transcriptionsDir,
    mappings,
    acceptDiscarded: values['accetta-scarti'],
    importedBy: `riga di comando (${userInfo().username})`,
  });
  for (const r of report) {
    console.log(
      `\n${r.file}: ${LABELS[r.outcome]}${r.rows !== undefined ? `, ${r.rows} righe` : ''}`,
    );
    for (const n of r.notes) console.log(`  - ${n}`);
    for (const w of r.warnings ?? []) console.log(`  ! ${w}`);
  }
  const outcomes = new Set(report.map((r) => r.outcome));
  const warned = report.some((r) => r.warnings?.length);
  process.exitCode = [...outcomes].some((o) => ERRORS.has(o))
    ? 1
    : [...outcomes].some((o) => NEEDS_ATTENTION.has(o)) || warned
      ? 2
      : 0;
} finally {
  await pool.end();
}
