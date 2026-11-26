import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findTranscriptions, TRANSCRIPTIONS_DIR } from '@mmg/reference';
import { afterAll, describe, expect, it } from 'vitest';
import { transcriptionsIn } from '../src/reference/importer';

/**
 * Le trascrizioni da più cartelle (D295): quella nazionale e quelle dei pacchetti regionali, lette
 * nell'ordine delle cartelle. Il percorso dentro la cartella nomina la trascrizione nel rapporto:
 * lo stesso percorso in due cartelle non entra da nessuna delle due.
 */
describe('trascrizioni da più cartelle (D295)', () => {
  const work = mkdtempSync(join(tmpdir(), 'mmg-trascrizioni-cartelle-'));
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  /** Una cartella con le schede indicate, copiate da quelle nazionali del programma. */
  const dirWith = (name: string, sheets: string[]) => {
    const dir = join(work, name);
    for (const sheet of sheets) {
      mkdirSync(join(dir, sheet.split('/')[0]!), { recursive: true });
      for (const ext of ['json', 'csv'])
        cpSync(join(TRANSCRIPTIONS_DIR, `${sheet}.${ext}`), join(dir, `${sheet}.${ext}`));
    }
    return dir;
  };
  const ACN = 'ppip/acn-2022-2024-allegato-6';
  const NOTE = 'lea/allegato-4-note';
  const paths = (r: { found: { path: string }[] }) => r.found.map((t) => t.path);

  it('una cartella sola: come prima', () => {
    const one = dirWith('una', [ACN, NOTE]);
    expect(transcriptionsIn(one)).toEqual(findTranscriptions(one));
    expect(transcriptionsIn(undefined)).toEqual({ found: [], invalid: [] });
  });

  it('due cartelle: le schede di tutte e due, nell’ordine delle cartelle', () => {
    const a = dirWith('a', [NOTE]);
    const b = dirWith('b', [ACN]);
    expect(paths(transcriptionsIn([a, b]))).toEqual([`${NOTE}.json`, `${ACN}.json`]);
    expect(paths(transcriptionsIn([b, a]))).toEqual([`${ACN}.json`, `${NOTE}.json`]);
    expect(transcriptionsIn([a, b]).invalid).toEqual([]);
  });

  it('lo stesso percorso in due cartelle: non entra da nessuna, e il rapporto lo dice; le altre sì', () => {
    const a = dirWith('doppia-a', [ACN, NOTE]);
    const b = dirWith('doppia-b', [ACN]);
    const r = transcriptionsIn([a, b]);
    expect(paths(r)).toEqual([`${NOTE}.json`]);
    expect(r.invalid).toEqual([
      {
        path: `${ACN}.json`,
        problem:
          'lo stesso percorso è in più cartelle delle trascrizioni: non entra nessuno di quei file',
      },
    ]);
  });
});
