import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { REGIONAL_PACKAGES } from './registry';
import type { RegionalPackage } from './types';

/** La cartella del pacchetto delle regioni (`packages/regions`). */
export const REGIONS_DIR = join(import.meta.dirname, '..');

/**
 * I dati di un pacchetto regionale stanno in `packages/regions/<chiave>/data/`, divisi per tipo:
 * le trascrizioni degli atti della regione, le tabelle RAO della regione, le corrispondenze per il
 * SIAP (D292, D295), le aggiunte della regione alle regole di prescrizione (D296). Le cartelle
 * nazionali restano in `packages/reference/data/` e `packages/rules/data/`.
 */
export type RegionalDataKind = 'trascrizioni' | 'rao' | 'siap' | 'regole';

/** La cartella di un tipo di dati di un pacchetto, se c'è. */
export function regionalDataDir(kind: RegionalDataKind, pkg: RegionalPackage): string | null {
  const dir = join(REGIONS_DIR, pkg.key, 'data', kind);
  return existsSync(dir) ? dir : null;
}

/** Le cartelle di un tipo di dati dei pacchetti, quelle che ci sono, nell'ordine dell'elenco. */
export function regionalDataDirs(
  kind: RegionalDataKind,
  packages: readonly RegionalPackage[] = REGIONAL_PACKAGES,
): string[] {
  return packages.map((p) => regionalDataDir(kind, p)).filter((d): d is string => d !== null);
}
