import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { PRODUCT_NAME } from '../brand';

/** Radice del repository. */
export const repoRoot = join(import.meta.dirname, '..', '..', '..');

/** Cartelle di codice in cui il nome del prodotto non deve comparire. */
export const guardedRoots = ['apps', 'packages', 'sync', 'fixtures', 'scripts'];

/** Unica eccezione: il pacchetto del marchio. */
export const allowedPrefix = ['packages', 'brand', ''].join(sep);

const skippedDirs = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.vite',
  '__pycache__',
  'test-results',
  'playwright-report',
]);

export interface Occurrence {
  file: string;
  line: number;
  text: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Il nome del prodotto in qualsiasi combinazione di maiuscole e minuscole. */
export const namePattern = new RegExp(escapeRegExp(PRODUCT_NAME), 'i');

/**
 * Cerca il nome del prodotto nei percorsi e nel contenuto dei file di testo sotto `roots`,
 * saltando `allowed` (percorso relativo alla radice).
 */
export function findNameOccurrences(
  root: string = repoRoot,
  roots: string[] = guardedRoots,
  allowed: string | null = allowedPrefix,
): Occurrence[] {
  const found: Occurrence[] = [];
  const visit = (abs: string) => {
    const rel = relative(root, abs);
    if (allowed && (rel + sep).startsWith(allowed)) return;
    const st = statSync(abs);
    if (st.isDirectory()) {
      if (skippedDirs.has(abs.split(sep).pop()!)) return;
      for (const entry of readdirSync(abs)) visit(join(abs, entry));
      return;
    }
    if (namePattern.test(rel)) found.push({ file: rel, line: 0, text: '(nel percorso)' });
    const buf = readFileSync(abs);
    if (buf.includes(0)) return; // file binario
    buf
      .toString('utf8')
      .split('\n')
      .forEach((text, i) => {
        if (namePattern.test(text)) found.push({ file: rel, line: i + 1, text: text.trim() });
      });
  };
  for (const r of roots) {
    const abs = join(root, r);
    try {
      statSync(abs);
    } catch {
      continue;
    }
    visit(abs);
  }
  return found;
}
