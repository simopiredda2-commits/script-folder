/**
 * Un timer che non tiene acceso il processo. Nel browser, dove gira la dimostrazione (D221),
 * `setTimeout` dà un numero e non c'è `unref`: chiamarlo lancerebbe un errore, e per esempio il
 * controllo su AURA prima della ricetta non aspetterebbe più AURA (D232).
 */
export function unrefTimer<T>(timer: T): T {
  (timer as { unref?: () => unknown }).unref?.();
  return timer;
}
