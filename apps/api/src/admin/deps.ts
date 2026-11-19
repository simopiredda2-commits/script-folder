import type { AppEnvironment } from '../config';
import type { Database } from '../db/client';
import type { AuraService } from '../aura/service';
import type { ReferenceUpdates } from '../reference/updates-service';

/** Dipendenze comuni delle rotte di amministrazione (tappa 14). */
export interface AdminDeps {
  db: Database;
  now: () => Date;
  /** Durata massima della sessione, dalla configurazione del servizio (D19): in sola lettura. */
  sessionMaxHours: number;
  /** Aggiornamento delle banche dati (D156): configurato o no, ora del giro notturno. */
  referenceUpdates: ReferenceUpdates;
  /** Ambiente dell'installazione (D170): in «prova» solo pazienti inventati. */
  environment: AppEnvironment;
  /** AURA, l'anagrafe regionale (D197): stato del collegamento e ultimo giro, nello stato del servizio. */
  aura?: AuraService;
  /** Prossimo controllo di ogni notte su AURA, se c'è l'ora. */
  auraNextRun?: () => Date | null;
}
