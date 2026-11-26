import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMappings } from '@mmg/reference';
import type { Database } from '../../src/db/client';
import { importReferenceData } from '../../src/reference/importer';
import { copyTranscriptions, subdirsOf } from './transcriptions';

/**
 * Le trascrizioni delle prestazioni aggiuntive del repository, nazionali e dei pacchetti regionali
 * (D292), importate con chi le ha controllate: senza, non entrano in uso (A8). Restituisce la
 * cartella di lavoro, da cancellare.
 */
export async function importPpipCatalog(db: Database) {
  const work = mkdtempSync(join(tmpdir(), 'mmg-ppip-'));
  const syncDir = join(work, 'dati-pubblici');
  mkdirSync(syncDir);
  writeFileSync(join(syncDir, 'stato.json'), JSON.stringify({ versione: 1, file: {} }));
  const dirs = copyTranscriptions(join(work, 'trascrizioni'), 'ppip');
  for (const dir of subdirsOf(dirs, 'ppip'))
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
      const sheet = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as Record<string, unknown>;
      writeFileSync(join(dir, f), JSON.stringify({ ...sheet, controllato_da: 'Persona di prova' }));
    }
  const report = await importReferenceData({
    db,
    syncDir,
    transcriptionsDir: dirs,
    mappings: loadMappings(),
    importedBy: 'prova',
  });
  return { work, syncDir, outcomes: report.map((r) => r.outcome) };
}
