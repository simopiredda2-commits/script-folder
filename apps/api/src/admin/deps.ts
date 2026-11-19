import type { Database } from '../db/client';

/** Dipendenze comuni delle rotte di amministrazione (tappa 14). */
export interface AdminDeps {
  db: Database;
  now: () => Date;
}
