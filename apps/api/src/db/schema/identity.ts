import { pgEnum, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { appUser, bytea } from './users';

/** Perché si entra con SPID o CIE (D189): ripristinare le credenziali, o collegare l'identità. */
export const identityPurpose = pgEnum('identity_purpose', ['recovery', 'link']);

/**
 * Richieste di accesso con SPID o CIE in corso (D189), come quelle dell'accesso regionale (D111):
 * impronta dello state, code_verifier cifrato, brevi e monouso. Per il ripristino l'utente si
 * conosce dal nome scritto e può mancare (nome sconosciuto o utente che non può ripristinare: la
 * risposta all'avvio è la stessa); dopo il riconoscimento la richiesta porta l'impronta del
 * passaggio con cui si sceglie la password nuova.
 */
export const identityRequest = pgTable(
  'identity_request',
  {
    id: uuid().primaryKey().defaultRandom(),
    purpose: identityPurpose().notNull(),
    userId: uuid().references(() => appUser.id),
    stateHash: text().notNull(),
    verifierEnc: bytea().notNull(),
    redirectUri: text().notNull(),
    /** Postazione scritta e indirizzo della richiesta, per il registro. */
    workstation: text(),
    address: text(),
    createdAt: timestamp({ withTimezone: true }).notNull(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    /** Ritorno da SPID o CIE consumato (una volta sola). */
    returnedAt: timestamp({ withTimezone: true }),
    /** Riconosciuta la persona: impronta del passaggio per la password nuova, e fino a quando. */
    recoveryTokenHash: text(),
    recoveryUntil: timestamp({ withTimezone: true }),
    /** SPID o CIE, come l'ha detto il gestore dell'identità. */
    method: text(),
    /** Password nuova scelta (ripristino concluso). */
    completedAt: timestamp({ withTimezone: true }),
  },
  (t) => [uniqueIndex().on(t.stateHash), uniqueIndex().on(t.recoveryTokenHash)],
);
