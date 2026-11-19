/**
 * Tetti dell'importazione (tappa 15). Sono scelte d'ingegneria, non valori dei requisiti: un file
 * caricato non è fidato, e ogni tetto ferma un file costruito per esaurire memoria o tempo del
 * servizio che serve l'ambulatorio. Un archivio più grande si importa in più file (un foglio per
 * menu, oppure gli anni in file diversi).
 */

/**
 * Dimensione massima del file: 16 MiB. Un CSV di 16 MiB sono circa 80.000 righe da 200
 * caratteri; un XLSX compresso ne contiene di più. Il corpo della richiesta è in base64 (4/3).
 */
export const MAX_FILE_BYTES = 16 * 1024 * 1024;

/** Corpo massimo della richiesta di caricamento: il file in base64 e il resto. */
export const UPLOAD_BODY_LIMIT = Math.ceil((MAX_FILE_BYTES * 4) / 3) + 64 * 1024;

/** Righe per tabella (foglio o CSV): oltre, il file va diviso. */
export const MAX_ROWS = 100_000;

/** Colonne per tabella: un'esportazione ne ha decine, non migliaia. */
export const MAX_COLUMNS = 200;

/** Celle piene in tutto il file: tiene la memoria della lettura sotto qualche centinaio di MB. */
export const MAX_CELLS = 1_000_000;

/** Caratteri in una cella: il diario ne ammette 10.000; una cella molto più lunga è anomala. */
export const MAX_CELL_CHARS = 50_000;

/** Fogli in un XLSX. */
export const MAX_SHEETS = 50;

/** Voci di un archivio ZIP (XLSX): un foglio di calcolo ne ha poche decine. */
export const MAX_ZIP_ENTRIES = 2_000;

/** Dimensione dichiarata, decompressa, di tutte le parti lette di un XLSX (l'XML è prolisso). */
export const MAX_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;

/** Lunghezza di un formato numerico personalizzato (styles.xml). */
export const MAX_NUMBER_FORMAT_CHARS = 255;

/** Tempo massimo della lettura del file: oltre, la lettura si ferma con un errore chiaro. */
export const PARSE_DEADLINE_MS = 20_000;

/** Quanto resta in memoria un file caricato, in attesa di prova e importazione: un'ora. */
export const UPLOAD_TTL_MS = 60 * 60 * 1000;

/**
 * File caricati tenuti in memoria insieme, in tutto il servizio, misurati dalla loro dimensione:
 * 64 MiB sono quattro file della dimensione massima (letti occupano qualche volta di più), o
 * centinaia di file piccoli. Oltre, il più vecchio esce per primo e va ricaricato.
 */
export const MAX_UPLOAD_BYTES_IN_MEMORY = 64 * 1024 * 1024;

/** File di uno stesso utente tenuti in memoria: gli ultimi tre (per esempio un file per menu). */
export const MAX_UPLOADS_PER_USER = 3;

/** Righe mostrate nell'anteprima, per ogni destinazione. */
export const PREVIEW_ROWS = 10;

/** Righe d'intestazione possibili: l'intestazione si cerca nelle prime righe del foglio. */
export const MAX_HEADER_ROW = 30;

/** Destinazioni in una sola importazione (smistamento di uno o più fogli). */
export const MAX_PARTS = 30;

/** Valori distinti di una colonna mostrati per le tabelle di corrispondenza. */
export const MAX_DISTINCT_VALUES = 40;

/** Righe del rapporto salvate con l'importazione; i conteggi restano sempre completi. */
export const MAX_REPORT_ROWS = 20_000;

/** Attesa massima dei blocchi di altre transazioni (una cartella aperta in scrittura). */
export const LOCK_TIMEOUT = '5s';

/** Tempo massimo di una singola istruzione della scrittura. */
export const STATEMENT_TIMEOUT = '60s';
