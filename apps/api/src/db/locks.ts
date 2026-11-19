import { sql } from 'drizzle-orm';
import type { Tx } from './tx';

/**
 * Attese sui blocchi delle righe (tappa 14, seconda revisione dei poteri dell'amministratore,
 * problema nuovo 2). Senza un limite una transazione aspetta finché l'altra non finisce, tenendo
 * occupata una connessione del gruppo: un'attesa lunga (per esempio dietro un'importazione) ne
 * ferma altre, fino a esaurire le connessioni del servizio. Con `lock_timeout` l'attesa ha un tetto
 * e allo scadere Postgres risponde con il codice 55P03 («lock_not_available»).
 */

/** Codice SQLSTATE di Postgres quando scade `lock_timeout` (errcodes.txt di Postgres 16). */
export const LOCK_NOT_AVAILABLE = '55P03';

/** Codice SQLSTATE di un errore di Postgres, anche dentro l'errore di Drizzle (`cause`). */
export function sqlStateOf(err: unknown): string | undefined {
  const e = err as { code?: unknown; cause?: { code?: unknown } } | null;
  const code = typeof e?.code === 'string' ? e.code : e?.cause?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : undefined;
}

/** L'errore è lo scadere di `lock_timeout`. */
export const isLockTimeout = (err: unknown) => sqlStateOf(err) === LOCK_NOT_AVAILABLE;

/**
 * Esegue `fn` con un'attesa massima dei blocchi, poi rimette il valore di prima nella
 * transazione: il limite vale solo per i blocchi presi in `fn`, non per quelli che vengono dopo
 * (per esempio la catena del registro, che si scrive in fondo). Se il limite scade, la
 * transazione è annullata e l'errore 55P03 arriva a chi chiama.
 */
export async function withLockTimeout<T>(
  tx: Tx,
  timeout: string,
  fn: () => Promise<T>,
): Promise<T> {
  const before = await tx.execute<{ v: string }>(sql`select current_setting('lock_timeout') as v`);
  await tx.execute(sql`select set_config('lock_timeout', ${timeout}, true)`);
  const out = await fn();
  await tx.execute(sql`select set_config('lock_timeout', ${before.rows[0]?.v ?? '0'}, true)`);
  return out;
}
