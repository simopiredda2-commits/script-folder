/**
 * Collegamenti verso siti pubblici, aperti dal medico in una scheda nuova: il programma non li
 * chiama (regola 7). Un valore null è «da completare»: l'indirizzo ufficiale non è stato ancora
 * verificato alla fonte, e l'interfaccia lo dice invece di inventarlo.
 */
export const LINKS: {
  /**
   * Come segnalare una sospetta reazione avversa (requisiti, «Scheda della terapia»; D82, D202):
   * la pagina AIFA, letta il 19/11/2026, con le due strade (scheda al responsabile di
   * farmacovigilanza della propria struttura, oppure segnalazione online).
   */
  pharmacovigilanceReport: string | null;
  /**
   * Segnalazione online: l'indirizzo scritto nella pagina AIFA qui sopra («Segnala online una
   * reazione avversa a farmaci e/o vaccini»). Il modulo non è stato aperto da qui: la rete
   * dell'ambiente di sviluppo non raggiunge quel sito (D202).
   */
  pharmacovigilanceOnline: string | null;
} = {
  pharmacovigilanceReport: 'https://www.aifa.gov.it/content/segnalazioni-reazioni-avverse',
  pharmacovigilanceOnline: 'https://servizionline.aifa.gov.it/schedasegnalazioni/#/',
};
