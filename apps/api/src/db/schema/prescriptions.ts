import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { patientRequest } from './agenda';
import { patient, reminderChannel } from './patients';
import { therapy } from './therapy';
import { appUser, archive } from './users';

export const prescriptionKind = pgEnum('prescription_kind', [
  'pharma_ssn',
  'specialist_ssn',
  'white',
  'devices',
]);
export const prescriptionStatus = pgEnum('prescription_status', [
  'draft',
  'to_sign',
  'sending',
  'sent',
  'error',
  'cancelled',
  'paper',
]);
export const sendErrorKind = pgEnum('send_error_kind', ['rejected', 'unreachable', 'timeout']);
export const priorityClass = pgEnum('priority_class', ['U', 'B', 'D', 'P']);
export const accessType = pgEnum('access_type', ['first', 'subsequent']);

/**
 * Ricetta: tipo, stato, NRE, priorità, quesito, esenzione, chi l'ha preparata e chi l'ha
 * firmata. Gli stati e le transizioni sono in packages/domain/src/prescription.ts.
 */
export const prescription = pgTable(
  'prescription',
  {
    id: uuid().primaryKey().defaultRandom(),
    patientId: uuid()
      .notNull()
      .references(() => patient.id),
    archiveId: uuid()
      .notNull()
      .references(() => archive.id),
    kind: prescriptionKind().notNull(),
    status: prescriptionStatus().notNull().default('draft'),
    /** Numero di ricetta elettronica (NRE; NRBE per la bianca), dato dal SAR o dal Sistema TS. */
    nre: text(),
    priority: priorityClass(),
    accessType: accessType(),
    diagnosticQuestion: text(),
    exemptionCode: text(),
    /** Richiesta del paziente da cui nasce, se c'è. */
    requestId: uuid().references(() => patientRequest.id),
    preparedBy: uuid()
      .notNull()
      .references(() => appUser.id),
    preparedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Chi firma e invia: sempre un medico, a nome suo (anche se sostituto). */
    signedBy: uuid().references(() => appUser.id),
    signedAt: timestamp({ withTimezone: true }),
    sentAt: timestamp({ withTimezone: true }),
    lastErrorKind: sendErrorKind(),
    lastErrorCode: text(),
    lastErrorMessage: text(),
    cancelledAt: timestamp({ withTimezone: true }),
    cancelledBy: uuid().references(() => appUser.id),
    cancelReason: text(),
    paperPrintedAt: timestamp({ withTimezone: true }),
    paperPrintedBy: uuid().references(() => appUser.id),
    /** Versione delle regole di prescrizione con cui è stata controllata (tappa 4). */
    rulesVersion: text(),
    /**
     * Ultimo stato di erogazione noto, chiesto all'ente (D70): «non_erogata», «presa_in_carico»,
     * «erogata_in_parte», «erogata», «annullata». Decide se la ricetta si può annullare.
     */
    dispensingState: text(),
    dispensingCheckedAt: timestamp({ withTimezone: true }),
    /** Canale del promemoria al paziente e recapito usato (R15, R16; tappa 4). */
    reminderChannel: reminderChannel(),
    reminderContact: text(),
    /**
     * Codice di autenticazione restituito dal SAC, anche tramite il SAR: senza, la ricetta SSN non
     * è valida e il promemoria non si dà; va stampato su ogni promemoria (specifiche del Sistema
     * TS, prescrizione, 5/12/2024).
     */
    authCode: text(),
    /** Cognome e nome del medico come li restituisce il SAC, per il promemoria (stesse specifiche). */
    sacDoctorName: text(),
    /** Ricetta bianca: numero breve per paziente e anno (Disciplinare tecnico, 1/12/2022). */
    pinNrbe: text(),
    /** Su richiesta del paziente: cognome, nome e indirizzo oscurati (oscuramDati). */
    obscured: boolean().notNull().default(false),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.archiveId, t.status), index().on(t.patientId)],
);

/** Riga di ricetta: un farmaco (o una prestazione) con la quantità. */
export const prescriptionLine = pgTable(
  'prescription_line',
  {
    id: uuid().primaryKey().defaultRandom(),
    prescriptionId: uuid()
      .notNull()
      .references(() => prescription.id),
    position: integer().notNull(),
    therapyId: uuid().references(() => therapy.id),
    drugAic: text(),
    drugName: text(),
    activeIngredient: text(),
    serviceCode: text(),
    serviceDescription: text(),
    /** Confezioni (farmaci) o quantità (prestazioni). */
    quantity: integer().notNull(),
    aifaNote: text(),
    byActiveIngredient: boolean().notNull().default(false),
    notSubstitutable: boolean().notNull().default(false),
    notSubstitutableReason: text(),
    posologyText: text(),
    /**
     * Ricetta bianca ripetibile: volte e mesi di validità, solo se diversi dalla regola del farmaco
     * (Disciplinare tecnico della ricetta bianca, 1/12/2022: numRipetibilita, validitaFarm).
     */
    repeatCount: integer(),
    validityMonths: integer(),
  },
  (t) => [index().on(t.prescriptionId)],
);

export const gatewaySystem = pgEnum('gateway_system', ['sar', 'sistema_ts']);

/**
 * Invio esterno: ogni chiamata al SAR o al Sistema TS con richiesta, risposta ed esito.
 * Non si modifica e non si cancella (migrazione 0004).
 */
export const externalSubmission = pgTable(
  'external_submission',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    system: gatewaySystem().notNull(),
    /** «simulator», «test» o «production». */
    environment: text().notNull(),
    operation: text().notNull(),
    prescriptionId: uuid()
      .notNull()
      .references(() => prescription.id),
    userId: uuid()
      .notNull()
      .references(() => appUser.id),
    request: jsonb().notNull(),
    response: jsonb(),
    outcome: text().notNull(),
    errorCode: text(),
    errorMessage: text(),
    durationMs: integer(),
  },
  (t) => [index().on(t.prescriptionId)],
);

/**
 * Controllo di una ricetta con le regole di prescrizione: versione delle regole, problemi
 * trovati, motivi dati dal medico agli avvisi, note AIFA confermate. Ogni controllo prima di un
 * invio resta registrato e non si modifica (migrazione 0005): la ricetta resta verificabile
 * anche dopo un cambio di norma.
 */
export const prescriptionCheck = pgTable(
  'prescription_check',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    prescriptionId: uuid()
      .notNull()
      .references(() => prescription.id),
    userId: uuid()
      .notNull()
      .references(() => appUser.id),
    rulesVersion: text().notNull(),
    /** «superato» o «bloccato». */
    outcome: text().notNull(),
    issues: jsonb().notNull(),
    reasons: jsonb().notNull(),
    confirmedAifaNotes: jsonb().notNull(),
  },
  (t) => [index().on(t.prescriptionId)],
);

export const prescriptionDocumentKind = pgEnum('prescription_document_kind', [
  'promemoria_dati',
  'promemoria_sac',
]);

/**
 * Documenti di una ricetta fissati al momento dell'invio: i dati del promemoria SSN, da cui ogni
 * ristampa esce identica, e il PDF del promemoria della ricetta bianca prodotto dal SAC, l'unico
 * che si può consegnare. Non si modificano e non si cancellano (migrazione 0008).
 */
export const prescriptionDocument = pgTable(
  'prescription_document',
  {
    id: uuid().primaryKey().defaultRandom(),
    prescriptionId: uuid()
      .notNull()
      .references(() => prescription.id),
    kind: prescriptionDocumentKind().notNull(),
    /** «application/json» per i dati, «application/pdf» per il PDF del SAC. */
    mediaType: text().notNull(),
    /** JSON in chiaro, oppure il PDF in base64: così l'esportazione resta testo. */
    content: text().notNull(),
    sha256: text().notNull(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.prescriptionId)],
);

export const reminderDeliveryChannel = pgEnum('reminder_delivery_channel', [
  'stampa_promemoria',
  'stampa_nre',
  'email',
  'sms',
]);

/**
 * Ogni consegna del promemoria: stampa, email o SMS, a chi, con quale esito. Il recapito è sempre
 * del paziente o di un suo delegato registrato (R16). Non si modifica e non si cancella.
 */
export const reminderDelivery = pgTable(
  'reminder_delivery',
  {
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
    prescriptionId: uuid()
      .notNull()
      .references(() => prescription.id),
    userId: uuid()
      .notNull()
      .references(() => appUser.id),
    channel: reminderDeliveryChannel().notNull(),
    /** «paziente» o «delegato»; vuoto per le stampe. */
    recipientKind: text(),
    delegationId: uuid(),
    recipient: text(),
    /** «simulator», «test» o «production» per email e SMS. */
    environment: text(),
    /** «stampato», «consegnato», «rifiutato», «non_raggiungibile». */
    outcome: text().notNull(),
    messageId: text(),
    errorMessage: text(),
  },
  (t) => [index().on(t.prescriptionId)],
);
