import type { FastifyInstance } from 'fastify';
import { markLocksSeen, unseenLocks } from '../auth/account-locks';
import type { Database } from '../db/client';

/**
 * Avvisi dei blocchi del conto (D181, D188): ognuno vede i propri, un medico titolare anche quelli
 * degli utenti dello studio; restano finché chi li riceve non li segna come visti.
 */
export function registerLockRoutes(app: FastifyInstance, db: Database, now: () => Date) {
  app.get('/api/blocchi', async (req) => unseenLocks(db, req.actor!));

  app.post('/api/blocchi/visti', async (req) => ({
    segnati: await markLocksSeen(db, req.actor!, req.body, now()),
  }));
}
