import { useEffect, useState } from 'react';

/**
 * Segna con `data-sotto` un riquadro che scorre e ha altro sotto (D249): su Mac le barre di
 * scorrimento non si vedono finché non si scorre, e un elenco tagliato sembrava finito. Il foglio
 * di stile disegna l'ombra in fondo (classe `ombre-scorrimento`). Niente segno se il riquadro non
 * scorre (overflow nascosto o visibile) o se è già in fondo.
 *
 * Dà il riferimento da mettere sull'elemento: così il segno si aggancia anche ai riquadri che
 * compaiono dopo il caricamento.
 */
export function useMoreBelow(): (node: HTMLElement | null) => void {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!el) return;
    const update = () => {
      const { overflowY } = getComputedStyle(el);
      const scrolls = overflowY === 'auto' || overflowY === 'scroll';
      const more = scrolls && el.scrollHeight - el.clientHeight - el.scrollTop > 1;
      if (more) el.setAttribute('data-sotto', '');
      else el.removeAttribute('data-sotto');
    };
    update();
    el.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    // Il contenuto cambia da solo: pagine nuove, righe che si aprono, risultati della ricerca.
    const changes = new MutationObserver(update);
    changes.observe(el, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['hidden', 'open', 'aria-expanded'],
    });
    const sizes = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    sizes?.observe(el);
    return () => {
      el.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      changes.disconnect();
      sizes?.disconnect();
    };
  }, [el]);
  return setEl;
}
