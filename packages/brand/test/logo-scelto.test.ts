import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRODUCT_NAME } from '../brand';
import { CHOSEN_PROPOSAL_ID, proposals } from '../logo-proposals';
import { productMark } from '../mark';
import { contrastRatio, scriptColors, uiColors } from '../tokens';

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
    // Su fondo scuro: l'icona gialla con il segno blu scuro (D214).
    for (const f of ['segno-su-scuro.svg', 'con-nome-su-scuro.svg', 'tavola-su-scuro.svg']) {
      const svg = read(f);
      for (const d of productMark.paths) expect(svg, f).toContain(`d="${d}"`);
      expect(svg, f).toMatch(new RegExp(`<rect [^>]*rx="[^"]+" fill="${productMark.onDark.tile}"`));
      expect(svg, f).toContain(`stroke="${productMark.onDark.color}"`);
      expect(svg, f).not.toContain(`stroke="${scriptColors.dark.luce}"`);
    }
  });

  it('su fondo scuro l’icona gialla con il segno blu scuro si legge (D214)', () => {
    // Il giallo è l'evidenziatore dell'interfaccia, usato come fondo con il blu scuro sopra (D69).
    expect(productMark.onDark.tile).toBe(uiColors.mark);
    expect(productMark.onDark.color).toBe(scriptColors.light.ombra);
    // Il segno sul giallo e il giallo sul fondo scuro di SCRIPT: ben oltre il 3:1 degli elementi grafici.
    expect(contrastRatio(productMark.onDark.color, productMark.onDark.tile)).toBeGreaterThanOrEqual(
      7,
    );
    expect(contrastRatio(productMark.onDark.tile, scriptColors.light.testo)).toBeGreaterThanOrEqual(
      7,
    );
    expect(productMark.onDark.scale).toBeGreaterThan(0.5);
    expect(productMark.onDark.scale).toBeLessThanOrEqual(0.85);
  });

  it('la favicon passa all’icona gialla quando il browser è in tema scuro (D214)', () => {
    const svg = read('favicon.svg');
    expect(svg).toContain('@media (prefers-color-scheme: dark)');
    expect(svg).toMatch(
      new RegExp(
        `<g class="su-chiaro">[^]*stroke="${productMark.color}"[^]*</g><g class="su-scuro">`,
      ),
    );
    expect(svg).toMatch(
      new RegExp(`<g class="su-scuro"><rect [^>]*fill="${productMark.onDark.tile}"`),
    );
    expect(svg).toContain(`stroke="${productMark.onDark.color}"`);
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
