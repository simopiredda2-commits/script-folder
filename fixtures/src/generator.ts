import { buildFiscalCode, type Sex } from '@mmg/domain';
import { Random } from './random';
import { femaleNames, maleNames, residenceTowns, streets, surnames } from './names';

/**
 * Lettera riservata ai luoghi di nascita inventati. Nel codice catastale la Z è degli Stati
 * esteri e ai comuni sono assegnati codici dalla A alla M (Wikipedia, «Codice catastale»,
 * consultata il 18/11/2026): un codice fiscale con la X in dodicesima posizione non può essere
 * di una persona reale. Da riverificare sul file ISTAT dei comuni (tappa 5).
 */
export const FICTITIOUS_PLACE_LETTER = 'X';

export type PatientStatus = 'active' | 'revoked' | 'deceased' | 'temporary';

export interface FixturePatient {
  id: string;
  firstName: string;
  lastName: string;
  sex: Sex;
  birthDate: string;
  birthPlace: { code: string; name: string };
  fiscalCode: string;
  phone: string;
  email: string;
  residence: { street: string; number: string; town: string; province: string };
  status: PatientStatus;
}

export interface GenerateOptions {
  seed: string | number;
  count: number;
  /** Data di riferimento per le età, AAAA-MM-GG. Fissa, così il risultato non cambia nel tempo. */
  referenceDate?: string;
  /**
   * Età minima, in anni compiuti alla data di riferimento. I più giovani si saltano: gli altri
   * restano gli stessi, nello stesso ordine, di una generazione senza limite. Per i dati
   * dimostrativi di uno studio di medicina generale: nessun paziente in età pediatrica (D149).
   */
  minAge?: number;
}

/** Anni compiuti alla data di riferimento (date AAAA-MM-GG). */
export function ageAt(birthDate: string, referenceDate: string): number {
  const years = Number(referenceDate.slice(0, 4)) - Number(birthDate.slice(0, 4));
  return referenceDate.slice(5) < birthDate.slice(5) ? years - 1 : years;
}

function isoDate(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Genera pazienti inventati: stesso seme e stesso numero, stessi pazienti. */
export function generatePatients({
  seed,
  count,
  referenceDate = '2026-11-18',
  minAge = 0,
}: GenerateOptions): FixturePatient[] {
  const rnd = new Random(seed);
  const refYear = Number(referenceDate.slice(0, 4));
  const patients: FixturePatient[] = [];
  for (let i = 0; patients.length < count; i++) {
    const sex: Sex = rnd.chance(0.5) ? 'F' : 'M';
    const firstName = rnd.pick(sex === 'F' ? femaleNames : maleNames);
    const lastName = rnd.pick(surnames);
    const year = refYear - rnd.int(1, 98);
    const month = rnd.int(1, 12);
    const day = rnd.int(1, daysInMonth(year, month));
    const birthDate = isoDate(year, month, day);
    const placeNumber = rnd.int(1, 999);
    const placeCode = `${FICTITIOUS_PLACE_LETTER}${String(placeNumber).padStart(3, '0')}`;
    const town = rnd.pick(residenceTowns);
    const roll = rnd.next();
    const status: PatientStatus =
      roll < 0.88 ? 'active' : roll < 0.94 ? 'revoked' : roll < 0.97 ? 'deceased' : 'temporary';
    const slug = `${firstName}.${lastName}`.toLowerCase().replace(/[^a-z.]/g, '');
    const patient: FixturePatient = {
      id: rnd.uuid(),
      firstName,
      lastName,
      sex,
      birthDate,
      birthPlace: { code: placeCode, name: `Comune immaginario ${placeNumber}` },
      fiscalCode: buildFiscalCode({
        surname: lastName,
        name: firstName,
        birthDate,
        sex,
        placeCode,
      }),
      // Prefisso 000: nessun numero italiano reale inizia così.
      phone: `+39 000 ${String(rnd.int(0, 9_999_999)).padStart(7, '0')}`,
      // example.org è riservato alla documentazione (RFC 2606): nessuna email arriva a qualcuno.
      email: `${slug}.${i + 1}@example.org`,
      residence: {
        street: rnd.pick(streets),
        number: String(rnd.int(1, 120)),
        town: town.name,
        province: town.province,
      },
      status,
    };
    // Tutti i numeri casuali sono già stati presi: saltare un paziente non cambia gli altri.
    if (ageAt(birthDate, referenceDate) >= minAge) patients.push(patient);
  }
  return patients;
}
