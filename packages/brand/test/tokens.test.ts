import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { contrastRatio, renderTokensCss, scriptColors, uiColors } from '../tokens';

const pkg = join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(pkg, p), 'utf8');

describe('token di marchio', () => {
  it('tokens.css è allineato a tokens.ts', () => {
    expect(read('tokens.css')).toBe(renderTokensCss());
  });

  it('i colori di SCRIPT sono quelli dei file ufficiali, su fondo chiaro e scuro', () => {
    const light = read('assets/script/script_logo_orizzontale.svg').toUpperCase();
    const dark = read('assets/script/script_logo_orizzontale_su_scuro.svg').toUpperCase();
    for (const c of Object.values(scriptColors.light)) expect(light).toContain(c);
    for (const c of Object.values(scriptColors.dark)) expect(dark).toContain(c);
  });

  it('il calcolo del contrasto dà i valori noti di WCAG', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
  });
});

describe('contrasti WCAG 2.2 AA dell’interfaccia', () => {
  const text: [string, string, string][] = [
    ['text', 'surface', 'testo su scheda'],
    ['text', 'background', 'testo su pagina'],
    ['text', 'surfaceMuted', 'testo su evidenza'],
    ['textMuted', 'surface', 'testo secondario su scheda'],
    ['textMuted', 'background', 'testo secondario su pagina'],
    ['primary', 'surface', 'collegamento su scheda'],
    ['primary', 'background', 'collegamento su pagina'],
    ['onPrimary', 'primary', 'testo del pulsante principale'],
    ['danger', 'dangerSurface', 'errore'],
    ['danger', 'surface', 'errore su scheda'],
    ['warning', 'warningSurface', 'avviso'],
    ['success', 'successSurface', 'esito positivo'],
    ['info', 'infoSurface', 'informazione'],
    ['onMark', 'mark', 'testo sull’evidenziatore'],
    ['textMuted', 'mark', 'testo secondario sull’evidenziatore'],
    ['warning', 'surface', 'avviso su scheda'],
  ];
  it.each(text)('%s su %s (%s) ≥ 4,5:1', (fg, bg) => {
    const ratio = contrastRatio(
      uiColors[fg as keyof typeof uiColors],
      uiColors[bg as keyof typeof uiColors],
    );
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  const graphics: [string, string, string][] = [
    ['border', 'surface', 'bordo dei campi'],
    ['border', 'background', 'bordo su pagina'],
    ['focus', 'surface', 'anello di messa a fuoco'],
    ['focus', 'background', 'anello di messa a fuoco su pagina'],
    ['chartSeries1', 'surface', 'prima serie dei grafici'],
    ['chartSeries2', 'surface', 'seconda serie dei grafici'],
  ];
  it.each(graphics)('%s su %s (%s) ≥ 3:1', (fg, bg) => {
    const ratio = contrastRatio(
      uiColors[fg as keyof typeof uiColors],
      uiColors[bg as keyof typeof uiColors],
    );
    expect(ratio).toBeGreaterThanOrEqual(3);
  });
});

describe('caratteri', () => {
  it('fonts.css importa solo i pacchetti @fontsource, nessun indirizzo esterno', () => {
    const css = read('fonts.css');
    expect(css).not.toMatch(/https?:\/\//);
    const imports = [...css.matchAll(/@import\s+'([^']+)'/g)].map((m) => m[1]!);
    expect(imports.length).toBeGreaterThan(0);
    for (const i of imports) {
      expect(i).toMatch(
        /^@fontsource\/(special-gothic-expanded-one|ibm-plex-sans|ibm-plex-mono)\//,
      );
    }
  });

  it('i CSS di @fontsource puntano a file locali del pacchetto', () => {
    const css = read('fonts.css');
    for (const m of css.matchAll(/@import\s+'([^']+)'/g)) {
      const file = readFileSync(join(pkg, 'node_modules', m[1]!), 'utf8');
      const urls = [...file.matchAll(/url\(([^)]+)\)/g)].map((u) => u[1]!);
      expect(urls.length).toBeGreaterThan(0);
      for (const u of urls) expect(u).toMatch(/^\.\/files\//);
    }
  });
});
