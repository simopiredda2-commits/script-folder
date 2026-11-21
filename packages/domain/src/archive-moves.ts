/**
 * Spostamenti di un paziente fra gli archivi dello studio (D200, D240), per sapere chi lo aveva in
 * un giorno. Serve alle prestazioni aggiuntive: il compenso è del medico che le ha eseguite (ACN
 * della medicina generale 2022-2024, allegato 6: comma 4, «riepilogo delle prestazioni eseguite»;
 * comma 6, «per le prestazioni rese, al medico spettano compensi»), quindi una prestazione va nella
 * distinta dell'archivio in cui il paziente stava il giorno dell'esecuzione, anche se la si
 * registra dopo lo spostamento.
 */

/** Uno spostamento: il giorno (data dello studio, AAAA-MM-GG) e i due archivi. */
export interface ArchiveMove {
  day: string;
  from: string;
  to: string;
}

/**
 * Gli archivi in cui il paziente stava in un giorno. Di solito uno solo. Nel giorno di uno
 * spostamento sono due, quello di prima e quello di dopo (o più, se gli spostamenti di quel giorno
 * sono più d'uno): solo l'ora dell'esecuzione direbbe quale, e la data non ce l'ha, quindi sceglie
 * chi registra. `moves` va in ordine di tempo; `current` è l'archivio di adesso.
 */
export function archivesOnDay(
  moves: readonly ArchiveMove[],
  current: string,
  day: string,
): string[] {
  const sameDay = moves.filter((m) => m.day === day);
  if (sameDay.length) return [...new Set([sameDay[0]!.from, ...sameDay.map((m) => m.to)])];
  const next = moves.find((m) => m.day > day);
  return [next ? next.from : current];
}
