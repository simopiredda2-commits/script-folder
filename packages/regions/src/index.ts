import { healthUnitsOfRegion } from '@mmg/domain';
import { REGIONAL_PACKAGES } from './registry';
import {
  REGIONAL_PARTS,
  type AslVariant,
  type RegionalPackage,
  type RegionalPart,
  type RegionalPartEntry,
} from './types';

export * from './data';
export * from './types';
export { REGIONAL_PACKAGES } from './registry';

/** Il pacchetto scelto per uno studio, con le parti che dà e quelle che mancano. */
export interface RegionalSelection {
  /** La regione dello studio nell'elenco del Ministero, se il nome scritto si riconosce. */
  region: { code: string; name: string } | null;
  package: RegionalPackage | null;
  /** La variante dell'ASL del medico, se il pacchetto ne ha una per quell'azienda. */
  asl: AslVariant | null;
  /** Le parti date dal pacchetto e dalla variante dell'ASL. */
  parts: RegionalPartEntry[];
  /** Le parti che nessun pacchetto dà: per queste valgono solo le parti nazionali. */
  missing: RegionalPart[];
}

/**
 * Il pacchetto regionale di uno studio (D288, D292): dalla regione scritta nei dati dello studio
 * (riconosciuta con l'elenco delle aziende sanitarie del Ministero) e dall'ASL del medico. Una
 * regione senza pacchetto, o non riconosciuta, ha solo le parti nazionali.
 */
export function selectRegionalPackage(
  input: { regionName: string | null | undefined; aslCode?: string | null },
  packages: readonly RegionalPackage[] = REGIONAL_PACKAGES,
): RegionalSelection {
  const units = healthUnitsOfRegion(input.regionName);
  const region = units?.[0] ? { code: units[0].regionCode, name: units[0].regionName } : null;
  const pkg = region ? (packages.find((p) => p.regionCode === region.code) ?? null) : null;
  const aslCode = input.aslCode?.trim();
  const asl = pkg && aslCode ? (pkg.asl.find((a) => a.code === aslCode) ?? null) : null;
  const parts = [...(pkg?.parts ?? []), ...(asl?.parts ?? [])];
  const given = new Set(parts.map((p) => p.part));
  return { region, package: pkg, asl, parts, missing: REGIONAL_PARTS.filter((p) => !given.has(p)) };
}

/**
 * La chiave del pacchetto regionale della regione scritta nei dati dello studio, o null se la
 * regione non ha un pacchetto o non si riconosce: con questa le regole di prescrizione portano le
 * aggiunte della regione (D296).
 */
export function regionalPackageKey(
  regionName: string | null | undefined,
  packages: readonly RegionalPackage[] = REGIONAL_PACKAGES,
): string | null {
  return selectRegionalPackage({ regionName }, packages).package?.key ?? null;
}
