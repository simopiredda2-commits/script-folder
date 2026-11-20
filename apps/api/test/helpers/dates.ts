import { startOfStudioDay } from '../../src/http/today-routes';
import { studioDate } from '../../src/prescriptions/rules-check';

/**
 * La data dello studio `offset` giorni dopo quella di `at`, contando i giorni del calendario.
 * Sommare multipli di 24 ore sbaglia di un giorno vicino a mezzanotte quando in mezzo c'è un cambio
 * dell'ora: alle 23:28 del 18/11, 150 volte 24 ore dopo in Italia è già il 18/4.
 */
export function studioDayFrom(at: Date, offset: number): string {
  const [y, m, d] = studioDate(at).split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + offset, 12)).toISOString().slice(0, 10);
}

/**
 * Mezzogiorno del giorno dello studio di `at` (ora di Roma). Le prove che fermano l'orologio del
 * servizio lo fermano qui: lontano dalla mezzanotte, la data resta la stessa anche se l'orologio
 * avanza di qualche ora, e anche se l'ora vera passa dalla mezzanotte durante il giro.
 */
export function middayOf(at: Date): Date {
  return new Date(startOfStudioDay(studioDate(at)).getTime() + 12 * 3_600_000);
}
