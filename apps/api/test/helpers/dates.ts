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
