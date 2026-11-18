import { sql } from 'drizzle-orm';
import type { Database } from './client';

export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Transazione a nome di un utente: il database lo scrive nello storico delle modifiche
 * (trigger mmg_record_change, migrazione 0002).
 */
export async function withActor<T>(
  db: Database,
  userId: string | null,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    if (userId) await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}
