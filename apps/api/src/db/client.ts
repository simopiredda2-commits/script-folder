import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;

/**
 * Attesa massima per una connessione libera del gruppo: oltre, la richiesta risponde 503 «servizio
 * occupato» invece di restare ferma senza limite (terza revisione: dieci accessi fermi su un blocco
 * occupavano tutte le connessioni e fermavano anche gli altri studi). Limite di buon senso.
 */
export const POOL_CONNECTION_TIMEOUT_MS = 10_000;
/** Il messaggio di pg-pool quando l'attesa di una connessione scade. */
export const POOL_TIMEOUT_MESSAGE = 'timeout exceeded when trying to connect';

export function createPool(
  databaseUrl: string,
  options: { max?: number; connectionTimeoutMillis?: number } = {},
): pg.Pool {
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: options.max ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? POOL_CONNECTION_TIMEOUT_MS,
  });
  // Una connessione può essere chiusa da Postgres (riavvio, rete interrotta, database cancellato
  // con FORCE), da ferma o mentre è in uso in una transazione: il client lo dice con un evento
  // «error», e un evento «error» senza chi lo ascolta fermerebbe il processo (D207, D209). Ogni
  // client ha il suo ascoltatore, che avvisa una volta; per i client fermi pg-pool ripete l'evento
  // sul gruppo, che lo ascolta senza ripetere l'avviso. La richiesta in corso fallisce con il suo
  // errore; le richieste dopo aprono una connessione nuova. Il messaggio di Postgres non contiene
  // dati dei pazienti.
  pool.on('connect', (client) => {
    client.on('error', (err) => {
      process.emitWarning(`Connessione al database chiusa: ${err.message}`);
    });
  });
  pool.on('error', () => {});
  return pool;
}

/** L'errore è l'attesa scaduta di una connessione del gruppo (anche dentro un errore di drizzle). */
export function isPoolTimeout(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && i < 5; e = (e as { cause?: unknown }).cause, i++)
    if (e instanceof Error && e.message === POOL_TIMEOUT_MESSAGE) return true;
  return false;
}

export function createDatabase(pool: pg.Pool): Database {
  return drizzle(pool, { schema, casing: 'snake_case' });
}
