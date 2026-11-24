/**
 * Forma dei numeri di ricetta che il medico scrive a mano quando un invio è rimasto senza risposta
 * e l'ente gli detta il numero (D233, audit D259). Si controlla solo la forma, prima della domanda
 * di conferma: un numero sbagliato non si corregge dopo, e il numero vero lo dà l'ente.
 *
 * - NRE della ricetta SSN: Sistema TS, «Web services per la trasmissione delle ricette
 *   dematerializzate – parte 1: prescrizione», 05/12/2024, paragrafi 5 e 5.1 (pagine 56 e 57).
 *   «AAA BB C DDDDDDD EE per un totale di 15 caratteri»; BB è un «codice alfanumerico»; C vale da 0
 *   a 7; «La somma dei campi DDDDDDD + EE è sempre di 9 byte», cifre. Per AAA («codice della
 *   Regione / Prov. Autonoma o medico prescrittore») il testo non dice se sono solo cifre: si
 *   accettano lettere e cifre.
 * - NRBE della ricetta bianca: Disciplinare tecnico del DM 1/12/2022, paragrafo 2.4: «stringa
 *   alfanumerica lunga 12 caratteri», il primo una lettera, il secondo una lettera o un numero, dal
 *   terzo al dodicesimo numeri. Per i pazienti con il codice fiscale il primo è la lettera di
 *   controllo del codice fiscale e il secondo un numero da 0 a 9.
 *
 * Il codice di autenticazione, il PIN della ricetta bianca e il protocollo dell'INPS non hanno un
 * formato nelle specifiche lette: restano lettere e cifre, da completare con le specifiche di
 * collaudo (D259).
 *
 * Il web ne ha una copia (`apps/web/src/lib/prescription-numbers.ts`), con gli stessi casi di prova.
 */

/** Lunghezza dell'NRE: «sempre di 15 byte» (paragrafo 5.1). */
export const NRE_LENGTH = 15;
/** Lunghezza dell'NRBE: «lunga 12 caratteri» (paragrafo 2.4). */
export const NRBE_LENGTH = 12;

/** Come si scrive il numero: senza spazi (l'esempio delle specifiche li ha), in maiuscolo. */
export function normalizePrescriptionNumber(raw: string): string {
  return raw.replace(/\s+/g, '').toUpperCase();
}

/** «qui ce ne sono 3», «qui ce n’è 1». */
const written = (n: number) => (n === 1 ? 'qui ce n’è 1' : `qui ce ne sono ${n}`);

/** Che cosa non va nell'NRE scritto, o null se la forma è giusta. */
export function nreProblem(raw: string): string | null {
  const nre = normalizePrescriptionNumber(raw);
  if (nre.length !== NRE_LENGTH)
    return `L’NRE ha sempre ${NRE_LENGTH} caratteri: ${written(nre.length)}. Rileggi il numero dato dall’ente.`;
  if (!/^[0-9A-Z]+$/.test(nre))
    return 'L’NRE ha solo lettere e cifre. Rileggi il numero dato dall’ente.';
  if (!/^[0-9A-Z]{5}[0-7][0-9]{9}$/.test(nre))
    return 'Nell’NRE il sesto carattere è una cifra da 0 a 7 e gli ultimi 9 sono cifre. Rileggi il numero dato dall’ente.';
  return null;
}

/**
 * Che cosa non va nell'NRBE scritto, o null se la forma è giusta. Con il codice fiscale del
 * paziente (quello mandato con la ricetta) si controlla anche la prima lettera.
 */
export function nrbeProblem(raw: string, fiscalCode?: string | null): string | null {
  const nrbe = normalizePrescriptionNumber(raw);
  if (nrbe.length !== NRBE_LENGTH)
    return `L’NRBE ha sempre ${NRBE_LENGTH} caratteri: ${written(nrbe.length)}. Rileggi il numero dato dal Sistema TS.`;
  if (!/^[A-Z][0-9A-Z][0-9]{10}$/.test(nrbe))
    return 'Nell’NRBE il primo carattere è una lettera, il secondo una lettera o una cifra, gli altri 10 sono cifre. Rileggi il numero dato dal Sistema TS.';
  const cf = fiscalCode ? normalizePrescriptionNumber(fiscalCode) : '';
  // Solo il codice fiscale di 16 caratteri ha la lettera di controllo in fondo.
  if (/^[0-9A-Z]{15}[A-Z]$/.test(cf) && !(nrbe[0] === cf[15] && /[0-9]/.test(nrbe[1]!)))
    return `Per un paziente con il codice fiscale l’NRBE comincia con la lettera di controllo del codice fiscale (${cf[15]}) seguita da una cifra. Rileggi il numero dato dal Sistema TS.`;
  return null;
}
