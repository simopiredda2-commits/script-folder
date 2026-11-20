import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { patient } from './patients';
import { referenceDataset } from './reference';
import { appUser, archive } from './users';

/** Dove si esegue la prestazione: a domicilio o in studio (ACN 2022-2024, allegato 6, comma 2). */
export const ppipPlace = pgEnum('ppip_place', ['studio', 'home']);
export const ppipStatus = pgEnum('ppip_status', ['active', 'annulled']);
export const ppipReportOutcome = pgEnum('ppip_report_outcome', [
  'accepted',
  'rejected',
  'unreachable',
]);

/**
 * Invio della distinta mensile delle prestazioni aggiuntive all'ASL (allegato 6, comma 4: «entro il
 * giorno 15 di ciascun mese il riepilogo delle prestazioni eseguite nel corso del mese precedente»).
 * Il collegamento con il portale regionale è da completare (D212): qui l'esito di ogni invio, con
 * la distinta come è partita. Non si modifica e non si cancella.
 */
export const ppipReport = pgTable(
  'ppip_report',
  {
    id: uuid().primaryKey().defaultRandom(),
    archiveId: uuid()
      .notNull()
      .references(() => archive.id),
    /** Mese delle prestazioni, AAAA-MM. */
    month: text().notNull(),
    outcome: ppipReportOutcome().notNull(),
    /** Numero o ricevuta del portale, se l'ha accolta. */
    protocol: text(),
    message: text(),
    /** Ambiente del portale: «simulator» finché il collegamento vero non c'è. */
    environment: text().notNull(),
    lines: integer().notNull(),
    total: numeric({ precision: 12, scale: 2 }),
    /** La distinta come è stata mandata. */
    content: jsonb().notNull(),
    sentBy: uuid()
      .notNull()
      .references(() => appUser.id),
    sentAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [index().on(t.archiveId, t.month)],
);

/**
 * Prestazione aggiuntiva eseguita (requisiti, «Certificati e moduli»: «PPIP: registrazione delle
 * prestazioni di particolare impegno professionale e riepilogo mensile»; D212). Voce, sezione e
 * compenso vengono dal catalogo in vigore il giorno dell'esecuzione e restano come erano anche
 * quando il catalogo cambia. Non si cancella: si annulla con un motivo.
 */
export const ppipRecord = pgTable(
  'ppip_record',
  {
    id: uuid().primaryKey().defaultRandom(),
    patientId: uuid()
      .notNull()
      .references(() => patient.id),
    performedOn: date().notNull(),
    code: text().notNull(),
    section: text().notNull(),
    description: text().notNull(),
    /** Prestazione soggetta ad autorizzazione (sezione B dell'allegato 6). */
    authorizationRequired: boolean().notNull(),
    /** Compenso di una prestazione secondo il catalogo, in euro; vuoto se il catalogo non lo dice. */
    unitCompensation: numeric({ precision: 12, scale: 2 }),
    /** Versione del catalogo da cui vengono voce e compenso. */
    datasetId: uuid()
      .notNull()
      .references(() => referenceDataset.id),
    quantity: integer().notNull().default(1),
    place: ppipPlace().notNull(),
    /** Estremi dell'autorizzazione (allegato 6, comma 5): obbligatori per la sezione B. */
    authorizationRef: text(),
    notes: text(),
    status: ppipStatus().notNull().default('active'),
    /** Invio in cui la prestazione è partita: dopo, non si annulla più qui. */
    reportId: uuid().references(() => ppipReport.id),
    annulledAt: timestamp({ withTimezone: true }),
    annulledBy: uuid().references(() => appUser.id),
    annulReason: text(),
    createdBy: uuid()
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.patientId), index().on(t.performedOn)],
);
