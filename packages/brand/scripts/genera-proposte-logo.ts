/**
 * Genera le proposte di logo in assets/proposte-logo/ e le tavole di confronto per docs/logo.md.
 *
 *   pnpm --filter @mmg/brand logo:proposte
 *
 * Il nome del prodotto viene da brand.ts e diventa tracciati (opentype.js sul file WOFF di
 * @fontsource/special-gothic-expanded-one): negli SVG non c'è testo. Il simbolo di SCRIPT non
 * entra in nessuna proposta.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import opentype from 'opentype.js';
import { PRODUCT_NAME } from '../brand';
import {
  chosenMarkDesign,
  previousMarkDesign as current,
  proposals,
  type MarkDesign,
} from '../logo-proposals';
import { productMark } from '../mark';
import { previousMark } from '../mark-previous';
import { scriptColors } from '../tokens';

const pkg = join(import.meta.dirname, '..');
const outDir = join(pkg, 'assets', 'proposte-logo');
const boardDir = join(outDir, 'tavole');

interface Palette {
  background: string;
  mark: string;
  name: string;
}

/** Colori: la tavolozza di SCRIPT (decisione D13 in docs/decisioni.md). */
const light: Palette = {
  background: '#FFFFFF',
  mark: scriptColors.light.luce,
  name: scriptColors.light.testo,
};
const dark: Palette = {
  background: scriptColors.light.testo,
  mark: scriptColors.dark.luce,
  name: scriptColors.dark.testo,
};
/** Il segno di oggi resta nel suo blu dei prototipi, per il confronto. */
const currentLight: Palette = { ...light, mark: previousMark.color };
const currentDark: Palette = { ...dark, mark: '#8FA0FF' };

const require = createRequire(import.meta.url);
const fontFile =
  require.resolve('@fontsource/special-gothic-expanded-one/files/special-gothic-expanded-one-latin-400-normal.woff');
const fontBuffer = readFileSync(fontFile);
const font = opentype.parse(
  fontBuffer.buffer.slice(fontBuffer.byteOffset, fontBuffer.byteOffset + fontBuffer.byteLength),
);
if (!font.tables.os2) throw new Error('Tabella OS/2 mancante nel carattere');
const capHeight = font.tables.os2.sCapHeight / font.unitsPerEm;

const fmt = (n: number) => Number(n.toFixed(2)).toString();

/** Il segno come gruppo SVG, scalato in un quadrato di lato `size` in (x, y). */
function markGroup(m: MarkDesign, color: string, x: number, y: number, size: number): string {
  const s = size / m.viewBox;
  const paths = m.paths
    .map(
      (d) =>
        `<path d="${d}" fill="none" stroke="${color}" stroke-width="${m.stroke}" stroke-linecap="round" stroke-linejoin="round"/>`,
    )
    .join('');
  return `<g transform="translate(${fmt(x)} ${fmt(y)}) scale(${fmt(s)})">${paths}</g>`;
}

/**
 * Il segno su fondo scuro (D214): icona gialla di lato `size` in (x, y), con il segno blu scuro
 * al centro. Il giallo è un fondo pieno, senza bordo né sfumature.
 */
function tileGroup(m: MarkDesign, x: number, y: number, size: number): string {
  const { tile, color, radius, scale } = productMark.onDark;
  const inner = size * scale;
  const offset = (size - inner) / 2;
  const rx = (radius * size) / m.viewBox;
  return (
    `<rect x="${fmt(x)}" y="${fmt(y)}" width="${fmt(size)}" height="${fmt(size)}" rx="${fmt(rx)}" fill="${tile}"/>` +
    markGroup(m, color, x + offset, y + offset, inner)
  );
}

/** Il nome del prodotto in tracciati, con altezza delle maiuscole `cap`, base in (x, baseline). */
function nameGroup(color: string, x: number, baseline: number, cap: number) {
  const fontSize = cap / capHeight;
  const path = font.getPath(PRODUCT_NAME, x, baseline, fontSize);
  const width = font.getAdvanceWidth(PRODUCT_NAME, fontSize);
  return { svg: `<path d="${path.toPathData(2)}" fill="${color}"/>`, width };
}

function svgDoc(width: number, height: number, body: string, background?: string): string {
  const bg = background ? `<rect width="100%" height="100%" fill="${background}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${fmt(width)}" height="${fmt(height)}" viewBox="0 0 ${fmt(width)} ${fmt(height)}">${bg}${body}</svg>\n`;
}

/**
 * Segno con il nome: il segno alto quanto la riga, il nome alto due terzi del segno. Con `tile`
 * il segno è l'icona gialla dei fondi scuri (D214).
 */
function lockup(m: MarkDesign, p: Palette, height: number, background = false, tile = false) {
  const markSize = height;
  const cap = height * 0.5;
  const gap = height * 0.28;
  const baseline = height / 2 + cap / 2;
  const name = nameGroup(p.name, markSize + gap, baseline, cap);
  const width = markSize + gap + name.width;
  const mark = tile ? tileGroup(m, 0, 0, markSize) : markGroup(m, p.mark, 0, 0, markSize);
  return {
    width,
    svg: svgDoc(width, height, mark + name.svg, background ? p.background : undefined),
    body: mark + name.svg,
  };
}

/** Tavola del logo scelto su fondo scuro (D214): l'icona a 16, 32 e 64 px e con il nome. */
function tileBoard(m: MarkDesign): string {
  const pad = 24;
  const parts: string[] = [];
  let x = pad;
  for (const size of [16, 32, 64]) {
    parts.push(tileGroup(m, x, pad + (64 - size) / 2, size));
    x += size + 32;
  }
  x += 16;
  const l = lockup(m, dark, 48, false, true);
  parts.push(`<g transform="translate(${fmt(x)} ${fmt(pad + 8)})">${l.body}</g>`);
  return svgDoc(x + l.width + pad, 64 + pad * 2, parts.join(''), dark.background);
}

/** Tavola: il segno a 16, 32 e 64 px e il segno con il nome, su un fondo. */
function board(m: MarkDesign, p: Palette): string {
  const pad = 24;
  const parts: string[] = [];
  let x = pad;
  for (const size of [16, 32, 64]) {
    parts.push(markGroup(m, p.mark, x, pad + (64 - size) / 2, size));
    x += size + 32;
  }
  x += 16;
  const l = lockup(m, p, 48);
  parts.push(`<g transform="translate(${fmt(x)} ${fmt(pad + 8)})">${l.body}</g>`);
  const width = x + l.width + pad;
  return svgDoc(width, 64 + pad * 2, parts.join(''), p.background);
}

/** Confronto di tutte le proposte alla stessa misura, su fondo chiaro e scuro. */
function comparison(size: number): string {
  const all = [current, ...proposals];
  const cell = Math.max(size + 32, 72);
  const width = cell * all.length;
  const rows = [light, dark].map((p, row) => {
    const y = row * cell;
    const bg = `<rect x="0" y="${y}" width="${width}" height="${cell}" fill="${p.background}"/>`;
    const marks = all
      .map((m, i) =>
        markGroup(
          m,
          m === current ? (row === 0 ? currentLight.mark : currentDark.mark) : p.mark,
          i * cell + (cell - size) / 2,
          y + (cell - size) / 2,
          size,
        ),
      )
      .join('');
    return bg + marks;
  });
  return svgDoc(width, cell * 2, rows.join(''));
}

mkdirSync(boardDir, { recursive: true });
const written: string[] = [];
const write = (dir: string, file: string, text: string) => {
  writeFileSync(join(dir, file), text);
  written.push(join(dir, file).slice(pkg.length + 1));
};

for (const m of proposals) {
  const view = m.viewBox;
  write(outDir, `${m.id}-segno.svg`, svgDoc(view, view, markGroup(m, light.mark, 0, 0, view)));
  write(
    outDir,
    `${m.id}-segno-su-scuro.svg`,
    svgDoc(view, view, markGroup(m, dark.mark, 0, 0, view)),
  );
  write(outDir, `${m.id}-con-nome.svg`, lockup(m, light, 64).svg);
  write(outDir, `${m.id}-con-nome-su-scuro.svg`, lockup(m, dark, 64).svg);
  write(boardDir, `${m.id}-chiaro.svg`, board(m, light));
  write(boardDir, `${m.id}-scuro.svg`, board(m, dark));
}
write(boardDir, `${current.id}-chiaro.svg`, board(current, currentLight));
write(boardDir, `${current.id}-scuro.svg`, board(current, currentDark));
write(boardDir, 'confronto-16.svg', comparison(16));
write(boardDir, 'confronto-32.svg', comparison(32));

// Logo scelto (D33): file definitivi in assets/logo/ e favicon dell'interfaccia. Su fondo scuro
// l'icona gialla con il segno blu scuro (D214).
const logoDir = join(pkg, 'assets', 'logo');
mkdirSync(logoDir, { recursive: true });
const chosen = chosenMarkDesign;
const view = chosen.viewBox;
write(logoDir, 'segno.svg', svgDoc(view, view, markGroup(chosen, light.mark, 0, 0, view)));
write(logoDir, 'segno-su-scuro.svg', svgDoc(view, view, tileGroup(chosen, 0, 0, view)));
write(logoDir, 'con-nome.svg', lockup(chosen, light, 64).svg);
write(logoDir, 'con-nome-su-scuro.svg', lockup(chosen, dark, 64, false, true).svg);
write(logoDir, 'tavola-su-scuro.svg', tileBoard(chosen));
// Nelle schede del browser con il tema scuro, la favicon diventa l'icona gialla.
const favicon = svgDoc(
  view,
  view,
  '<style>.su-scuro{display:none}@media (prefers-color-scheme: dark){.su-chiaro{display:none}.su-scuro{display:inline}}</style>' +
    `<g class="su-chiaro">${markGroup(chosen, light.mark, 0, 0, view)}</g>` +
    `<g class="su-scuro">${tileGroup(chosen, 0, 0, view)}</g>`,
);
write(logoDir, 'favicon.svg', favicon);
const webPublic = join(pkg, '..', '..', 'apps', 'web', 'public');
mkdirSync(webPublic, { recursive: true });
writeFileSync(join(webPublic, 'favicon.svg'), favicon);
written.push('../../apps/web/public/favicon.svg');

console.log(`Scritti ${written.length} file:\n${written.join('\n')}`);
