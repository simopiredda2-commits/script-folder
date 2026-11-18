import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderRulesTable } from '../src/docs';

/** Aggiorna la tabella in docs/regole.md tra i due segnaposto. */
const file = join(import.meta.dirname, '..', '..', '..', 'docs', 'regole.md');
const start = '<!-- regole:inizio -->';
const end = '<!-- regole:fine -->';
const doc = readFileSync(file, 'utf8');
const i = doc.indexOf(start);
const j = doc.indexOf(end);
if (i < 0 || j < i) throw new Error('Segnaposto della tabella non trovati');
writeFileSync(
  file,
  `${doc.slice(0, i + start.length)}\n\n${renderRulesTable()}\n\n${doc.slice(j)}`,
);
console.log(`Aggiornato ${file}`);
