import { ASL_LIST, type HealthUnit } from './asl-elenco';

export { ASL_LIST, ASL_SOURCE, type HealthUnit } from './asl-elenco';

/** Codice di un'azienda sanitaria nell'elenco del Ministero: tre cifre (D267). */
export const ASL_CODE = /^\d{3}$/;

/** Nome di regione confrontabile: maiuscole, senza accenti, apostrofi, punti e spazi. */
function regionKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
}

/**
 * Le aziende della regione dello studio, riconosciuta dal nome scritto nei dati dello studio
 * («PIEMONTE»). `null` se il nome manca o non è una regione dell'elenco: allora vale l'elenco
 * intero.
 */
export function healthUnitsOfRegion(regionName: string | null | undefined): HealthUnit[] | null {
  const key = regionName ? regionKey(regionName) : '';
  if (!key) return null;
  const units = ASL_LIST.filter((a) => regionKey(a.regionName) === key);
  return units.length ? units : null;
}

/**
 * L'azienda con questo codice nella regione dello studio; se la regione non si riconosce, in
 * qualunque regione (il codice da solo non basta a dire quale: per questo il nome della regione va
 * scritto nei dati dello studio). `null` se il codice non c'è.
 */
export function findHealthUnit(code: string, regionName?: string | null): HealthUnit | null {
  const units = healthUnitsOfRegion(regionName) ?? ASL_LIST;
  return units.find((a) => a.code === code.trim()) ?? null;
}

/** Come appare un'azienda in un elenco: «301 – ASL CITTA' DI TORINO». */
export function healthUnitLabel(a: HealthUnit, withRegion = false): string {
  return `${a.code} – ${a.name}${withRegion ? ` (${a.regionName})` : ''}`;
}
