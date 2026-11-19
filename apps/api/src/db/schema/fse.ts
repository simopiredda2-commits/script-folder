import {
  customType,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { patient } from './patients';
import { studio } from './studio';
import { appUser } from './users';

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

/**
 * Impostazioni del Fascicolo dello studio (tappa 11). Gli identificativi (OID) dei documenti e
 * del repository, il custode e la struttura nel formato XON li danno la Regione e l'accreditamento:
 * finché mancano il Profilo non parte («da completare», D133). Nessun segreto qui: i certificati
 * del Gateway stanno nelle credenziali cifrate.
 */
export const fseSetting = pgTable('fse_setting', {
  studioId: uuid()
    .primaryKey()
    .references(() => studio.id),
  /** Organizzazione (tabella 16.3.7 delle specifiche del Gateway): 010 è la Regione Piemonte. */
  organizationId: text().notNull().default('010'),
  organizationName: text().notNull().default('Regione Piemonte'),
  /** Radice OID degli identificativi dei documenti dello studio. */
  documentIdRoot: text(),
  /** Identificativo del repository (XDSDocumentEntry.repositoryUniqueId). */
  repositoryId: text(),
  /** Radice OID degli invii (XDSSubmissionSet.uniqueId). */
  submissionIdRoot: text(),
  custodianIdRoot: text(),
  custodianIdExtension: text(),
  custodianName: text(),
  custodianStreet: text(),
  custodianCity: text(),
  custodianIstatCode: text(),
  custodianProvince: text(),
  /** Struttura del medico nel formato XON (campo «locality» del token). */
  locality: text(),
  /** Tabella 16.3.2: «Territorio» è dei documenti di MMG e PLS. */
  facilityType: text().notNull().default('Territorio'),
  /** Tabella 16.3.8: AD_PSC130 «Medicina di Base». */
  practiceSetting: text().notNull().default('AD_PSC130'),
  /** Tabella 16.3.1 (XDSSubmissionSet.contentTypeCode): da completare. */
  clinicalActivity: text(),
  /** Tabella 16.3.13: da completare. */
  administrativeRequest: text(),
  updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid().references(() => appUser.id),
});

export const pssStatus = pgEnum('pss_status', [
  'draft',
  'validated',
  'signed',
  'submitted',
  'published',
  'replaced',
  'discarded',
]);

/**
 * Profilo Sanitario Sintetico: una riga per versione. Il contenuto è la fotografia di quello che
 * il medico ha controllato; il documento CDA2 e il PDF non cambiano più dopo la firma.
 */
export const pssDocument = pgTable(
  'pss_document',
  {
    id: uuid().primaryKey().defaultRandom(),
    patientId: uuid()
      .notNull()
      .references(() => patient.id),
    authorUserId: uuid()
      .notNull()
      .references(() => appUser.id),
    status: pssStatus().notNull().default('draft'),
    /** ClinicalDocument.setId: lo stesso per le versioni dello stesso medico. */
    setRoot: text().notNull(),
    setExtension: text().notNull(),
    version: integer().notNull(),
    docRoot: text().notNull(),
    docExtension: text().notNull(),
    /** Versione precedente sostituita da questa. */
    replacesId: uuid(),
    /** Che cosa è entrato, voce per voce, come il medico l'ha controllato. */
    content: jsonb().notNull(),
    cdaXml: text(),
    cdaSha256: text(),
    workflowInstanceId: text(),
    traceId: text(),
    /** Ultimo problema del Gateway (RFC 7807), per l'interfaccia. */
    lastProblem: jsonb(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    validatedAt: timestamp({ withTimezone: true }),
    signedAt: timestamp({ withTimezone: true }),
    submittedAt: timestamp({ withTimezone: true }),
    publishedAt: timestamp({ withTimezone: true }),
    replacedAt: timestamp({ withTimezone: true }),
    discardedAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.patientId, t.createdAt)],
);

export const pssFileKind = pgEnum('pss_file_kind', ['pdf', 'signed_pdf']);

/** Il PDF del Profilo con il CDA dentro, e quello firmato: non si modificano né si cancellano. */
export const pssFile = pgTable('pss_file', {
  id: uuid().primaryKey().defaultRandom(),
  documentId: uuid()
    .notNull()
    .references(() => pssDocument.id),
  kind: pssFileKind().notNull(),
  content: bytea().notNull(),
  sha256: text().notNull(),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
});

export const fseOperation = pgEnum('fse_operation', [
  'validation',
  'publication',
  'replacement',
  'status',
]);
export const fseOutcome = pgEnum('fse_outcome', ['ok', 'problem', 'unreachable', 'timeout']);

/** Ogni chiamata al Gateway, con l'esito: si scrive e non si tocca più. */
export const fseTransmission = pgTable(
  'fse_transmission',
  {
    id: uuid().primaryKey().defaultRandom(),
    documentId: uuid()
      .notNull()
      .references(() => pssDocument.id),
    operation: fseOperation().notNull(),
    outcome: fseOutcome().notNull(),
    httpStatus: integer(),
    problemType: text(),
    problemTitle: text(),
    problemDetail: text(),
    traceId: text(),
    workflowInstanceId: text(),
    actorUserId: uuid()
      .notNull()
      .references(() => appUser.id),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.documentId, t.at)],
);
