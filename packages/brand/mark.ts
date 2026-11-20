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
