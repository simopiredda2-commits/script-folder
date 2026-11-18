import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRODUCT_NAME } from '../brand';
import { CHOSEN_PROPOSAL_ID, proposals } from '../logo-proposals';
import { productMark } from '../mark';
import { scriptColors } from '../tokens';

const logoDir = join(import.meta.dirname, '..', 'assets', 'logo');
const read = (f: string) => readFileSync(join(logoDir, f), 'utf8');

describe('logo scelto alla prima fermata', () => {
  it('è la proposta B e il segno del prodotto ne usa la geometria', () => {
    expect(CHOSEN_PROPOSAL_ID).toBe('proposta-b');
    const b = proposals.find((p) => p.id === 'proposta-b')!;
    expect(productMark.paths).toEqual(b.paths);
    expect(productMark.strokeWidth).toBe(b.stroke);
  });

  it('i file in assets/logo/ disegnano proprio quel segno, nei colori di SCRIPT', () => {
    for (const f of ['segno.svg', 'con-nome.svg', 'favicon.svg']) {
      const svg = read(f);
      for (const d of productMark.paths) expect(svg, f).toContain(`d="${d}"`);
      expect(svg, f).toContain(`stroke="${scriptColors.light.luce}"`);
    }
    for (const f of ['segno-su-scuro.svg', 'con-nome-su-scuro.svg']) {
      expect(read(f), f).toContain(`stroke="${scriptColors.dark.luce}"`);
    }
  });

  it('il nome nei file con il nome è in tracciati, non testo', () => {
    for (const f of ['con-nome.svg', 'con-nome-su-scuro.svg']) {
      const svg = read(f);
      expect(svg).not.toMatch(/<text/);
      expect(svg.toLowerCase()).not.toContain(PRODUCT_NAME.toLowerCase());
      expect((svg.match(/<path /g) ?? []).length).toBeGreaterThan(productMark.paths.length);
    }
  });

  it('la favicon dell’interfaccia è quella del logo scelto', () => {
    const web = readFileSync(
      join(import.meta.dirname, '..', '..', '..', 'apps', 'web', 'public', 'favicon.svg'),
      'utf8',
    );
    expect(web).toBe(read('favicon.svg'));
  });
});
