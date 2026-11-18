import { chosenMarkDesign } from './logo-proposals';
import { scriptColors } from './tokens';

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
  /** Su fondo scuro. */
  colorOnDark: scriptColors.dark.luce,
} as const;
