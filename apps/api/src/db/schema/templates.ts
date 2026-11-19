import type { FilledParts, PrintLayout, TemplateSource } from '@mmg/domain';
import { boolean, date, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { patient } from './patients';
import { studio } from './studio';
import { appUser } from './users';

/**
 * Modelli scritti nello studio (tappa 13): per i certificati che non hanno un modello ufficiale.
 * Testo con i segnaposto dei dati del paziente e del medico; non si cancellano, si archiviano.
 */
export const studioTemplate = pgTable(
  'studio_template',
  {
    id: uuid().primaryKey().defaultRandom(),
    studioId: uuid()
      .notNull()
      .references(() => studio.id),
    title: text().notNull(),
    /** Paragrafi del testo, con i segnaposto. */
    body: jsonb().$type<string[]>().notNull(),
    createdBy: uuid()
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid().references(() => appUser.id),
    updatedAt: timestamp({ withTimezone: true }),
    archivedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.studioId)],
);

/** Un campo del modello com'era compilato al rilascio. */
export interface IssuedField {
  key: string;
  label: string;
  value: string;
}

/**
 * Certificato rilasciato da un modello (tappa 13). Si conserva com'era al rilascio: testo, campi,
 * fonte e versione del modello, impaginazione. Non si modifica: si annulla con un motivo.
 */
export const templateCertificate = pgTable(
  'template_certificate',
  {
    id: uuid().primaryKey().defaultRandom(),
    patientId: uuid()
      .notNull()
      .references(() => patient.id),
    /** Chiave del modello ufficiale, oppure «studio:» e l'identificativo del modello dello studio. */
    templateKey: text().notNull(),
    templateTitle: text().notNull(),
    templateVersion: text().notNull(),
    official: boolean().notNull(),
    source: jsonb().$type<TemplateSource | null>(),
    fields: jsonb().$type<IssuedField[]>().notNull(),
    paragraphs: jsonb().$type<string[]>().notNull(),
    signature: text().notNull(),
    /**
     * Le parti della struttura comune com'erano al rilascio (D158): riferimento normativo, note,
     * luogo e data, altre firme. Vuoto per i certificati rilasciati prima.
     */
    parts: jsonb().$type<FilledParts>(),
    layout: jsonb().$type<PrintLayout>().notNull(),
    issuedOn: date().notNull(),
    /** Fino a quando vale, se il modello ha una validità. */
    validUntil: date(),
    issuedBy: uuid()
      .notNull()
      .references(() => appUser.id),
    issuedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    annulledAt: timestamp({ withTimezone: true }),
    annulledBy: uuid().references(() => appUser.id),
    annulReason: text(),
  },
  (t) => [index().on(t.patientId)],
);
