/**
 * Famiglie dei codici di esenzione (D190). Un catalogo delle esenzioni dice che un codice non
 * esiste solo per le famiglie che contiene: con le sole malattie croniche dell'allegato 8 del
 * DPCM LEA, un'esenzione per reddito o per gravidanza non è «inesistente», è non nota, e R9 non
 * la blocca per questo.
 *
 * - codici che cominciano con una cifra: malattie croniche e invalidanti (013, 013.250, 0A31…);
 * - codici che cominciano con R e una lettera: malattie rare (RA0010, RBG010…);
 * - gli altri: le lettere iniziali (E01 → E, M50 → M).
 */
export function exemptionFamily(code: string): string {
  const c = code.trim().toUpperCase();
  if (/^\d/.test(c)) return 'croniche';
  if (/^R[A-Z]/.test(c)) return 'rare';
  return /^[A-Z]+/.exec(c)?.[0] ?? c;
}
