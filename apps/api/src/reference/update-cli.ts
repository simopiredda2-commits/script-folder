/**
 * Aggiorna le banche dati con un comando solo (D156): sync scarica dalle fonti ciò che è cambiato,
 * l'importazione controlla e mette in uso le versioni nuove, il giro resta nel registro.
 *
 *   pnpm banche-dati:aggiorna -- --dati ~/dati-pubblici --trascrizioni ~/trascrizioni
 *   pnpm banche-dati:aggiorna -- --esempio
 *
 * --dati           cartella di sync (il suo --dest); per difetto BANCHE_DATI_DIR
 * --trascrizioni   cartella delle trascrizioni dei PDF; per difetto BANCHE_DATI_TRASCRIZIONI
 * --fonti          «pubbliche» (sync/fonti.json), «esempio» o un file di fonti; per difetto
 *                  BANCHE_DATI_FONTI, altrimenti «pubbliche»
 * --esempio        il sito d'esempio servito in locale, in una cartella temporanea se non c'è --dati
 *
 * Codici d'uscita come sync: 0 tutto a posto, 1 almeno un errore (o giro interrotto), 2 qualcosa
 * da completare o verificare a mano.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { createDatabase, createPool } from '../db/client';
import { runMigrations } from '../db/migrate';
import { issuesOf } from './update';
import { referenceUpdatesFromConfig } from './updates-service';

const { values } = parseArgs({
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    dati: { type: 'string' },
    trascrizioni: { type: 'string' },
    fonti: { type: 'string' },
    esempio: { type: 'boolean', default: false },
  },
});

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL mancante');
const sources = values.esempio
  ? 'esempio'
  : (values.fonti ?? (process.env.BANCHE_DATI_FONTI?.trim() || 'pubbliche'));
const dataDir =
  values.dati ??
  process.env.BANCHE_DATI_DIR?.trim() ??
  (values.esempio ? join(mkdtempSync(join(tmpdir(), 'mmg-banche-dati-')), 'dati-pubblici') : '');
if (!dataDir) throw new Error('Indica --dati (la cartella di sync) oppure BANCHE_DATI_DIR');
const transcriptionsDir = values.trascrizioni ?? process.env.BANCHE_DATI_TRASCRIZIONI?.trim();

const OUTCOME: Record<string, string> = {
  ok: 'tutto a posto',
  da_verificare: 'qualcosa da verificare a mano',
  errore: 'almeno un errore',
  interrotto: 'interrotto',
};

const pool = createPool(databaseUrl);
try {
  const db = createDatabase(pool);
  await runMigrations(pool);
  const updates = referenceUpdatesFromConfig(db, {
    dataDir,
    sources,
    ...(transcriptionsDir ? { transcriptionsDir } : {}),
  });
  console.log(`Aggiornamento delle banche dati in ${dataDir} (fonti: ${sources})`);
  const run = await (
    await updates.start('comando', `riga di comando (${userInfo().username})`)
  ).done;
  console.log(`\nEsito: ${OUTCOME[run.outcome ?? 'errore']}`);
  if (run.message) console.log(run.message);
  const issues = issuesOf(run);
  if (issues.length) {
    console.log('\nDa guardare:');
    for (const i of issues) {
      console.log(`  ${i.level === 'errore' ? '✗' : '?'} ${i.source}/${i.file}: ${i.what}`);
      for (const n of i.notes) console.log(`      - ${n}`);
    }
  }
  if (run.outcome !== 'ok' && run.output) console.log(`\nOutput di sync:\n${run.output}`);
  process.exitCode = run.outcome === 'ok' ? 0 : run.outcome === 'da_verificare' ? 2 : 1;
} finally {
  await pool.end();
}
