/**
 * Farmaci e prestazioni prescritti al paziente, come li raggruppa la cartella (D152).
 */

/** I gruppi delle prestazioni prescritte, nell'ordine in cui la cartella li mostra. */
export const SERVICE_GROUPS = ['visita', 'altro'] as const;
export type ServiceGroup = (typeof SERVICE_GROUPS)[number];

export const SERVICE_GROUP_LABELS: Record<ServiceGroup, string> = {
  visita: 'Visite',
  altro: 'Esami e altre prestazioni',
};

/**
 * La descrizione comincia con VISITA, PRIMA VISITA o TELEVISITA; oppure, dopo un trattino, nomina
 * la visita («… (CDCC/UVA) - VISITA NEUROLOGICA»). Parole intere, maiuscole o minuscole.
 */
const VISIT =
  /^\s*(?:PRIMA\s+)?(?:TELE)?VISITA(?=[^\p{L}]|$)|\s-\s*(?:PRIMA\s+)?VISITA(?=[^\p{L}]|$)/iu;

/**
 * Una prestazione è una visita se la sua descrizione comincia con VISITA, PRIMA VISITA o
 * TELEVISITA, oppure se dopo un trattino nomina la visita. Tutte le altre sono «esami e altre
 * prestazioni»: laboratorio, immagini, esami strumentali, terapie e riabilitazione, consulti,
 * colloqui, consulenze e valutazioni (le fonti non le chiamano visite), interventi.
 *
 * Verificata il 18/11/2026, senza eccezioni, su tre elenchi interi:
 * - cataloghi regionali delle D.D. 868/2024 e 990/2024: 349 e 356 visite; le due che non
 *   cominciano con «VISITA» sono le rivalutazioni presso il centro demenze (codici 8901.85 e
 *   9412.85, «… - VISITA NEUROLOGICA», «… - VISITA PSCHIATRICA»);
 * - nomenclatore nazionale (allegato 4 del DPCM LEA, PDF del Ministero in 5 parti): 61 visite
 *   su 2113 prestazioni.
 * Cercare la parola in qualunque punto non basta: nel nomenclatore le descrizioni la usano nelle
 * note («ELETTROCARDIOGRAMMA. Non associabile a Prima visita cardiologica», «Incluso: Visita
 * anestesiologica») e nelle spiegazioni (consulenza genetica).
 *
 * Si applica alla descrizione della riga di ricetta, cioè a quella del catalogo in uso quando è
 * stata prescritta: con un catalogo nuovo vale senza modifiche, e la prova sugli elenchi interi si
 * ripete a ogni nuova versione (D152).
 */
export function serviceGroup(description: string | null | undefined): ServiceGroup {
  return VISIT.test(description ?? '') ? 'visita' : 'altro';
}
