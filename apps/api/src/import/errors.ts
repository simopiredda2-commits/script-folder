import { HttpError } from '../http/errors';
import { FileRejected } from './table';

/**
 * Errori dell'importazione senza valori dei pazienti (tappa 15). Un errore di Postgres porta nel
 * dettaglio i valori della riga (un indice unico mostra il codice fiscale) e Drizzle aggiunge la
 * query con i parametri: né l'uno né l'altra devono arrivare al registro, ai log del servizio o
 * allo schermo. Resta il codice SQLSTATE, con il significato dal file ufficiale di Postgres 16
 * (`/usr/share/postgresql/16/errcodes.txt`, letto il 19/11/2026).
 */

const SQLSTATE: Record<string, string> = {
  '22001': 'un testo è più lungo di quanto il database ammette',
  '22007': 'una data non è valida',
  '22008': 'una data è fuori dall’intervallo ammesso',
  '22P02': 'un valore non ha la forma attesa',
  '23502': 'manca un valore obbligatorio',
  '23503': 'un riferimento punta a un dato che non c’è',
  '23505': 'un valore che deve essere unico è già presente',
  '23514': 'un valore non rispetta un vincolo del database',
  '40001': 'un’altra operazione ha cambiato gli stessi dati',
  '40P01': 'un’altra operazione ha cambiato gli stessi dati',
  '55P03': 'una cartella è in uso da un altro utente',
  '57014': 'l’operazione ha superato il tempo massimo',
};

/** Codice SQLSTATE di un errore di Postgres, anche dentro l'errore di Drizzle (`cause`). */
export function sqlState(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = typeof e?.code === 'string' ? e.code : e?.cause?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

/** Un errore qualsiasi della lettura o della scrittura, tradotto in un errore HTTP senza valori. */
export function importError(err: unknown, what: 'prova' | 'scrittura'): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof FileRejected) return new HttpError(err.statusCode, err.message);
  const code = sqlState(err);
  const meaning = code ? SQLSTATE[code] : undefined;
  const busy = code === '55P03' || code === '57014' || code === '40001' || code === '40P01';
  const subject = what === 'prova' ? 'La prova non è riuscita' : 'L’importazione non è riuscita';
  return new HttpError(
    busy ? 409 : 500,
    `${subject} e nessun dato è stato scritto: ${meaning ?? 'errore interno'}${code ? ` (codice ${code})` : ''}.${busy ? ' Riprova tra poco.' : ''}`,
  );
}
