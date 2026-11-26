import {
  boolean,
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
  /** Tabella 16.3.13: fra i regimi che la regione dello studio ammette (D297). */
  administrativeRequest: text(),
  /**
   * Invii al Fascicolo regionale sospesi dall'amministratore, per esempio su richiesta del supporto
   * della regione: i messaggi restano in coda e partono alla ripresa.
   */
  regionalSendingSuspended: boolean().notNull().default(false),
  regionalSuspendedAt: timestamp({ withTimezone: true }),
  regionalSuspendedReason: text(),
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
  'rejected',
  'deleted',
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
    /** OID definitivo del documento nel Fascicolo regionale (EsitoCaricamentoDocumento, V09 5.4). */
    regionalOid: text(),
    /** «N», oppure «V» con P99 se il documento è oscurato nel Fascicolo (V09, 5.2.2). */
    confidentiality: text().notNull().default('N'),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    validatedAt: timestamp({ withTimezone: true }),
    signedAt: timestamp({ withTimezone: true }),
    submittedAt: timestamp({ withTimezone: true }),
    publishedAt: timestamp({ withTimezone: true }),
    replacedAt: timestamp({ withTimezone: true }),
    discardedAt: timestamp({ withTimezone: true }),
    /** Scartato dal Fascicolo regionale («KO», V09 5.4.3). */
    rejectedAt: timestamp({ withTimezone: true }),
    /** Cancellato dal Fascicolo regionale (CancellazioneMetadati, V09 5.3). */
    deletedAt: timestamp({ withTimezone: true }),
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
  'regional_create',
  'regional_replace',
  'regional_update',
  'regional_delete',
  'regional_outcome',
  'regional_search',
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
    /**
     * Servizi del Fascicolo regionale: il messaggio partito, senza credenziali e con il documento
     * indicato dall'impronta (è in pss_file), e la risposta (FSE-INT-SRS-01-V02, 3.6 e 4.4).
     */
    request: text(),
    response: text(),
    actorUserId: uuid()
      .notNull()
      .references(() => appUser.id),
    at: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index().on(t.documentId, t.at)],
);

export const fseRegionalOperation = pgEnum('fse_regional_operation', [
  'create',
  'replace',
  'update',
  'delete',
]);
export const fseRegionalStatus = pgEnum('fse_regional_status', [
  /** Da mandare, o da rimandare all'ora di `nextAttemptAt`. */
  'queued',
  /** Preso in carico con l'identificativo temporaneo: si chiede l'esito. */
  'waiting',
  'done',
  /** Errore del messaggio o del contenuto: si rimanda solo dopo la correzione. */
  'to_fix',
  /** I giorni di tentativi della regione senza esito: da segnalare a chi la regione indica. */
  'failed',
  /** Tolto dalla coda: il Profilo è stato scartato. */
  'cancelled',
]);

/**
 * Coda degli invii al Fascicolo regionale (D280): un messaggio per riga, nell'ordine in cui il
 * medico li ha fatti partire, con le politiche di invio della regione dello studio (D297): il
 * fermo notturno; dopo un tempo scaduto, un errore di sistema o una risposta senza esito, le
 * ripetizioni ravvicinate e poi un tentativo al giorno; gli altri errori si correggono prima di
 * rimandare.
 */
export const fseRegionalSend = pgTable(
  'fse_regional_send',
  {
    id: uuid().primaryKey().defaultRandom(),
    documentId: uuid()
      .notNull()
      .references(() => pssDocument.id),
    /** Il medico autore: i servizi della regione vogliono le sue credenziali. */
    doctorUserId: uuid()
      .notNull()
      .references(() => appUser.id),
    operation: fseRegionalOperation().notNull(),
    status: fseRegionalStatus().notNull().default('queued'),
    /** Per l'UPDATE: la riservatezza da mandare («N» o «V»). */
    confidentiality: text(),
    /** Identificativo temporaneo della ComunicazioneMetadati (5.2.5), poi l'OID definitivo. */
    temporaryId: text(),
    oid: text(),
    /** Tentativi falliti della fase in corso, e la fase: «ripetizione» (5 minuti) o «coda». */
    attempts: integer().notNull().default(0),
    phase: text().notNull().default('ripetizione'),
    /** Richieste dell'esito con «ELAB». */
    polls: integer().notNull().default(0),
    /** Quando è cominciata la coda di un tentativo al giorno. */
    queuedSince: timestamp({ withTimezone: true }),
    nextAttemptAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /**
     * Il messaggio è di un giro della coda fino a quest'ora: un altro giro, anche di un'altra
     * istanza del servizio, non lo manda insieme; se il giro si interrompe, dopo quest'ora lo
     * riprende un altro. «Riprova» non la tocca, e lo scarto aspetta che il giro finisca.
     */
    leaseUntil: timestamp({ withTimezone: true }),
    lastAttemptAt: timestamp({ withTimezone: true }),
    lastError: text(),
    /** Gli errori della V09 dell'ultima risposta (codice, testo, tipo, fonte). */
    errors: jsonb(),
    createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp({ withTimezone: true }),
    doneAt: timestamp({ withTimezone: true }),
  },
  (t) => [index().on(t.status, t.nextAttemptAt), index().on(t.documentId, t.createdAt)],
);
