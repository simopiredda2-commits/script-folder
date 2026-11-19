import { integer, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Tipo di studio: medico singolo o medicina di gruppo (più titolari, archivi separati). */
export const studioKind = pgEnum('studio_kind', ['single', 'group']);

/** Studio medico: tutti i dati sono separati per studio. */
export const studio = pgTable('studio', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  address: text(),
  /**
   * Regione o provincia autonoma per l'intestazione del promemoria («SERVIZIO SANITARIO
   * NAZIONALE – REGIONE …», DM 2 novembre 2011, allegato 2, campo 1), es. «PIEMONTE».
   */
  regionName: text(),
  kind: studioKind().notNull().default('single'),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  /**
   * Blocco della sessione dopo «pochi minuti» di inattività: 5, scelti da Simone alla prima
   * fermata (D29). Vuoto = blocco non attivo.
   */
  idleLockMinutes: integer().default(5),
  /**
   * Password sbagliate di seguito prima del blocco del conto: la soglia alta (D181, D188). Le
   * sbaglia anche chi conosce solo il nome utente: prima del blocco valgono le attese per indirizzo
   * e postazione (auth/login-sources.ts). 50: valore provvisorio, da completare.
   */
  maxFailedLogins: integer().default(50),
  /**
   * Codici a 6 cifre sbagliati di seguito, all'accesso e allo sblocco della sessione, e password
   * attuali sbagliate nel cambio della password, prima del blocco del conto: 5, la soglia scelta
   * alla prima fermata (D29). Li sbaglia solo chi ha già la password o una sessione (D188). È anche
   * il numero di codici che un passaggio dell'accesso guarda.
   */
  maxFailedCodes: integer().default(5),
  /** Durata del blocco del conto, per tutte e due le soglie: 15 minuti (D29). */
  failedLoginLockMinutes: integer().default(15),
  /**
   * Indirizzo completo dello studio (tappa 14): `address` è via e numero civico, poi CAP, comune e
   * provincia. Vanno sulla copia del certificato INPS per la visita in studio (D106) e sui documenti.
   */
  postalCode: text(),
  municipality: text(),
  province: text(),
  phone: text(),
  email: text(),
  pec: text(),
  /**
   * Intestazione dello studio, una riga per riga (fino a 6): l'amministratore la imposta
   * (requisiti, «Utenti e ruoli»); vale quando il medico non ha la sua (D145, D163).
   */
  headerText: text(),
  /** Tempo massimo di attesa dell'invio a SAR, Sistema TS e INPS, in secondi (D94: 6–8). */
  sendTimeoutSeconds: integer().notNull().default(8),
  /**
   * Avvisi sugli accessi anomali (Garante, linee guida sul dossier sanitario, par. 7, lett. c):
   * cartelle diverse aperte da un utente in un giorno, fascia oraria anomala (dalle ore … alle
   * ore …), consultazioni dell'AFT di un collega in un giorno. Vuoti: valori da completare, avvisi
   * spenti (tappa 14).
   */
  alertDailyRecords: integer(),
  alertNightFromHour: integer(),
  alertNightToHour: integer(),
  alertAftDaily: integer(),
});
