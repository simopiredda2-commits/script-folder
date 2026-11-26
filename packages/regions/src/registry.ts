import { piemonte } from '../piemonte';
import type { RegionalPackage } from './types';

/**
 * L'elenco dei pacchetti regionali (D292): l'unico file del nucleo che nomina le regioni che hanno
 * un pacchetto, come `brand.ts` per il nome del prodotto. Un pacchetto nuovo si aggiunge qui.
 */
export const REGIONAL_PACKAGES: readonly RegionalPackage[] = [piemonte];
