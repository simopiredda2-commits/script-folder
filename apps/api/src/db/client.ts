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
  return new pg.Pool({
    connectionString: databaseUrl,
    max: options.max ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? POOL_CONNECTION_TIMEOUT_MS,
  });
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
