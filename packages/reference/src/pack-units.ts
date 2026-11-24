/**
 * Unità posologiche di una confezione, lette dalla descrizione dell'anagrafica AIFA delle
 * confezioni (scelta di Simone del 24/11/2026, D252): «5 MG COMPRESSE- 28 COMPRESSE IN BLISTER»
 * dà 28 compresse. Servono al contatore delle confezioni (R11) e al limite dei 180 giorni (R4).
 *
 * Si legge solo il numero che apre l'ultima parte della descrizione, dopo l'ultimo «- », e solo se
 * lo segue un'unità che è anche un'unità della posologia: compresse, capsule, bustine. Penne,
 * fiale, flaconi o «2 BLISTER DA 14» non si leggono: il contatore dice che non conta. Nessun
 * numero ricostruito; la banca dati con licenza controllerà le differenze.
 */

export type PackUnit = 'compressa' | 'capsula' | 'bustina';

/** Le parole della descrizione AIFA e della posologia, al singolare. */
const UNITS: Record<string, PackUnit> = {
  compressa: 'compressa',
  compresse: 'compressa',
  capsula: 'capsula',
  capsule: 'capsula',
  bustina: 'bustina',
  bustine: 'bustina',
};

export function packUnits(
  description: string | null | undefined,
): { count: number; unit: PackUnit } | null {
  if (!description) return null;
  const parts = description.split(/-\s+/);
  const last = parts[parts.length - 1]!.trim();
  const match = /^(\d+)\s+(\p{L}+)/u.exec(last);
  if (!match) return null;
  const count = Number(match[1]);
  const unit = UNITS[match[2]!.toLowerCase()];
  return unit && count > 0 ? { count, unit } : null;
}

/** L'unità della posologia di una terapia è la stessa della confezione: «compresse» e «compressa». */
export function samePackUnit(doseUnit: string | null | undefined, unit: PackUnit): boolean {
  return !!doseUnit && UNITS[doseUnit.trim().toLowerCase()] === unit;
}
