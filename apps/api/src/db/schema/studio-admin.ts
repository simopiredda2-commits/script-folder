import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { studio } from './studio';
import { appUser } from './users';

/**
 * Postazioni dello studio (tappa 14): il nome che ognuno scrive all'accesso, condivisa (ambulatorio,
 * segreteria) o personale. Servono a ricordare le preferenze di stampa di ogni computer. Non si
 * cancellano: si archiviano.
 */
export const workstation = pgTable(
  'workstation',
  {
    id: uuid().primaryKey().defaultRandom(),
    studioId: uuid()
      .notNull()
      .references(() => studio.id),
    name: text().notNull(),
    shared: boolean().notNull().default(true),
    notes: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex('workstation_name_key')
      .on(t.studioId, sql`lower(${t.name})`)
      .where(sql`${t.archivedAt} is null`),
  ],
);

/**
 * Preferenze di stampa per tipo di documento (tappa 14): per lo studio (postazione vuota) e, se
 * serve, per una postazione. La stampante si sceglie comunque nella finestra di stampa del browser:
 * il programma propone quella preferita, il numero di copie e, dove il formato non è fissato da un
 * atto, la carta.
 */
export const printSetting = pgTable(
  'print_setting',
  {
    id: uuid().primaryKey().defaultRandom(),
    studioId: uuid()
      .notNull()
      .references(() => studio.id),
    workstationId: uuid().references(() => workstation.id),
    /** Tipo di documento (`PRINT_DOCUMENT_KINDS` del dominio). */
    documentKind: text().notNull(),
    printerName: text(),
    /** Formato della carta, dove il documento lo consente: «A4» o «A5». */
    paper: text(),
    copies: integer().notNull().default(1),
    /** Solo per il promemoria: «completo» o «solo_nre». */
    reminderVariant: text(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid().references(() => appUser.id),
  },
  (t) => [
    uniqueIndex('print_setting_key').on(
      t.studioId,
      sql`coalesce(${t.workstationId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
      t.documentKind,
    ),
  ],
);

export const studioListKind = pgEnum('studio_list_kind', [
  'suggeritore',
  'posologia',
  'pacchetto',
  'contatto',
]);

/**
 * Elenchi dello studio (tappa 14): medici suggeritori, posologie, pacchetti di prestazioni, contatti
 * utili. I campi di ogni tipo sono in `data`, controllati dal servizio. Non si cancellano: si
 * archiviano, perché una terapia o una ricetta può averli usati.
 */
export const studioListItem = pgTable(
  'studio_list_item',
  {
    id: uuid().primaryKey().defaultRandom(),
    studioId: uuid()
      .notNull()
      .references(() => studio.id),
    kind: studioListKind().notNull(),
    label: text().notNull(),
    data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdBy: uuid()
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.studioId, t.kind)],
);
