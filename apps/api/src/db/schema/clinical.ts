import {
  boolean,
  date,
  index,
  integer,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { patient } from './patients';
import { appUser } from './users';

export const clinicalEntryKind = pgEnum('clinical_entry_kind', [
  'problem',
  'diary',
  'measurement',
  'anamnesis',
  'allergy',
  'risk_factor',
  'examination',
  'vaccination',
  'lab_result',
  'report',
]);
export const entryStatus = pgEnum('entry_status', ['active', 'annulled']);

/**
 * Voce clinica: i campi comuni a tutti i tipi. Il dettaglio è nella tabella del suo tipo.
 * Le voci non si cancellano mai: si annullano con un motivo (trigger nel database).
 */
export const clinicalEntry = pgTable(
  'clinical_entry',
  {
    id: uuid().primaryKey().defaultRandom(),
    patientId: uuid()
      .notNull()
      .references(() => patient.id),
    kind: clinicalEntryKind().notNull(),
    occurredOn: date().notNull(),
    authorUserId: uuid()
      .notNull()
      .references(() => appUser.id),
    notes: text(),
    /** Visibile solo al medico. */
    reserved: boolean().notNull().default(false),
    /** Oscurato su richiesta del paziente (privacy, Fascicolo). */
    obscured: boolean().notNull().default(false),
    /** Promemoria collegato alla voce. */
    reminderOn: date(),
    status: entryStatus().notNull().default('active'),
    annulledAt: timestamp({ withTimezone: true }),
    annulledBy: uuid().references(() => appUser.id),
    annulReason: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.patientId, t.occurredOn)],
);

const entryRef = () =>
  uuid()
    .primaryKey()
    .references(() => clinicalEntry.id);

export const problemState = pgEnum('problem_state', ['active', 'resolved']);

/** Problema o diagnosi, in ICD-9-CM (dal 2027 ICD-10-IM). */
export const problemDetail = pgTable('problem_detail', {
  entryId: entryRef(),
  icdCode: text(),
  icdSystem: text().notNull().default('ICD-9-CM'),
  description: text().notNull(),
  state: problemState().notNull().default('active'),
  onsetOn: date(),
  resolvedOn: date(),
  /** Quesito diagnostico ancora aperto. */
  openQuestion: boolean().notNull().default(false),
});

export const contactType = pgEnum('contact_type', ['office', 'home', 'phone', 'televisit']);

/** Nota del diario clinico, per tipo di contatto. */
export const diaryDetail = pgTable('diary_detail', {
  entryId: entryRef(),
  contactType: contactType().notNull(),
  text: text().notNull(),
});

/** Parametro o misura: pressione, peso, altezza, BMI, glicemia, saturazione… */
export const measurementDetail = pgTable('measurement_detail', {
  entryId: entryRef(),
  measure: text().notNull(),
  value: numeric().notNull(),
  unit: text().notNull(),
});

export const anamnesisSection = pgEnum('anamnesis_section', [
  'family',
  'physiological',
  'remote_pathological',
  'pregnancies',
]);

export const anamnesisDetail = pgTable('anamnesis_detail', {
  entryId: entryRef(),
  section: anamnesisSection().notNull(),
  text: text().notNull(),
});

/** Allergia o reazione avversa: sempre visibile in testata. */
export const allergyDetail = pgTable('allergy_detail', {
  entryId: entryRef(),
  substance: text().notNull(),
  reaction: text(),
  drugRelated: boolean().notNull().default(false),
});

/** Stili di vita e fattori di rischio: fumo, alcol, attività fisica. */
export const riskFactorDetail = pgTable('risk_factor_detail', {
  entryId: entryRef(),
  factor: text().notNull(),
  value: text().notNull(),
});

/** Esame obiettivo e valutazioni, comprese le schede UVG. */
export const examinationDetail = pgTable('examination_detail', {
  entryId: entryRef(),
  text: text().notNull(),
  scale: text(),
  score: text(),
});

/** Vaccinazione con lotto. */
export const vaccinationDetail = pgTable('vaccination_detail', {
  entryId: entryRef(),
  vaccine: text().notNull(),
  lot: text(),
  doseNumber: integer(),
  campaign: text(),
});

/** Risultato di laboratorio come valore strutturato. */
export const labResultDetail = pgTable('lab_result_detail', {
  entryId: entryRef(),
  analyte: text().notNull(),
  value: text().notNull(),
  unit: text(),
  referenceLow: text(),
  referenceHigh: text(),
  referenceText: text(),
  serviceCode: text(),
});

/** Referto (esami strumentali, specialistica): il file è un allegato. */
export const reportDetail = pgTable('report_detail', {
  entryId: entryRef(),
  title: text().notNull(),
  facility: text(),
});

/** Allegato di una voce: referti e documenti in PDF o immagine. */
export const attachment = pgTable('attachment', {
  id: uuid().primaryKey().defaultRandom(),
  entryId: uuid()
    .notNull()
    .references(() => clinicalEntry.id),
  filename: text().notNull(),
  mediaType: text().notNull(),
  sizeBytes: integer().notNull(),
  sha256: text().notNull(),
  storageKey: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
