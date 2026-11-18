import {
  boolean,
  customType,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { attachment, clinicalEntry, entryStatus } from './clinical';
import { patient } from './patients';
import { prescription, prescriptionLine } from './prescriptions';
import { appUser } from './users';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/**
 * Contenuto di un allegato (referti e documenti in PDF o immagine), nel database: così sta nei
 * salvataggi e nell'esportazione insieme al resto. Non si modifica e non si cancella.
 */
export const attachmentContent = pgTable('attachment_content', {
  attachmentId: uuid()
    .primaryKey()
    .references(() => attachment.id),
  content: bytea().notNull(),
});

/**
 * Seguito di una prestazione prescritta (tappa 10): esecuzione, struttura, esito, seduta del
 * ciclo, referto. Una riga per esecuzione o per seduta; non si cancella, si annulla con un motivo.
 */
export const serviceExecution = pgTable(
  'service_execution',
  {
    id: uuid().primaryKey().defaultRandom(),
    patientId: uuid()
      .notNull()
      .references(() => patient.id),
    prescriptionId: uuid()
      .notNull()
      .references(() => prescription.id),
    prescriptionLineId: uuid()
      .notNull()
      .references(() => prescriptionLine.id),
    executedOn: date().notNull(),
    facility: text(),
    outcome: text(),
    /** Numero della seduta, per i cicli (es. riabilitazione); vuoto per le prestazioni singole. */
    sessionNumber: integer(),
    /** Referto: voce clinica di tipo «report», con l'allegato. */
    reportEntryId: uuid().references(() => clinicalEntry.id),
    notes: text(),
    recordedBy: uuid()
      .notNull()
      .references(() => appUser.id),
    recordedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    status: entryStatus().notNull().default('active'),
    annulledAt: timestamp({ withTimezone: true }),
    annulledBy: uuid().references(() => appUser.id),
    annulReason: text(),
  },
  (t) => [index().on(t.patientId), index().on(t.prescriptionLineId)],
);

export const supplyCategory = pgEnum('supply_category', [
  'monouso',
  'diabetici',
  'medicazione_tradizionale',
  'medicazione_avanzata',
  'dietetici',
  'altro',
]);
export const supplyPrescriber = pgEnum('supply_prescriber', ['mmg', 'specialista']);
export const supplyStatus = pgEnum('supply_status', ['active', 'ended', 'annulled']);

/**
 * Presidi e assistenza integrativa (tappa 10): che cosa, quanto al mese, per quanti mesi, chi l'ha
 * prescritto per primo. Categorie dal DPCM 12/1/2017 (art. 10–14) e dalla guida della Regione
 * Piemonte (medicazioni). Non si cancella: si conclude, si rinnova o si annulla con un motivo.
 */
export const supplyPrescription = pgTable(
  'supply_prescription',
  {
    id: uuid().primaryKey().defaultRandom(),
    patientId: uuid()
      .notNull()
      .references(() => patient.id),
    category: supplyCategory().notNull(),
    product: text().notNull(),
    /** Codice del nomenclatore (allegati 2 e 3 del DPCM), se noto. */
    code: text(),
    monthlyQuantity: integer().notNull(),
    unit: text().notNull(),
    months: integer().notNull(),
    startOn: date().notNull(),
    endOn: date().notNull(),
    prescriber: supplyPrescriber().notNull().default('mmg'),
    /** Prima prescrizione dello specialista (medicazioni avanzate e rinnovi). */
    firstSpecialist: text(),
    firstSpecialistOn: date(),
    indicationEntryId: uuid().references(() => clinicalEntry.id),
    /** Il rinnovo riparte dalla prescrizione precedente. */
    renewsId: uuid(),
    notes: text(),
    reserved: boolean().notNull().default(false),
    status: supplyStatus().notNull().default('active'),
    annulledAt: timestamp({ withTimezone: true }),
    annulledBy: uuid().references(() => appUser.id),
    annulReason: text(),
    createdBy: uuid()
      .notNull()
      .references(() => appUser.id),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.patientId)],
);
