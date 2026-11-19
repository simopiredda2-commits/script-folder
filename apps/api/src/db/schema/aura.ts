import type { AuraRegistry } from '@mmg/integrations';
import {
  date,
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
import { appUser, archive } from './users';

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

/**
 * Nuovi assistiti segnalati da AURA (D199): chi ha scelto un medico dello studio e non è ancora nel
 * suo archivio. Una riga per studio e assistito. Medico o segreteria lo registrano con un clic dalla
 * pagina Oggi, o scelgono di non registrarlo. Le righe non si cancellano: cambia lo stato, con lo
 * storico (trigger nella migrazione).
 */
export const auraNewPatient = pgTable(
  'aura_new_patient',
  {
    id: uuid().primaryKey().defaultRandom(),
    studioId: uuid()
      .notNull()
      .references(() => studio.id),
    /** L'archivio del medico scelto, dove il paziente entra. */
    archiveId: uuid()
      .notNull()
      .references(() => archive.id),
    doctorUserId: uuid()
      .notNull()
      .references(() => appUser.id),
    auraId: text().notNull(),
    fiscalCode: text().notNull(),
    lastName: text().notNull(),
    firstName: text().notNull(),
    birthDate: date().notNull(),
    /** La scelta del medico come la dice AURA. */
    chosenOn: date().notNull(),
    expiresOn: date(),
    /** Anagrafica di AURA quando è arrivata la notifica (residenza, ASL, …). */
    registry: jsonb().$type<AuraRegistry>(),
    /**
     * «da_registrare»; «registrato» (con il paziente); «non_registrato» (scelto da medico o
     * segreteria); «superato» (la scelta non vale più, o il paziente è già nell'archivio).
     */
    status: text().notNull(),
    patientId: uuid().references(() => patient.id),
    /** L'ultima volta che AURA l'ha segnalato. */
    notifiedAt: timestamp({ withTimezone: true }).notNull(),
    decidedBy: uuid().references(() => appUser.id),
    decidedAt: timestamp({ withTimezone: true }),
  },
  (t) => [uniqueIndex().on(t.studioId, t.auraId), index().on(t.archiveId, t.status)],
);

/**
 * Cambi di medico dentro lo studio (D200): AURA dice che il paziente ha scelto un altro medico dello
 * studio, titolare di un altro archivio. Lo spostamento lo conferma il titolare dell'archivio dove
 * il paziente sta, con un clic, o sceglie di non spostarlo; il medico scelto lo sa dalla pagina
 * Oggi. Una riga per paziente: cambia lo stato, con lo storico (trigger nella migrazione), e non si
 * cancella.
 */
export const auraDoctorChange = pgTable(
  'aura_doctor_change',
  {
    id: uuid().primaryKey().defaultRandom(),
    studioId: uuid()
      .notNull()
      .references(() => studio.id),
    patientId: uuid()
      .notNull()
      .unique()
      .references(() => patient.id),
    /** L'archivio dove il paziente stava quando il controllo con AURA ha trovato la scelta. */
    fromArchiveId: uuid()
      .notNull()
      .references(() => archive.id),
    /** L'archivio del medico scelto. */
    toArchiveId: uuid()
      .notNull()
      .references(() => archive.id),
    toDoctorUserId: uuid()
      .notNull()
      .references(() => appUser.id),
    /** La scelta del medico come la dice AURA. */
    chosenOn: date().notNull(),
    /**
     * «da_decidere»; «spostato» (dal titolare di prima); «non_spostato» (scelto dal titolare di
     * prima: non si ripropone finché AURA non manda una scelta nuova); «superato» (la scelta non
     * vale più, il paziente è già nell'archivio del medico scelto, o è deceduto).
     */
    status: text().notNull(),
    /** L'ultima volta che il controllo con AURA l'ha proposto o ritirato. */
    detectedAt: timestamp({ withTimezone: true }).notNull(),
    decidedBy: uuid().references(() => appUser.id),
    decidedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.fromArchiveId, t.status), index().on(t.toDoctorUserId, t.status)],
);
