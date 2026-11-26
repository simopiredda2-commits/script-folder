import { api } from './api';

/**
 * Chiamate di contesto (D220, D297): una pagina dei servizi della regione dello studio, aperta con
 * il contesto del paziente in una scheda nuova. Il meccanismo è uno per tutte le destinazioni; il
 * servizio dà un indirizzo che vale una volta.
 */

/** Una destinazione della regione dello studio, come la descrive il servizio. */
export interface ContextDestination {
  tipo: string;
  parametri: {
    chiave: string;
    etichetta: string;
    /** La scelta che vale «tutti». */
    tutti: string;
    valori: { codice: string; nome: string }[];
  }[];
  simulato: boolean;
  attivo: boolean;
  /** Le parole della regione: a chi si chiede l'accesso, la pagina di prova, con chi si attiva. */
  testi: { introduzione: string; simulato: string; nonAttivo: string };
}

/**
 * Prepara la scheda nuova prima della richiesta, mentre il clic è ancora «del medico»: dopo
 * un'attesa molti browser bloccano le finestre nuove. Senza legame con questa pagina (opener),
 * perché vi si apre un sito della regione.
 */
function reserveTab(title: string, waiting: string): Window | null {
  let tab: Window | null;
  try {
    tab = window.open('', '_blank');
  } catch {
    return null;
  }
  if (!tab) return null;
  try {
    tab.opener = null;
    tab.document.title = title;
    tab.document.body.textContent = waiting;
  } catch {
    // La scheda c'è ma non si scrive: resta vuota fino all'indirizzo.
  }
  return tab;
}

/**
 * Apre la destinazione per il paziente: la scheda nuova riceve l'indirizzo; se il browser l'ha
 * bloccata, resta l'indirizzo da aprire a mano. Un errore del servizio chiude la scheda preparata.
 */
export async function openContextCall(
  patientId: string,
  kind: string,
  parameters: Record<string, string | null>,
  tab: { title: string; waiting: string },
): Promise<{ url: string; inTab: boolean }> {
  const reserved = reserveTab(tab.title, tab.waiting);
  try {
    const r = await api<{ indirizzo: string; simulato: boolean }>(
      `/api/pazienti/${patientId}/chiamate-di-contesto/${kind}`,
      { method: 'POST', body: { parametri: parameters } },
    );
    // L'indirizzo completo: la scheda vuota non ha un indirizzo da cui partire.
    const url = new URL(r.indirizzo, window.location.href).href;
    if (reserved) reserved.location.replace(url);
    return { url, inTab: reserved !== null };
  } catch (err) {
    reserved?.close();
    throw err;
  }
}
