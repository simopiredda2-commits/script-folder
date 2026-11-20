/**
 * Conferme e stampa nella cornice dell'artifact (D223). Dentro un artifact il browser non apre le
 * sue finestre: `window.confirm` risponde subito «no» e `window.print` non fa nulla. Il programma
 * chiede conferma con `window.confirm` (archiviare, confermare un utente, uscire dall'AFT…) e
 * stampa lo schema orario con `window.print`.
 *
 * - Conferma: se il browser risponde «no» prima che una persona possa leggere la domanda, la
 *   finestra era bloccata. La stessa domanda compare in un riquadro della pagina; con «Conferma» il
 *   clic che l'aveva chiesta si ripete, e questa volta la risposta è «sì».
 * - Stampa: un avviso dice che nella dimostrazione non si stampa.
 *
 * Fuori dalla cornice (la pagina aperta da sola) le finestre del browser funzionano come sempre.
 */

/** Sotto questo tempo nessuno ha letto la domanda: la finestra non si è aperta. */
const BLOCKED_WITHIN_MS = 50;
/** Quanto vale una conferma data nel riquadro, se il clic non si ripete da solo. */
const APPROVAL_MS = 15_000;

let lastClicked: HTMLElement | null = null;
const approved = new Map<string, number>();

function notice(text: string) {
  document.getElementById('dimo-avviso')?.remove();
  const box = document.createElement('div');
  box.id = 'dimo-avviso';
  box.className = 'dimo-avviso';
  box.setAttribute('role', 'status');
  const p = document.createElement('p');
  p.textContent = text;
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = 'Chiudi';
  close.addEventListener('click', () => box.remove());
  box.append(p, close);
  document.body.append(box);
  window.setTimeout(() => box.remove(), 12_000);
}

function askInPage(message: string, origin: HTMLElement | null) {
  document.getElementById('dimo-conferma')?.remove();
  const overlay = document.createElement('div');
  overlay.id = 'dimo-conferma';
  overlay.className = 'dimo-conferma';
  overlay.setAttribute('role', 'alertdialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'dimo-conferma-titolo');
  overlay.setAttribute('aria-describedby', 'dimo-conferma-testo');
  const box = document.createElement('div');
  box.className = 'dimo-conferma-riquadro';
  const title = document.createElement('h2');
  title.id = 'dimo-conferma-titolo';
  title.textContent = 'Conferma';
  const text = document.createElement('p');
  text.id = 'dimo-conferma-testo';
  text.textContent = message;
  const note = document.createElement('p');
  note.className = 'dimo-tenue';
  note.textContent =
    'Nel programma vero questa domanda è una finestra del browser, che dentro la dimostrazione non si apre.';
  const actions = document.createElement('div');
  actions.className = 'dimo-conferma-azioni';
  const yes = document.createElement('button');
  yes.type = 'button';
  yes.className = 'dimo-conferma-si';
  yes.textContent = 'Conferma';
  const no = document.createElement('button');
  no.type = 'button';
  no.textContent = 'Annulla';
  const done = () => {
    overlay.remove();
    if (origin?.isConnected) origin.focus();
  };
  no.addEventListener('click', done);
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') done();
  });
  yes.addEventListener('click', () => {
    approved.set(message, Date.now() + APPROVAL_MS);
    done();
    // Il clic di prima si ripete: il programma chiede di nuovo e ora la risposta è «sì».
    if (origin?.isConnected) origin.click();
    else notice('Confermato: premi di nuovo il pulsante.');
  });
  actions.append(yes, no);
  box.append(title, text, note, actions);
  overlay.append(box);
  document.body.append(overlay);
  yes.focus();
}

export function installDialogs() {
  // Il pulsante premuto per ultimo: è quello da ripetere dopo la conferma nella pagina.
  document.addEventListener(
    'click',
    (e) => {
      const target = (e.target as Element | null)?.closest?.('button, a, input');
      if (target instanceof HTMLElement && !target.closest('#dimo-conferma')) lastClicked = target;
    },
    true,
  );

  const originalConfirm = window.confirm.bind(window);
  window.confirm = (message?: string) => {
    const text = String(message ?? '');
    const until = approved.get(text);
    if (until !== undefined) {
      approved.delete(text);
      if (until >= Date.now()) return true;
    }
    const started = performance.now();
    let answer: boolean;
    try {
      answer = originalConfirm(text);
    } catch {
      answer = false;
    }
    if (answer || performance.now() - started >= BLOCKED_WITHIN_MS) return answer;
    askInPage(text, lastClicked);
    return false;
  };

  const originalPrint = window.print.bind(window);
  window.print = () => {
    try {
      originalPrint();
    } catch {
      // Nella cornice la stampa può anche dare errore: l'avviso sotto basta.
    }
    notice(
      'Nella dimostrazione la stampa non parte: nel programma vero qui si apre la finestra di stampa del browser.',
    );
  };
}
