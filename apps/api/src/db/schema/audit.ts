import {
  bigint,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { patient } from './patients';
import { studio } from './studio';
import { appUser } from './users';

/**
 * Registro degli accessi: chi ha aperto quale cartella, quando, da quale postazione.
 * Non modificabile: un trigger rifiuta UPDATE, DELETE e TRUNCATE, e ogni riga porta
 * l'impronta della precedente (catena verificabile). Vedi la migrazione 0002.
 */
export const accessLog = pgTable(
  'access_log',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    /** Posizione nella catena: 1, 2, 3… senza buchi. La assegna il database. */
    seq: bigint({ mode: 'number' }).notNull().default(0),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    studioId: uuid().references(() => studio.id),
    userId: uuid().references(() => appUser.id),
    patientId: uuid().references(() => patient.id),
    action: text().notNull(),
    outcome: text().notNull(),
    workstation: text(),
    details: jsonb().notNull().default({}),
    /** Impronte della catena: le calcola il database. */
    prevHash: text().notNull().default(''),
    hash: text().notNull().default(''),
  },
  (t) => [
    uniqueIndex('access_log_seq_key').on(t.seq),
    index().on(t.patientId, t.at),
    index().on(t.userId, t.at),
  ],
);

/**
 * Storico delle modifiche: ogni inserimento e modifica dei dati del paziente, con chi l'ha
 * fatta. Lo scrivono i trigger del database; anche questo non è modificabile.
 */
export const changeHistory = pgTable(
  'change_history',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    userId: uuid(),
    tableName: text().notNull(),
    rowId: text().notNull(),
    operation: text().notNull(),
    oldRow: jsonb(),
    newRow: jsonb(),
  },
  (t) => [index().on(t.tableName, t.rowId)],
);
