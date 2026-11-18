import {
  date,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { appUser, bytea } from './users';

/** Servizi con credenziali del medico (D100). */
export const credentialService = pgEnum('credential_service', ['sistema_ts', 'rupar_piemonte']);

/**
 * Credenziali dei servizi esterni del medico (D100): utente, password e PIN cifrati insieme, con
 * una chiave solo per questo uso e legati a medico e servizio. L'interfaccia non le rilegge mai.
 * Senza storico, perché nessun segreto vecchio resti conservato; il medico può cancellarle.
 */
export const serviceCredential = pgTable(
  'service_credential',
  {
    userId: uuid()
      .notNull()
      .references(() => appUser.id),
    service: credentialService().notNull(),
    secretEnc: bytea().notNull(),
    /** Ultime tre lettere dell'utente, per riconoscere quale credenziale c'è. */
    usernameHint: text().notNull(),
    /** Data dell'ultimo cambio della password, dichiarata dal medico (D101). */
    passwordChangedOn: date().notNull(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.service] })],
);

/** Id-Sessione del secondo fattore (D102): cifrato, con la scadenza data dal servizio. */
export const serviceSession = pgTable(
  'service_session',
  {
    userId: uuid()
      .notNull()
      .references(() => appUser.id),
    service: credentialService().notNull(),
    tokenEnc: bytea().notNull(),
    validUntil: timestamp({ withTimezone: true }).notNull(),
    activatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.service] })],
);

/**
 * Che cosa è successo alle credenziali e alle sessioni, senza alcun valore segreto: chi, quando,
 * da quale postazione, con il messaggio del servizio se ha rifiutato. Non si modifica.
 */
export const serviceCredentialEvent = pgTable(
  'service_credential_event',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => appUser.id),
    service: credentialService().notNull(),
    event: text().notNull(),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    workstation: text(),
    detail: text(),
  },
  (t) => [index().on(t.userId)],
);
