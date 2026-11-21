/**
 * I cambi di pagina della dimostrazione (D221). Nel programma vero alcune funzioni (accesso
 * regionale e collegamento con SPID o CIE, ripristino) portano il browser alla pagina del servizio
 * e poi lo riportano al programma. Nell'artifact un cambio di pagina farebbe perdere la
 * dimostrazione: qui la pagina del simulatore si apre nel visore, i rimandi si seguono dentro il
 * servizio nel browser e il ritorno al programma diventa un cambio di pagina interno.
 */
import { callService } from './bridge';
import { closeViewer, showPage } from './viewer';

const MAX_REDIRECTS = 10;

let reloadApp: () => void = () => undefined;

/**
 * Un indirizzo del programma (non /api/): nel programma vero il browser carica la pagina da capo.
 * Qui si cambia indirizzo e l'interfaccia riparte da zero, con i dati letti di nuovo dal servizio.
 */
function openInApp(url: URL) {
  closeViewer();
  history.pushState({}, '', `${url.pathname}${url.search}${url.hash}`);
  reloadApp();
}

async function go(start: URL) {
  let url = start;
  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    if (url.origin !== location.origin) {
      // Un sito esterno: nella dimostrazione non si apre (regola 7, nessun servizio vero).
      console.warn(`[dimostrazione] indirizzo esterno non aperto: ${url.href}`);
      return;
    }
    if (!url.pathname.startsWith('/api/')) {
      openInApp(url);
      return;
    }
    const res = await callService(new Request(url.href));
    const location_ = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location_) {
      url = new URL(location_, url);
      continue;
    }
    const type = res.headers.get('content-type') ?? '';
    if (type.startsWith('text/html')) {
      showPage(await res.text(), url, follow);
      return;
    }
    console.warn(`[dimostrazione] risposta inattesa ${res.status} da ${url.pathname}`);
    return;
  }
}

/** Un cambio di pagina che non riesce si dice nella console, senza un errore non gestito (D232). */
function follow(url: URL) {
  go(url).catch((err: unknown) => {
    console.warn(`[dimostrazione] cambio di pagina non riuscito: ${String(err)}`);
  });
}

declare global {
  var __dimostrazioneVai: ((url: string) => void) | undefined;
}

/** vite.config.ts sostituisce window.location.assign(…) dell'interfaccia con questa funzione. */
export function installNavigation(reload: () => void) {
  reloadApp = reload;
  globalThis.__dimostrazioneVai = (target: string) => follow(new URL(target, location.href));
}
