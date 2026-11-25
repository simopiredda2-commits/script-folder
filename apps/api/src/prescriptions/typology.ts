/**
 * Tipologia della ricetta farmaceutica, S suggerita o H ricovero: dalle schede delle terapie delle
 * righe, e solo se tutte le righe hanno la stessa (D217). La stessa regola vale per il campo 14 del
 * promemoria e per indicazionePrescr del messaggio della ricetta (D273).
 */
export function prescriptionTypology(
  lines: readonly { therapyId: string | null }[],
  therapies: readonly { id: string; suggestedS: boolean; hospitalH: boolean }[],
): 'S' | 'H' | null {
  const typologies = lines.map((l) => {
    const t = therapies.find((x) => x.id === l.therapyId);
    return t?.suggestedS ? ('S' as const) : t?.hospitalH ? ('H' as const) : null;
  });
  const first = typologies[0] ?? null;
  return first !== null && typologies.every((x) => x === first) ? first : null;
}
