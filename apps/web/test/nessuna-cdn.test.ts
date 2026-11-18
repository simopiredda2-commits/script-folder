// @vitest-environment node
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PRODUCT_FULL_NAME } from '@mmg/brand';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** Host di CDN e servizi di caratteri che non devono mai comparire nell'interfaccia compilata. */
const cdnHosts =
  /fonts\.googleapis|fonts\.gstatic|jsdelivr|unpkg\.com|cdnjs|cloudflare|bootstrapcdn|typekit|fontawesome/i;

const listFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listFiles(join(dir, e.name)) : [join(dir, e.name)],
  );

describe('interfaccia compilata', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'mmg-web-'));
  let files: string[] = [];

  beforeAll(async () => {
    await build({
      root: join(import.meta.dirname, '..'),
      logLevel: 'silent',
      build: { outDir, emptyOutDir: true },
    });
    files = listFiles(outDir);
  }, 60_000);
  afterAll(() => rmSync(outDir, { recursive: true, force: true }));

  it('HTML e CSS non caricano nulla da indirizzi esterni', () => {
    for (const f of files.filter((f) => /\.(html|css)$/.test(f))) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/(src|href)\s*=\s*["']?\s*(https?:)?\/\//i);
      expect(text, f).not.toMatch(/url\(\s*["']?\s*(https?:)?\/\//i);
      expect(text, f).not.toMatch(/@import\s+(url\()?\s*["']?\s*(https?:)?\/\//i);
    }
  });

  it('nessun file nomina una CDN o un servizio di caratteri esterno', () => {
    for (const f of files.filter((f) => /\.(html|css|js)$/.test(f))) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(cdnHosts);
    }
  });

  it('i caratteri di SCRIPT sono tra le risorse servite dal nostro dominio', () => {
    const fonts = files.filter((f) => f.endsWith('.woff2')).map((f) => f.split('/').pop()!);
    for (const family of ['special-gothic-expanded-one', 'ibm-plex-sans', 'ibm-plex-mono']) {
      expect(
        fonts.some((f) => f.startsWith(family)),
        family,
      ).toBe(true);
    }
  });

  it('il titolo della pagina è preso da packages/brand', () => {
    const html = readFileSync(join(outDir, 'index.html'), 'utf8');
    expect(html).toContain(`<title>${PRODUCT_FULL_NAME}</title>`);
  });
});
