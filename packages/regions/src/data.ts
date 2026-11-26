import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { REGIONAL_PACKAGES } from './registry';
import type { RegionalPackage } from './types';

/** La cartella del pacchetto delle regioni (`packages/regions`). */
export const REGIONS_DIR = join(import.meta.dirname, '..');

/**
 * I dati di un pacchetto regionale stanno in `packages/regions/<chiave>/data/`, divisi per tipo:
 * le trascrizioni degli atti della regione, le tabelle RAO della regione, le corrispondenze per il
 * SIAP (D292). Le cartelle nazionali restano in `packages/reference/data/`.
 */
export type RegionalDataKind = 'trascrizioni' | 'rao' | 'siap';

/** Le cartelle di un tipo di dati dei pacchetti, quelle che ci sono, nell'ordine dell'elenco. */
export function regionalDataDirs(
  kind: RegionalDataKind,
  packages: readonly RegionalPackage[] = REGIONAL_PACKAGES,
): string[] {
  return packages.map((p) => join(REGIONS_DIR, p.key, 'data', kind)).filter((d) => existsSync(d));
}
