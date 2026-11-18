import { pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { patient } from './patients';
import { studio } from './studio';
import { appUser } from './users';

export const appointmentKind = pgEnum('appointment_kind', ['office', 'home', 'televisit']);
export const appointmentStatus = pgEnum('appointment_status', [
  'booked',
  'done',
  'cancelled',
  'no_show',
]);

/** Appuntamento: visite in studio, domicili e televisite. */
export const appointment = pgTable('appointment', {
  id: uuid().primaryKey().defaultRandom(),
  studioId: uuid()
    .notNull()
    .references(() => studio.id),
  patientId: uuid().references(() => patient.id),
  doctorUserId: uuid()
    .notNull()
    .references(() => appUser.id),
  startsAt: timestamp({ withTimezone: true }).notNull(),
  endsAt: timestamp({ withTimezone: true }).notNull(),
  kind: appointmentKind().notNull(),
  status: appointmentStatus().notNull().default('booked'),
  notes: text(),
  createdBy: uuid()
    .notNull()
    .references(() => appUser.id),
});

export const requestKind = pgEnum('patient_request_kind', [
  'therapy_repeat',
  'certificate',
  'appointment',
  'other',
]);
export const requestStatus = pgEnum('patient_request_status', [
  'open',
  'in_progress',
  'done',
  'rejected',
]);

/** Richiesta del paziente: ripetizione di terapie, certificati, appuntamenti. */
export const patientRequest = pgTable('patient_request', {
  id: uuid().primaryKey().defaultRandom(),
  patientId: uuid()
    .notNull()
    .references(() => patient.id),
  kind: requestKind().notNull(),
  text: text(),
  status: requestStatus().notNull().default('open'),
  outcome: text(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  handledBy: uuid().references(() => appUser.id),
});
