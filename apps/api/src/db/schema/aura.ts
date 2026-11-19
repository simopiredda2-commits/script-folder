import type { AuraRegistry } from '@mmg/integrations';
import {
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

/**
 * Collegamento di un paziente con AURA, l'anagrafe regionale degli assistiti (D197): l'identificativo
 * AURA trovato con il codice fiscale e com'è andato l'ultimo controllo. Una riga per paziente.
 */
export const auraLink = pgTable('aura_link', {
  id: uuid().primaryKey().defaultRandom(),
  patientId: uuid()
    .notNull()
    .unique()
    .references(() => patient.id),
  /** Identificativo AURA; vuoto finché AURA non trova una sola persona con quel codice fiscale. */
  auraId: text(),
  checkedAt: timestamp({ withTimezone: true }).notNull(),
  /** «aggiornato», «non_trovato», «ambiguo», «non_raggiungibile» o «rifiutato». */
  outcome: text().notNull(),
  message: text(),
  /** Ultimo controllo andato a buon fine: da quando esenzioni e scelte sono quelle di AURA. */
  updatedAt: timestamp({ withTimezone: true }),
  /**
   * Anagrafica che AURA ha mandato all'ultimo controllo (D198). Non entra da sola nella cartella:
   * le differenze si confermano dal pannello.
   */
  registry: jsonb().$type<AuraRegistry>(),
  /** Valori di AURA che medico o segreteria hanno scelto di non usare, campo per campo. */
  registryDismissed: jsonb().$type<Record<string, string>>().notNull().default({}),
});

/**
 * Variazioni arrivate da AURA: esenzioni e scelte nuove, cambiate o tolte, in parole. Restano: non
 * si modificano e non si cancellano (trigger nella migrazione).
 */
export const auraChange = pgTable(
  'aura_change',
  {
    id: uuid().primaryKey().defaultRandom(),
    studioId: uuid()
      .notNull()
      .references(() => studio.id),
    patientId: uuid()
      .notNull()
      .references(() => patient.id),
    at: timestamp({ withTimezone: true }).notNull(),
    /** «esenzione» o «scelta». */
    kind: text().notNull(),
    /** «nuova», «cambiata» o «tolta». */
    change: text().notNull(),
    /** Codice dell'esenzione, o nome del medico per le scelte. */
    subject: text().notNull(),
    /** Che cosa dice AURA adesso, in parole. */
    description: text().notNull(),
    /** Da dove è partito il controllo: «notte», «notifica», «manuale» o «ricetta». */
    trigger: text().notNull(),
  },
  (t) => [index().on(t.studioId, t.at), index().on(t.patientId, t.at)],
);

/**
 * Giri di controllo su AURA (ogni notte, o dal server): quanti pazienti, quante variazioni, in tutto
 * il servizio. Lo vede solo chi gestisce il servizio; lo studio vede i suoi numeri in
 * `aura_sync_run_studio`.
 */
export const auraSyncRun = pgTable('aura_sync_run', {
  id: uuid().primaryKey().defaultRandom(),
  trigger: text().notNull(),
  startedAt: timestamp({ withTimezone: true }).notNull(),
  finishedAt: timestamp({ withTimezone: true }),
  patients: integer().notNull().default(0),
  changed: integer().notNull().default(0),
  failed: integer().notNull().default(0),
  message: text(),
});

/** Lo stesso giro, studio per studio: l'amministratore di uno studio vede solo i numeri del suo. */
export const auraSyncRunStudio = pgTable(
  'aura_sync_run_studio',
  {
    id: uuid().primaryKey().defaultRandom(),
    runId: uuid()
      .notNull()
      .references(() => auraSyncRun.id),
    studioId: uuid()
      .notNull()
      .references(() => studio.id),
    patients: integer().notNull().default(0),
    changed: integer().notNull().default(0),
    failed: integer().notNull().default(0),
  },
  (t) => [uniqueIndex().on(t.runId, t.studioId)],
);
