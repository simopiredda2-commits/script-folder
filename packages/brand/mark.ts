import { chosenMarkDesign } from './logo-proposals';
import { scriptColors, uiColors } from './tokens';

export { previousMark } from './mark-previous';

/**
 * Ingombro dell'inchiostro di un segno fatto di segmenti (M, L, H, V, Z), in unità della sua
 * viewBox: i vertici più mezzo spessore. Con estremi e giunzioni tondi è proprio il bordo del
 * tratto, in alto, in basso e ai lati.
 */
export function markInk(paths: readonly string[], stroke: number) {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const d of paths) {
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
  const half = stroke / 2;
  return {
    left: Math.min(...xs) - half,
    right: Math.max(...xs) + half,
    top: Math.min(...ys) - half,
    bottom: Math.max(...ys) + half,
  };
}

/**
 * Segno del prodotto: la proposta B, «linguetta a picco», scelta da Simone alla prima fermata
 * (D33). Linea continua, spessore costante, estremi arrotondati; tavolozza di SCRIPT.
 */
export const productMark = {
  viewBox: `0 0 ${chosenMarkDesign.viewBox} ${chosenMarkDesign.viewBox}`,
  /** Lato della viewBox. */
  size: chosenMarkDesign.viewBox,
  /**
   * Dove il segno poggia, in unità della viewBox: il bordo in basso del tratto. Accanto al nome
   * il segno sta su questa linea, sulla base delle lettere (D242): centrato come riquadro, il
   * corpo della cartella, che pesa in basso, scendeva sotto il nome.
   */
  base: markInk(chosenMarkDesign.paths, chosenMarkDesign.stroke).bottom,
  paths: chosenMarkDesign.paths,
  strokeWidth: chosenMarkDesign.stroke,
  /** Su fondo chiaro. */
  color: scriptColors.light.luce,
  /**
   * Su fondo scuro: icona gialla con il segno blu scuro (scelta di Simone del 20/11/2026, D214).
   * Il giallo è l'evidenziatore dell'interfaccia e resta un fondo con sopra il blu scuro, come
   * vuole la sua regola (D69); sul chiaro il segno resta blu.
   */
  onDark: {
    /** Fondo dell'icona. */
    tile: uiColors.mark,
    /** Il segno sopra il giallo: l'ombra di SCRIPT. */
    color: scriptColors.light.ombra,
    /** Raggio degli angoli dell'icona, in unità della viewBox del segno. */
    radius: 7,
    /** Lato del segno dentro l'icona, in proporzione al lato dell'icona. */
    scale: 0.75,
    /**
     * Quanto sale il segno dal centro geometrico dell'icona, in unità della viewBox (su 32).
     * Centrato come ingombro, il segno sembra basso: il corpo della cartella pesa in basso e la
     * punta è sottile. Il baricentro del tratto sta 1,76 unità sotto il centro (misurato su un
     * disegno a 1024 px); il segno sale di metà di quello scarto, così la punta resta lontana
     * dal bordo (D214).
     */
    raise: 0.9,
  },
} as const;
