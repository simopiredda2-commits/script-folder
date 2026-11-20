import { mkdirSync, mkdtempSync, readdirSync, readFileSync, cpSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMappings, REGIONAL_TRANSCRIPTIONS } from '@mmg/reference';
import type { Database } from '../../src/db/client';
import { importReferenceData } from '../../src/reference/importer';

/**
 * Le trascrizioni delle prestazioni aggiuntive del repository, importate con chi le ha
 * controllate: senza, non entrano in uso (A8). Restituisce la cartella di lavoro, da cancellare.
 */
export async function importPpipCatalog(db: Database) {
  const work = mkdtempSync(join(tmpdir(), 'mmg-ppip-'));
  const syncDir = join(work, 'dati-pubblici');
  mkdirSync(syncDir);
  writeFileSync(join(syncDir, 'stato.json'), JSON.stringify({ versione: 1, file: {} }));
  const dir = join(work, 'trascrizioni', 'ppip');
  cpSync(join(REGIONAL_TRANSCRIPTIONS, 'ppip'), dir, { recursive: true });
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.json'))) {
    const sheet = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as Record<string, unknown>;
    writeFileSync(join(dir, f), JSON.stringify({ ...sheet, controllato_da: 'Persona di prova' }));
  }
  const report = await importReferenceData({
    db,
    syncDir,
    transcriptionsDir: join(work, 'trascrizioni'),
    mappings: loadMappings(),
    importedBy: 'prova',
  });
  return { work, syncDir, outcomes: report.map((r) => r.outcome) };
}
