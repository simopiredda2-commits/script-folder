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
import { currentMark } from '../mark';
import { scriptColors } from '../tokens';

const pkg = join(import.meta.dirname, '..');
const outDir = join(pkg, 'assets', 'proposte-logo');
const boardDir = join(outDir, 'tavole');

/** Un segno: tracciati con linea continua, spessore costante, estremi arrotondati. */
export interface MarkDesign {
  id: string;
  title: string;
  idea: string;
  viewBox: number;
  stroke: number;
  /** Ogni elemento è un attributo `d` di <path>. */
  paths: string[];
}

/** Il segno di oggi, identico all'originale (viewBox 30). */
const current: MarkDesign = {
  id: 'segno-attuale',
  title: 'Segno di oggi',
  idea: 'Il tratto di ECG dei prototipi, accanto al nome.',
  viewBox: 30,
  stroke: currentMark.strokeWidth,
  paths: [`M${currentMark.points.split(' ').join(' L')}`],
};

/**
 * Proposte su griglia 32×32, spessore 3 (lo stesso rapporto del segno di oggi: 2,8 su 30).
 * Il ritmo del battito resta piatto–su–giù–piatto, con le proporzioni del tratto originale:
 * salita breve, discesa lunga, risalita breve.
 */
export const proposals: MarkDesign[] = [
  {
    id: 'proposta-a',
    title: 'A · Battito sulla cartella',
    idea: 'La sagoma della cartella con la linguetta; il battito la attraversa da un lato all’altro.',
    viewBox: 32,
    stroke: 3,
    paths: [
      'M5 26.5 V8 H12 L14.5 10.5 H27 V26.5 Z',
      'M5 18.5 H10 L12.5 13.5 L15.5 23.5 L17.5 18.5 H27',
    ],
  },
  {
    id: 'proposta-b',
    title: 'B · Linguetta a picco',
    idea: 'Una sola linea chiusa: la linguetta della cartella è il picco del battito.',
    viewBox: 32,
    stroke: 3,
    paths: ['M5 27 V13 H10 L12.5 5 L16 20 L18.5 13 H27 V27 Z'],
  },
  {
    id: 'proposta-c',
    title: 'C · Tratto che diventa cartella',
    idea: 'Il battito entra da sinistra come nel segno di oggi e prosegue disegnando la cartella.',
    viewBox: 32,
    stroke: 3,
    paths: ['M2.5 13 H8 L10.5 5.5 L14 20 L16.5 13 H28.5 V27 H6.5 V17.5'],
  },
];

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
const currentLight: Palette = { ...light, mark: currentMark.color };
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

/** Segno con il nome: il segno alto quanto la riga, il nome alto due terzi del segno. */
function lockup(m: MarkDesign, p: Palette, height: number, background = false) {
  const markSize = height;
  const cap = height * 0.5;
  const gap = height * 0.28;
  const baseline = height / 2 + cap / 2;
  const name = nameGroup(p.name, markSize + gap, baseline, cap);
  const width = markSize + gap + name.width;
  return {
    width,
    svg: svgDoc(
      width,
      height,
      markGroup(m, p.mark, 0, 0, markSize) + name.svg,
      background ? p.background : undefined,
    ),
    body: markGroup(m, p.mark, 0, 0, markSize) + name.svg,
  };
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

console.log(`Scritti ${written.length} file:\n${written.join('\n')}`);
