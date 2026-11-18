import {
  boolean,
  date,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { clinicalEntry } from './clinical';
import { patient } from './patients';
import { appUser } from './users';

/** Piano terapeutico: farmaco, concessione, scadenza, centro, confezioni autorizzate. */
export const therapeuticPlan = pgTable('therapeutic_plan', {
  id: uuid().primaryKey().defaultRandom(),
  patientId: uuid()
    .notNull()
    .references(() => patient.id),
  drugAic: text(),
  drugName: text().notNull(),
  activeIngredient: text(),
  grantedOn: date().notNull(),
  expiresOn: date().notNull(),
  center: text(),
  specialist: text(),
  packsAuthorized: integer(),
  posologyText: text(),
  /** In Piemonte alcuni piani sono ancora cartacei (es. Nota 85). */
  paperOnly: boolean().notNull().default(false),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const therapyKind = pgEnum('therapy_kind', ['chronic', 'as_needed', 'cycle']);
export const therapyStatus = pgEnum('therapy_status', ['active', 'suspended', 'ended']);

/**
 * Terapia: la scheda in tre parti dei requisiti (il farmaco, come si prende, come va in
 * ricetta) con le sue opzioni. I dati del farmaco sono una copia presa dalla banca dati al
 * momento della scelta.
 */
export const therapy = pgTable('therapy', {
  id: uuid().primaryKey().defaultRandom(),
  patientId: uuid()
    .notNull()
    .references(() => patient.id),
  // Il farmaco
  drugAic: text(),
  drugName: text().notNull(),
  activeIngredient: text(),
  atc: text(),
  drugClass: text(),
  equivalenceGroup: text(),
  dpc: boolean().notNull().default(false),
  // Come si prende
  dose: text(),
  doseUnit: text(),
  frequency: text(),
  timeOfDay: text(),
  route: text(),
  /** Unità al giorno, per il contatore delle confezioni (R11). */
  unitsPerDay: text(),
  kind: therapyKind().notNull(),
  startOn: date().notNull(),
  endOn: date(),
  // Come va in ricetta
  packsPerPrescription: integer().notNull().default(1),
  indicationEntryId: uuid().references(() => clinicalEntry.id),
  habitualExemptionCode: text(),
  aifaNote: text(),
  therapeuticPlanId: uuid().references(() => therapeuticPlan.id),
  suggestedByName: text(),
  suggestedByFacility: text(),
  suggestedOn: date(),
  patientInstructions: text(),
  // Opzioni (Scheda della terapia)
  important: boolean().notNull().default(false),
  reserved: boolean().notNull().default(false),
  notReimbursable: boolean().notNull().default(false),
  byActiveIngredient: boolean().notNull().default(false),
  notSubstitutable: boolean().notNull().default(false),
  notSubstitutableReason: text(),
  multiPrescription: boolean().notNull().default(false),
  suggestedS: boolean().notNull().default(false),
  hospitalH: boolean().notNull().default(false),
  // Stato
  status: therapyStatus().notNull().default('active'),
  suspendedReason: text(),
  createdBy: uuid()
    .notNull()
    .references(() => appUser.id),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
