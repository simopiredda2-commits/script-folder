import {
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { studio } from './studio';
import { appUser } from './users';

/**
 * Provenienza delle password sbagliate (D181, D188): l'indirizzo della richiesta, oppure la
 * postazione scritta a quell'indirizzo. Le attese crescono per provenienza, non per utente: chi
 * prova le password di un medico da un altro computer rallenta sé stesso, non il medico.
 */
export const loginSourceKind = pgEnum('login_source_kind', ['address', 'workstation']);

/**
 * Password sbagliate di seguito da una provenienza e attesa prima della prossima. Tabella del
 * servizio, non di uno studio: un nome utente sconosciuto non ha studio, e lo stesso indirizzo può
 * provare utenti di studi diversi. Una password giusta toglie la riga; una provenienza senza
 * password sbagliate da un giorno si dimentica. Niente storico: dice solo quanto aspettare, e ogni
 * tentativo resta nel registro degli accessi.
 */
export const loginSource = pgTable(
  'login_source',
  {
    kind: loginSourceKind().notNull(),
    /** L'indirizzo; per la postazione, l'indirizzo e il nome scritto (senza maiuscole). */
    sourceKey: text().notNull(),
    /** Password sbagliate di seguito, contata prima di guardarla (vedi login-sources.ts). */
    failures: integer().notNull(),
    lastFailureAt: timestamp({ withTimezone: true }).notNull(),
    /** Fino a quando la provenienza aspetta: prima, nessuna password si guarda. */
    waitUntil: timestamp({ withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.kind, t.sourceKey] }), index().on(t.lastFailureAt)],
);

/** Perché il conto si è bloccato: password sbagliate (soglia alta) o codici sbagliati. */
export const accountLockReason = pgEnum('account_lock_reason', ['passwords', 'codes']);

/**
 * Blocchi del conto (D181, D188): uno per blocco, con le provenienze dei tentativi che l'hanno
 * fatto scattare. Da qui gli avvisi all'utente bloccato e ai medici titolari dello studio. Non si
 * modifica e non si cancella, come il registro degli accessi.
 */
export const accountLock = pgTable(
  'account_lock',
  {
    id: uuid().primaryKey().defaultRandom(),
    studioId: uuid()
      .notNull()
      .references(() => studio.id),
    userId: uuid()
      .notNull()
      .references(() => appUser.id),
    reason: accountLockReason().notNull(),
    /** Tentativi sbagliati di seguito alla soglia: la soglia dello studio in quel momento. */
    failures: integer().notNull(),
    lockedAt: timestamp({ withTimezone: true }).notNull(),
    lockedUntil: timestamp({ withTimezone: true }).notNull(),
    /** Indirizzi e postazioni dei tentativi contati, senza ripetizioni (al più 10 ciascuno). */
    addresses: text().array().notNull(),
    workstations: text().array().notNull(),
  },
  (t) => [index().on(t.studioId, t.lockedAt), index().on(t.userId, t.lockedAt)],
);

/** Chi ha visto l'avviso di un blocco: l'utente bloccato, un medico titolare. Non si cancella. */
export const accountLockSeen = pgTable(
  'account_lock_seen',
  {
    lockId: uuid()
      .notNull()
      .references(() => accountLock.id),
    userId: uuid()
      .notNull()
      .references(() => appUser.id),
    seenAt: timestamp({ withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.lockId, t.userId] })],
);
