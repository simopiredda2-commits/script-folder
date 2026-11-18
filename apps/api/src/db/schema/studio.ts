import { pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Tipo di studio: medico singolo o medicina di gruppo (più titolari, archivi separati). */
export const studioKind = pgEnum('studio_kind', ['single', 'group']);

/** Studio medico: tutti i dati sono separati per studio. */
export const studio = pgTable('studio', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  address: text(),
  kind: studioKind().notNull().default('single'),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});
