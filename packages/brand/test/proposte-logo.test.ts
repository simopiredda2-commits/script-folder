import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRODUCT_NAME } from '../brand';
import { currentMark } from '../mark';
import { scriptColors } from '../tokens';

const dir = join(import.meta.dirname, '..', 'assets', 'proposte-logo');
const files = readdirSync(dir).filter((f) => f.endsWith('.svg'));
const boards = readdirSync(join(dir, 'tavole')).filter((f) => f.endsWith('.svg'));
const all = [
  ...files.map((f) => [f, readFileSync(join(dir, f), 'utf8')] as const),
  ...boards.map((f) => [`tavole/${f}`, readFileSync(join(dir, 'tavole', f), 'utf8')] as const),
];

/** Colori ammessi: tavolozza di SCRIPT, blu dei prototipi, bianco del fondo. */
const allowed = new Set(
  [
    ...Object.values(scriptColors.light),
    ...Object.values(scriptColors.dark),
    currentMark.color,
    '#FFFFFF',
  ].map((c) => c.toUpperCase()),
);

describe('proposte di logo', () => {
  it('ci sono il segno di oggi e almeno due proposte, chiaro e scuro, con e senza nome', () => {
    expect(files).toContain('segno-attuale.svg');
    const ids = new Set(files.filter((f) => f.startsWith('proposta-')).map((f) => f.slice(0, 10)));
    expect(ids.size).toBeGreaterThanOrEqual(2);
    for (const id of ids) {
      for (const suffix of ['segno', 'segno-su-scuro', 'con-nome', 'con-nome-su-scuro']) {
        expect(files).toContain(`${id}-${suffix}.svg`);
      }
    }
  });

  it.each(all)('%s: marchio piatto, senza testo, sfumature o filtri', (_, svg) => {
    expect(svg).not.toMatch(/<text|<tspan|font-family/i);
    expect(svg).not.toMatch(/Gradient|<filter|opacity|<image|href=/i);
    expect(svg.toLowerCase()).not.toContain(PRODUCT_NAME.toLowerCase());
  });

  it.each(all)('%s: solo colori ammessi', (_, svg) => {
    const colors = [...svg.matchAll(/#[0-9a-f]{6}\b/gi)].map((m) => m[0].toUpperCase());
    for (const c of colors) expect(allowed, c).toContain(c);
  });

  it.each(all)('%s: tratti con estremi e giunzioni arrotondati', (_, svg) => {
    const strokes = [...svg.matchAll(/<(?:path|polyline)[^>]*stroke="#[^"]+"[^>]*>/g)].map(
      (m) => m[0],
    );
    for (const s of strokes) {
      expect(s).toContain('stroke-linecap="round"');
      expect(s).toContain('stroke-linejoin="round"');
    }
  });

  it.each(all)('%s: il simbolo di SCRIPT non entra nel logo', (_, svg) => {
    // Il simbolo di SCRIPT è fatto di poligoni; le proposte solo di tratti e del nome.
    expect(svg).not.toMatch(/<polygon/);
  });

  it('il segno di oggi è identico all’originale', () => {
    const svg = readFileSync(join(dir, 'segno-attuale.svg'), 'utf8');
    expect(svg).toContain(`points="${currentMark.points}"`);
    expect(svg).toContain(`stroke="${currentMark.color}"`);
    expect(svg).toContain(`stroke-width="${currentMark.strokeWidth}"`);
  });
});
