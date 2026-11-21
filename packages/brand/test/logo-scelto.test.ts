import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRODUCT_NAME } from '../brand';
import { CHOSEN_PROPOSAL_ID, proposals } from '../logo-proposals';
import { markInk, productMark } from '../mark';
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

  it('il segno poggia sul bordo in basso del suo tratto (D242)', () => {
    // I vertici più bassi sono a 27, il tratto è spesso 3: il bordo è a 28,5 su 32.
    expect(markInk(productMark.paths, productMark.strokeWidth)).toEqual({
      left: 3.5,
      right: 28.5,
      top: 3.5,
      bottom: 28.5,
    });
    expect(productMark.base).toBe(28.5);
    expect(productMark.size).toBe(32);
  });

  it('nel logo con il nome il segno poggia sulla base del nome, come nell’interfaccia (D242)', () => {
    const svg = read('con-nome.svg');
    const [ty, s] = /<g transform="translate\([-\d.]+ ([-\d.]+)\) scale\(([\d.]+)\)">/
      .exec(svg)!
      .slice(1)
      .map(Number) as [number, number];
    // Il nome comincia con la «F»: il suo primo punto è in basso a sinistra, sulla base.
    const baseline = Number(/<\/g><path d="M[\d.]+ ([\d.]+)/.exec(svg)![1]);
    expect(ty + productMark.base * s).toBeCloseTo(baseline, 2);
    // Il nome resta dentro il riquadro: gli occhielli scendono appena sotto la base.
    const height = Number(/viewBox="0 0 [\d.]+ ([\d.]+)"/.exec(svg)![1]);
    expect(baseline).toBeLessThan(height - 2);
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

  it('nell’icona il segno è centrato di lato e alzato al centro ottico (D214)', () => {
    const svg = read('segno-su-scuro.svg');
    const size = Number(/<rect [^>]*width="([\d.]+)"/.exec(svg)![1]);
    const [tx, ty, s] = /<g transform="translate\(([-\d.]+) ([-\d.]+)\) scale\(([\d.]+)\)">/
      .exec(svg)!
      .slice(1)
      .map(Number) as [number, number, number];
    // Ingombro del tratto nelle coordinate del segno: i vertici più mezzo spessore (giunzioni tonde).
    const xs: number[] = [];
    const ys: number[] = [];
    for (const d of productMark.paths) {
      let x = 0;
      let y = 0;
      for (const [, cmd, args] of d.matchAll(/([MLHVZ])([^MLHVZ]*)/g)) {
        const n = args!
          .trim()
          .split(/[\s,]+/)
          .filter(Boolean)
          .map(Number);
        if (cmd === 'M' || cmd === 'L') [x, y] = n as [number, number];
        else if (cmd === 'H') x = n[0]!;
        else if (cmd === 'V') y = n[0]!;
        xs.push(x);
        ys.push(y);
      }
    }
    const half = productMark.strokeWidth / 2;
    const left = tx + (Math.min(...xs) - half) * s;
    const right = size - (tx + (Math.max(...xs) + half) * s);
    const top = ty + (Math.min(...ys) - half) * s;
    const bottom = size - (ty + (Math.max(...ys) + half) * s);
    expect(Math.abs(left - right)).toBeLessThan(0.01);
    // Alzato di `raise`: sotto resta più spazio che sopra, proprio del doppio dello spostamento.
    expect(productMark.onDark.raise).toBeGreaterThan(0);
    expect(bottom - top).toBeCloseTo((2 * productMark.onDark.raise * size) / 32, 2);
    // La punta non si avvicina al bordo: sopra resta almeno tre quarti del margine di lato.
    expect(top).toBeGreaterThanOrEqual(0.75 * left);
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
