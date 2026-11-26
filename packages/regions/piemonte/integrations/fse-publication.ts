/**
 * Pubblicazione del Profilo Sanitario Sintetico con i servizi del Fascicolo della Regione Piemonte:
 * «Specifiche di integrazione tra le Cartelle Cliniche Elettroniche dei MMG/PLS e il Fascicolo
 * Sanitario Elettronico della Regione Piemonte per l'invio del Patient Summary, del Bilancio di
 * Salute e del Piano di Cura Personalizzato», CSI Piemonte, FSE-PSS-SRS-01-V09, maggio 2026
 * (D266, D280).
 *
 * In FSE 2.0 la cartella valida il documento sul Gateway nazionale e ne riceve il
 * workflowInstanceId; poi lo manda alla Regione, che lo pubblica sul Gateway (2, 4):
 * - ComunicazioneMetadati «CREATE»: il PDF firmato con il CDA e i metadati; la risposta dà un
 *   identificativo temporaneo (5.2.5);
 * - EsitoCaricamentoDocumento: «ELAB» finché la pubblicazione non è finita, poi «OK» con l'OID
 *   del documento o «KO» con la motivazione (5.4);
 * - «REPLACE»: RicercaDocumenti dall'OID all'UUID, poi ComunicazioneMetadati «REPLACE» (4.3);
 * - «UPDATE»: solo i metadati, per esempio l'oscuramento (4.2);
 * - CancellazioneMetadati, con l'OID o con l'UUID (4.4).
 *
 * Servizi SOAP con WS-Security (username token) e le credenziali RUPAR del medico; nel messaggio
 * il PIN cifrato con la chiave pubblica del certificato della Regione (lo stesso del SIRPED), RSA
 * con padding PKCS#1 v1.5, in BASE64 (3.2). Qui i messaggi, il cliente e la pubblicazione che
 * attua il contratto nazionale di `@mmg/integrations` con le politiche di invio della Regione
 * (D297); il simulatore è in `fse-publication-simulator.ts` (regola 7). Il trasporto vero (HTTPS
 * con TLS 1.2, documento in MTOM) si scrive con il kit di prova del CSI.
 */

import { constants, createHash, publicEncrypt, randomUUID, X509Certificate } from 'node:crypto';
import {
  hl7Time,
  xmlText,
  type RegionalAuthor,
  type RegionalCreateInput,
  type RegionalDeleteInput,
  type RegionalError,
  type RegionalExchange,
  type RegionalFailure,
  type RegionalFsePublication,
  type RegionalOutcomeInput,
  type RegionalOutcomeResult,
  type RegionalPublicationPolicy,
  type RegionalReplaceInput,
  type RegionalSearchInput,
  type RegionalSearchResult,
  type RegionalSendResult,
  type RegionalSubmitResult,
  type RegionalUpdateInput,
  type ServiceAuth,
} from '@mmg/integrations';
import { DOMParser, type Element } from '@xmldom/xmldom';
import { RUPAR_CREDENTIALS } from './rupar';

/** Spazi dei nomi scritti nella V09 (5.2.1, ComunicazioneMetadati) e quelli di WS-Security. */
export const V09_NAMESPACES = {
  soap12: 'http://www.w3.org/2003/05/soap-envelope',
  soap11: 'http://schemas.xmlsoap.org/soap/envelope/',
  dmac: 'http://dmaclbl.csi.it/',
  tip: 'http://tipodaticomunicazionemetadati.xsd.fse.ini.finanze.it',
  dma: 'http://dma.csi.it/',
  wsse: 'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd',
} as const;

/** Password in chiaro nel token (su canale cifrato): profilo «username token» di WS-Security. */
export const PASSWORD_TEXT =
  'http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordText';

/**
 * Spazi dei nomi che la V09 lascia vuoti («xmlns:can=" "», 5.3.1, 5.4.1, 1.2.1): vengono dal WSDL
 * del CSI, con il kit di prova (da completare). Il simulatore usa i suoi.
 */
export interface RegionalFseNamespaces {
  /** CancellazioneMetadatiRichiesta (prefisso «can»). */
  cancellation: string;
  /** EsitoCaricamentoDocumentoRichiesta (prefisso «esit»). */
  outcome: string;
  /** RicercaDocumentiRichiesta (prefisso «ric»). */
  search: string;
}

export const SIMULATED_REGIONAL_NAMESPACES: RegionalFseNamespaces = {
  cancellation: 'urn:simulatore:fse-piemonte:cancellazione-metadati',
  outcome: 'urn:simulatore:fse-piemonte:esito-caricamento-documento',
  search: 'urn:simulatore:fse-piemonte:ricerca-documenti',
};

/** I valori che la V09 fissa per il PSS del medico di medicina generale (5.2.2–5.4.2). */
export const V09 = {
  /** IdentificativoOrganizzazione: «010» per la Regione Piemonte. */
  organization: '010',
  /** StrutturaUtente: sei trattini, come nelle specifiche INI. */
  userStructure: '------',
  role: 'APR',
  context: 'TREATMENT',
  facilityType: 'Territorio',
  mimeType: 'application/pdf+text/x-cda-r2+xml',
  /** TipologiaDocumentoAlto, Medio e Basso del PSS. */
  classCode: 'SUM',
  typeCode: '60591-5',
  formatCode: 'PDF',
  authorRole: 'APR',
  /** SpecialitaAutore e AssettoOrganizzativo: «AD_PSC130» (Medicina di Base). */
  authorSpecialty: 'AD_PSC130',
  practiceSetting: 'AD_PSC130',
  /** TipoAttivitaClinica: «ERP» (Erogazione Prestazione Prenotata), D266. */
  clinicalActivity: 'ERP',
  /** ModalitaAlimentazione: «FSE2.0», invio verso il Gateway. */
  mode: 'FSE2.0',
  /** Oscuramento del documento a tutti i ruoli (RegoleAccesso). */
  obscured: 'P99',
  updateAssociation: 'urn:oasis:names:tc:ebxmlregrep:AssociationType:HasMember',
  replaceAssociation: 'urn:ihe:iti:2007:AssociationType:RPLC',
  /** Radice del codice fiscale nel tipo XCN di IHE (CodiceFiscaleAutore). */
  fiscalCodeRoot: '2.16.840.1.113883.2.9.4.3.2',
} as const;

/** Tabella dei regimi della V09 (5.2.2): il codice va in RegimeDocumento. */
export const REGIONAL_REGIMES = {
  SSN: 'Regime SSN',
  INPATIENT: 'Regime di ricovero',
  NOSSN: 'Regime privato',
  SSR: 'Regime SSR',
  DONOR: 'Regime donatori',
} as const;
export type RegionalRegime = keyof typeof REGIONAL_REGIMES;

/**
 * Codici di errore per cui le politiche di invio vogliono un nuovo tentativo senza toccare il
 * messaggio (FSE-INT-SRS-01-V02, 4.1): FSE_ER_000 ed errori di sistema di INI. Per gli altri si
 * corregge prima di rimandare.
 */
export const REGIONAL_RETRYABLE_CODES = new Set([
  'FSE_ER_000',
  'INI-9000',
  'INI-9904',
  'INI-9905',
  'INI-9906',
]);

/** Esiti della V09 (5.2.5): 0000 riuscita, 0001 riuscita con avvisi, 9999 fallita. */
export const REGIONAL_OK = '0000';
export const REGIONAL_OK_WITH_WARNINGS = '0001';
export const REGIONAL_FAILED = '9999';
/** «Nessun metadato trovato da cancellare» (5.3.3.2). */
export const REGIONAL_NOTHING_TO_DELETE = '1103';
/** «Nessun risultato trovato» (5.4.3.2, 1.2.3.2). */
export const REGIONAL_NOT_FOUND = '1059';

export type RegionalFseService =
  | 'ComunicazioneMetadati'
  | 'CancellazioneMetadati'
  | 'EsitoCaricamentoDocumento'
  | 'RicercaDocumenti';

/** La richiesta come arriva al servizio: il messaggio SOAP intero, credenziali comprese. */
export interface RegionalSoapRequest {
  service: RegionalFseService;
  envelope: string;
}

export type RegionalSoapResponse =
  { status: number; body: string } | { error: 'unreachable' | 'timeout' };

export interface RegionalFseTransport {
  readonly environment: 'simulator' | 'test' | 'production';
  send(req: RegionalSoapRequest): Promise<RegionalSoapResponse>;
}

export interface RegionalApplication {
  id: string;
  vendor: string;
  version: string;
}

/**
 * I risultati del cliente, come li dice la V09: l'identificativo temporaneo c'è solo nelle
 * comunicazioni accettate di CREATE e REPLACE; l'OID solo con «OK». La pubblicazione li porta al
 * contratto nazionale (`V09FsePublication`).
 */
export type V09SendResult = RegionalExchange &
  (
    | { outcome: 'accepted'; esito: string; warnings: RegionalError[]; temporaryId: string | null }
    | RegionalFailure
  );

export type V09OutcomeResult = RegionalExchange &
  (
    | {
        outcome: 'checked';
        state: 'OK' | 'KO' | 'ELAB';
        /** OID definitivo, con «OK». */
        oid: string | null;
        /** Motivazione dello scarto, con «KO». */
        reason: string | null;
        warnings: RegionalError[];
        /** La risposta del Gateway nazionale, in FSE 2.0 (resultGW). */
        gateway: { traceId: string | null; spanId: string | null; transactionData: string[] };
      }
    | RegionalFailure
  );

/* Messaggi ------------------------------------------------------------------------------------ */

/** Data nel formato della V09, «yyyymmddHH24MMSS», nell'ora di Roma. */
export const v09Time = (d: Date) => hl7Time(d).slice(0, 14);

/** Nome per il tipo XCN: niente separatori HL7, maiuscole come nell'esempio della V09. */
const xcnPart = (s: string) =>
  s
    .replace(/[\^&|~\\]/g, ' ')
    .trim()
    .toUpperCase();

/** CodiceFiscaleAutore nel tipo IHE ITI TF-3 XCN (5.2.2). */
export const authorXcn = (a: RegionalAuthor) =>
  `${a.fiscalCode}^${xcnPart(a.lastName)}^${xcnPart(a.firstName)}^^^^^^&${V09.fiscalCodeRoot}&ISO`;

/** IstituzioneAutore: codice della regione e dell'ASL, attaccati (5.2.2). */
export const authorInstitution = (a: RegionalAuthor) => `${V09.organization}${a.aslCode}`;

/**
 * Impronta del documento in HashDoc. La V09 dice solo «da valorizzare»: qui SHA-256 in esadecimale,
 * come l'attachment_hash del Gateway; l'algoritmo è da confermare con il CSI (D280).
 */
export const documentHash = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

const el = (name: string, value: string | number | null | undefined) =>
  value === null || value === undefined || value === ''
    ? ''
    : `<${name}>${xmlText(String(value))}</${name}>`;

/** La parte fissa delle richieste (5.2.2): utente, PIN, organizzazione, struttura, ruolo. */
function caller(prefix: string, author: RegionalAuthor, pinCode: string, context = true) {
  return [
    el(`${prefix}IdentificativoUtente`, author.fiscalCode),
    el(`${prefix}pinCode`, pinCode),
    el(`${prefix}IdentificativoOrganizzazione`, V09.organization),
    el(`${prefix}StrutturaUtente`, V09.userStructure),
    el(`${prefix}RuoloUtente`, V09.role),
    context ? el(`${prefix}ContestoOperativo`, V09.context) : '',
  ].join('');
}

function applicationFields(app: RegionalApplication) {
  return [
    el('IdentificativoApplicativoRichiedente', app.id),
    el('FornitoreApplicativoRichiedente', app.vendor),
    el('VersioneApplicativoRichiedente', app.version),
  ].join('');
}

type CommunicationInput =
  | ({ operation: 'CREATE' } & RegionalCreateInput)
  | ({ operation: 'REPLACE' } & RegionalReplaceInput)
  | ({ operation: 'UPDATE' } & RegionalUpdateInput);

/** Il tag metadato (5.2.2, 5.2.3, 5.2.4), con le sue regole per ciascuna modalità. */
function metadataXml(input: CommunicationInput, symbolicUuid: string): string {
  const m = input.metadata;
  const at = v09Time(m.writtenAt);
  const doc = input.operation === 'UPDATE' ? null : input.document;
  const t = (name: string, value: string | number | null | undefined) => el(`tip:${name}`, value);
  const association =
    input.operation === 'UPDATE'
      ? `<tip:Associazione>${t('associationType', V09.updateAssociation)}${t('sourceObject', 'source')}${t('targetObject', 'target update')}${t('submissionSetStatus', 'Original')}${t('previousVersion', '1')}</tip:Associazione>`
      : input.operation === 'REPLACE'
        ? `<tip:Associazione>${t('associationType', V09.replaceAssociation)}${t('sourceObject', symbolicUuid)}${t('targetObject', input.target)}${t('submissionSetStatus', 'Original')}</tip:Associazione>`
        : '';
  return [
    '<metadato>',
    t('TipologiaStrutturaProdDoc', V09.facilityType),
    t('IdentificativoAssistito', m.patientFiscalCode),
    t('TipoMime', V09.mimeType),
    t('LivelloConfidenzialita', m.confidentiality),
    // P99 solo con «V»; con «N» il tag non si valorizza (5.2.2).
    m.confidentiality === 'V' ? t('RegoleAccesso', V09.obscured) : '',
    t('TipologiaDocumentoAlto', V09.classCode),
    t('TipologiaDocumentoMedio', V09.typeCode),
    t('TipologiaDocumentoBasso', V09.formatCode),
    input.operation === 'UPDATE'
      ? t('RiferimentoDocumento', input.documentOid)
      : input.operation === 'REPLACE'
        ? t('RiferimentoDocumento', input.target)
        : '',
    association,
    input.operation === 'UPDATE'
      ? t('IdentificativoUnivocoDocumento', 'source')
      : input.operation === 'REPLACE'
        ? t('IdentificativoUnivocoDocumento', symbolicUuid)
        : '',
    t('DataValidazioneDocumento', at),
    t('RuoloAutore', V09.authorRole),
    t('IstituzioneAutore', authorInstitution(input.author)),
    t('CodiceFiscaleAutore', authorXcn(input.author)),
    t('SpecialitaAutore', V09.authorSpecialty),
    doc ? t('HashDoc', documentHash(doc)) : '',
    doc ? t('SizeDoc', doc.byteLength) : '',
    t('AssettoOrganizzativo', V09.practiceSetting),
    t('TipoAttivitaClinica', V09.clinicalActivity),
    t('DataInizioPrestazione', at),
    t('DataFinePrestazione', at),
    // RappresentanteLegale: il codice fiscale dell'autore, in UPDATE e REPLACE; in CREATE si omette.
    input.operation === 'CREATE' ? '' : t('RappresentanteLegale', input.author.fiscalCode),
    t('DocumentoFirmato', m.signed ? 'true^Documento firmato' : 'false^Documento non firmato'),
    t('RegimeDocumento', m.regime),
    '</metadato>',
  ].join('');
}

function wsSecurity(auth: ServiceAuth): string {
  return `<wsse:Security xmlns:wsse="${V09_NAMESPACES.wsse}"><wsse:UsernameToken><wsse:Username>${xmlText(auth.username ?? '')}</wsse:Username><wsse:Password Type="${PASSWORD_TEXT}">${xmlText(auth.password ?? '')}</wsse:Password></wsse:UsernameToken></wsse:Security>`;
}

/** Al posto delle credenziali, nel registro degli invii. */
const MASKED = '[omessa]';

function envelope12(header: string, body: string) {
  return `<?xml version="1.0" encoding="UTF-8"?><soap:Envelope xmlns:soap="${V09_NAMESPACES.soap12}" xmlns:dmac="${V09_NAMESPACES.dmac}" xmlns:tip="${V09_NAMESPACES.tip}" xmlns:dma="${V09_NAMESPACES.dma}"><soap:Header>${header}</soap:Header><soap:Body>${body}</soap:Body></soap:Envelope>`;
}

function envelope11(header: string, body: string, ns: Record<string, string>) {
  const decl = Object.entries(ns)
    .map(([p, u]) => ` xmlns:${p}="${u}"`)
    .join('');
  return `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="${V09_NAMESPACES.soap11}"${decl}><soapenv:Header>${header}</soapenv:Header><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;
}

/** ComunicazioneMetadatiRichiesta (5.2.1): il documento in BASE64 nel tag «documento». */
export function communicationBody(
  input: CommunicationInput,
  app: RegionalApplication,
  pinCode: string,
  symbolicUuid = 'urn:uuid:00000000-0000-4000-8000-000000000000',
): string {
  const doc = input.operation === 'UPDATE' ? null : input;
  return [
    '<dmac:ComunicazioneMetadatiRichiesta>',
    el('identificativoUtente', input.author.fiscalCode),
    el('pinCode', pinCode),
    el('identificativoOrganizzazione', V09.organization),
    el('strutturaUtente', V09.userStructure),
    el('ruoloUtente', V09.role),
    el('contestoOperativo', V09.context),
    el('identificativoAssistito', input.metadata.patientFiscalCode),
    el('presaInCarico', 'true'),
    el('tipoAttivita', input.operation),
    metadataXml(input, symbolicUuid),
    doc ? el('documento', Buffer.from(doc.document).toString('base64')) : '',
    applicationFields(app),
    doc ? el('WorkflowInstanceId', doc.workflowInstanceId) : '',
    doc ? el('Locality', doc.locality) : '',
    el('ModalitaAlimentazione', V09.mode),
    '</dmac:ComunicazioneMetadatiRichiesta>',
  ].join('');
}

/** CancellazioneMetadatiRichiesta (5.3.1). */
export function cancellationBody(
  input: RegionalDeleteInput,
  app: RegionalApplication,
  pinCode: string,
): string {
  return [
    '<can:CancellazioneMetadatiRichiesta>',
    caller('can:', input.author, pinCode),
    el('can:TipoDocumento', V09.typeCode),
    el('can:IdentificativoAssistito', input.patientFiscalCode),
    el('can:TipoAttivita', 'DELETE'),
    el('can:IdentificativoDocumento', input.documentId),
    applicationFields(app),
    el('ModalitaAlimentazione', V09.mode),
    '</can:CancellazioneMetadatiRichiesta>',
  ].join('');
}

/** EsitoCaricamentoDocumentoRichiesta (5.4.1). */
export function outcomeBody(input: RegionalOutcomeInput, pinCode: string): string {
  return [
    '<esit:EsitoCaricamentoDocumentoRichiesta>',
    caller('esit:', input.author, pinCode, false),
    el('esit:IdentificativiTemporaneiDocumenti', input.temporaryId),
    el('esit:DataRicercaDA', v09Time(input.from)),
    el('esit:DataRicercaA', v09Time(input.to)),
    '</esit:EsitoCaricamentoDocumentoRichiesta>',
  ].join('');
}

/** RicercaDocumentiRichiesta (1.2.1): «ObjectRef» per avere OID, UUID e versione. */
export function searchBody(
  input: RegionalSearchInput,
  app: RegionalApplication,
  pinCode: string,
): string {
  return [
    '<ric:RicercaDocumentiRichiesta>',
    caller('ric:', input.author, pinCode),
    el('ric:IdentificativoAssistito', input.patientFiscalCode),
    el('ric:PresaInCarico', 'True'),
    el('ric:IdentificativoDocumento', input.documentOid),
    applicationFields(app),
    el('ric:OpzioniRisposta', 'ObjectRef'),
    '</ric:RicercaDocumentiRichiesta>',
  ].join('');
}

/* Risposte ----------------------------------------------------------------------------------- */

/** Gli elementi con quel nome locale, qualunque sia lo spazio dei nomi (la V09 li lascia vuoti). */
function byName(node: Element | Document, name: string): Element[] {
  return Array.from(node.getElementsByTagNameNS('*', name) as unknown as ArrayLike<Element>);
}
const textIn = (node: Element | Document, name: string): string | null => {
  const e = byName(node, name)[0];
  return e ? (e.textContent ?? '').trim() : null;
};

function parse(body: string): Document | null {
  try {
    const doc = new DOMParser({ onError: () => undefined }).parseFromString(body, 'text/xml');
    return doc.documentElement ? (doc as unknown as Document) : null;
  } catch {
    return null;
  }
}

function errorsOf(doc: Document): RegionalError[] {
  return byName(doc, 'Errore').map((e) => ({
    code: textIn(e, 'codEsito') ?? '',
    message: textIn(e, 'esito') ?? '',
    kind: textIn(e, 'tipoErrore') ?? '',
    source: textIn(e, 'fonte') ?? '',
  }));
}

/** Un errore della V09 «Success» non è un errore: resta come avviso solo se non è riuscita. */
const realErrors = (errors: RegionalError[]) =>
  errors.filter((e) => e.kind !== 'Success' && e.code !== REGIONAL_OK);

type Parsed =
  | { kind: 'ok'; doc: Document; esito: string; warnings: RegionalError[] }
  | { kind: 'failure'; failure: RegionalFailure };

/**
 * Esito della risposta: 0000 o 0001 riuscita; 9999 fallita; un SOAP Fault «FailedAuthentication»
 * è WS-Security rifiutato. Senza un esito positivo esplicito il messaggio non è acquisito e si
 * riprova (FSE-INT-SRS-01-V02, 2.1).
 */
function read(res: RegionalSoapResponse): Parsed {
  if ('error' in res)
    return {
      kind: 'failure',
      failure:
        res.error === 'timeout'
          ? { outcome: 'timeout', message: 'Fascicolo regionale: nessuna risposta in tempo' }
          : { outcome: 'unreachable', message: 'Fascicolo regionale non raggiungibile' },
    };
  const doc = parse(res.body);
  const fault = doc ? byName(doc, 'Fault')[0] : undefined;
  if (doc && fault) {
    const text = (fault.textContent ?? '').replace(/\s+/g, ' ').trim();
    const auth = /FailedAuthentication/.test(text);
    return {
      kind: 'failure',
      failure: {
        outcome: 'rejected',
        esito: 'Fault',
        errors: [
          {
            code: auth ? 'FailedAuthentication' : 'Fault',
            message: text,
            kind: 'Bloccante',
            source: 'SOAP',
          },
        ],
        retryable: !auth,
        ...(auth ? { authProblem: 'credentials' as const } : {}),
      },
    };
  }
  const esito = doc ? textIn(doc, 'Esito') : null;
  if (!doc || !esito)
    return {
      kind: 'failure',
      failure: {
        outcome: 'rejected',
        esito: '',
        errors: [
          {
            code: 'FSE_ER_000',
            message: 'Risposta senza un esito esplicito: il messaggio non risulta acquisito',
            kind: 'Bloccante',
            source: 'programma',
          },
        ],
        retryable: true,
      },
    };
  const errors = realErrors(errorsOf(doc));
  if (esito === REGIONAL_OK || esito === REGIONAL_OK_WITH_WARNINGS)
    return { kind: 'ok', doc, esito, warnings: errors };
  return {
    kind: 'failure',
    failure: {
      outcome: 'rejected',
      esito,
      errors,
      retryable: errors.length === 0 || errors.every((e) => REGIONAL_RETRYABLE_CODES.has(e.code)),
    },
  };
}

/* Cliente ------------------------------------------------------------------------------------ */

export interface RegionalFseClientOptions {
  /** Il certificato X.509 della Regione per cifrare il PIN (DER o PEM), lo stesso del SIRPED. */
  encryptionCertificate: Buffer | string;
  application: RegionalApplication;
  namespaces?: RegionalFseNamespaces;
  /** UUID simbolico del documento nuovo, in REPLACE (5.2.4). */
  symbolicUuid?: () => string;
}

/**
 * Cliente dei servizi regionali: gli stessi messaggi per il simulatore e per il servizio vero.
 * Le credenziali arrivano a ogni chiamata (`ServiceAuth`) e nel registro non ci vanno: il messaggio
 * conservato ha «[omessa]» al posto di password e PIN.
 */
export class RegionalFseClient {
  private readonly namespaces: RegionalFseNamespaces;

  constructor(
    private readonly transport: RegionalFseTransport,
    private readonly options: RegionalFseClientOptions,
  ) {
    this.namespaces = options.namespaces ?? SIMULATED_REGIONAL_NAMESPACES;
  }

  get environment() {
    return this.transport.environment;
  }

  /** Il PIN cifrato con la chiave pubblica della Regione: RSA, PKCS#1 v1.5, BASE64 (3.2.2). */
  encryptPin(pin: string): string {
    const { publicKey } = new X509Certificate(this.options.encryptionCertificate);
    return publicEncrypt(
      { key: publicKey, padding: constants.RSA_PKCS1_PADDING },
      Buffer.from(pin, 'utf8'),
    ).toString('base64');
  }

  private async exchange(
    service: RegionalFseService,
    auth: ServiceAuth,
    build: (pinCode: string) => string,
    wrap: (header: string, body: string) => string,
  ): Promise<{ res: RegionalSoapResponse; sent: string }> {
    const sent = wrap('', build(MASKED));
    const res = await this.transport.send({
      service,
      envelope: wrap(wsSecurity(auth), build(this.encryptPin(auth.pin ?? ''))),
    });
    return { res, sent };
  }

  private communication(input: CommunicationInput, auth: ServiceAuth) {
    const uuid = this.options.symbolicUuid?.() ?? `urn:uuid:${randomUUID()}`;
    return this.exchange(
      'ComunicazioneMetadati',
      auth,
      (pin) => communicationBody(input, this.options.application, pin, uuid),
      envelope12,
    );
  }

  private async sendResult(p: Promise<{ res: RegionalSoapResponse; sent: string }>) {
    const { res, sent } = await p;
    const received = 'body' in res ? res.body : null;
    const r = read(res);
    if (r.kind === 'failure') return { sent, received, ...r.failure } satisfies V09SendResult;
    return {
      sent,
      received,
      outcome: 'accepted',
      esito: r.esito,
      warnings: r.warnings,
      temporaryId: textIn(r.doc, 'IdentificativoDocumento') || null,
    } satisfies V09SendResult;
  }

  /** Scenario 1: documento nuovo (CREATE). */
  create(input: RegionalCreateInput, auth: ServiceAuth): Promise<V09SendResult> {
    return this.sendResult(this.communication({ operation: 'CREATE', ...input }, auth));
  }

  /** Scenario 3: correzione del documento (REPLACE), dopo la ricerca dell'UUID. */
  replace(input: RegionalReplaceInput, auth: ServiceAuth): Promise<V09SendResult> {
    return this.sendResult(this.communication({ operation: 'REPLACE', ...input }, auth));
  }

  /** Scenario 2: solo i metadati (UPDATE). */
  update(input: RegionalUpdateInput, auth: ServiceAuth): Promise<V09SendResult> {
    return this.sendResult(this.communication({ operation: 'UPDATE', ...input }, auth));
  }

  /** Scenario 4: cancellazione del documento e dei metadati. */
  remove(input: RegionalDeleteInput, auth: ServiceAuth): Promise<V09SendResult> {
    return this.sendResult(
      this.exchange(
        'CancellazioneMetadati',
        auth,
        (pin) => cancellationBody(input, this.options.application, pin),
        (h, b) => envelope11(h, b, { can: this.namespaces.cancellation }),
      ),
    );
  }

  /** Esito del caricamento: ELAB, OK con l'OID, KO con la motivazione (5.4). */
  async outcome(input: RegionalOutcomeInput, auth: ServiceAuth): Promise<V09OutcomeResult> {
    const { res, sent } = await this.exchange(
      'EsitoCaricamentoDocumento',
      auth,
      (pin) => outcomeBody(input, pin),
      (h, b) => envelope11(h, b, { esit: this.namespaces.outcome }),
    );
    const received = 'body' in res ? res.body : null;
    const r = read(res);
    if (r.kind === 'failure') return { sent, received, ...r.failure };
    const state = textIn(r.doc, 'StatoElaborazione');
    const gw = byName(r.doc, 'resultGW')[0];
    const gateway = {
      traceId: gw ? textIn(gw, 'traceID') : null,
      spanId: gw ? textIn(gw, 'spanID') : null,
      transactionData: gw ? byName(gw, 'transactionData').map((e) => e.textContent ?? '') : [],
    };
    // Identificativo temporaneo sconosciuto («Nessun risultato trovato»): riprovare non serve.
    if (!state && r.warnings.some((w) => w.code === REGIONAL_NOT_FOUND))
      return {
        sent,
        received,
        outcome: 'rejected',
        esito: r.esito,
        errors: r.warnings,
        retryable: false,
      };
    if (state !== 'OK' && state !== 'KO' && state !== 'ELAB')
      return {
        sent,
        received,
        outcome: 'rejected',
        esito: r.esito,
        errors: [
          {
            code: 'FSE_ER_000',
            message: `Stato di elaborazione non previsto: «${state ?? ''}»`,
            kind: 'Bloccante',
            source: 'programma',
          },
        ],
        retryable: true,
      };
    return {
      sent,
      received,
      outcome: 'checked',
      state,
      oid: state === 'OK' ? textIn(r.doc, 'IdentificativoDocumento') || null : null,
      reason: state === 'KO' ? textIn(r.doc, 'MotivazioneScarto') || null : null,
      warnings: r.warnings,
      gateway,
    };
  }

  /** Ricerca dall'OID: UUID e versione del documento (1.2). */
  async search(input: RegionalSearchInput, auth: ServiceAuth): Promise<RegionalSearchResult> {
    const { res, sent } = await this.exchange(
      'RicercaDocumenti',
      auth,
      (pin) => searchBody(input, this.options.application, pin),
      (h, b) => envelope11(h, b, { ric: this.namespaces.search }),
    );
    const received = 'body' in res ? res.body : null;
    const r = read(res);
    if (r.kind === 'failure') return { sent, received, ...r.failure };
    const metadata = byName(r.doc, 'Metadato')[0];
    const oid = metadata ? textIn(metadata, 'IdentificativoDocumento') : null;
    const uuid = metadata ? textIn(metadata, 'IdentificativoUnivocoDocumento') : null;
    if (!oid || !uuid) return { sent, received, outcome: 'not-found', warnings: r.warnings };
    return {
      sent,
      received,
      outcome: 'found',
      oid,
      uuid,
      version: metadata ? textIn(metadata, 'VersioneOggettoDocumento') : null,
      warnings: r.warnings,
    };
  }
}

/* Pubblicazione per il contratto nazionale (D297) ------------------------------------------- */

/**
 * Le politiche della Regione per chi manda messaggi al Fascicolo (FSE-INT-SRS-01-V02): niente
 * invii dalle 00:00 alle 07:00, quando il Fascicolo è fermo per manutenzione (3.2); almeno 3
 * secondi fra due invii (3.5, 4.3); tempo scaduto, risposta senza un esito positivo esplicito,
 * FSE_ER_000 o errori di sistema di INI: si rimanda dopo almeno 5 minuti, fino a tre volte; poi un
 * tentativo al giorno per dieci giorni, dalle 07:00 alle 00:00; poi si segnala al supporto del CSI
 * (4.1, 4.2).
 */
export const FSE_PUBLICATION_POLICY: RegionalPublicationPolicy = {
  quietUntilHour: 7,
  minIntervalMs: 3000,
  retries: 3,
  retryDelayMs: 5 * 60_000,
  fallbackDays: 10,
};

/** Le parole per il medico: le credenziali RUPAR della V09 (3.2.1) e il supporto del CSI (4.2). */
export const FSE_PUBLICATION_TEXTS = {
  credentialsRefused: 'Controlla utente, password e PIN RUPAR in «Credenziali dei servizi»',
  credentialsMissing:
    'Per il Fascicolo regionale servono utente, password e PIN RUPAR del medico (V09, 3.2.1): inseriscili in «Credenziali dei servizi»',
  reportTo: 'al supporto del Fascicolo del CSI Piemonte (supporto.fse@csi.it)',
} as const;

/** Il codice dell'ASL del medico: tre cifre, che con «010» davanti fanno IstituzioneAutore. */
export function fsePublicationAuthorIssues(a: Pick<RegionalAuthor, 'aslCode'>): string[] {
  return a.aslCode && /^\d{3}$/.test(a.aslCode)
    ? []
    : [
        'Medico: manca il codice ASL nel profilo (tre cifre): il Fascicolo regionale lo vuole con il codice della regione (IstituzioneAutore)',
      ];
}

/** Una risposta che la V09 non prevede: il messaggio non risulta acquisito e si riprova. */
const incomplete = (r: RegionalExchange, esito: string, message: string) =>
  ({
    sent: r.sent,
    received: r.received,
    outcome: 'rejected',
    esito,
    errors: [{ code: 'FSE_ER_000', message, kind: 'Bloccante', source: 'programma' }],
    retryable: true,
  }) satisfies RegionalExchange & RegionalFailure;

/**
 * La pubblicazione nel Fascicolo della Regione Piemonte come la vuole il contratto nazionale
 * (D297): il cliente della V09, con le politiche di invio, i regimi, l'attività clinica «ERP» e le
 * parole della Regione. Le risposte che la V09 non prevede (presa in carico senza identificativo,
 * «OK» senza OID) diventano errori da ripetere; «1103» nella cancellazione dice che non c'è niente
 * da cancellare.
 */
export class V09FsePublication implements RegionalFsePublication {
  /** Si pubblica con utente, password e PIN RUPAR (V09, 3.2.1): le credenziali del pacchetto. */
  readonly credentialService = RUPAR_CREDENTIALS.slug;
  readonly regimes = REGIONAL_REGIMES;
  readonly clinicalActivity = V09.clinicalActivity;
  readonly policy = FSE_PUBLICATION_POLICY;
  readonly texts = FSE_PUBLICATION_TEXTS;

  constructor(readonly client: RegionalFseClient) {}

  get environment() {
    return this.client.environment;
  }

  authorIssues(author: Pick<RegionalAuthor, 'aslCode'>): string[] {
    return fsePublicationAuthorIssues(author);
  }

  private async submitted(p: Promise<V09SendResult>): Promise<RegionalSubmitResult> {
    const r = await p;
    if (r.outcome !== 'accepted') return r;
    if (!r.temporaryId)
      return incomplete(r, r.esito, 'Presa in carico senza identificativo temporaneo');
    return { ...r, temporaryId: r.temporaryId };
  }

  private async sent(p: Promise<V09SendResult>): Promise<RegionalSendResult> {
    const r = await p;
    if (r.outcome !== 'accepted') return r;
    return {
      sent: r.sent,
      received: r.received,
      outcome: 'accepted',
      esito: r.esito,
      warnings: r.warnings,
    };
  }

  create(input: RegionalCreateInput, auth: ServiceAuth): Promise<RegionalSubmitResult> {
    return this.submitted(this.client.create(input, auth));
  }

  replace(input: RegionalReplaceInput, auth: ServiceAuth): Promise<RegionalSubmitResult> {
    return this.submitted(this.client.replace(input, auth));
  }

  update(input: RegionalUpdateInput, auth: ServiceAuth): Promise<RegionalSendResult> {
    return this.sent(this.client.update(input, auth));
  }

  async remove(input: RegionalDeleteInput, auth: ServiceAuth): Promise<RegionalSendResult> {
    const r = await this.sent(this.client.remove(input, auth));
    // «Nessun metadato trovato da cancellare» (5.3.3.2).
    if (r.outcome === 'rejected' && r.errors.some((e) => e.code === REGIONAL_NOTHING_TO_DELETE))
      return { ...r, nothingToDelete: true };
    return r;
  }

  async outcome(input: RegionalOutcomeInput, auth: ServiceAuth): Promise<RegionalOutcomeResult> {
    const r = await this.client.outcome(input, auth);
    if (r.outcome !== 'checked') return r;
    const base = {
      sent: r.sent,
      received: r.received,
      outcome: 'checked' as const,
      warnings: r.warnings,
    };
    if (r.state === 'ELAB') return { ...base, state: 'ELAB' };
    if (r.state === 'KO') return { ...base, state: 'KO', reason: r.reason };
    if (!r.oid) return incomplete(r, '', 'Esito «OK» senza OID');
    return { ...base, state: 'OK', oid: r.oid };
  }

  search(input: RegionalSearchInput, auth: ServiceAuth): Promise<RegionalSearchResult> {
    return this.client.search(input, auth);
  }
}
