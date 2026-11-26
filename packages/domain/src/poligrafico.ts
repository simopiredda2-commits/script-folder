/**
 * Numero del Poligrafico della ricetta rossa (D270): il codice a barre stampato dall'IPZS in alto a
 * destra del modulo SSN. Due parti (disciplinare tecnico del DM 17/3/2008, comma 2, 2.3.1.2;
 * Sistema TS, «Collegamento telematico in rete dei medici», versione 11 del 1/3/2016, 7.1):
 *
 * - parte 1, 5 cifre: codice dell'ente (la regione, 3 cifre, Allegato 11) e
 *   ultime due cifre dell'anno del ricettario;
 * - parte 2, 10 cifre: progressivo del ricettario (7), numero della ricetta nel ricettario da 00 a
 *   99 (2) e una cifra di controllo, che il Sistema TS non usa e di cui le fonti lette non danno il
 *   calcolo: per questo il numero si legge dal modulo (codice a barre o a mano) e non si calcola.
 *
 * Nella ricetta DPCM le due parti vanno in Bar1 e Bar2 (schema RicettaMIR, Bar1Type di 5 e Bar2Type
 * di 10 caratteri).
 */

export interface PoligraficoCode {
  /** Le 15 cifre, senza spazi. */
  code: string;
  /** Parte 1 (Bar1): ente e anno. */
  bar1: string;
  /** Parte 2 (Bar2): ricettario, ricetta e cifra di controllo. */
  bar2: string;
  /** Codice dell'ente di competenza: la regione (Allegato 11 del disciplinare). */
  regionCode: string;
  /** Ultime due cifre dell'anno di produzione del ricettario. */
  year: string;
  /** Progressivo del ricettario (7 cifre). */
  booklet: string;
  /** Numero della ricetta nel ricettario, da 00 a 99. */
  sheet: string;
}

/** Il numero com'è letto: senza spazi, trattini e punti che un lettore o chi scrive può mettere. */
export function normalizePoligrafico(raw: string): string {
  return raw.replace(/[\s.-]/g, '');
}

/**
 * Che cosa non va nel numero letto dal modulo, o null. Con `regionCode` controlla anche che il
 * modulo sia della regione dello studio: i ricettari li dà l'ASL del medico.
 */
export function poligraficoProblem(raw: string, regionCode?: string | null): string | null {
  const code = normalizePoligrafico(raw);
  if (!/^\d+$/.test(code))
    return 'Il numero del Poligrafico ha solo cifre: si legge dal codice a barre in alto a destra della ricetta rossa';
  if (code.length !== 15)
    return `Il numero del Poligrafico ha 15 cifre (5 della prima parte e 10 della seconda), non ${code.length}`;
  if (regionCode && code.slice(0, 3) !== regionCode)
    return `Il modulo è di un altro ente (codice ${code.slice(0, 3)}): i ricettari dello studio hanno il codice ${regionCode}`;
  return null;
}

/** Le parti del numero, se è nella forma giusta. */
export function parsePoligrafico(raw: string): PoligraficoCode | null {
  const code = normalizePoligrafico(raw);
  if (poligraficoProblem(code) !== null) return null;
  return {
    code,
    bar1: code.slice(0, 5),
    bar2: code.slice(5),
    regionCode: code.slice(0, 3),
    year: code.slice(3, 5),
    booklet: code.slice(5, 12),
    sheet: code.slice(12, 14),
  };
}
