import { describe, expect, it } from 'vitest';
import { findNameOccurrences } from './nome-prodotto';

describe('nome del prodotto', () => {
  it('compare solo in packages/brand: mai in apps/, packages/, sync/, fixtures/, scripts/', () => {
    const found = findNameOccurrences();
    const report = found.map((o) => `${o.file}:${o.line}  ${o.text}`).join('\n');
    expect(found, `Nome del prodotto fuori da packages/brand:\n${report}`).toEqual([]);
  });

  it('la ricerca funziona: senza eccezione trova il nome in packages/brand/brand.ts', () => {
    const found = findNameOccurrences(undefined, ['packages/brand'], null);
    expect(found.some((o) => o.file.endsWith('brand.ts') && o.line > 0)).toBe(true);
  });
});
