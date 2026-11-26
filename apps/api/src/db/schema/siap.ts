import { sql } from 'drizzle-orm';
import {
  check,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { clinicalEntry } from './clinical';
import { patient } from './patients';
import { structureType, studio } from './studio';
import { appUser } from './users';

/**
 * I domini dei campi del contatto del SIAP (specifiche funzionali del Ministero 1.3, § 3.9.2): le
 * chiavi di `@mmg/domain`, nello stesso ordine (una prova lo controlla). Codici e descrizioni del
 * Ministero sono un dato.
 */
export const siapContactMode = pgEnum('siap_contact_mode', [
  'office',
  'home',
  'telemedicine',
  'remote',
  'unknown',
]);
export const siapActivityRegime = pgEnum('siap_activity_regime', ['choice', 'hourly', 'unknown']);
export const siapAccessType = pgEnum('siap_access_type', ['scheduled', 'direct', 'unknown']);
export const siapProblemState = pgEnum('siap_problem_state', [
  'suspected',
  'evolving',
  'chronic',
  'unknown',
]);
/** Il contatto confermato dal medico, o scartato con il motivo (D291). */
export const siapContactStatus = pgEnum('siap_contact_status', ['confirmed', 'discarded']);
/** Gli atti da cui viene il contatto: le chiavi di `SIAP_ACT_KINDS` di `@mmg/domain`. */
export const siapActKind = pgEnum('siap_act_kind', [
  'diary',
  'pharma',
  'specialist',
  'devices',
  'sick_leave',
  'certificate',
  'vaccination',
  'ppip',
  'choice',
]);

/**
 * Contatto del SIAP (D291): un incontro fra il medico e l'assistito, per paziente, medico e giorno.
 * Il programma lo propone dagli atti; diventa una riga quando il medico lo conferma o lo scarta.
 * Alla conferma prende il progressivo del giorno nello studio e vi si fermano il codice e il tipo
 * della struttura. Lo scarto tiene il motivo e il contatto non si ripropone.
 */
export const siapContact = pgTable(
  'siap_contact',
  {
    id: uuid().primaryKey().defaultRandom(),
    studioId: uuid()
      .notNull()
      .references(() => studio.id),
    patientId: uuid()
      .notNull()
      .references(() => patient.id),
    /** Il medico che ha fatto gli atti, anche il sostituto. */
    doctorId: uuid()
      .notNull()
      .references(() => appUser.id),
    occurredOn: date().notNull(),
    status: siapContactStatus().notNull(),
    /** Il numero del contatto confermato nel giorno, nello studio, dal primo (D291). */
    daySequence: integer(),
    /** Codice e tipo della struttura com'erano alla conferma (D289). */
    structureCode: text(),
    structureType: structureType(),
    mode: siapContactMode(),
    regime: siapActivityRegime(),
    accessType: siapAccessType(),
    /** Codice ICD-9-CM del problema, con il punto; il generico V70.0 senza un problema scelto. */
    problemCode: text(),
    problemState: siapProblemState(),
    problemOpenedOn: date(),
    /** Il problema della cartella scelto dal medico; vuoto con il codice generico. */
    problemEntryId: uuid().references(() => clinicalEntry.id),
    discardReason: text(),
    decidedBy: uuid()
      .notNull()
      .references(() => appUser.id),
    decidedAt: timestamp({ withTimezone: true }).notNull(),
    updatedAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [
    unique('siap_contact_day').on(t.patientId, t.doctorId, t.occurredOn),
    uniqueIndex('siap_contact_sequence')
      .on(t.studioId, t.occurredOn, t.daySequence)
      .where(sql`${t.daySequence} is not null`),
    index().on(t.doctorId, t.occurredOn),
    check(
      'siap_contact_decided',
      sql`(${t.status} = 'confirmed' and ${t.daySequence} >= 1 and ${t.mode} is not null and ${t.regime} is not null and ${t.accessType} is not null and ${t.problemCode} is not null and ${t.problemState} is not null and ${t.discardReason} is null) or (${t.status} = 'discarded' and ${t.daySequence} is null and length(trim(${t.discardReason})) > 0)`,
    ),
    check('siap_contact_structure_code', sql`${t.structureCode} ~ '^[A-Z0-9]{6}$'`),
  ],
);

/** Le attività e prestazioni del contatto confermato: tipologia e dettaglio dell'allegato 2, quantità. */
export const siapContactService = pgTable(
  'siap_contact_service',
  {
    contactId: uuid()
      .notNull()
      .references(() => siapContact.id, { onDelete: 'cascade' }),
    typology: integer().notNull(),
    detail: integer().notNull(),
    /** Il campo ha una cifra (§ 3.9.2, campo 16). */
    quantity: integer().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.contactId, t.typology, t.detail] }),
    check('siap_contact_service_quantity', sql`${t.quantity} between 1 and 9`),
  ],
);

/**
 * Gli atti che il contatto contava quando il medico l'ha confermato o scartato: un atto nuovo dello
 * stesso giorno lo fa vedere «da aggiornare» (D291).
 */
export const siapContactAct = pgTable(
  'siap_contact_act',
  {
    contactId: uuid()
      .notNull()
      .references(() => siapContact.id, { onDelete: 'cascade' }),
    kind: siapActKind().notNull(),
    actId: uuid().notNull(),
  },
  (t) => [primaryKey({ columns: [t.contactId, t.kind, t.actId] }), index().on(t.kind, t.actId)],
);
