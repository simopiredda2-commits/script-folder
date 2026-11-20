/**
 * La dimostrazione nel browser (D221): l'interfaccia vera (apps/web) e il servizio vero (apps/api)
 * in un Web Worker, con PGlite al posto di Postgres. Dati inventati, solo simulatori; niente esce
 * dal browser. Prima si avvia il servizio, poi l'interfaccia.
 */
import { StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { App } from '../../web/src/App';
import '../../web/src/styles/global.css';
import './demo.css';
import { installFetch, startService } from './bridge';
import { DemoPanel } from './DemoPanel';
import { installDialogs } from './dialogs';
import { installNavigation } from './navigation';
import { installDocumentViewer } from './viewer';
import workerUrl from './worker/index.ts?worker&url';

const status = document.getElementById('avvio-stato');
const startedAt = performance.now();

function show(message: string) {
  if (status) status.textContent = message;
}

function fail(message: string) {
  const box = document.getElementById('avvio');
  if (!box) return;
  box.classList.add('avvio-errore');
  show('La dimostrazione non è partita in questo browser.');
  const detail = document.getElementById('avvio-dettaglio');
  if (detail) {
    detail.hidden = false;
    detail.textContent = `Motivo tecnico: ${message}. Prova con una versione recente di Chrome, Edge, Safari o Firefox su computer.`;
  }
}

let appRoot: Root | null = null;
let generation = 0;
/** Disegna l'interfaccia; di nuovo da zero quando il programma vero ricaricherebbe la pagina. */
function renderApp() {
  appRoot?.render(
    <StrictMode>
      <App key={generation++} />
    </StrictMode>,
  );
}

installFetch();
installDocumentViewer();
installDialogs();
installNavigation(renderApp);

startService(workerUrl, show).then(
  (ready) => {
    document.getElementById('avvio')?.remove();
    appRoot = createRoot(document.getElementById('root')!);
    renderApp();
    const panel = document.getElementById('dimostrazione')!;
    createRoot(panel).render(
      <DemoPanel ready={ready} seconds={Math.round((performance.now() - startedAt) / 1000)} />,
    );
  },
  (err: unknown) => fail(err instanceof Error ? err.message : String(err)),
);
