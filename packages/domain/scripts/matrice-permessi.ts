import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderPermissionsMatrix } from '../src/permissions-matrix';

/** Aggiorna la matrice in docs/ruoli-permessi.md tra i due segnaposto. */
const file = join(import.meta.dirname, '..', '..', '..', 'docs', 'ruoli-permessi.md');
const start = '<!-- matrice:inizio -->';
const end = '<!-- matrice:fine -->';
const doc = readFileSync(file, 'utf8');
const i = doc.indexOf(start);
const j = doc.indexOf(end);
if (i < 0 || j < i) throw new Error('Segnaposto della matrice non trovati');
writeFileSync(
  file,
  `${doc.slice(0, i + start.length)}\n\n${renderPermissionsMatrix()}\n\n${doc.slice(j)}`,
);
console.log(`Aggiornato ${file}`);
