import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { aft } from './aft';
import { patient } from './patients';
import { appUser } from './users';

/**
 * Registro di AFT (tappa 12, D161): l'attività che un collega dell'AFT svolge per un paziente di un
 * altro medico, con orario, tipologia ed esito (DGR Piemonte 27/5/2024, n. 31-8647, accordo
 * integrativo, art. 22, c. 2, 3 e 5). Il medico curante la trova nella cronologia della cartella.
 * Non si modifica e non si cancella: una correzione è una riga nuova.
 */
export const aftActivity = pgTable(
  'aft_activity',
  {
    id: uuid().primaryKey().defaultRandom(),
    aftId: uuid()
      .notNull()
      .references(() => aft.id),
    patientId: uuid()
      .notNull()
      .references(() => patient.id),
    /** Il medico curante quando l'attività è stata registrata. */
    ownerUserId: uuid()
      .notNull()
      .references(() => appUser.id),
    /** Il collega dell'AFT che ha svolto l'attività. */
    doctorUserId: uuid()
      .notNull()
      .references(() => appUser.id),
    /** Data e ora dell'attività. */
    performedAt: timestamp({ withTimezone: true }).notNull(),
    /** Tipologia (`AFT_ACTIVITY_KINDS`). */
    kind: text().notNull(),
    outcome: text().notNull(),
    notes: text(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.patientId, t.performedAt), index().on(t.ownerUserId, t.performedAt)],
);
