import type { Database } from '../db/client';
import type { ReferenceUpdates } from '../reference/updates-service';

/** Dipendenze comuni delle rotte di amministrazione (tappa 14). */
export interface AdminDeps {
  db: Database;
  now: () => Date;
  /** Durata massima della sessione, dalla configurazione del servizio (D19): in sola lettura. */
  sessionMaxHours: number;
  /** Aggiornamento delle banche dati (D156): configurato o no, ora del giro notturno. */
  referenceUpdates: ReferenceUpdates;
}
