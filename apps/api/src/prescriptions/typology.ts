/**
 * Tipologia della ricetta farmaceutica, S suggerita o H ricovero: dalle righe, e solo se tutte le
 * righe hanno la stessa (D217). La stessa regola vale per il campo 14 del promemoria e per
 * indicazionePrescr del messaggio della ricetta (D273). Per ogni riga vale la scelta segnata sulla
 * riga, quando c'è (D283); altrimenti la scheda della terapia collegata.
 */
export function prescriptionTypology(
  lines: readonly {
    therapyId: string | null;
    /** La scelta che vale per la riga (del medico, o proposta confermata); null: nessuna. */
    choice?: { typology: 'S' | 'H' | null } | null;
  }[],
  therapies: readonly { id: string; suggestedS: boolean; hospitalH: boolean }[],
): 'S' | 'H' | null {
  const typologies = lines.map((l) => {
    if (l.choice) return l.choice.typology;
    const t = therapies.find((x) => x.id === l.therapyId);
    return t?.suggestedS ? ('S' as const) : t?.hospitalH ? ('H' as const) : null;
  });
  const first = typologies[0] ?? null;
  return first !== null && typologies.every((x) => x === first) ? first : null;
}
