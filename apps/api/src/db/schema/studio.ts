import { boolean, integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Tipo di studio: medico singolo o medicina di gruppo (più titolari, archivi separati). */
export const studioKind = pgEnum('studio_kind', ['single', 'group']);

/** Studio medico: tutti i dati sono separati per studio. */
export const studio = pgTable('studio', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  address: text(),
  kind: studioKind().notNull().default('single'),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  /** «Leggere il diario clinico (configurabile)» per la segreteria: per difetto no. */
  secretaryCanReadDiary: boolean().notNull().default(false),
  /**
   * Blocco della sessione dopo «pochi minuti» di inattività. Valore da completare: i requisiti
   * non lo fissano. Vuoto = blocco non attivo, segnalato dallo stato di salute.
   */
  idleLockMinutes: integer(),
  /** Tentativi di accesso falliti prima del blocco temporaneo dell'utente. Da completare. */
  maxFailedLogins: integer(),
  /** Durata del blocco temporaneo dopo troppi tentativi falliti. Da completare. */
  failedLoginLockMinutes: integer(),
});
