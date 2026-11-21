/**
 * Spostamenti del paziente fra gli archivi dello studio (D200, D240): come `archivesOnDay` di
 * @mmg/domain, che il servizio usa per decidere. Qui serve a dire prima in quale distinta va una
 * prestazione aggiuntiva, e a chiedere di scegliere il giorno di uno spostamento.
 */
export interface ArchiveMove {
  giorno: string;
  da: string;
  daNome: string;
  a: string;
  aNome: string;
}

/**
 * Gli archivi in cui il paziente stava in un giorno: di solito uno; nel giorno di uno spostamento
 * quello di prima e quello di dopo. `moves` va in ordine di tempo; `current` è l'archivio di adesso.
 */
export function archivesOnDay(
  moves: readonly ArchiveMove[],
  current: string,
  day: string,
): string[] {
  const sameDay = moves.filter((m) => m.giorno === day);
  if (sameDay.length) return [...new Set([sameDay[0]!.da, ...sameDay.map((m) => m.a)])];
  const next = moves.find((m) => m.giorno > day);
  return [next ? next.da : current];
}

/** Il nome di ogni archivio che compare negli spostamenti. */
export function archiveNames(moves: readonly ArchiveMove[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const m of moves) names.set(m.da, m.daNome).set(m.a, m.aNome);
  return names;
}
