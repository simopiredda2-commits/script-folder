import { nreProblem } from './prescription-numbers';

/**
 * Lotti di NRE della Regione Piemonte (D269): la cartella numera da sé le ricette, con i lotti
 * che il SAR le «distribuisce» (SIRPED, «Cartelle cliniche MMG e PLS», V06 del 10/04/2026, 3.2 e
 * 4.1, p. 7–11).
 *
 * - Il medico chiede un lotto di tipo 1, 1000 NRE: in Piemonte è l'unico ammesso (3.2).
 * - Il SAR lo «estrae» da un lotto più grande avuto dal SAC: restituisce come identificativo del
 *   lotto quello del SAC (per esempio 4) e come codice il lotto estratto. Esempio della V06:
 *   lotto «010 A0 4 000000»; la cartella genera gli NRE da «010 A0 4 000000 000» a
 *   «010 A0 4 000000 999», agendo solo sul progressivo (4.1, p. 10–11).
 * - L'NRE ha 15 caratteri: regione (3), raggruppamento (2), identificativo del lotto (1), poi 9
 *   cifre fra codice del lotto e progressivo (Sistema TS, «Gestione del numero ricetta
 *   elettronica», versione 2 del 21/05/2012, §2 e §2.1, p. 4).
 *
 * Per i 1000 NRE il codice del lotto ha 6 cifre e il progressivo 3, come nell'esempio della V06 e
 * nella composizione «AAA BB C DDDDDD EEE» della guida per il lotto da 1000 (§2.1).
 */

/** Numeri di un lotto del medico: tipo 1, «1.000 NRE» (V06, 3.2). */
export const NRE_LOT_SIZE = 1000;
/** Il tipo di lotto che la cartella chiede: solo 1 in Piemonte (V06, 3.2 e 4.1). */
export const NRE_LOT_REQUEST_TYPE = '1';

/** Il lotto come lo restituisce il SAR (ricevuta «LottoRicevutaNRE» della guida, §3.1). */
export interface NreLotCode {
  /** CodRegione, 3 cifre: 010 il Piemonte. */
  regionCode: string;
  /** CodRagLotto, 2 caratteri: assegnato dal SAC. */
  groupCode: string;
  /** IdentificativoLotto, 1 cifra: quello del lotto del SAR, non quello chiesto (V06, 4.1). */
  lotType: string;
  /** CodLotto: per il lotto estratto di 1000 NRE, 6 cifre. */
  lotCode: string;
}

/** Che cosa non va nel lotto ricevuto, o null se si possono generarne gli NRE. */
export function nreLotProblem(lot: NreLotCode): string | null {
  if (!/^\d{3}$/.test(lot.regionCode)) return 'Il codice della regione del lotto non ha 3 cifre';
  if (!/^[0-9A-Z]{2}$/.test(lot.groupCode))
    return 'Il codice di raggruppamento del lotto non ha 2 lettere o cifre';
  if (!/^[0-7]$/.test(lot.lotType)) return 'L’identificativo del lotto non è una cifra da 0 a 7';
  if (!/^\d{6}$/.test(lot.lotCode))
    return 'Il codice del lotto non ha le 6 cifre di un lotto da 1000 NRE (V06, 4.1)';
  return null;
}

/** L'inizio comune ai 1000 NRE del lotto: «010A04000000». */
export function nreLotPrefix(lot: NreLotCode): string {
  const problem = nreLotProblem(lot);
  if (problem) throw new Error(problem);
  return `${lot.regionCode}${lot.groupCode}${lot.lotType}${lot.lotCode}`;
}

/** L'NRE numero `progressive` (da 0 a 999) del lotto. */
export function composeNre(lot: NreLotCode, progressive: number): string {
  if (!Number.isInteger(progressive) || progressive < 0 || progressive >= NRE_LOT_SIZE)
    throw new Error(`Progressivo fuori dal lotto: ${progressive} (da 0 a ${NRE_LOT_SIZE - 1})`);
  const nre = `${nreLotPrefix(lot)}${String(progressive).padStart(3, '0')}`;
  const problem = nreProblem(nre);
  if (problem) throw new Error(problem);
  return nre;
}

/** Il lotto e il progressivo di un NRE, se è nella forma di un lotto da 1000. */
export function splitNre(nre: string): { prefix: string; progressive: number } | null {
  if (nreProblem(nre) !== null) return null;
  return { prefix: nre.slice(0, 12), progressive: Number(nre.slice(12)) };
}
