import {
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { patient } from './patients';
import { studio } from './studio';
import { appUser, archive } from './users';

/**
 * Profili d'importazione (tappa 15): per un programma d'origine e un tipo di file, quale
 * destinazione, quali colonne verso quali campi, quali valori convertire. Si riusano alla
 * seconda importazione. Non si cancellano: si archiviano.
 */
export const importProfile = pgTable('import_profile', {
  id: uuid().primaryKey().defaultRandom(),
  studioId: uuid()
    .notNull()
    .references(() => studio.id),
  name: text().notNull(),
  /** Programma d'origine, come lo scrive chi importa. */
  sourceProgram: text(),
  /** Formato del file: csv, xlsx, json, fhir e gli altri del motore d'importazione. */
  format: text().notNull(),
  /** Destinazione (catalogo delle destinazioni del dominio). */
  destination: text().notNull(),
  mapping: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  options: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  createdBy: uuid()
    .notNull()
    .references(() => appUser.id),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  archivedAt: timestamp({ withTimezone: true }),
});

/**
 * Un'importazione: il file (nome, impronta, dimensione; il contenuto non si conserva), dove va,
 * con quale mappatura, l'esito riga per riga. «prova» è la prova senza scrivere; «importato» ha
 * scritto le righe valide.
 */
export const importBatch = pgTable(
  'import_batch',
  {
    id: uuid().primaryKey().defaultRandom(),
    studioId: uuid()
      .notNull()
      .references(() => studio.id),
    archiveId: uuid()
      .notNull()
      .references(() => archive.id),
    userId: uuid()
      .notNull()
      .references(() => appUser.id),
    profileId: uuid().references(() => importProfile.id),
    sourceProgram: text(),
    fileName: text().notNull(),
    fileSha256: text().notNull(),
    fileSize: integer().notNull(),
    format: text().notNull(),
    destination: text().notNull(),
    mapping: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    options: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    status: text().notNull(),
    /** Conteggi: righe lette, scritte, già presenti, scartate, con avvisi. */
    counts: jsonb().$type<Record<string, number>>().notNull().default({}),
    /** Esito riga per riga (errori e avvisi), con un limite di righe. */
    report: jsonb().$type<unknown[]>().notNull().default([]),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.archiveId, t.createdAt)],
);

/**
 * Provenienza di ogni riga importata: tabella e riga scritte, chiave nel programma d'origine.
 * Serve a non duplicare a una seconda importazione e a riconoscere i dati importati.
 */
export const importOrigin = pgTable(
  'import_origin',
  {
    id: uuid().primaryKey().defaultRandom(),
    batchId: uuid()
      .notNull()
      .references(() => importBatch.id),
    archiveId: uuid()
      .notNull()
      .references(() => archive.id),
    tableName: text().notNull(),
    rowId: uuid().notNull(),
    /** Identificativo nel programma d'origine, o impronta della riga se il file non ne ha. */
    sourceKey: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('import_origin_source_key').on(t.archiveId, t.tableName, t.sourceKey),
    index().on(t.tableName, t.rowId),
  ],
);

/**
 * Ricette fatte con un altro programma, per lo storico dei farmaci e delle prestazioni prescritti
 * (tappa 15). Non sono ricette di questo programma: non si firmano, non si inviano, non si
 * annullano verso il SAR. Si annullano qui con un motivo, se importate per errore.
 */
export const historicalPrescription = pgTable(
  'historical_prescription',
  {
    id: uuid().primaryKey().defaultRandom(),
    patientId: uuid()
      .notNull()
      .references(() => patient.id),
    archiveId: uuid()
      .notNull()
      .references(() => archive.id),
    /** «farmaco» o «prestazione». */
    kind: text().notNull(),
    prescribedOn: date().notNull(),
    drugAic: text(),
    drugName: text(),
    activeIngredient: text(),
    atcCode: text(),
    quantity: integer(),
    posologyText: text(),
    serviceCode: text(),
    serviceDescription: text(),
    nre: text(),
    prescriberName: text(),
    notes: text(),
    sourceProgram: text(),
    importBatchId: uuid().references(() => importBatch.id),
    recordedBy: uuid()
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    annulledAt: timestamp({ withTimezone: true }),
    annulReason: text(),
  },
  (t) => [index().on(t.patientId, t.prescribedOn)],
);
