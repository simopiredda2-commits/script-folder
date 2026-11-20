import { chosenMarkDesign } from './logo-proposals';
import { scriptColors, uiColors } from './tokens';

export { previousMark } from './mark-previous';

/**
 * Segno del prodotto: la proposta B, «linguetta a picco», scelta da Simone alla prima fermata
 * (D33). Linea continua, spessore costante, estremi arrotondati; tavolozza di SCRIPT.
 */
export const productMark = {
  viewBox: `0 0 ${chosenMarkDesign.viewBox} ${chosenMarkDesign.viewBox}`,
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
  },
} as const;
