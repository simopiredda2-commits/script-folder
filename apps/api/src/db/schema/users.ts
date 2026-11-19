import {
  bigint,
  boolean,
  customType,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { studio } from './studio';

/** Byte grezzi (dati cifrati). */
export const bytea = customType<{ data: Buffer }>({ dataType: () => 'bytea' });

export const userRole = pgEnum('user_role', [
  'owner_doctor',
  'secretary',
  'substitute_doctor',
  'administrator',
]);
export const userStatus = pgEnum('user_status', ['active', 'suspended']);

/** Utente: nome, ruoli, secondo fattore, stato. */
export const appUser = pgTable(
  'app_user',
  {
    id: uuid().primaryKey().defaultRandom(),
    studioId: uuid()
      .notNull()
      .references(() => studio.id),
    username: text().notNull(),
    displayName: text().notNull(),
    email: text(),
    passwordHash: text().notNull(),
    roles: userRole().array().notNull(),
    status: userStatus().notNull().default('active'),
    /** Segreto TOTP cifrato con la chiave dell'applicazione. */
    totpSecretEnc: bytea(),
    totpEnabledAt: timestamp({ withTimezone: true }),
    /** Ultimo intervallo TOTP usato: lo stesso codice non vale due volte. */
    totpLastStep: bigint({ mode: 'number' }),
    failedLogins: integer().notNull().default(0),
    lockedUntil: timestamp({ withTimezone: true }),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /**
     * Password temporanea data dall'amministratore: al primo accesso va cambiata prima di ogni
     * altra cosa (tappa 14).
     */
    mustChangePassword: boolean().notNull().default(false),
    passwordChangedAt: timestamp({ withTimezone: true }),
    /**
     * Conferma di un medico titolare (tappa 14): un utente con un ruolo che apre dati dei
     * pazienti, creato dall'amministratore o a cui l'amministratore aggiunge quel ruolo, non entra
     * finché un titolare attivo dello studio non lo conferma. Colonna esplicita: gli utenti di
     * prima, dei dati dimostrativi e delle prove non sono in attesa. Conferme e rifiuti vanno nel
     * registro delle azioni di amministrazione (qui niente storico: la riga ha l'impronta della
     * password e il segreto del secondo fattore).
     */
    awaitingConfirmation: boolean().notNull().default(false),
    /** Chi ha chiesto la conferma (l'amministratore che ha creato o cambiato l'utente) e quando. */
    confirmationRequestedBy: uuid().references((): AnyPgColumn => appUser.id),
    confirmationRequestedAt: timestamp({ withTimezone: true }),
    /**
     * Alla conferma il titolare riceve una password temporanea nuova, da consegnare di persona, e
     * il secondo fattore si riattiva: per gli utenti nuovi e per chi prima non aveva ruoli con i
     * dati dei pazienti, di cui l'amministratore può conoscere le credenziali.
     */
    confirmationIssuesPassword: boolean().notNull().default(false),
    /** Il titolare che ha confermato l'ultima richiesta, e quando. */
    confirmedBy: uuid().references((): AnyPgColumn => appUser.id),
    confirmedAt: timestamp({ withTimezone: true }),
    /**
     * Sospeso da chi gestisce il servizio, sul server (`pnpm utente:ripristina --sospendi` o
     * `--rifiuta`): dal programma non si riattiva, lo riattiva solo il server (`--riattiva`), che
     * toglie il segno. Vale solo mentre l'utente è sospeso (tappa 14, revisione dei poteri
     * dell'amministratore, problema 7).
     */
    suspendedByService: boolean().notNull().default(false),
  },
  (t) => [uniqueIndex('app_user_username_key').on(t.username)],
);

/**
 * Profilo del medico: codice regionale, ASL, intestazioni, timbro. Le credenziali dei servizi
 * esterni stanno in `service_credential` (D100).
 */
export const doctorProfile = pgTable('doctor_profile', {
  userId: uuid()
    .primaryKey()
    .references(() => appUser.id),
  regionalCode: text(),
  /** Codice fiscale del medico: va sul promemoria (DM 2 novembre 2011, allegato 2, campo 20). */
  fiscalCode: text(),
  asl: text(),
  headerText: text(),
  stampText: text(),
  /** Nome e cognome separati, come li vuole il Profilo Sanitario Sintetico (tappa 11). */
  firstName: text(),
  lastName: text(),
  /** Recapiti di studio: il Profilo Sanitario Sintetico ne vuole almeno uno (tappa 11). */
  phone: text(),
  email: text(),
  pec: text(),
  /**
   * Impaginazione dei certificati dai modelli, scelta dal medico (tappa 13): carattere standard
   * del PDF, dimensione, allineamento dell'intestazione (`headerText`, una riga per riga), margini,
   * luogo proposto per «luogo e data». Il timbro è `stampText`.
   */
  printFont: text().notNull().default('sans'),
  printFontSize: integer().notNull().default(11),
  printHeaderAlign: text().notNull().default('left'),
  printMarginMm: integer().notNull().default(20),
  printPlace: text(),
});

/** Archivio dei pazienti di un medico titolare. In medicina di gruppo ce n'è uno per titolare. */
export const archive = pgTable('archive', {
  id: uuid().primaryKey().defaultRandom(),
  studioId: uuid()
    .notNull()
    .references(() => studio.id),
  ownerUserId: uuid()
    .notNull()
    .references(() => appUser.id),
  name: text().notNull(),
  /**
   * Il titolare decide che cosa vede la segreteria del suo archivio, oltre ad anagrafica e
   * terapie non riservate (D30). Spenti per difetto; da confermare con il consulente privacy.
   */
  secretaryCanReadDiary: boolean().notNull().default(false),
  secretaryCanReadSummary: boolean().notNull().default(false),
});

export const grantKind = pgEnum('grant_kind', ['substitution', 'group_colleague']);

/** Autorizzazione di un medico su un archivio non suo: sostituzione o medicina di gruppo. */
export const archiveGrant = pgTable('archive_grant', {
  id: uuid().primaryKey().defaultRandom(),
  archiveId: uuid()
    .notNull()
    .references(() => archive.id),
  granteeUserId: uuid()
    .notNull()
    .references(() => appUser.id),
  kind: grantKind().notNull(),
  validFrom: timestamp({ withTimezone: true }).notNull(),
  validTo: timestamp({ withTimezone: true }).notNull(),
  reason: text().notNull(),
  grantedBy: uuid()
    .notNull()
    .references(() => appUser.id),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp({ withTimezone: true }),
});

/** Sessione di lavoro su una postazione. Il token è conservato solo come impronta. */
export const session = pgTable(
  'session',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => appUser.id),
    tokenHash: text().notNull(),
    workstation: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    lastActivityAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    lockedAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
  },
  (t) => [uniqueIndex('session_token_hash_key').on(t.tokenHash), index().on(t.userId)],
);

export const challengePurpose = pgEnum('challenge_purpose', ['second_factor', 'enroll']);

/** Passo intermedio dell'accesso: password giusta, secondo fattore ancora da verificare. */
export const authChallenge = pgTable(
  'auth_challenge',
  {
    id: uuid().primaryKey().defaultRandom(),
    userId: uuid()
      .notNull()
      .references(() => appUser.id),
    tokenHash: text().notNull(),
    purpose: challengePurpose().notNull(),
    workstation: text().notNull(),
    /** Segreto TOTP proposto durante l'attivazione, cifrato. */
    pendingSecretEnc: bytea(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    usedAt: timestamp({ withTimezone: true }),
    /**
     * Codici provati su questo passaggio, giusti o sbagliati: ogni codice si conta prima di
     * guardarlo, in un solo comando, e arrivati ai tentativi dello studio il passaggio non ne
     * guarda altri (tappa 14, seconda revisione dei poteri dell'amministratore: con le richieste
     * in parallelo il conto dopo la verifica lasciava passare centinaia di codici). La colonna si
     * chiama ancora `failed_codes` dalla migrazione 0025, quando contava solo i codici sbagliati.
     */
    triedCodes: integer('failed_codes').notNull().default(0),
  },
  (t) => [uniqueIndex('auth_challenge_token_hash_key').on(t.tokenHash)],
);
