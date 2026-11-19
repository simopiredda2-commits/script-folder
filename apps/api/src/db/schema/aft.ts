import { sql } from 'drizzle-orm';
import { boolean, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { appUser } from './users';

/**
 * Aggregazione funzionale territoriale (tappa 12, D161): i medici che la compongono e usano il
 * programma. La crea un medico titolare; gli altri entrano su invito, e solo accettandolo.
 */
export const aft = pgTable('aft', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  /** Azienda sanitaria e codice dell'AFT, come li dà l'ASL: facoltativi. */
  asl: text(),
  code: text(),
  createdBy: uuid()
    .notNull()
    .references(() => appUser.id),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

/**
 * Un medico in un'AFT: invito, accettazione, uscita. Una riga per periodo; chi esce e rientra ha
 * una riga nuova. Condivide i suoi pazienti solo se lo attiva lui (`sharing`), e comunque solo
 * quelli che hanno dato il consenso.
 */
export const aftMember = pgTable(
  'aft_member',
  {
    id: uuid().primaryKey().defaultRandom(),
    aftId: uuid()
      .notNull()
      .references(() => aft.id),
    userId: uuid()
      .notNull()
      .references(() => appUser.id),
    /** Chi l'ha invitato; null per chi ha creato l'AFT. */
    invitedBy: uuid().references(() => appUser.id),
    invitedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Da quando è membro: l'accettazione dell'invito. Null finché l'invito è in attesa. */
    joinedAt: timestamp({ withTimezone: true }),
    /** Invito rifiutato o ritirato. */
    declinedAt: timestamp({ withTimezone: true }),
    /** Uscita dall'AFT. */
    leftAt: timestamp({ withTimezone: true }),
    sharing: boolean().notNull().default(false),
    sharingChangedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    // Una sola riga aperta (invito in attesa o membro) per medico e AFT.
    uniqueIndex('aft_member_open_key')
      .on(t.aftId, t.userId)
      .where(sql`${t.leftAt} is null and ${t.declinedAt} is null`),
  ],
);
