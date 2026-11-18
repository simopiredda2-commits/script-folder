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
  },
  (t) => [uniqueIndex('app_user_username_key').on(t.username)],
);

/** Profilo del medico: codice regionale, ASL, intestazioni, timbro, credenziali esterne cifrate. */
export const doctorProfile = pgTable('doctor_profile', {
  userId: uuid()
    .primaryKey()
    .references(() => appUser.id),
  regionalCode: text(),
  asl: text(),
  headerText: text(),
  stampText: text(),
  /** Credenziali verso Sistema TS e Regione, cifrate. Mai in chiaro. */
  externalCredentialsEnc: bytea(),
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
  },
  (t) => [uniqueIndex('auth_challenge_token_hash_key').on(t.tokenHash)],
);
