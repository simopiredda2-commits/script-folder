/**
 * Simulatore dei servizi del Fascicolo della Regione Piemonte per le cartelle dei medici
 * (FSE-PSS-SRS-01-V09, maggio 2026; D280). Fa quello che la V09 dice che fa il Fascicolo
 * regionale, con le stesse regole sui campi; in FSE 2.0, come l'intermediario regionale, pubblica,
 * sostituisce e cancella sul Gateway nazionale simulato, che controlla il workflowInstanceId della
 * validazione, la firma PAdES e i 5 giorni.
 *
 * Che cosa non sa: i codici di errore della Regione, che la V09 non elenca (tranne 1059 e 1103).
 * Per le regole sui campi usa codici suoi, che cominciano con «SIM_». Per gli errori di sistema usa
 * quelli delle politiche di invio (INI-9000). Per credenziali rifiutate risponde con il SOAP Fault
 * standard di WS-Security («FailedAuthentication»).
 */

import { constants, privateDecrypt, randomUUID } from 'node:crypto';
import { DOMParser, type Element } from '@xmldom/xmldom';
import * as xpathLib from 'xpath';
import { FseGatewayClient, type FseCaller, type FseResult } from './gateway';
import { SIMULATED_FSE_AUDIENCE, type SimulatedFseGateway } from './gateway-simulator';
import { extractCda } from './pdf';
import {
  documentHash,
  REGIONAL_FAILED,
  REGIONAL_NOT_FOUND,
  REGIONAL_NOTHING_TO_DELETE,
  REGIONAL_OK,
  REGIONAL_OK_WITH_WARNINGS,
  REGIONAL_REGIMES,
  V09,
  V09_NAMESPACES,
  type RegionalFseService,
  type RegionalFseTransport,
  type RegionalSoapRequest,
  type RegionalSoapResponse,
} from './regional-publication';
import { createTestCertificate, type TestCertificate } from './x509';

export type SimulatedRegionalOutcome =
  'ok' | 'unreachable' | 'timeout' | 'system-error' | 'no-esito';

export interface SimulatedRegionalFseOptions {
  /** Il Gateway nazionale simulato su cui la Regione pubblica, in FSE 2.0. */
  gateway: SimulatedFseGateway;
  now?: () => Date;
  /** Per le prove: rete assente, nessuna risposta, errore di sistema, risposta senza esito. */
  decide?: (service: RegionalFseService) => SimulatedRegionalOutcome;
  /** Quante richieste di esito rispondono «ELAB» prima di guardare il Gateway (0 per difetto). */
  elabPolls?: number;
  /** L'assistito: iscritto a un'ASL del Piemonte, con il consenso all'alimentazione (sì e sì). */
  patient?: (fiscalCode: string) => { enrolled: boolean; consent: boolean };
  /** Le credenziali RUPAR: valide se utente, password e PIN non sono vuoti. */
  credentials?: (username: string, password: string, pin: string) => boolean;
}

/** Radici simulate: OID dei documenti come nell'esempio della V09 (5.2.4), repository e invii. */
const SIM_OID_ROOT = '2.16.840.1.113883.2.9.2.10.4.4';
const SIM_REPOSITORY = 'SIMULATORE.FSE.PIEMONTE.REPOSITORY';
const SIM_SUBMISSION_ROOT = 'SIMULATORE.FSE.PIEMONTE.INVII';
const SIM_RESPONSE_NS = 'urn:simulatore:fse-piemonte:risposta';

const CF = /^[A-Z0-9]{16}$/;
const XCN = new RegExp(
  `^([A-Z0-9]{16})\\^[^^]+\\^[^^]+\\^\\^\\^\\^\\^\\^&${V09.fiscalCodeRoot.replaceAll('.', '\\.')}&ISO$`,
);
const TIME = /^\d{14}$/;

interface Stored {
  oid: string;
  uuid: string;
  version: number;
  authorCf: string;
  patientCf: string;
  /** L'identificativo del CDA, con cui il documento è sul Gateway. */
  gatewayDocumentId: string;
  confidentiality: 'N' | 'V';
  deleted: boolean;
  replacedBy?: string;
}

interface Pending {
  temporaryId: string;
  operation: 'CREATE' | 'REPLACE';
  authorCf: string;
  patientCf: string;
  gatewayDocumentId: string;
  workflowInstanceId: string;
  caller: FseCaller;
  confidentiality: 'N' | 'V';
  target?: Stored;
  gateway: FseResult;
  polls: number;
  result?: { state: 'OK'; oid: string } | { state: 'KO'; reason: string };
}

interface Fail {
  code: string;
  message: string;
}

const xpath = xpathLib as unknown as {
  useNamespaces(
    ns: Record<string, string>,
  ): (expr: string, node: unknown, single?: boolean) => unknown;
};
const select = xpath.useNamespaces({ hl7: 'urn:hl7-org:v3' });

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function byName(node: Element | Document, name: string): Element[] {
  return Array.from(node.getElementsByTagNameNS('*', name) as unknown as ArrayLike<Element>);
}

/** Il testo di un campo figlio diretto (o il primo discendente) con quel nome locale. */
function field(node: Element, name: string): string | null {
  const e = byName(node, name)[0];
  return e ? (e.textContent ?? '').trim() : null;
}

function errorXml(errors: Fail[], kind = 'Bloccante') {
  return errors
    .map(
      (e) =>
        `<Errore><codEsito>${esc(e.code)}</codEsito><esito>${esc(e.message)}</esito><tipoErrore>${kind}</tipoErrore><fonte>FSE</fonte></Errore>`,
    )
    .join('');
}

const OK_ERROR = `<Errore><codEsito>${REGIONAL_OK}</codEsito><esito>Operazione eseguita correttamente</esito><tipoErrore>Success</tipoErrore><fonte>FSE</fonte></Errore>`;

function reply(root: string, inner: string): RegionalSoapResponse {
  return {
    status: 200,
    body: `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="${V09_NAMESPACES.soap11}"><soapenv:Body><a:${root} xmlns:a="${SIM_RESPONSE_NS}">${inner}</a:${root}></soapenv:Body></soapenv:Envelope>`,
  };
}

export class SimulatedRegionalFse implements RegionalFseTransport {
  readonly environment = 'simulator' as const;
  /** Ogni richiesta ricevuta, per le prove: servizio, modalità, esito e codici; mai il contenuto. */
  readonly log: { service: RegionalFseService; mode?: string; esito: string; codes: string[] }[] =
    [];
  private readonly certificate: TestCertificate;
  private readonly gatewayClient: FseGatewayClient;
  private readonly documents = new Map<string, Stored>();
  private readonly pending = new Map<string, Pending>();
  private counter = 150_000;

  constructor(private readonly options: SimulatedRegionalFseOptions) {
    this.certificate = createTestCertificate({
      commonName: 'Regione Piemonte – cifratura dei dati (simulatore)',
      organization: 'Simulatore Fascicolo regionale',
      from: new Date(this.now().getTime() - 86_400_000),
    });
    this.gatewayClient = new FseGatewayClient(
      options.gateway,
      options.gateway.issueCredentials('Intermediario regionale (simulatore)'),
      () => this.now(),
    );
  }

  private now() {
    return this.options.now?.() ?? new Date();
  }

  /** Il certificato con cui la cartella cifra il PIN (DER), come quello della Regione (3.2.2). */
  get encryptionCertificate(): Buffer {
    return this.certificate.der;
  }

  /** Per le prove: il documento nel Fascicolo regionale simulato. */
  stored(oid: string): Readonly<Stored> | undefined {
    return this.documents.get(oid);
  }

  async send(req: RegionalSoapRequest): Promise<RegionalSoapResponse> {
    const outcome = this.options.decide?.(req.service) ?? 'ok';
    if (outcome === 'unreachable' || outcome === 'timeout') {
      this.log.push({ service: req.service, esito: outcome, codes: [] });
      return { error: outcome };
    }
    if (outcome === 'no-esito') {
      this.log.push({ service: req.service, esito: 'nessun esito', codes: [] });
      return reply(`${req.service}Ricevuta`, '');
    }
    let doc: Document;
    try {
      doc = new DOMParser().parseFromString(req.envelope, 'text/xml') as unknown as Document;
    } catch {
      return this.answer(
        req.service,
        undefined,
        this.failure(req.service, [
          { code: 'SIM_XML', message: 'Simulatore: messaggio non leggibile' },
        ]),
      );
    }
    // WS-Security, username token con le credenziali RUPAR (3.2.1).
    const token = byName(doc, 'UsernameToken')[0];
    const username = token ? (field(token, 'Username') ?? '') : '';
    const password = token ? (field(token, 'Password') ?? '') : '';
    const root = byName(doc, `${req.service}Richiesta`)[0];
    if (!root)
      return this.answer(
        req.service,
        undefined,
        this.failure(req.service, [
          { code: 'SIM_XML', message: `Simulatore: manca ${req.service}Richiesta` },
        ]),
      );
    if (!username || !password) return this.fault(req.service);
    // Con la «implicit rejection» di OpenSSL un PIN cifrato con un'altra chiave non dà errore: si
    // decifra in un valore a caso, a volte vuoto (con Node 22 circa una volta su 230, D286). Per
    // questo il PIN si confronta con quello del medico, e «PIN mancante» vale solo per il campo
    // vuoto o per un valore che non si decifra: un PIN decifrato vuoto è un PIN sbagliato.
    const pin = this.pin(field(root, 'pinCode'));
    if (pin === null)
      return this.answer(
        req.service,
        undefined,
        this.failure(req.service, [
          {
            code: 'SIM_PIN',
            message: 'Simulatore: PIN mancante o non cifrato con il certificato della Regione',
          },
        ]),
      );
    const valid = this.options.credentials ?? ((u, p, n) => !!u && !!p && !!n);
    if (!valid(username, password, pin)) return this.fault(req.service);
    if (outcome === 'system-error')
      return this.answer(
        req.service,
        undefined,
        this.failure(req.service, [{ code: 'INI-9000', message: 'Errore di sistema' }]),
      );
    switch (req.service) {
      case 'ComunicazioneMetadati':
        return this.communication(root);
      case 'CancellazioneMetadati':
        return this.cancellation(root);
      case 'EsitoCaricamentoDocumento':
        return this.outcome(root);
      case 'RicercaDocumenti':
        return this.search(root);
    }
  }

  /**
   * Il PIN decifrato con la chiave privata del certificato, anche vuoto; null se il campo è vuoto
   * o se il valore non si decifra.
   */
  private pin(encrypted: string | null): string | null {
    if (!encrypted) return null;
    try {
      return privateDecrypt(
        { key: this.certificate.privateKeyPem, padding: constants.RSA_PKCS1_PADDING },
        Buffer.from(encrypted, 'base64'),
      ).toString('utf8');
    } catch {
      return null;
    }
  }

  private fault(service: RegionalFseService): RegionalSoapResponse {
    this.log.push({ service, esito: 'Fault', codes: ['FailedAuthentication'] });
    return {
      status: 500,
      body: `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="${V09_NAMESPACES.soap11}" xmlns:wsse="${V09_NAMESPACES.wsse}"><soapenv:Body><soapenv:Fault><faultcode>wsse:FailedAuthentication</faultcode><faultstring>The security token could not be authenticated or authorized</faultstring></soapenv:Fault></soapenv:Body></soapenv:Envelope>`,
    };
  }

  private failure(service: RegionalFseService, errors: Fail[]) {
    return { service, esito: REGIONAL_FAILED, errors };
  }

  private answer(
    service: RegionalFseService,
    mode: string | undefined,
    r: { esito: string; errors: Fail[]; inner?: string; kind?: string },
  ): RegionalSoapResponse {
    this.log.push({ service, mode, esito: r.esito, codes: r.errors.map((e) => e.code) });
    const errors = r.errors.length ? errorXml(r.errors, r.kind) : OK_ERROR;
    return reply(
      `${service}Ricevuta`,
      `<a:Esito>${r.esito}</a:Esito>${r.inner ?? ''}<a:ElencoErrori>${errors}</a:ElencoErrori>`,
    );
  }

  /** Utente, organizzazione, struttura, ruolo e contesto, comuni a tutti i servizi (5.2.2). */
  private callerProblems(root: Element, context = true): Fail[] {
    const f: Fail[] = [];
    const v = (name: string) => field(root, name);
    if (!CF.test(v('IdentificativoUtente') ?? v('identificativoUtente') ?? ''))
      f.push({ code: 'SIM_UTENTE', message: 'IdentificativoUtente: un codice fiscale' });
    if (
      (v('IdentificativoOrganizzazione') ?? v('identificativoOrganizzazione')) !== V09.organization
    )
      f.push({ code: 'SIM_ORGANIZZAZIONE', message: 'IdentificativoOrganizzazione: «010»' });
    if ((v('StrutturaUtente') ?? v('strutturaUtente')) !== V09.userStructure)
      f.push({ code: 'SIM_STRUTTURA', message: 'StrutturaUtente: sei trattini' });
    if ((v('RuoloUtente') ?? v('ruoloUtente')) !== V09.role)
      f.push({ code: 'SIM_RUOLO', message: 'RuoloUtente: «APR»' });
    if (context && (v('ContestoOperativo') ?? v('contestoOperativo')) !== V09.context)
      f.push({ code: 'SIM_CONTESTO', message: 'ContestoOperativo: «TREATMENT»' });
    return f;
  }

  private userOf(root: Element) {
    return field(root, 'IdentificativoUtente') ?? field(root, 'identificativoUtente') ?? '';
  }

  private findDocument(id: string): Stored | undefined {
    if (id.startsWith('urn:uuid:')) return [...this.documents.values()].find((d) => d.uuid === id);
    return this.documents.get(id);
  }

  /** ComunicazioneMetadati: CREATE, UPDATE e REPLACE, con le regole dei campi (5.2.2–5.2.4). */
  private async communication(root: Element): Promise<RegionalSoapResponse> {
    const service = 'ComunicazioneMetadati';
    const mode = field(root, 'tipoAttivita') ?? '';
    const user = this.userOf(root);
    const m = byName(root, 'metadato')[0];
    const f = this.callerProblems(root);
    if (!m) f.push({ code: 'SIM_METADATO', message: 'Manca il tag metadato' });
    if (!['CREATE', 'UPDATE', 'REPLACE'].includes(mode))
      f.push({ code: 'SIM_ATTIVITA', message: 'tipoAttivita: CREATE, UPDATE o REPLACE' });
    if (f.length || !m) return this.answer(service, mode, this.failure(service, f));
    const v = (name: string) => field(m, name);
    const patientCf = field(root, 'identificativoAssistito') ?? '';
    const expect = (name: string, value: string | null, rule: string) => {
      if (v(name) !== value) f.push({ code: 'SIM_CAMPO', message: `${name}: ${rule} (V09, 5.2)` });
    };
    if (!CF.test(patientCf))
      f.push({ code: 'SIM_ASSISTITO', message: 'identificativoAssistito: un codice fiscale' });
    if (field(root, 'presaInCarico') !== 'true')
      f.push({ code: 'SIM_CAMPO', message: 'presaInCarico: «true»' });
    expect('IdentificativoAssistito', patientCf, 'il codice fiscale di identificativoAssistito');
    expect('TipologiaStrutturaProdDoc', V09.facilityType, '«Territorio»');
    expect('TipoMime', V09.mimeType, `«${V09.mimeType}»`);
    const conf = v('LivelloConfidenzialita');
    if (conf !== 'N' && conf !== 'V')
      f.push({ code: 'SIM_CAMPO', message: 'LivelloConfidenzialita: «N» o «V»' });
    const rules = v('RegoleAccesso');
    if (conf === 'V' && !(rules ?? '').split(';').includes(V09.obscured))
      f.push({ code: 'SIM_CAMPO', message: 'RegoleAccesso: con «V» obbligatoriamente «P99»' });
    if (conf === 'N' && rules !== null)
      f.push({ code: 'SIM_CAMPO', message: 'RegoleAccesso: con «N» il tag non si valorizza' });
    expect('TipologiaDocumentoAlto', V09.classCode, '«SUM» per il PSS');
    expect('TipologiaDocumentoMedio', V09.typeCode, '«60591-5» per il PSS');
    expect('TipologiaDocumentoBasso', V09.formatCode, '«PDF»');
    const at = v('DataValidazioneDocumento') ?? '';
    if (!TIME.test(at))
      f.push({ code: 'SIM_CAMPO', message: 'DataValidazioneDocumento: yyyymmddHH24MMSS' });
    expect('DataInizioPrestazione', at, 'uguale a DataValidazioneDocumento');
    expect('DataFinePrestazione', at, 'uguale a DataValidazioneDocumento');
    expect('RuoloAutore', V09.authorRole, '«APR»');
    if (!/^010\d{3}$/.test(v('IstituzioneAutore') ?? ''))
      f.push({ code: 'SIM_CAMPO', message: 'IstituzioneAutore: «010» e il codice ASL' });
    const xcn = XCN.exec(v('CodiceFiscaleAutore') ?? '');
    if (!xcn) f.push({ code: 'SIM_CAMPO', message: 'CodiceFiscaleAutore: nel tipo XCN di IHE' });
    else if (xcn[1] !== user)
      f.push({
        code: 'SIM_CAMPO',
        message: 'CodiceFiscaleAutore: lo stesso codice fiscale di IdentificativoUtente',
      });
    expect('SpecialitaAutore', V09.authorSpecialty, '«AD_PSC130»');
    expect('AssettoOrganizzativo', V09.practiceSetting, '«AD_PSC130»');
    expect('TipoAttivitaClinica', V09.clinicalActivity, '«ERP»');
    if (!Object.hasOwn(REGIONAL_REGIMES, v('RegimeDocumento') ?? ''))
      f.push({ code: 'SIM_CAMPO', message: 'RegimeDocumento: un codice della tabella dei regimi' });
    const signed = v('DocumentoFirmato');
    if (
      signed !== null &&
      !['true^Documento firmato', 'false^Documento non firmato'].includes(signed)
    )
      f.push({ code: 'SIM_CAMPO', message: 'DocumentoFirmato: «true^…» o «false^…»' });
    if (field(root, 'ModalitaAlimentazione') !== V09.mode)
      f.push({ code: 'SIM_MODALITA', message: 'Simulatore: solo ModalitaAlimentazione «FSE2.0»' });
    const withDocument = mode !== 'UPDATE';
    const docText = field(root, 'documento');
    const document = docText ? Buffer.from(docText, 'base64') : null;
    const wii = field(root, 'WorkflowInstanceId');
    const locality = field(root, 'Locality');
    if (withDocument) {
      if (!document?.length) f.push({ code: 'SIM_DOCUMENTO', message: 'documento: il PDF' });
      if (!wii)
        f.push({ code: 'SIM_CAMPO', message: 'WorkflowInstanceId: obbligatorio in FSE 2.0' });
      if (!locality) f.push({ code: 'SIM_CAMPO', message: 'Locality: obbligatorio in FSE 2.0' });
      if (document && v('HashDoc') !== documentHash(document))
        f.push({ code: 'SIM_CAMPO', message: 'HashDoc: l’impronta del documento' });
      if (document && v('SizeDoc') !== String(document.byteLength))
        f.push({ code: 'SIM_CAMPO', message: 'SizeDoc: la dimensione del documento' });
    } else {
      if (docText !== null) f.push({ code: 'SIM_CAMPO', message: 'documento: in UPDATE non va' });
      if (wii !== null || locality !== null)
        f.push({
          code: 'SIM_CAMPO',
          message: 'WorkflowInstanceId e Locality: in UPDATE si omettono',
        });
      if (v('HashDoc') !== null || v('SizeDoc') !== null)
        f.push({ code: 'SIM_CAMPO', message: 'HashDoc e SizeDoc: in UPDATE non si valorizzano' });
    }
    const assoc = byName(m, 'Associazione')[0];
    const a = (name: string) => (assoc ? field(assoc, name) : null);
    let target: Stored | undefined;
    if (mode === 'CREATE') {
      if (
        v('RiferimentoDocumento') !== null ||
        assoc ||
        v('IdentificativoUnivocoDocumento') !== null
      )
        f.push({
          code: 'SIM_CAMPO',
          message:
            'RiferimentoDocumento, Associazione, IdentificativoUnivocoDocumento: in CREATE non si valorizzano',
        });
    } else {
      if (v('RappresentanteLegale') !== user)
        f.push({
          code: 'SIM_CAMPO',
          message: 'RappresentanteLegale: il codice fiscale dell’autore',
        });
      const ref = v('RiferimentoDocumento') ?? '';
      target = this.findDocument(ref);
      if (mode === 'UPDATE') {
        if (ref.startsWith('urn:uuid:'))
          f.push({
            code: 'SIM_CAMPO',
            message: 'RiferimentoDocumento: in UPDATE l’OID del documento',
          });
        if (
          a('associationType') !== V09.updateAssociation ||
          a('sourceObject') !== 'source' ||
          a('targetObject') !== 'target update' ||
          a('submissionSetStatus') !== 'Original' ||
          a('previousVersion') !== '1'
        )
          f.push({
            code: 'SIM_CAMPO',
            message: 'Associazione: come nella tabella dell’UPDATE (5.2.3)',
          });
        if (v('IdentificativoUnivocoDocumento') !== 'source')
          f.push({ code: 'SIM_CAMPO', message: 'IdentificativoUnivocoDocumento: «source»' });
      } else {
        const symbolic = v('IdentificativoUnivocoDocumento') ?? '';
        if (
          a('associationType') !== V09.replaceAssociation ||
          !symbolic.startsWith('urn:uuid:') ||
          a('sourceObject') !== symbolic ||
          a('targetObject') !== ref ||
          a('submissionSetStatus') !== 'Original' ||
          a('previousVersion') !== null
        )
          f.push({
            code: 'SIM_CAMPO',
            message: 'Associazione: come nella tabella del REPLACE (5.2.4)',
          });
      }
    }
    if (f.length) return this.answer(service, mode, this.failure(service, f));
    // Assistito, consenso e documento da correggere (5.1).
    const p = this.options.patient?.(patientCf) ?? { enrolled: true, consent: true };
    if (!p.enrolled)
      f.push({ code: 'SIM_NON_ISCRITTO', message: 'Assistito non iscritto a un’ASL del Piemonte' });
    if (mode !== 'UPDATE' && !p.consent)
      f.push({
        code: 'SIM_CONSENSO',
        message: 'Assistito senza consenso all’alimentazione del Fascicolo',
      });
    if (mode !== 'CREATE') {
      if (!target || target.deleted || target.replacedBy)
        f.push({
          code: 'SIM_NON_TROVATO',
          message: 'Il documento da correggere non è nel Fascicolo',
        });
      else if (target.authorCf !== user)
        f.push({
          code: 'SIM_AUTORE',
          message: 'La correzione la chiede il medico che ha redatto il documento',
        });
      else if (target.patientCf !== patientCf)
        f.push({ code: 'SIM_ASSISTITO', message: 'Il documento è di un altro assistito' });
    }
    if (f.length) return this.answer(service, mode, this.failure(service, f));
    if (mode === 'UPDATE') {
      target!.confidentiality = conf as 'N' | 'V';
      return this.answer(service, mode, { esito: REGIONAL_OK, errors: [] });
    }
    // FSE 2.0: l'intermediario pubblica sul Gateway con il workflowInstanceId della validazione.
    const cda = await extractCda(document!);
    const gatewayDocumentId = cda ? this.cdaId(cda) : null;
    if (!gatewayDocumentId)
      return this.answer(
        service,
        mode,
        this.failure(service, [{ code: 'SIM_DOCUMENTO', message: 'Il PDF non ha il CDA dentro' }]),
      );
    const caller: FseCaller = {
      audience: SIMULATED_FSE_AUDIENCE,
      fiscalCode: user,
      role: 'APR',
      organizationId: V09.organization,
      organizationName: 'Regione Piemonte',
      locality: locality!,
      application: {
        id: field(root, 'IdentificativoApplicativoRichiedente') || 'NON INDICATO',
        vendor: field(root, 'FornitoreApplicativoRichiedente') || 'NON INDICATO',
        version: field(root, 'VersioneApplicativoRichiedente') || 'NON INDICATO',
      },
    };
    const metadata = {
      workflowInstanceId: wii!,
      healthDataFormat: 'CDA' as const,
      mode: 'ATTACHMENT' as const,
      tipologiaStruttura: V09.facilityType,
      ...(conf === 'V' ? { attiCliniciRegoleAccesso: [V09.obscured] } : {}),
      identificativoDoc: gatewayDocumentId,
      identificativoRep: SIM_REPOSITORY,
      tipoDocumentoLivAlto: V09.classCode,
      assettoOrganizzativo: V09.practiceSetting,
      tipoAttivitaClinica: V09.clinicalActivity,
      identificativoSottomissione: `${SIM_SUBMISSION_ROOT}.${++this.counter}`,
      administrativeRequest: [v('RegimeDocumento')!],
    };
    const gateway =
      mode === 'REPLACE'
        ? await this.gatewayClient.replace(
            caller,
            patientCf,
            target!.gatewayDocumentId,
            document!,
            metadata,
          )
        : await this.gatewayClient.publish(caller, patientCf, document!, metadata);
    // Il workflowInstanceId si controlla subito (5.1): se il Gateway non lo riconosce, è un errore.
    if (gateway.outcome === 'problem' && gateway.problem.type === '/msg/cda-match')
      return this.answer(
        service,
        mode,
        this.failure(service, [
          {
            code: 'SIM_WORKFLOW',
            message: 'WorkflowInstanceId non valido: il documento non risulta validato dal Gateway',
          },
        ]),
      );
    const temporaryId = `TEMP_010_${++this.counter}`;
    this.pending.set(temporaryId, {
      temporaryId,
      operation: mode as 'CREATE' | 'REPLACE',
      authorCf: user,
      patientCf,
      gatewayDocumentId,
      workflowInstanceId: wii!,
      caller,
      confidentiality: conf as 'N' | 'V',
      ...(target ? { target } : {}),
      gateway,
      polls: 0,
    });
    return this.answer(service, mode, {
      esito: REGIONAL_OK,
      errors: [],
      inner: `<a:IdentificativoDocumento>${temporaryId}</a:IdentificativoDocumento>`,
    });
  }

  private cdaId(xml: string): string | null {
    try {
      const doc = new DOMParser().parseFromString(xml, 'text/xml');
      const one = (expr: string) =>
        (select(expr, doc, true) as { value?: string } | undefined)?.value ?? '';
      const root = one('/hl7:ClinicalDocument/hl7:id/@root');
      const ext = one('/hl7:ClinicalDocument/hl7:id/@extension');
      return root && ext ? `${root}^${ext}` : null;
    } catch {
      return null;
    }
  }

  /** EsitoCaricamentoDocumento: ELAB, OK con l'OID, KO con la motivazione (5.4). */
  private async outcome(root: Element): Promise<RegionalSoapResponse> {
    const service = 'EsitoCaricamentoDocumento';
    const f = this.callerProblems(root, false);
    const from = field(root, 'DataRicercaDA') ?? '';
    const to = field(root, 'DataRicercaA') ?? '';
    if (!TIME.test(from) || !TIME.test(to))
      f.push({ code: 'SIM_CAMPO', message: 'DataRicercaDA e DataRicercaA: yyyymmddHH24MMSS' });
    else if (to < from)
      f.push({
        code: 'SIM_CAMPO',
        message: 'DataRicercaA non deve essere precedente a DataRicercaDA',
      });
    if (f.length) return this.answer(service, undefined, this.failure(service, f));
    const id = field(root, 'IdentificativiTemporaneiDocumenti') ?? '';
    const p = this.pending.get(id);
    if (!p)
      return this.answer(service, undefined, {
        esito: REGIONAL_OK_WITH_WARNINGS,
        errors: [{ code: REGIONAL_NOT_FOUND, message: 'Nessun risultato trovato' }],
        kind: 'Info',
      });
    if (p.authorCf !== this.userOf(root))
      return this.answer(
        service,
        undefined,
        this.failure(service, [
          {
            code: 'SIM_TITOLARE',
            message: 'Il medico che chiede l’esito non è il titolare del documento',
          },
        ]),
      );
    let gw: { traceId: string; events: string[] } = { traceId: '', events: [] };
    if (!p.result) {
      if (p.polls < (this.options.elabPolls ?? 0)) {
        p.polls++;
        return this.answer(service, undefined, {
          esito: REGIONAL_OK,
          errors: [],
          inner: this.outcomeXml(p, 'ELAB'),
        });
      }
      if (p.gateway.outcome !== 'ok')
        p.result = {
          state: 'KO',
          reason:
            p.gateway.outcome === 'problem'
              ? `Gateway: ${p.gateway.problem.title} ${p.gateway.problem.detail}`.trim()
              : `Gateway: ${p.gateway.message}`,
        };
      else {
        const st = await this.gatewayClient.status(p.caller, p.patientCf, p.workflowInstanceId);
        if (st.outcome !== 'ok')
          return this.answer(service, undefined, {
            esito: REGIONAL_OK,
            errors: [],
            inner: this.outcomeXml(p, 'ELAB'),
          });
        gw = { traceId: p.gateway.traceId, events: st.events.map((e) => JSON.stringify(e)) };
        if (!st.events.some((e) => e.eventType === 'SEND_TO_INI' && e.eventStatus === 'SUCCESS'))
          return this.answer(service, undefined, {
            esito: REGIONAL_OK,
            errors: [],
            inner: this.outcomeXml(p, 'ELAB', gw),
          });
        const oid = `${SIM_OID_ROOT}^${++this.counter}`;
        this.documents.set(oid, {
          oid,
          uuid: `urn:uuid:${randomUUID()}`,
          version: 1,
          authorCf: p.authorCf,
          patientCf: p.patientCf,
          gatewayDocumentId: p.gatewayDocumentId,
          confidentiality: p.confidentiality,
          deleted: false,
        });
        if (p.target) p.target.replacedBy = oid;
        p.result = { state: 'OK', oid };
      }
    }
    return this.answer(service, undefined, {
      esito: REGIONAL_OK,
      errors: [],
      inner: this.outcomeXml(p, p.result.state, gw),
    });
  }

  private outcomeXml(
    p: Pending,
    state: 'OK' | 'KO' | 'ELAB',
    gw?: { traceId: string; events: string[] },
  ) {
    const r = p.result;
    return [
      '<a:EsitoCaricamentoDocumento>',
      `<IdentificativoTemporaneoDocumento>${esc(p.temporaryId)}</IdentificativoTemporaneoDocumento>`,
      `<StatoElaborazione>${state}</StatoElaborazione>`,
      r?.state === 'OK' ? `<IdentificativoDocumento>${esc(r.oid)}</IdentificativoDocumento>` : '',
      r?.state === 'KO' ? `<MotivazioneScarto>${esc(r.reason)}</MotivazioneScarto>` : '',
      '</a:EsitoCaricamentoDocumento>',
      gw?.traceId
        ? `<a:resultGW><spanID>${esc(gw.traceId)}</spanID><traceID>${esc(gw.traceId)}</traceID>${gw.events.map((e) => `<transactionData>${esc(e)}</transactionData>`).join('')}</a:resultGW>`
        : '',
    ].join('');
  }

  /** RicercaDocumenti, «ObjectRef»: OID, versione e UUID del documento (1.2). */
  private search(root: Element): RegionalSoapResponse {
    const service = 'RicercaDocumenti';
    const f = this.callerProblems(root);
    const patientCf = field(root, 'IdentificativoAssistito') ?? '';
    if (!CF.test(patientCf))
      f.push({ code: 'SIM_ASSISTITO', message: 'IdentificativoAssistito: un codice fiscale' });
    const options = field(root, 'OpzioniRisposta');
    if (options !== 'ObjectRef' && options !== 'LeafClass')
      f.push({ code: 'SIM_CAMPO', message: 'OpzioniRisposta: «ObjectRef» o «LeafClass»' });
    if (f.length) return this.answer(service, undefined, this.failure(service, f));
    const user = this.userOf(root);
    const oid = field(root, 'IdentificativoDocumento');
    const mine = [...this.documents.values()].filter(
      (d) => !d.deleted && d.authorCf === user && d.patientCf === patientCf,
    );
    const found = oid ? mine.find((d) => d.oid === oid) : mine.at(-1);
    if (oid && !found && this.documents.get(oid) && !this.documents.get(oid)!.deleted)
      return this.answer(
        service,
        undefined,
        this.failure(service, [
          { code: 'SIM_TITOLARE', message: 'Il medico che cerca non è il titolare del documento' },
        ]),
      );
    if (!found)
      return this.answer(service, undefined, {
        esito: REGIONAL_OK_WITH_WARNINGS,
        errors: [{ code: REGIONAL_NOT_FOUND, message: 'Nessun risultato trovato' }],
        kind: 'Info',
      });
    return this.answer(service, undefined, {
      esito: REGIONAL_OK,
      errors: [],
      inner: `<a:Metadato><IdentificativoDocumento>${esc(found.oid)}</IdentificativoDocumento><VersioneOggettoDocumento>${found.version}</VersioneOggettoDocumento><IdentificativoUnivocoDocumento>${esc(found.uuid)}</IdentificativoUnivocoDocumento></a:Metadato>`,
    });
  }

  /** CancellazioneMetadati: con l'OID o con l'UUID, solo il medico che l'ha redatto (5.3). */
  private async cancellation(root: Element): Promise<RegionalSoapResponse> {
    const service = 'CancellazioneMetadati';
    const f = this.callerProblems(root);
    if (field(root, 'TipoDocumento') !== V09.typeCode)
      f.push({ code: 'SIM_CAMPO', message: 'TipoDocumento: «60591-5» per il PSS' });
    if (field(root, 'TipoAttivita') !== 'DELETE')
      f.push({ code: 'SIM_CAMPO', message: 'TipoAttivita: «DELETE»' });
    if (field(root, 'ModalitaAlimentazione') !== V09.mode)
      f.push({ code: 'SIM_MODALITA', message: 'Simulatore: solo ModalitaAlimentazione «FSE2.0»' });
    if (f.length) return this.answer(service, 'DELETE', this.failure(service, f));
    const id = field(root, 'IdentificativoDocumento') ?? '';
    const d = this.findDocument(id);
    if (!d || d.deleted)
      return this.answer(
        service,
        'DELETE',
        this.failure(service, [
          { code: REGIONAL_NOTHING_TO_DELETE, message: 'Nessun metadato trovato da cancellare' },
        ]),
      );
    const user = this.userOf(root);
    if (d.authorCf !== user)
      return this.answer(
        service,
        'DELETE',
        this.failure(service, [
          {
            code: 'SIM_AUTORE',
            message: 'La cancellazione la chiede il medico che ha redatto il documento',
          },
        ]),
      );
    if (d.patientCf !== field(root, 'IdentificativoAssistito'))
      return this.answer(
        service,
        'DELETE',
        this.failure(service, [
          { code: 'SIM_ASSISTITO', message: 'Il documento è di un altro assistito' },
        ]),
      );
    // In FSE 2.0 l'intermediario cancella anche sul Gateway (specifiche del Gateway, 6).
    const gateway = await this.gatewayClient.remove(
      {
        audience: SIMULATED_FSE_AUDIENCE,
        fiscalCode: user,
        role: 'APR',
        organizationId: V09.organization,
        organizationName: 'Regione Piemonte',
        locality: `Regione Piemonte^^^^^&${SIM_OID_ROOT}&ISO^^^^010`,
        application: { id: 'INTERMEDIARIO', vendor: 'SIMULATORE', version: '1' },
      },
      d.patientCf,
      d.gatewayDocumentId,
    );
    if (gateway.outcome !== 'ok')
      return this.answer(
        service,
        'DELETE',
        this.failure(service, [
          {
            code: 'SIM_GATEWAY',
            message:
              gateway.outcome === 'problem'
                ? `Gateway: ${gateway.problem.title} ${gateway.problem.detail}`.trim()
                : `Gateway: ${gateway.message}`,
          },
        ]),
      );
    d.deleted = true;
    return this.answer(service, 'DELETE', { esito: REGIONAL_OK, errors: [] });
  }
}
