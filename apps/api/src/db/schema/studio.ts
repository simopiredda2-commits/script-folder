import { integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Tipo di studio: medico singolo o medicina di gruppo (più titolari, archivi separati). */
export const studioKind = pgEnum('studio_kind', ['single', 'group']);

/** Studio medico: tutti i dati sono separati per studio. */
export const studio = pgTable('studio', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  address: text(),
  /**
   * Regione o provincia autonoma per l'intestazione del promemoria («SERVIZIO SANITARIO
   * NAZIONALE – REGIONE …», DM 2 novembre 2011, allegato 2, campo 1), es. «PIEMONTE».
   */
  regionName: text(),
  kind: studioKind().notNull().default('single'),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  /**
   * Blocco della sessione dopo «pochi minuti» di inattività: 5, scelti da Simone alla prima
   * fermata (D29). Vuoto = blocco non attivo.
   */
  idleLockMinutes: integer().default(5),
  /** Tentativi di accesso falliti prima del blocco temporaneo dell'utente: 5 (D29). */
  maxFailedLogins: integer().default(5),
  /** Durata del blocco temporaneo dopo troppi tentativi falliti: 15 minuti (D29). */
  failedLoginLockMinutes: integer().default(15),
});
