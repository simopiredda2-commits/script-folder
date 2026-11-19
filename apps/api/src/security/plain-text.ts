/**
 * Caratteri che un testo scritto a mano non contiene: di controllo (\p{Cc}, per esempio ESC, il
 * ritorno a capo e la tabulazione), di formato (\p{Cf}, per esempio i controlli bidirezionali) e i
 * separatori di riga e di paragrafo. Stampati sul terminale da un comando del server riscrivono
 * quello che si legge: un nome con ESC[1A può coprire la riga dei ruoli (terza revisione dei poteri
 * dell'amministratore, D179). Nei testi che l'amministratore scrive e che il server stampa non
 * entrano.
 */
const CONTROL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const CONTROL_ALL = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

export const CONTROL_CHARACTERS_MESSAGE =
  'Caratteri non ammessi: niente caratteri di controllo, a capo o invisibili';

/** Il testo contiene caratteri di controllo, di formato o separatori di riga. */
export const hasControlCharacters = (value: string): boolean => CONTROL.test(value);

/**
 * Per stampare sul terminale un testo che non viene dal server: ogni carattere di controllo o di
 * formato diventa visibile come \u{…}, così nulla si nasconde e nulla si riscrive.
 */
export function visibleText(value: string): string {
  return value.replace(
    CONTROL_ALL,
    (ch) => `\\u{${ch.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}}`,
  );
}
