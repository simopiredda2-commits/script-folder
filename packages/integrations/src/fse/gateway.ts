/**
 * Gateway del Fascicolo Sanitario Elettronico 2.0 (specifiche di integrazione del Ministero,
 * versione 2.26 del 30/10/2026). Qui il cliente del programma: costruisce i due token JWT e la
 * richiesta, la passa a un trasporto e legge la risposta (RFC 7807 per gli errori). Il trasporto
 * vero (HTTPS con il certificato di collegamento) arriverà con l'accreditamento; per ora c'è solo
 * il simulatore (regola 7).
 */

import { createHash, randomUUID } from 'node:crypto';
import { createPrivateKey } from 'node:crypto';
import { signJwt } from './jwt';

/** Codifica del codice fiscale nei token: «CF^^^&2.16.840.1.113883.2.9.4.3.2&ISO» (16.1). */
export const fiscalCodeClaim = (cf: string) => `${cf}^^^&2.16.840.1.113883.2.9.4.3.2&ISO`;

/** Tipo di documento del PSS nei token (resource_hl7_type, 16.1): LOINC 60591-5. */
export const PSS_RESOURCE_TYPE = "('60591-5^^2.16.840.1.113883.6.1')";

/**
 * Attività clinica (metadato tipoAttivitaClinica): codice e nome della tabella 57 della specifica
 * del Gateway 2.26, che la prende dall'Affinity Domain Italia 2.5.
 */
export const FSE_CLINICAL_ACTIVITIES = {
  PHR: 'Personal Health Record Update',
  CON: 'Consulto',
  DIS: 'Discharge',
  ERP: 'Erogazione Prestazione Prenotata',
  Sistema_TS: 'Documenti sistema TS',
  INI: 'Documenti INI',
  PN_DGC: 'Documenti PN-DGC',
  OBS: 'Documento stato di salute',
} as const;
export type FseClinicalActivity = keyof typeof FSE_CLINICAL_ACTIVITIES;

/** Regime di erogazione (metadato administrativeRequest): tabella 63 della stessa specifica. */
export const FSE_ADMINISTRATIVE_REQUESTS = {
  SSN: 'Regime SSN',
  INPATIENT: 'Regime di ricovero',
  NOSSN: 'Regime privato',
  SSR: 'Regime SSR',
  DONOR: 'Regime donatori',
  AUTO: 'Autoprodotto',
} as const;
export type FseAdministrativeRequest = keyof typeof FSE_ADMINISTRATIVE_REQUESTS;

export interface FseCertificate {
  der: Buffer;
  /** Chiave privata in PEM: nel programma vero viene dalle credenziali cifrate. */
  privateKeyPem: string;
}

/** I due certificati del programma rilasciati con l'accreditamento (2.3). */
export interface FseCredentials {
  /** Solo per il collegamento HTTPS. */
  authentication: FseCertificate;
  /** Solo per firmare i token JWT. */
  signature: FseCertificate;
}

/** Chi chiama: il medico, la sua struttura e il programma (campi dei token, 16.1). */
export interface FseCaller {
  /** Destinatario dei token: l'indirizzo di base del servizio (aud). */
  audience: string;
  /** Codice fiscale del medico (sub, iss). */
  fiscalCode: string;
  /** Ruolo (tabella 16.3.5): APR è il medico di medicina generale. */
  role: 'APR';
  /** Organizzazione (tabella 16.3.7), per esempio «010» e «Regione Piemonte». */
  organizationId: string;
  organizationName: string;
  /** Struttura dell'utente nel formato XON (locality). */
  locality: string;
  application: { id: string; vendor: string; version: string };
}

export type FseActivity = 'VALIDATION' | 'VERIFICA';

/** Metadati della pubblicazione (5.1, tabella 16). */
export interface FsePublicationMetadata {
  workflowInstanceId: string;
  healthDataFormat: 'CDA';
  mode: 'ATTACHMENT';
  tipologiaStruttura: string;
  attiCliniciRegoleAccesso?: string[];
  identificativoDoc: string;
  identificativoRep: string;
  tipoDocumentoLivAlto: string;
  assettoOrganizzativo: string;
  dataInizioPrestazione?: string;
  dataFinePrestazione?: string;
  tipoAttivitaClinica: string;
  identificativoSottomissione: string;
  descriptions?: string[];
  administrativeRequest: string[];
}

export interface FseProblem {
  type: string;
  title: string;
  detail: string;
  status: number;
  instance?: string;
}

export type FseResult =
  | {
      outcome: 'ok';
      status: number;
      traceId: string;
      workflowInstanceId?: string;
      warning?: string;
    }
  | { outcome: 'problem'; status: number; problem: FseProblem; traceId?: string }
  | { outcome: 'unreachable'; message: string }
  | { outcome: 'timeout'; message: string };

export interface FseEvent {
  eventType: string;
  eventStatus: 'SUCCESS' | 'BLOCKING_ERROR';
  eventDate: string;
}

export type FseStatusResult =
  | { outcome: 'ok'; events: FseEvent[] }
  | { outcome: 'problem'; status: number; problem: FseProblem }
  | { outcome: 'unreachable'; message: string }
  | { outcome: 'timeout'; message: string };

/** Richiesta così come arriva al servizio: intestazioni, corpo, certificato di collegamento. */
export interface FseHttpRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  headers: Record<string, string>;
  /** Impronta del certificato client del collegamento HTTPS. */
  clientCertificate: Buffer;
  requestBody?: Record<string, unknown>;
  file?: Uint8Array;
}

export type FseHttpResponse =
  { status: number; body: Record<string, unknown> } | { error: 'unreachable' | 'timeout' };

export interface FseTransport {
  readonly environment: 'simulator' | 'test' | 'production';
  send(req: FseHttpRequest): Promise<FseHttpResponse>;
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** Un campo di testo della risposta; vuoto se non c'è o non è testo. */
export const textOf = (v: unknown): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';

/**
 * Cliente del Gateway: le stesse richieste per il simulatore e per il servizio vero. I token
 * durano 5 minuti; ogni chiamata ha i suoi (jti diversi).
 */
export class FseGatewayClient {
  constructor(
    private readonly transport: FseTransport,
    private readonly credentials: FseCredentials,
    private readonly now: () => Date = () => new Date(),
  ) {}

  get environment() {
    return this.transport.environment;
  }

  /**
   * I due token. Contesto operativo (purpose_of_use) e tipo di attività (action_id) come nella
   * specifica 2.26, 8.1: TREATMENT e CREATE per validazione e creazione; UPDATE per sostituzione,
   * aggiornamento dei metadati ed eliminazione, che ha DELETE come tipo di attività.
   */
  private tokens(
    caller: FseCaller,
    patientFiscalCode: string,
    action: 'CREATE' | 'UPDATE' | 'DELETE',
    file?: Uint8Array,
  ) {
    const iat = Math.floor(this.now().getTime() / 1000);
    const common = {
      iat,
      exp: iat + 300,
      aud: caller.audience,
      sub: fiscalCodeClaim(caller.fiscalCode),
    };
    const key = createPrivateKey(this.credentials.signature.privateKeyPem);
    const auth = signJwt(
      {
        ...common,
        iss: `auth:${caller.fiscalCode}`,
        jti: randomUUID(),
        subject_organization_id: caller.organizationId,
        subject_organization: caller.organizationName,
        locality: caller.locality,
        subject_role: caller.role,
        person_id: fiscalCodeClaim(patientFiscalCode),
        patient_consent: true,
        purpose_of_use: action === 'CREATE' ? 'TREATMENT' : 'UPDATE',
        resource_hl7_type: PSS_RESOURCE_TYPE,
        action_id: action,
        subject_application_id: caller.application.id,
        subject_application_vendor: caller.application.vendor,
        subject_application_version: caller.application.version,
      },
      key,
      this.credentials.signature.der,
    );
    const signature = signJwt(
      {
        ...common,
        iss: `integrity:${caller.fiscalCode}`,
        jti: randomUUID(),
        ...(file ? { attachment_hash: sha256(file) } : {}),
      },
      key,
      this.credentials.signature.der,
    );
    return { authorization: `Bearer ${auth}`, 'fse-jwt-signature': signature };
  }

  private async call(req: Omit<FseHttpRequest, 'clientCertificate'>): Promise<FseResult> {
    const res = await this.transport.send({
      ...req,
      clientCertificate: this.credentials.authentication.der,
    });
    if ('error' in res)
      return res.error === 'timeout'
        ? { outcome: 'timeout', message: 'Gateway: nessuna risposta in tempo' }
        : { outcome: 'unreachable', message: 'Gateway non raggiungibile' };
    const b = res.body;
    if (res.status >= 400)
      return {
        outcome: 'problem',
        status: res.status,
        traceId: typeof b.traceID === 'string' ? b.traceID : undefined,
        problem: {
          type: textOf(b.type),
          title: textOf(b.title),
          detail: textOf(b.detail),
          status: Number(b.status ?? res.status),
          ...(typeof b.instance === 'string' ? { instance: b.instance } : {}),
        },
      };
    return {
      outcome: 'ok',
      status: res.status,
      traceId: textOf(b.traceID),
      ...(typeof b.workflowInstanceId === 'string'
        ? { workflowInstanceId: b.workflowInstanceId }
        : {}),
      ...(typeof b.warning === 'string' ? { warning: b.warning } : {}),
    };
  }

  /** Validazione del PDF con il CDA (3): VALIDATION se seguirà la pubblicazione. */
  validate(
    caller: FseCaller,
    patientFiscalCode: string,
    pdf: Uint8Array,
    activity: FseActivity = 'VALIDATION',
  ): Promise<FseResult> {
    return this.call({
      method: 'POST',
      path: '/v1/documents/validation',
      headers: this.tokens(caller, patientFiscalCode, 'CREATE', pdf),
      requestBody: { healthDataFormat: 'CDA', mode: 'ATTACHMENT', activity },
      file: pdf,
    });
  }

  /** Pubblicazione del PDF firmato (5): risponde 202, presa in carico. */
  publish(
    caller: FseCaller,
    patientFiscalCode: string,
    signedPdf: Uint8Array,
    metadata: FsePublicationMetadata,
  ): Promise<FseResult> {
    return this.call({
      method: 'POST',
      path: '/v1/documents',
      headers: this.tokens(caller, patientFiscalCode, 'CREATE', signedPdf),
      requestBody: { ...metadata },
      file: signedPdf,
    });
  }

  /** Sostituzione di un documento pubblicato (7): la versione nuova prende il suo posto. */
  replace(
    caller: FseCaller,
    patientFiscalCode: string,
    replacedDocumentId: string,
    signedPdf: Uint8Array,
    metadata: FsePublicationMetadata,
  ): Promise<FseResult> {
    return this.call({
      method: 'PUT',
      path: `/v1/documents/${encodeURIComponent(replacedDocumentId)}`,
      headers: this.tokens(caller, patientFiscalCode, 'UPDATE', signedPdf),
      requestBody: { ...metadata },
      file: signedPdf,
    });
  }

  /**
   * Eliminazione di un documento pubblicato (6): `DELETE /v1/documents/{identificativoDocUpdate}`,
   * l'OID usato come identificativoDoc nella creazione. Sincrona: 200 se eseguita.
   */
  remove(caller: FseCaller, patientFiscalCode: string, documentId: string): Promise<FseResult> {
    return this.call({
      method: 'DELETE',
      path: `/v1/documents/${encodeURIComponent(documentId)}`,
      headers: this.tokens(caller, patientFiscalCode, 'DELETE'),
    });
  }

  /** Stato della transazione (13): gli eventi verso INI ed EDS. */
  async status(
    caller: FseCaller,
    patientFiscalCode: string,
    workflowInstanceId: string,
  ): Promise<FseStatusResult> {
    const res = await this.transport.send({
      method: 'GET',
      path: `/v1/status/${encodeURIComponent(workflowInstanceId)}`,
      headers: this.tokens(caller, patientFiscalCode, 'CREATE'),
      clientCertificate: this.credentials.authentication.der,
    });
    if ('error' in res)
      return res.error === 'timeout'
        ? { outcome: 'timeout', message: 'Gateway: nessuna risposta in tempo' }
        : { outcome: 'unreachable', message: 'Gateway non raggiungibile' };
    if (res.status >= 400)
      return {
        outcome: 'problem',
        status: res.status,
        problem: {
          type: textOf(res.body.type),
          title: textOf(res.body.title),
          detail: textOf(res.body.detail),
          status: res.status,
        },
      };
    return { outcome: 'ok', events: (res.body.transactionData as FseEvent[] | undefined) ?? [] };
  }
}
