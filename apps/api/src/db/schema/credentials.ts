import { sql, type SQL } from 'drizzle-orm';
import {
  check,
  date,
  index,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { appUser, bytea } from './users';

/**
 * Il servizio con le credenziali del medico (D100, D301): il Sistema TS o il servizio di una
 * regione, con la chiave che dà il suo pacchetto. Testo con la forma di una chiave, non un tipo
 * enumerato: le chiavi delle regioni sono dei pacchetti, e quelle già salvate restano come sono,
 * perché utente, password e PIN sono cifrati con loro.
 */
const serviceKey = (column: AnyPgColumn): SQL => sql`${column} ~ '^[a-z][a-z0-9_]{1,39}$'`;

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
    service: text().notNull(),
    secretEnc: bytea().notNull(),
    /** Ultime tre lettere dell'utente, per riconoscere quale credenziale c'è. */
    usernameHint: text().notNull(),
    /** Data dell'ultimo cambio della password, dichiarata dal medico (D101). */
    passwordChangedOn: date().notNull(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.service] }),
    check('service_credential_service', serviceKey(t.service)),
  ],
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
    service: text().notNull(),
    tokenEnc: bytea().notNull(),
    validUntil: timestamp({ withTimezone: true }).notNull(),
    activatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    mode: sessionMode().notNull().default('email'),
    /** Codice fiscale di chi è entrato con SPID o CIE (sub del token), per verifica e revoca. */
    subject: text(),
    /**
     * Con SPID o CIE: il `client_id` per cui la regione ha dato il token, che la revoca deve
     * ripetere (D301). Una sessione di prima della migrazione 0062 non ce l'ha: si chiude solo qui.
     */
    clientId: text(),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.service] }),
    check('service_session_service', serviceKey(t.service)),
  ],
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
    /** Il servizio della regione per cui il medico entra (D301): il ritorno è di quel servizio. */
    service: text().notNull(),
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
  (t) => [
    uniqueIndex().on(t.stateHash),
    check('regional_authorization_request_service', serviceKey(t.service)),
  ],
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
    service: text().notNull(),
    event: text().notNull(),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    workstation: text(),
    detail: text(),
  },
  (t) => [index().on(t.userId), check('service_credential_event_service', serviceKey(t.service))],
);
