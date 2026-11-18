import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './nome-prodotto';

/**
 * Regola 2 (sviluppo indipendente) e registro `docs/provenienze.md`: ogni immagine, documento o
 * archivio nel repository ha una provenienza dichiarata e controllata qui. Una schermata o un
 * manuale di un altro programma non può entrare senza che questa prova diventi rossa. Come la
 * regola 6, è un controllo su tutto il repository.
 */
const MEDIA =
  /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif|ico|svg|pdf|docx?|xlsx?|pptx?|od[tsp]|rtf|zip|7z|rar|tar|gz|tgz|mp4|mov|webm|mp3|wav)$/i;

const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf-8');

/** File del repository: quelli tracciati e quelli nuovi non ignorati. */
function repositoryFiles(): string[] {
  const out = execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  return [...new Set(out.split('\0').filter(Boolean))];
}

/** Le schermate che fotografa il nostro programma, con pazienti inventati. */
function screenshotNames(): Set<string> {
  const src = read('apps/api/test/e2e/schermate.ts');
  return new Set([...src.matchAll(/'(\d{2}-[a-z0-9-]+)'/g)].map((m) => `${m[1]}.png`));
}

/** I file del sito d'esempio che `fixtures/banche-dati/genera.py` scrive, con dati inventati. */
function exampleFiles(): Set<string> {
  const src = read('fixtures/banche-dati/genera.py');
  return new Set([...src.matchAll(/"([^"/]+\.(?:pdf|xlsx))"/g)].map((m) => m[1]!));
}

/** Da dove viene un file; `null` se non ha una provenienza dichiarata. */
function originOf(path: string, shots: Set<string>, examples: Set<string>): string | null {
  if (path.startsWith('docs/schermate/') && shots.has(path.slice('docs/schermate/'.length)))
    return 'schermata del nostro programma (apps/api/test/e2e/schermate.ts)';
  if (path.startsWith('fixtures/banche-dati/sito/') && examples.has(basename(path)))
    return 'file inventato (fixtures/banche-dati/genera.py)';
  if (path.startsWith('packages/brand/assets/') && path.endsWith('.svg'))
    return 'marchi (packages/brand: SHA256SUMS o genera-proposte-logo.ts)';
  if (path === 'apps/web/public/favicon.svg')
    return 'segno del logo (packages/brand/scripts/genera-proposte-logo.ts)';
  return null;
}

/** Licenze ammesse per le dipendenze di produzione: solo permissive (e OFL per i caratteri). */
const ALLOWED_LICENSES = new Set([
  'MIT',
  'ISC',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  '0BSD',
  'Zlib',
  'OFL-1.1',
]);

/** Una licenza SPDX, anche composta («(MIT AND Zlib)»): ogni parte dev'essere ammessa. */
function licenseAllowed(expression: string): boolean {
  const parts = expression
    .replace(/[()]/g, ' ')
    .split(/\s+(?:AND|OR)\s+|\s+/)
    .filter(Boolean);
  return parts.length > 0 && parts.every((p) => ALLOWED_LICENSES.has(p));
}

describe('provenienza dei file (regola 2)', () => {
  it('immagini, documenti e archivi: solo con una provenienza dichiarata', () => {
    const shots = screenshotNames();
    const examples = exampleFiles();
    const media = repositoryFiles().filter((f) => MEDIA.test(f));
    const unknown = media.filter((f) => !originOf(f, shots, examples));
    expect(
      unknown,
      `File senza provenienza dichiarata (vedi docs/provenienze.md):\n${unknown.join('\n')}`,
    ).toEqual([]);
    // La ricerca funziona: trova le schermate e i file d'esempio che ci sono.
    expect(media.some((f) => f.startsWith('docs/schermate/'))).toBe(true);
    expect(media.some((f) => f.startsWith('fixtures/banche-dati/sito/'))).toBe(true);
  });

  it('il controllo funziona: una schermata o un manuale estranei sono rifiutati', () => {
    const shots = screenshotNames();
    const examples = exampleFiles();
    expect(originOf('docs/schermate/02-oggi.png', shots, examples)).not.toBeNull();
    expect(originOf('docs/schermate/schermata-di-un-altro-programma.png', shots, examples)).toBe(
      null,
    );
    expect(originOf('docs/manuale.pdf', shots, examples)).toBeNull();
    expect(originOf('fixtures/banche-dati/sito/manuale.pdf', shots, examples)).toBeNull();
    expect(originOf('apps/web/public/immagine.png', shots, examples)).toBeNull();
  });

  it('dipendenze di produzione: solo licenze permissive', { timeout: 120_000 }, () => {
    const out = execFileSync('pnpm', ['licenses', 'list', '--prod', '--json'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const byLicense = JSON.parse(out) as Record<string, { name: string }[]>;
    const refused = Object.entries(byLicense)
      .filter(([license]) => !licenseAllowed(license))
      .map(([license, list]) => `${license}: ${list.map((p) => p.name).join(', ')}`);
    expect(refused, 'Dipendenze con una licenza non ammessa').toEqual([]);
    expect(Object.keys(byLicense).length).toBeGreaterThan(0);
    expect(licenseAllowed('(MIT AND Zlib)')).toBe(true);
    expect(licenseAllowed('GPL-3.0-only')).toBe(false);
    expect(licenseAllowed('(MIT OR GPL-3.0-only)')).toBe(false);
  });
});
