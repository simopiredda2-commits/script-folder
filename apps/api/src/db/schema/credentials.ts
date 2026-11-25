import {
  date,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
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

/** Come si è ottenuto il codice di sessione: per email (D102) o con SPID o CIE (D109). */
export const sessionMode = pgEnum('session_mode', ['email', 'spid_cie']);

/**
 * Id-Sessione del secondo fattore (D102) o token dell'accesso regionale con SPID o CIE (D109):
 * cifrato, con la scadenza data dal servizio.
 */
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
    mode: sessionMode().notNull().default('email'),
    /** Codice fiscale di chi è entrato con SPID o CIE (sub del token), per verifica e revoca. */
    subject: text(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.service] })],
);

/**
 * Richieste di accesso regionale in corso (D109): impronta dello state e code_verifier cifrato.
 * Brevi e monouso: il ritorno dalla Regione deve portare lo state di una richiesta di quel medico.
 */
export const regionalAuthorizationRequest = pgTable(
  'regional_authorization_request',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => appUser.id),
    stateHash: text().notNull(),
    verifierEnc: bytea().notNull(),
    redirectUri: text().notNull(),
    /**
     * Il `client_id` con cui la richiesta è partita: codice del gestionale e codice ASL del medico
     * (D266). Lo scambio del codice deve usare lo stesso, anche se nel frattempo cambia l'ASL.
     */
    clientId: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    usedAt: timestamp({ withTimezone: true }),
  },
  (t) => [uniqueIndex().on(t.stateHash)],
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
