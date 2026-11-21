/**
 * L'indirizzo con cui la dimostrazione si è aperta, letto prima che l'interfaccia lo cambi. Il
 * Worker del servizio e i suoi file stanno accanto a questo indirizzo: «Ricomincia da capo» torna
 * qui, non all'indirizzo della pagina interna aperta in quel momento (D232).
 */
export const START_URL = location.href;
