import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { patient } from './patients';
import { sendErrorKind } from './prescriptions';
import { appUser, archive } from './users';

/** Stati del certificato nel programma (packages/domain, `certificateTransition`). */
export const certificateStatus = pgEnum('certificate_status', [
  'draft',
  'sending',
  'sent',
  'error',
  'cancelled',
  'rectified',
]);

/**
 * Certificato di malattia telematico (tappa 8). I valori dei campi sono quelli delle specifiche
 * INPS del Sistema TS, versione 3.2 (tipoCertificato, tipoVisita, ruolo, agevolazioni). Residenza,
 * reperibilità e dati di lavoratore e medico si fissano: la copia resta identica anche se poi
 * cambia l'anagrafica. Storico e divieto di cancellazione come gli altri dati dei pazienti.
 */
export const sickLeaveCertificate = pgTable(
  'sick_leave_certificate',
  {
    id: uuid().primaryKey().defaultRandom(),
    patientId: uuid()
      .notNull()
      .references(() => patient.id),
    archiveId: uuid()
      .notNull()
      .references(() => archive.id),
    status: certificateStatus().notNull().default('draft'),
    /** I, C, R: inizio, continuazione, ricaduta. */
    type: text().notNull(),
    /** A, D, P: ambulatoriale, domiciliare, pronto soccorso. */
    visit: text().notNull(),
    /** S, P: medico del SSN o libero professionista. */
    role: text().notNull().default('S'),
    releaseDate: date().notNull(),
    startDate: date().notNull(),
    endDate: date().notNull(),
    diagnosisCode: text(),
    diagnosisNotes: text(),
    workedDay: boolean().notNull().default(false),
    trauma: boolean().notNull().default(false),
    /** T, C, I: agevolazioni del modello. */
    benefits: text(),
    /** Residenza o domicilio abituale: via, numero (SNC), CAP, comune, provincia. */
    residence: jsonb().notNull(),
    /** Reperibilità, se diversa dalla residenza: nominativo presso l'abitazione e indirizzo. */
    availability: jsonb(),
    /** Lavoratore, medico e luogo come all'invio. */
    snapshot: jsonb(),
    /** Numero di protocollo (idCertificato) e data di ricezione dell'INPS. */
    protocol: text(),
    receivedAt: timestamp({ withTimezone: true }),
    /** Certificato rettificato da questo: il suo protocollo va sulla copia. */
    rectifiesId: uuid(),
    cancelProtocol: text(),
    cancelledAt: timestamp({ withTimezone: true }),
    cancelledBy: uuid().references(() => appUser.id),
    cancelReason: text(),
    preparedBy: uuid()
      .notNull()
      .references(() => appUser.id),
    signedBy: uuid().references(() => appUser.id),
    signedAt: timestamp({ withTimezone: true }),
    lastErrorKind: sendErrorKind(),
    lastErrorCode: text(),
    lastErrorMessage: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.patientId)],
);

/** Ogni chiamata all'INPS, riuscita o no: richiesta (senza credenziali), risposta, esito. */
export const certificateSubmission = pgTable(
  'certificate_submission',
  {
    id: uuid().primaryKey().defaultRandom(),
    certificateId: uuid()
      .notNull()
      .references(() => sickLeaveCertificate.id),
    operation: text().notNull(),
    environment: text().notNull(),
    userId: uuid()
      .notNull()
      .references(() => appUser.id),
    request: jsonb(),
    response: jsonb(),
    outcome: text().notNull(),
    errorCode: text(),
    errorMessage: text(),
    durationMs: integer(),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.certificateId)],
);

/** Stampe e consegne di copia e attestato: chi, quando, a chi, con quale esito. */
export const certificateDelivery = pgTable(
  'certificate_delivery',
  {
    id: uuid().primaryKey().defaultRandom(),
    certificateId: uuid()
      .notNull()
      .references(() => sickLeaveCertificate.id),
    userId: uuid()
      .notNull()
      .references(() => appUser.id),
    channel: text().notNull(),
    recipient: text(),
    environment: text(),
    outcome: text().notNull(),
    messageId: text(),
    errorMessage: text(),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.certificateId)],
);
