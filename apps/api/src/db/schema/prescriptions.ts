import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { patientRequest } from './agenda';
import { patient, reminderChannel } from './patients';
import { therapy, therapyKind } from './therapy';
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
export const sendErrorKind = pgEnum('send_error_kind', [
  'rejected',
  'unreachable',
  'timeout',
  'auth',
]);
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
    /** Numero di ricetta elettronica (NRE; NRBE per la bianca), dal servizio o dal Sistema TS. */
    nre: text(),
    /**
     * NRE preso dal lotto del medico alla prima firma (D269): la ricetta lo tiene e, dopo un
     * rifiuto con errori bloccanti, si rimanda con lo stesso numero (V06, 4.3.1, caso 3). Nessun
     * NRE di un lotto va a due ricette.
     */
    assignedNre: text(),
    nreLotId: uuid().references((): AnyPgColumn => nreLot.id),
    priority: priorityClass(),
    accessType: accessType(),
    diagnosticQuestion: text(),
    /**
     * Condizione RAO scelta dal medico (D285), com'era alla scelta: la chiave (fonte, tabella, riga e
     * indicazione), la classe della tabella, il testo dell'indicazione e la fonte con la tabella. La
     * classe della ricetta resta `priority`: il programma ci mette questa, il medico la può cambiare.
     */
    raoConditionKey: text(),
    raoConditionPriority: priorityClass(),
    raoConditionText: text(),
    raoConditionSource: text(),
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
    /**
     * «Archivia ricette confermate» (D254): la ricetta inviata o stampata esce dall'elenco della
     * pagina Ricette e resta nello storico del paziente. Vale per tutto lo studio.
     */
    archivedAt: timestamp({ withTimezone: true }),
    archivedBy: uuid().references(() => appUser.id),
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
     * Codice di autenticazione restituito dal SAC, anche tramite il servizio della regione: senza,
     * la ricetta SSN non è valida e il promemoria non si dà; va stampato su ogni promemoria
     * (specifiche del Sistema TS, prescrizione, 5/12/2024).
     */
    authCode: text(),
    /** Cognome e nome del medico come li restituisce il SAC, per il promemoria (stesse specifiche). */
    sacDoctorName: text(),
    /** Ricetta bianca: numero breve per paziente e anno (Disciplinare tecnico, 1/12/2022). */
    pinNrbe: text(),
    /** Su richiesta del paziente: cognome, nome e indirizzo oscurati (oscuramDati). */
    obscured: boolean().notNull().default(false),
    /**
     * Invio in corso (D239): il messaggio mandato all'ente e i dati del paziente per il promemoria,
     * com'erano alla firma. Se il servizio si ferma prima della risposta, l'esito segnato a mano
     * registra la richiesta partita davvero. Si toglie con l'esito.
     */
    sendingSnapshot: jsonb(),
    updatedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index().on(t.archiveId, t.status),
    index().on(t.patientId),
    uniqueIndex('prescription_assigned_nre_key')
      .on(t.assignedNre)
      .where(sql`${t.assignedNre} is not null`),
    // La condizione RAO c'è tutta o non c'è (D285), e solo sulla specialistica del primo accesso.
    check(
      'prescription_rao_condition',
      sql`(${t.raoConditionKey} is null and ${t.raoConditionPriority} is null and ${t.raoConditionText} is null and ${t.raoConditionSource} is null) or (${t.raoConditionKey} is not null and ${t.raoConditionPriority} is not null and ${t.raoConditionText} is not null and ${t.raoConditionSource} is not null and ${t.kind} = 'specialist_ssn' and ${t.accessType} = 'first')`,
    ),
  ],
);

/**
 * Lotto di NRE del medico (D269, D300): 1000 numeri che il servizio della regione «estrae» da un
 * lotto avuto dal SAC e lega al codice fiscale del medico, dove la regione dà i lotti. La
 * cartella genera gli NRE agendo solo sul progressivo, da 000 a 999, e non dà mai due volte lo
 * stesso: il prossimo progressivo cresce dentro la transazione che lo assegna. I lotti di un
 * simulatore non vanno al servizio vero: si tengono per ambiente.
 */
export const nreLot = pgTable(
  'nre_lot',
  {
    id: uuid().primaryKey().defaultRandom(),
    doctorUserId: uuid()
      .notNull()
      .references(() => appUser.id),
    /** Codice fiscale con cui il medico ha chiesto il lotto: il servizio lo lega a lui. */
    doctorFiscalCode: text().notNull(),
    /** «simulator», «test» o «production», come il registro degli invii. */
    environment: text().notNull(),
    /** CodRegione, CodRagLotto, IdentificativoLotto e CodLotto della ricevuta del servizio. */
    regionCode: text().notNull(),
    groupCode: text().notNull(),
    lotType: text().notNull(),
    lotCode: text().notNull(),
    /** I primi 12 caratteri, comuni ai 1000 NRE. */
    prefix: text().notNull(),
    size: integer().notNull(),
    /** Il prossimo progressivo da dare: quando arriva a `size`, il lotto è finito. */
    nextProgressive: integer().notNull().default(0),
    receivedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** La ricevuta del servizio così com'è. */
    response: jsonb(),
  },
  (t) => [
    uniqueIndex('nre_lot_prefix_key').on(t.environment, t.prefix),
    index().on(t.doctorUserId, t.environment),
    check(
      'nre_lot_progressive_check',
      sql`${t.nextProgressive} >= 0 and ${t.nextProgressive} <= ${t.size}`,
    ),
  ],
);

export const dpcmStatus = pgEnum('dpcm_status', [
  /** Da mandare al servizio della regione: la coda ci riprova finché non è accolta. */
  'to_send',
  /** Accolta, con il protocollo: si aspetta l'esito dei controlli. */
  'accepted',
  /** Esito letto: senza errori. */
  'ok',
  /** Esito letto: con avvisi, che non si correggono (per esempio 2090). */
  'warnings',
  /** Esito letto: errori scartanti, o file scartato del tutto (stati 4 e 5). */
  'discarded',
]);

/**
 * Ricetta rossa in modalità DPCM (D270, D300): dove la regione la vuole, la ricetta stampata sul
 * modulo del Poligrafico quando la ricetta dematerializzata non ha esito, mandata poi al servizio
 * della regione con il numero del modulo e un NRE nuovo del lotto del medico, entro 24 ore dalla
 * compilazione. Se la ricetta dematerializzata può essere arrivata, la cartella la annulla da sé.
 */
export const dpcmPrescription = pgTable(
  'dpcm_prescription',
  {
    id: uuid().primaryKey().defaultRandom(),
    prescriptionId: uuid()
      .notNull()
      .references(() => prescription.id),
    /** Il medico che ha stampato e firmato il modulo: il servizio gli lega l'NRE. */
    doctorUserId: uuid()
      .notNull()
      .references(() => appUser.id),
    /** «simulator», «test» o «production». */
    environment: text().notNull(),
    /** Il numero del Poligrafico letto dal modulo, 15 cifre (Bar1 e Bar2). */
    poligrafico: text().notNull(),
    /** L'NRE nuovo, dal lotto del medico (Ricetta1). */
    nre: text().notNull(),
    nreLotId: uuid().references(() => nreLot.id),
    printedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** La ricetta come va al servizio, con i dati in chiaro: la cifratura si fa all'invio. */
    content: jsonb().notNull(),
    status: dpcmStatus().notNull().default('to_send'),
    /** Il protocollo della ricevuta di accoglienza (23 cifre). */
    protocol: text(),
    acceptedAt: timestamp({ withTimezone: true }),
    /** Ultimo stato dell'elenco sintetico (da 1 a 5) e messaggi dell'elenco analitico. */
    sendState: integer(),
    messages: jsonb(),
    checkedAt: timestamp({ withTimezone: true }),
    attempts: integer().notNull().default(0),
    lastAttemptAt: timestamp({ withTimezone: true }),
    lastError: text(),
    /** Quando la coda riprova (invio o lettura dell'esito). */
    nextAttemptAt: timestamp({ withTimezone: true }),
    /**
     * Ricetta dematerializzata da annullare: il suo NRE, se può essere arrivata al servizio (tempo
     * scaduto o eccezione di sistema). Null se non serve.
     */
    dmNre: text(),
    /**
     * Chi aveva firmato la ricetta dematerializzata: l'annullamento si chiede con le sue credenziali
     * e a suo nome, anche se la ricetta rossa l'ha stampata un altro medico dell'archivio.
     */
    dmDoctorUserId: uuid().references(() => appUser.id),
    /** «pending», «done» (annullata), «failed» (non annullata: lo dice il messaggio). */
    dmCancelStatus: text(),
    dmCancelAttempts: integer().notNull().default(0),
    dmCancelNextAt: timestamp({ withTimezone: true }),
    dmCancelError: text(),
    dmCancelledAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    uniqueIndex('dpcm_prescription_prescription_key').on(t.prescriptionId),
    uniqueIndex('dpcm_prescription_poligrafico_key').on(t.poligrafico),
    uniqueIndex('dpcm_prescription_nre_key').on(t.nre),
    index().on(t.doctorUserId, t.status),
  ],
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
    /** Codice del catalogo regionale della prestazione (codCatalogoPrescr). */
    serviceCode: text(),
    /**
     * Codice del nomenclatore, il «codice DM» (codProdPrest): obbligatorio per la specialistica
     * insieme a quello del catalogo (specifiche del Sistema TS, prescrizione, 5/12/2024; D154).
     */
    serviceNationalCode: text(),
    serviceDescription: text(),
    /**
     * Numero della nota del nomenclatore (numeroNota): condizione di erogabilità o indicazione di
     * appropriatezza prescrittiva dell'allegato 4D del DPCM LEA (D276).
     */
    serviceNote: text(),
    /** Tipo della nota quando si è fatta la riga: «condizione» o «appropriatezza» (D276). */
    serviceNoteKind: text(),
    /**
     * Lettera della condizione o dell'indicazione scelta dal medico fra quelle della nota
     * (condErogabilita o approprPrescrittiva, secondo il tipo della nota; D276).
     */
    serviceNoteLetter: text(),
    /** Sedute del ciclo (numsedute), solo per le prestazioni a ciclo (D276). */
    sessions: integer(),
    /** Confezioni (farmaci) o quantità (prestazioni). */
    quantity: integer().notNull(),
    aifaNote: text(),
    byActiveIngredient: boolean().notNull().default(false),
    notSubstitutable: boolean().notNull().default(false),
    notSubstitutableReason: text(),
    /** Codice della motivazione di non sostituibilità, da 1 a 4 (codMotivazione, Prescrizione1; D273). */
    notSubstitutableCode: text(),
    posologyText: text(),
    /**
     * Ricetta bianca ripetibile: volte e mesi di validità, solo se diversi dalla regola del farmaco
     * (Disciplinare tecnico della ricetta bianca, 1/12/2022: numRipetibilita, validitaFarm).
     */
    repeatCount: integer(),
    validityMonths: integer(),
    /**
     * Tipo di terapia segnato sulla riga (D283): con il tipo la riga porta la scelta intera (tipo,
     * fine del ciclo, tipologia S o H, «Non rimborsabile SSN», medico suggeritore). Alla firma il
     * programma crea la terapia, o aggiorna quella collegata. Vuoto: la riga non sceglie niente.
     */
    therapyKind: therapyKind(),
    therapyEndOn: date(),
    /** «S» suggerita o «H» ricovero; vuoto: nessuna delle due. */
    therapyTypology: text(),
    therapyNotReimbursable: boolean(),
    therapySuggestedByName: text(),
    therapySuggestedByFacility: text(),
    therapySuggestedOn: date(),
    /** La scelta è una proposta di chi non firma (la segreteria): il medico la conferma o no. */
    therapyProposedBy: uuid().references(() => appUser.id),
    /** Decisione del medico sulla proposta, alla firma: «confirmed» o «declined». */
    therapyProposalDecision: text(),
    /** Quando la scelta è passata alla terapia: una volta sola, anche se l'invio si ripete. */
    therapyChoiceAppliedAt: timestamp({ withTimezone: true }),
  },
  (t) => [
    index().on(t.prescriptionId),
    check(
      'prescription_line_therapy_typology',
      sql`${t.therapyTypology} is null or ${t.therapyTypology} in ('S', 'H')`,
    ),
    check(
      'prescription_line_therapy_decision',
      sql`${t.therapyProposalDecision} is null or ${t.therapyProposalDecision} in ('confirmed', 'declined')`,
    ),
  ],
);

/**
 * Dove va la chiamata: al servizio delle ricette della regione dello studio o al Sistema TS (D300;
 * prima del 26/11/2026 il primo valore aveva il nome del servizio di una regione, migrazione 0061).
 */
export const gatewaySystem = pgEnum('gateway_system', ['regional', 'sistema_ts']);

/**
 * Invio esterno: ogni chiamata al servizio della regione o al Sistema TS con richiesta, risposta ed
 * esito. Non si modifica e non si cancella (migrazione 0004).
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
    /**
     * «consegnato», «rifiutato», «non_raggiungibile»; «stampato» per le stampe registrate
     * all'apertura del PDF fino all'audit D259: da allora la carta è «consegnato», segnato da chi
     * l'ha data.
     */
    outcome: text().notNull(),
    messageId: text(),
    errorMessage: text(),
  },
  (t) => [index().on(t.prescriptionId)],
);
