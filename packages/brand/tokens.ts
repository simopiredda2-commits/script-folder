/**
 * Token di marchio e di interfaccia.
 *
 * Fonte unica: da qui si genera tokens.css (`pnpm --filter @mmg/brand tokens:css`) e un test
 * controlla che il file generato sia allineato.
 */

/**
 * Colori ufficiali di SCRIPT. Valori letti dai file del marchio in assets/script/:
 * su fondo chiaro luce, ombra e testo; su fondo scuro le loro controparti.
 */
export const scriptColors = {
  light: { luce: '#4D6BFE', ombra: '#1B237A', testo: '#0E1435' },
  dark: { luce: '#8FA0FF', ombra: '#3B4DE0', testo: '#FFFFFF' },
} as const;

/**
 * Colori dell'interfaccia, solo tema chiaro (decisione D11 in docs/decisioni.md).
 * I colori di marchio vengono da SCRIPT; neutri e stati sono scelti per il contrasto
 * WCAG 2.2 AA, verificato da un test (testo ≥ 4,5:1, elementi grafici ≥ 3:1).
 */
export const uiColors = {
  /** Fondo della pagina. */
  background: '#F5F6FA',
  /** Fondo di schede, pannelli e campi. */
  surface: '#FFFFFF',
  /** Fondo leggero per righe alternate ed evidenze. */
  surfaceMuted: '#ECEEF5',
  /** Testo principale. */
  text: scriptColors.light.testo,
  /** Testo secondario. */
  textMuted: '#4A5070',
  /** Bordi di campi e controlli (elemento grafico: ≥ 3:1). */
  border: '#7A809C',
  /** Separatori decorativi, non portano informazione. */
  divider: '#D5D8E5',
  /** Azione principale: fondo dei pulsanti primari e testo dei collegamenti. */
  primary: scriptColors.light.ombra,
  /** Testo sopra il colore principale. */
  onPrimary: '#FFFFFF',
  /** Accento di marchio per elementi grafici (non per il testo). */
  accent: scriptColors.light.luce,
  /** Anello di messa a fuoco. */
  focus: scriptColors.light.luce,
  /**
   * Evidenziatore giallo dei prototipi, ripreso su richiesta di Simone (D69): solo come sfondo
   * (contatori, cartella attiva, selezioni), sempre con onMark per il testo. Mai per il testo né
   * per gli avvisi: il giallo vuol dire «in evidenza», non «attenzione».
   */
  mark: '#FFE45C',
  onMark: scriptColors.light.testo,
  /** Stati: sempre accompagnati da una parola, mai solo colore. */
  danger: '#A4161A',
  dangerSurface: '#FCE9EA',
  /** Attenzione: arancio bruciato, per non confondersi con l'evidenziatore giallo (D69). */
  warning: '#8A3B00',
  warningSurface: '#FFE9D6',
  success: '#17663A',
  successSurface: '#E5F4EA',
  info: scriptColors.light.ombra,
  infoSurface: '#E8ECFF',
  /**
   * Serie dei grafici (andamento dei parametri, tappa 9): la prima è la luce di SCRIPT, la
   * seconda un magenta. Validate con il controllo dei colori dei grafici: contrasto ≥ 3:1 sulla
   * scheda, distinte anche per chi confonde i colori; mai colori di stato.
   */
  chartSeries1: scriptColors.light.luce,
  chartSeries2: '#D55181',
  /**
   * Farmaci nella cartella (D152): lo sfondo della riga dice come si prende il farmaco, la barra
   * a sinistra lo ripete in colore pieno; sempre con la parola, mai solo colore. Tinte tenui, con
   * il testo scuro sopra; il giallo è più chiaro dell'evidenziatore e non ha mai il bordo scuro
   * delle selezioni.
   * - Cronica: azzurro, la continuità (il blu di SCRIPT è il colore della struttura).
   * - Ciclo con data di fine: verde, un percorso che si chiude.
   * - Al bisogno: giallo, il più leggero, per l'uso saltuario.
   */
  therapyChronicSurface: '#D3E8FA',
  therapyChronicEdge: '#1F6FB2',
  therapyCycleSurface: '#D8EFCC',
  therapyCycleEdge: '#3B7D28',
  therapyAsNeededSurface: '#FFEDA8',
  therapyAsNeededEdge: '#866A00',
  /** Tipologia sulla ricetta, S suggerita o H ricovero: viola, proposta da un altro medico. */
  therapyOrigin: '#5B2C91',
  therapyOriginSurface: '#E8DCFA',
  therapyOriginEdge: '#7445B3',
} as const;

export type UiColor = keyof typeof uiColors;

/** Famiglie di caratteri, dai pacchetti @fontsource serviti dal nostro dominio (fonts.css). */
export const fontFamilies = {
  /** Nome del prodotto e titoli. */
  display: "'Special Gothic Expanded One', 'IBM Plex Sans', system-ui, sans-serif",
  /** Testo. */
  text: "'IBM Plex Sans', system-ui, sans-serif",
  /** Codici ed etichette: codice fiscale, NRE, AIC. */
  mono: "'IBM Plex Mono', ui-monospace, monospace",
} as const;

/** Misure minime dell'interfaccia. */
export const sizes = {
  /** Bersaglio minimo per tocco e clic, in px (richiesta: almeno 44 px). */
  minTarget: 44,
  /** Testo di base, in px: testo grande per i requisiti di leggibilità. */
  baseFont: 17,
  radius: 8,
} as const;

/** Rapporto di contrasto WCAG fra due colori #RRGGBB. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Luminanza relativa secondo WCAG 2.x. */
export function relativeLuminance(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) throw new Error(`Colore non valido: ${hex}`);
  const channel = (h: string) => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [channel(m[1]!), channel(m[2]!), channel(m[3]!)];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Testo del file tokens.css generato dai token. */
export function renderTokensCss(): string {
  const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  const lines: string[] = [
    '/* File generato da tokens.ts con `pnpm --filter @mmg/brand tokens:css`: non modificarlo a mano. */',
    ':root {',
  ];
  for (const [theme, colors] of Object.entries(scriptColors)) {
    for (const [name, value] of Object.entries(colors)) {
      lines.push(`  --script-${theme}-${name}: ${value};`);
    }
  }
  for (const [name, value] of Object.entries(uiColors)) {
    lines.push(`  --color-${kebab(name)}: ${value};`);
  }
  for (const [name, value] of Object.entries(fontFamilies)) {
    lines.push(`  --font-${name}: ${value};`);
  }
  lines.push(`  --size-min-target: ${sizes.minTarget}px;`);
  lines.push(`  --size-base-font: ${sizes.baseFont}px;`);
  lines.push(`  --radius: ${sizes.radius}px;`);
  lines.push('}', '');
  return lines.join('\n');
}
