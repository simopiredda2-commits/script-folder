import { cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { TRANSCRIPTION_DIRS } from '@mmg/reference';

/**
 * Le trascrizioni del repository copiate in una cartella della prova, per scegliere chi le ha
 * controllate: ogni cartella (quella nazionale e quelle dei pacchetti regionali, D292) nella sua
 * sottocartella, come le legge il programma; con `only`, di ognuna solo quel tipo (per esempio
 * `ppip`). Dà le copie, nell'ordine delle cartelle.
 */
export function copyTranscriptions(
  dest: string,
  only?: string,
  dirs: readonly string[] = TRANSCRIPTION_DIRS,
) {
  return dirs.flatMap((dir, i) => {
    const from = only ? join(dir, only) : dir;
    if (!existsSync(from)) return [];
    const root = join(dest, String(i));
    cpSync(from, only ? join(root, only) : root, { recursive: true });
    return [root];
  });
}

/** Le cartelle di un tipo di trascrizioni (per esempio `lea`) nelle copie, quelle che ci sono. */
export const subdirsOf = (copies: readonly string[], name: string) =>
  copies.map((c) => join(c, name)).filter((d) => existsSync(d));
