import type { ServiceAuth } from '../service-auth';

/**
 * Pubblicare il Profilo Sanitario Sintetico nel Fascicolo della regione dello studio (D280): il
 * contratto nazionale. In FSE 2.0 il programma valida il documento sul Gateway nazionale; dove la
 * regione lo vuole, lo manda poi ai servizi del suo Fascicolo, che lo pubblicano sul Gateway. Lo
 * attua il pacchetto della regione (D288, D297), con le sue specifiche, le sue politiche di invio
 * e il suo simulatore (regola 7); la coda del programma lo usa, un messaggio alla volta.
 *
 * Le credenziali del medico per i servizi della regione arrivano a ogni chiamata e nel registro
 * degli invii non ci vanno: il messaggio conservato le ha tolte.
 */

/** Il medico autore: codice fiscale, nome e il codice della sua ASL. */
export interface RegionalAuthor {
  fiscalCode: string;
  firstName: string;
  lastName: string;
  aslCode: string;
}

/** I metadati del documento che dipendono dal Profilo (gli altri li fissa la regione). */
export interface RegionalPssMetadata {
  patientFiscalCode: string;
  /** «N» normale; «V» per un documento oscurato o con dati a maggior tutela. */
  confidentiality: 'N' | 'V';
  /** Quando il medico ha redatto il documento. */
  writtenAt: Date;
  /** Il regime (administrativeRequest del Gateway), uno di quelli che la regione ammette. */
  regime: string;
  signed: boolean;
}

interface DocumentPart {
  /** Il PDF firmato con il CDA dentro. */
  document: Uint8Array;
  /** Dalla validazione sul Gateway. */
  workflowInstanceId: string;
  /** La struttura nel formato XON mandata al Gateway nella validazione (Locality). */
  locality: string;
}

export interface RegionalCreateInput extends DocumentPart {
  author: RegionalAuthor;
  metadata: RegionalPssMetadata;
}

export interface RegionalReplaceInput extends RegionalCreateInput {
  /** Il documento da sostituire, come lo dà la ricerca (`uuid`). */
  target: string;
}

export interface RegionalUpdateInput {
  author: RegionalAuthor;
  metadata: RegionalPssMetadata;
  /** Identificativo del documento pubblicato i cui metadati cambiano. */
  documentOid: string;
}

export interface RegionalDeleteInput {
  author: RegionalAuthor;
  patientFiscalCode: string;
  /** Identificativo del documento pubblicato. */
  documentId: string;
}

export interface RegionalOutcomeInput {
  author: RegionalAuthor;
  temporaryId: string;
  /** Intervallo di ricerca dell'esito. */
  from: Date;
  to: Date;
}

export interface RegionalSearchInput {
  author: RegionalAuthor;
  patientFiscalCode: string;
  /** Identificativo del documento; senza, l'ultimo documento del medico per l'assistito. */
  documentOid?: string;
}

export interface RegionalError {
  code: string;
  message: string;
  /** Il tipo dell'errore con le parole del servizio della regione (avviso, bloccante…). */
  kind: string;
  source: string;
}

/** Che cosa è partito e che cosa è tornato, per il registro degli invii (credenziali tolte). */
export interface RegionalExchange {
  sent: string;
  received: string | null;
}

export type RegionalFailure =
  | {
      outcome: 'rejected';
      /** L'esito del servizio della regione, con le sue parole o il suo codice. */
      esito: string;
      errors: RegionalError[];
      /** Le politiche di invio vogliono un nuovo tentativo, senza toccare il messaggio. */
      retryable: boolean;
      /** Le credenziali del medico rifiutate dal servizio della regione. */
      authProblem?: 'credentials';
      /** Solo nella cancellazione: il servizio dice che non c'è niente da cancellare. */
      nothingToDelete?: true;
    }
  | { outcome: 'unreachable'; message: string }
  | { outcome: 'timeout'; message: string };

/** Documento nuovo o sostituzione: presa in carico, con l'identificativo per chiedere l'esito. */
export type RegionalSubmitResult = RegionalExchange &
  (
    | { outcome: 'accepted'; esito: string; warnings: RegionalError[]; temporaryId: string }
    | RegionalFailure
  );

/** Metadati cambiati o documento cancellato. */
export type RegionalSendResult = RegionalExchange &
  ({ outcome: 'accepted'; esito: string; warnings: RegionalError[] } | RegionalFailure);

/** L'esito della pubblicazione: ancora in elaborazione, pubblicato con l'OID, scartato. */
export type RegionalOutcomeResult = RegionalExchange &
  (
    | { outcome: 'checked'; state: 'ELAB'; warnings: RegionalError[] }
    | { outcome: 'checked'; state: 'OK'; oid: string; warnings: RegionalError[] }
    | { outcome: 'checked'; state: 'KO'; reason: string | null; warnings: RegionalError[] }
    | RegionalFailure
  );

export type RegionalSearchResult = RegionalExchange &
  (
    | {
        outcome: 'found';
        oid: string;
        uuid: string;
        version: string | null;
        warnings: RegionalError[];
      }
    | { outcome: 'not-found'; warnings: RegionalError[] }
    | RegionalFailure
  );

/** Le politiche di invio della regione, per la coda del programma. */
export interface RegionalPublicationPolicy {
  /** Dalla mezzanotte a quest'ora di Roma il Fascicolo della regione non riceve; null se mai. */
  quietUntilHour: number | null;
  /** Fra due messaggi, negli invii in serie, con il servizio vero (millisecondi). */
  minIntervalMs: number;
  /** Dopo il primo invio fallito che si può ripetere: quante ripetizioni ravvicinate. */
  retries: number;
  /** A che distanza (millisecondi). */
  retryDelayMs: number;
  /** Poi un tentativo al giorno per tanti giorni; poi il messaggio non è arrivato. */
  fallbackDays: number;
}

export interface RegionalFsePublication {
  readonly environment: 'simulator' | 'test' | 'production';
  /** Con quali credenziali del medico si pubblica: il nome corto del servizio (D301). */
  readonly credentialService: string;
  /** I regimi che la regione ammette (codici del Gateway, administrativeRequest), con i nomi. */
  readonly regimes: Readonly<Record<string, string>>;
  /** L'attività clinica che la regione fissa per il Profilo (tipoAttivitaClinica del Gateway). */
  readonly clinicalActivity: string;
  readonly policy: RegionalPublicationPolicy;
  /** Le parole per il medico, della regione. */
  readonly texts: {
    /** Credenziali rifiutate: che cosa controllare, e dove. */
    credentialsRefused: string;
    /** Credenziali mancanti: quali servono, e dove si inseriscono. */
    credentialsMissing: string;
    /** A chi segnalare un messaggio che non arriva: il complemento, «al supporto …». */
    reportTo: string;
  };
  /** Che cosa manca al medico autore per i servizi della regione (per esempio il codice ASL). */
  authorIssues(author: Pick<RegionalAuthor, 'aslCode'>): string[];
  /** Documento nuovo. */
  create(input: RegionalCreateInput, auth: ServiceAuth): Promise<RegionalSubmitResult>;
  /** Correzione del documento pubblicato, dopo la ricerca. */
  replace(input: RegionalReplaceInput, auth: ServiceAuth): Promise<RegionalSubmitResult>;
  /** Solo i metadati, per esempio l'oscuramento. */
  update(input: RegionalUpdateInput, auth: ServiceAuth): Promise<RegionalSendResult>;
  /** Cancellazione del documento e dei metadati. */
  remove(input: RegionalDeleteInput, auth: ServiceAuth): Promise<RegionalSendResult>;
  /** L'esito della pubblicazione, con l'identificativo della presa in carico. */
  outcome(input: RegionalOutcomeInput, auth: ServiceAuth): Promise<RegionalOutcomeResult>;
  /** Il documento pubblicato, dal suo identificativo: per sostituirlo. */
  search(input: RegionalSearchInput, auth: ServiceAuth): Promise<RegionalSearchResult>;
}

/** Il regime, se la regione lo ammette. */
export const regimeOf = (
  publication: Pick<RegionalFsePublication, 'regimes'>,
  value: string | null | undefined,
): string | null => (value && Object.hasOwn(publication.regimes, value) ? value : null);
