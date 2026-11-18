import {
  date,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { studio } from './studio';
import { appUser, archive } from './users';

/** Nucleo familiare: per la ricerca per famiglia e per i collegamenti tra assistiti. */
export const family = pgTable('family', {
  id: uuid().primaryKey().defaultRandom(),
  studioId: uuid()
    .notNull()
    .references(() => studio.id),
  label: text().notNull(),
});

export const patientStatus = pgEnum('patient_status', [
  'active',
  'revoked',
  'deceased',
  'temporary',
]);
export const sex = pgEnum('sex', ['M', 'F']);
/** Canali del promemoria della ricetta (Consegna al paziente, R15). */
export const reminderChannel = pgEnum('reminder_channel', [
  'paper',
  'email',
  'pec',
  'sms',
  'messaging_app',
  'phone',
  'fse',
]);

/** Paziente: anagrafica, dati SSN, recapiti, lavoro e stato. */
export const patient = pgTable(
  'patient',
  {
    id: uuid().primaryKey().defaultRandom(),
    studioId: uuid()
      .notNull()
      .references(() => studio.id),
    archiveId: uuid()
      .notNull()
      .references(() => archive.id),
    familyId: uuid().references(() => family.id),
    firstName: text().notNull(),
    lastName: text().notNull(),
    sex: sex().notNull(),
    birthDate: date().notNull(),
    birthPlaceCode: text(),
    birthPlaceName: text(),
    fiscalCode: text().notNull(),
    phone: text(),
    email: text(),
    residenceStreet: text(),
    residenceNumber: text(),
    residenceTown: text(),
    residenceProvince: text(),
    residencePostalCode: text(),
    domicile: text(),
    asl: text(),
    district: text(),
    assistanceType: text(),
    status: patientStatus().notNull().default('active'),
    deceasedOn: date(),
    /** Causa del decesso in ICD. */
    deathCauseIcd: text(),
    /** Cittadini stranieri: tessera europea (TEAM) ed ente estero. */
    foreignHealthCard: text(),
    foreignInstitution: text(),
    occupation: text(),
    employmentCondition: text(),
    /** Email del datore di lavoro per i certificati INPS. */
    employerEmail: text(),
    /** Canale preferito per il promemoria, con recapito e data della scelta (R15). */
    reminderChannel: reminderChannel(),
    reminderContact: text(),
    reminderChannelChosenOn: date(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('patient_studio_fiscal_code_key').on(t.studioId, t.fiscalCode),
    index().on(t.archiveId),
    index().on(t.lastName, t.firstName),
  ],
);

export const dataSource = pgEnum('data_source', ['aura', 'manual']);

/** Scelta e revoca del medico (sincronizzate con AURA). */
export const patientChoice = pgTable('patient_choice', {
  id: uuid().primaryKey().defaultRandom(),
  patientId: uuid()
    .notNull()
    .references(() => patient.id),
  doctorUserId: uuid()
    .notNull()
    .references(() => appUser.id),
  chosenOn: date().notNull(),
  expiresOn: date(),
  endedOn: date(),
  endReason: text(),
  source: dataSource().notNull(),
});

/** Esenzione: codice, validità e codice da riportare in ricetta. */
export const exemption = pgTable('exemption', {
  id: uuid().primaryKey().defaultRandom(),
  patientId: uuid()
    .notNull()
    .references(() => patient.id),
  code: text().notNull(),
  validFrom: date().notNull(),
  validTo: date(),
  prescriptionCode: text(),
  source: dataSource().notNull(),
});

export const consentStatus = pgEnum('consent_status', ['given', 'refused', 'revoked']);

/** Consensi, compreso quello al Fascicolo Sanitario Elettronico. */
export const consent = pgTable('consent', {
  id: uuid().primaryKey().defaultRandom(),
  patientId: uuid()
    .notNull()
    .references(() => patient.id),
  kind: text().notNull(),
  status: consentStatus().notNull(),
  givenOn: date(),
  revokedOn: date(),
  notes: text(),
});

/** Delega: chi può ricevere ricette e promemoria per il paziente (R16). */
export const delegation = pgTable('delegation', {
  id: uuid().primaryKey().defaultRandom(),
  patientId: uuid()
    .notNull()
    .references(() => patient.id),
  delegateName: text().notNull(),
  delegateFiscalCode: text(),
  delegatePhone: text(),
  delegateEmail: text(),
  scope: text().notNull(),
  validFrom: date().notNull(),
  validTo: date(),
  revokedOn: date(),
});
