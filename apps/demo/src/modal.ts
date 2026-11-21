/** Gli elementi che Tab raggiunge. */
const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Un riquadro modale della dimostrazione (visore, conferma): mentre è aperto, il resto della pagina
 * non si raggiunge con la tastiera e i lettori di schermo non lo leggono (`inert`). Senza, con Tab
 * il fuoco usciva sui campi nascosti dietro il riquadro (WCAG 2.4.3 e 2.4.11, D232). Il fuoco gira
 * dentro il riquadro: Tab dall'ultimo elemento torna al primo, Maiuscolo+Tab dal primo va
 * all'ultimo, come nello schema dei dialoghi modali di WAI-ARIA. Altrimenti dall'ultimo elemento il
 * fuoco uscirebbe dalla cornice dell'artifact, sulla pagina che la contiene. Restituisce la funzione
 * che rimette la pagina com'era.
 */
export function holdFocusIn(overlay: HTMLElement): () => void {
  const others = [...document.body.children].filter(
    (el): el is HTMLElement => el instanceof HTMLElement && el !== overlay && !el.inert,
  );
  for (const el of others) el.inert = true;
  const wrap = (e: KeyboardEvent) => {
    // Un altro riquadro sopra questo (una conferma sul visore) tiene lui il fuoco.
    if (e.key !== 'Tab' || overlay.inert) return;
    const items = [...overlay.querySelectorAll<HTMLElement>(TABBABLE)].filter(
      (el) => el.getClientRects().length > 0,
    );
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    const outside = !(active instanceof Node) || !overlay.contains(active);
    if (e.shiftKey && (active === first || outside)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || outside)) {
      e.preventDefault();
      first.focus();
    }
  };
  // Sul documento, non sul riquadro: anche con il fuoco sul fondo della pagina Tab torna dentro.
  document.addEventListener('keydown', wrap, true);
  return () => {
    document.removeEventListener('keydown', wrap, true);
    for (const el of others) el.inert = false;
  };
}
