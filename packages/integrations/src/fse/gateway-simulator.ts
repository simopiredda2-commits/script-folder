/**
 * Simulatore del Gateway del Fascicolo (tappa 11, regola 7). Fa i controlli che le specifiche
 * descrivono (versione 2.26): i due token JWT firmati con un certificato rilasciato a chi chiama,
 * il PDF con «cda.xml», lo schematron ufficiale del PSS (D132), i codici dei dizionari copiati,
 * l'impronta del file nel token di firma, il CDA pubblicato uguale a quello validato, la firma
 * PAdES, i 5 giorni (art. 12 del DM 7/9/2023). Gli errori sono quelli della tabella 15.1.1.
 *
 * Dove le specifiche non dicono che errore dà il Gateway (PDF non firmato, documento già
 * pubblicato), il tipo comincia con «/msg/simulatore-»: è nostro, non del Ministero.
 */

import { createHash, randomBytes } from 'node:crypto';
import { DOMParser, type Element } from '@xmldom/xmldom';
import * as xpathLib from 'xpath';
import { FSE_DICTIONARIES, fseDictionaryEntry } from './dictionaries';
import type {
  FseCredentials,
  FseEvent,
  FseHttpRequest,
  FseHttpResponse,
  FseTransport,
} from './gateway';
import { PSS_RESOURCE_TYPE, textOf } from './gateway';
import { readJwt } from './jwt';
import { extractCda, readPades } from './pdf';
import { pssSchematron } from './schematron';
import { certificateFingerprint, createTestCertificate } from './x509';

/** Destinatario dei token per il simulatore (nel servizio vero è l'indirizzo di base). */
export const SIMULATED_FSE_AUDIENCE = 'simulatore-gateway-fse/v1';

export type SimulatedFseOutcome = 'ok' | 'unreachable' | 'timeout' | 'internal-error';
type Operation = 'validation' | 'publication' | 'replacement' | 'status';

/** Tabelle dei valori delle specifiche (16.3) usate nei controlli dei metadati. */
const FACILITY_TYPES = [
  'Ospedale',
  'Prevenzione',
  'Territorio',
  'SistemaTS',
  'Cittadino',
  'MdsPN_DGC',
];
const CLASS_CODES = [
  'WOR',
  'REF',
  'LDO',
  'RIC',
  'SUM',
  'TAC',
  'PRS',
  'PRE',
  'ESE',
  'PDC',
  'VAC',
  'CER',
  'VRB',
  'CON',
  'CNT',
  'CRT',
  'LET',
  'PRO',
  'COL',
];
const CLINICAL_ACTIVITIES = ['PHR', 'CON', 'DIS', 'ERP', 'Sistema_TS', 'INI', 'PN_DGC', 'OBS'];
const ADMINISTRATIVE_REQUESTS = ['SSN', 'INPATIENT', 'NOSSN', 'SSR', 'DONOR', 'AUTO'];
const ROLES = [
  'AAS',
  'APR',
  'PSS',
  'INF',
  'FAR',
  'DSA',
  'DAM',
  'OAM',
  'ASS',
  'TUT',
  'ING',
  'GEN',
  'NOR',
  'DRS',
  'RSA',
  'MRP',
  'INI',
  'OGC',
  'OPI',
  'MDS',
  'GTW',
  'DAP',
];
const ORGANIZATIONS: Record<string, string> = {
  '010': 'Regione Piemonte',
  '020': "Regione Valle d'Aosta",
  '030': 'Regione Lombardia',
  '041': 'P.A. Bolzano',
  '042': 'P.A. Trento',
  '050': 'Regione Veneto',
  '060': 'Regione Friuli Venezia Giulia',
  '070': 'Regione Liguria',
  '080': 'Regione Emilia-Romagna',
};
/** Correlazione tra tipo di documento e classe (16.4): per il PSS, SUM. */
const CLASS_OF_TYPE: Record<string, string> = { '60591-5': 'SUM' };
const FIVE_DAYS_MS = 5 * 86_400_000;

const CF_CLAIM = /^[A-Z0-9]{16}\^\^\^&2\.16\.840\.1\.113883\.2\.9\.4\.3\.2&ISO$/;
/** XON: XON.1 nome, XON.6.2 OID, XON.6.3 «ISO», XON.10 codice (16.1, locality). */
const XON = /^[^^]+\^\^\^\^\^&[0-9.]+&ISO\^\^\^\^[^^]+$/;

const xpath = xpathLib as unknown as {
  select(expr: string, node: unknown): unknown;
  useNamespaces(
    ns: Record<string, string>,
  ): (expr: string, node: unknown, single?: boolean) => unknown;
};
const select = xpath.useNamespaces({ hl7: 'urn:hl7-org:v3' });

interface Workflow {
  cdaHash: string;
  patientCf: string;
  documentId: string;
  activity: 'VALIDATION' | 'VERIFICA';
  events: FseEvent[];
}
interface Published {
  workflowInstanceId: string;
  patientCf: string;
  replacedBy?: string;
}

/** Risposta del servizio (non un errore di rete). */
type Reply = { status: number; body: Record<string, unknown> };

const hex = (n: number) => randomBytes(n).toString('hex');
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

/** Data HL7 (AAAAMMGGhhmmss±hhmm) in millisecondi; null se non è nel formato. */
function hl7ToMs(v: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?([+-]\d{4})?$/.exec(v);
  if (!m) return null;
  const zone = m[7] ? `${m[7].slice(0, 3)}:${m[7].slice(3)}` : 'Z';
  return Date.parse(
    `${m[1]}-${m[2]}-${m[3]}T${m[4] ?? '00'}:${m[5] ?? '00'}:${m[6] ?? '00'}${zone}`,
  );
}

export class SimulatedFseGateway implements FseTransport {
  readonly environment = 'simulator' as const;
  private readonly authCertificates = new Set<string>();
  private readonly signatureCertificates = new Set<string>();
  private readonly workflows = new Map<string, Workflow>();
  private readonly documents = new Map<string, Published>();
  /** Ogni richiesta ricevuta, per le prove: operazione ed esito, mai il contenuto clinico. */
  readonly log: { operation: Operation; status: number; type?: string }[] = [];

  constructor(
    private readonly options: {
      now?: () => Date;
      decide?: (op: Operation) => SimulatedFseOutcome;
    } = {},
  ) {}

  private now() {
    return this.options.now?.() ?? new Date();
  }

  /** Certificati di collegamento e di firma, come quelli di Sogei con l'accreditamento (2.3). */
  issueCredentials(name: string): FseCredentials {
    const from = new Date(this.now().getTime() - 86_400_000);
    const auth = createTestCertificate({
      commonName: `${name} – collegamento`,
      organization: 'Simulatore Gateway',
      from,
    });
    const sign = createTestCertificate({
      commonName: `${name} – firma dei token`,
      organization: 'Simulatore Gateway',
      from,
    });
    this.authCertificates.add(auth.fingerprint);
    this.signatureCertificates.add(sign.fingerprint);
    return {
      authentication: { der: auth.der, privateKeyPem: auth.privateKeyPem },
      signature: { der: sign.der, privateKeyPem: sign.privateKeyPem },
    };
  }

  private problem(
    status: number,
    type: string,
    title: string,
    detail: string,
    instance?: string,
  ): Reply {
    const trace = hex(8);
    return {
      status,
      body: {
        traceID: trace,
        spanID: trace,
        type,
        title,
        detail,
        status,
        ...(instance ? { instance } : {}),
      },
    };
  }

  async send(req: FseHttpRequest): Promise<FseHttpResponse> {
    const op: Operation =
      req.method === 'GET'
        ? 'status'
        : req.method === 'PUT'
          ? 'replacement'
          : req.path.endsWith('/validation')
            ? 'validation'
            : 'publication';
    const outcome = this.options.decide?.(op) ?? 'ok';
    if (outcome === 'unreachable' || outcome === 'timeout') {
      this.log.push({ operation: op, status: 0 });
      return { error: outcome };
    }
    const res =
      outcome === 'internal-error'
        ? this.problem(
            500,
            '/msg/generic-error',
            'Errore generico.',
            'Simulatore: errore interno, per prova',
          )
        : await this.handle(op, req);
    this.log.push({
      operation: op,
      status: 'status' in res ? res.status : 0,
      ...('status' in res && typeof res.body.type === 'string' ? { type: res.body.type } : {}),
    });
    return res;
  }

  /** I due token: firma, certificato rilasciato, campi obbligatori e loro valori (16.1). */
  private checkTokens(
    req: FseHttpRequest,
    op: Operation,
    file?: Uint8Array,
  ): Reply | { patientCf: string } {
    if (!this.authCertificates.has(certificateFingerprint(req.clientCertificate)))
      return this.problem(
        401,
        '/msg/unauthorized',
        'Unauthorized',
        'Certificato di collegamento non riconosciuto',
      );
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const integrity = req.headers['fse-jwt-signature'];
    if (!bearer || !integrity)
      return this.problem(
        403,
        '/msg/missing-token',
        'Token non fornito.',
        'Attenzione il jwt fornito risulta essere vuoto',
        '/missing-jwt',
      );
    const now = Math.floor(this.now().getTime() / 1000);
    const read = (token: string, prefix: string) => {
      const r = readJwt(token);
      if (!r.ok) return r.reason;
      const fp = r.certificate.fingerprint256.replaceAll(':', '').toLowerCase();
      if (!this.signatureCertificates.has(fp))
        return 'Certificato di firma del token non riconosciuto';
      const p = r.parts.payload;
      for (const k of ['iss', 'iat', 'exp', 'jti', 'aud', 'sub'])
        if (p[k] === undefined || p[k] === '') return `Campo obbligatorio ${k} assente`;
      if (!String(p.iss).startsWith(prefix)) return `Il campo iss deve cominciare con «${prefix}»`;
      if (p.aud !== SIMULATED_FSE_AUDIENCE) return 'Il campo aud non è l’indirizzo del servizio';
      if (typeof p.exp !== 'number' || p.exp < now) return 'Token scaduto';
      if (typeof p.iat !== 'number' || p.iat > now + 60) return 'Token emesso nel futuro';
      if (!CF_CLAIM.test(String(p.sub)))
        return 'Il campo sub non è un codice fiscale nel formato atteso';
      return p;
    };
    const auth = read(bearer, 'auth:');
    if (typeof auth === 'string')
      return this.problem(
        403,
        '/msg/jwt-validation',
        'Campo token JWT non valido.',
        auth,
        '/jwt-validation',
      );
    const signature = read(integrity, 'integrity:');
    if (typeof signature === 'string')
      return this.problem(
        403,
        '/msg/jwt-validation',
        'Campo token JWT non valido.',
        signature,
        '/jwt-validation',
      );
    const required = [
      'subject_organization_id',
      'subject_organization',
      'locality',
      'subject_role',
      'person_id',
      'patient_consent',
      'purpose_of_use',
      'action_id',
      'subject_application_id',
      'subject_application_vendor',
      'subject_application_version',
      'resource_hl7_type',
    ];
    for (const k of required)
      if (auth[k] === undefined || auth[k] === '')
        return this.problem(
          403,
          '/msg/mandatory-element-token',
          'Token JWT non valido.',
          `Campo ${k} assente nel token`,
          '/jwt-mandatory-field-missing',
        );
    const fail = (detail: string) =>
      this.problem(
        403,
        '/msg/jwt-validation',
        'Campo token JWT non valido.',
        detail,
        '/jwt-validation',
      );
    if (!ROLES.includes(String(auth.subject_role)))
      return fail('Ruolo (subject_role) non nella tabella');
    if (ORGANIZATIONS[String(auth.subject_organization_id)] !== auth.subject_organization)
      return fail('Organizzazione (subject_organization_id) non coerente');
    if (!XON.test(String(auth.locality))) return fail('Il campo locality non è nel formato XON');
    if (!CF_CLAIM.test(String(auth.person_id)))
      return fail('Il campo person_id non è nel formato atteso');
    if (typeof auth.patient_consent !== 'boolean')
      return fail('Il campo patient_consent deve essere vero o falso');
    const update = op === 'replacement';
    if (auth.purpose_of_use !== (update ? 'UPDATE' : 'TREATMENT'))
      return fail('Contesto operativo (purpose_of_use) non ammesso per il servizio');
    if (auth.action_id !== (update ? 'UPDATE' : 'CREATE'))
      return fail('Tipo di attività (action_id) non ammesso per il servizio');
    if (auth.resource_hl7_type !== PSS_RESOURCE_TYPE)
      return fail('Tipo di documento (resource_hl7_type) non gestito dal simulatore');
    if ((op === 'publication' || op === 'replacement') && file) {
      if (!signature.attachment_hash)
        return this.problem(
          403,
          '/msg/mandatory-element-token',
          'Token JWT non valido.',
          'Campo attachment_hash assente nel token',
          '/jwt-mandatory-field-missing',
        );
      if (signature.attachment_hash !== sha256(file))
        return this.problem(
          400,
          '/msg/document-hash',
          'Verifica hash fallita.',
          'Verifica hash fallita.',
          '/jwt-hash-match',
        );
    }
    return { patientCf: String(auth.person_id).slice(0, 16) };
  }

  /** Il PDF con «cda.xml»: problema, oppure il CDA e i suoi dati principali. */
  private async document(file: Uint8Array | undefined): Promise<
    | Reply
    | {
        xml: string;
        hash: string;
        code: string;
        patientCf: string;
        documentId: string;
        createdAt: number | null;
      }
  > {
    if (!file || !file.length)
      return this.problem(
        400,
        '/msg/empty-file',
        'File vuoto.',
        'File vuoto',
        '/empty-multipart-file',
      );
    if (Buffer.from(file.subarray(0, 5)).toString('latin1') !== '%PDF-')
      return this.problem(
        415,
        '/msg/document-type',
        'Il documento non è pdf.',
        'Il documento non è pdf.',
        '/multipart-file',
      );
    const xml = await extractCda(file);
    if (xml === null)
      return this.problem(
        400,
        '/msg/cda-element',
        'Errore in fase di estrazione del CDA.',
        'Errore in fase di estrazione del CDA.',
        '/cda-extraction',
      );
    let doc: ReturnType<DOMParser['parseFromString']>;
    try {
      doc = new DOMParser().parseFromString(xml, 'text/xml');
    } catch (e) {
      return this.problem(
        400,
        '/msg/syntax',
        'Errore di sintassi.',
        e instanceof Error ? e.message : 'XML non valido',
        '/validation/error',
      );
    }
    const one = (expr: string) => {
      const v = select(expr, doc, true) as { value?: string } | undefined;
      return v?.value ?? '';
    };
    return {
      xml,
      hash: sha256(xml),
      code: one('/hl7:ClinicalDocument/hl7:code/@code'),
      patientCf: one(
        "/hl7:ClinicalDocument/hl7:recordTarget/hl7:patientRole/hl7:id[@root='2.16.840.1.113883.2.9.4.3.2']/@extension",
      ),
      documentId: `${one('/hl7:ClinicalDocument/hl7:id/@root')}^${one('/hl7:ClinicalDocument/hl7:id/@extension')}`,
      createdAt: hl7ToMs(one('/hl7:ClinicalDocument/hl7:effectiveTime/@value')),
    };
  }

  /** Codici dei dizionari copiati (errore «vocabolario»); LOINC e ICD-9-CM non si controllano. */
  private vocabulary(xml: string): string | null {
    const known = new Set<string>(Object.values(FSE_DICTIONARIES));
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const nodes = select('//*[@codeSystem and @code]', doc) as Element[];
    for (const n of nodes) {
      const system = n.getAttribute('codeSystem')!;
      const code = n.getAttribute('code')!;
      if (known.has(system) && !fseDictionaryEntry(system, code))
        return `Il codice ${code} non è nel dizionario ${system}`;
    }
    return null;
  }

  private async handle(op: Operation, req: FseHttpRequest): Promise<Reply> {
    const tokens = this.checkTokens(req, op, req.file);
    if ('status' in tokens) return tokens;
    if (op === 'status') {
      const wii = decodeURIComponent(req.path.split('/').pop() ?? '');
      const w = this.workflows.get(wii);
      if (!w)
        return this.problem(
          404,
          '/msg/record-not-found',
          'Record non trovato.',
          'Transazione non trovata',
        );
      const trace = hex(8);
      return { status: 200, body: { traceID: trace, spanID: trace, transactionData: w.events } };
    }
    const d = await this.document(req.file);
    if ('status' in d) return d;
    if (d.patientCf !== tokens.patientCf)
      return this.problem(
        403,
        '/msg/jwt-validation',
        'Campo token JWT non valido.',
        'Il paziente del token (person_id) non è quello del documento',
        '/jwt-person-id',
      );
    if (d.code !== '60591-5')
      return this.problem(
        403,
        '/msg/jwt-validation',
        'Campo token JWT non valido.',
        'Il tipo di documento del token non è quello del documento',
        '/jwt-validation',
      );
    const at = this.now();
    if (op === 'validation') {
      const body = req.requestBody ?? {};
      if (body.activity !== 'VALIDATION' && body.activity !== 'VERIFICA')
        return this.problem(
          400,
          '/msg/mandatory-element',
          'Campo obbligatorio non presente.',
          'Il campo activity deve essere valorizzato',
          '/request-missing-field',
        );
      const sch = pssSchematron().validate(d.xml);
      if (sch.errors.length)
        return this.problem(
          422,
          '/msg/semantic',
          'Errore semantico.',
          sch.errors.map((e) => e.message).join(' | '),
          '/validation/error',
        );
      const vocab = this.vocabulary(d.xml);
      if (vocab)
        return this.problem(
          400,
          '/msg/vocabulary',
          'Errore vocabolario.',
          vocab,
          '/validation/error',
        );
      const root = d.documentId.split('^')[0]!;
      const wii = `${root}.${sha256(d.xml + hex(4))}.${hex(5)}^^^^urn:ihe:iti:xdw:2013:workflowInstanceId`;
      this.workflows.set(wii, {
        cdaHash: d.hash,
        patientCf: d.patientCf,
        documentId: d.documentId,
        activity: body.activity,
        events: [{ eventType: 'VALIDATION', eventStatus: 'SUCCESS', eventDate: at.toISOString() }],
      });
      const trace = hex(8);
      const warning = body.mode
        ? undefined
        : 'Attenzione, non è stata selezionata la modalità di estrazione del CDA';
      return {
        status: body.activity === 'VALIDATION' ? 201 : 200,
        body: {
          traceID: trace,
          spanID: trace,
          workflowInstanceId: wii,
          ...(warning ? { warning } : {}),
        },
      };
    }
    // Pubblicazione o sostituzione.
    const b = req.requestBody ?? {};
    const missing = [
      'tipologiaStruttura',
      'identificativoDoc',
      'identificativoRep',
      'tipoDocumentoLivAlto',
      'assettoOrganizzativo',
      'tipoAttivitaClinica',
      'identificativoSottomissione',
      'administrativeRequest',
    ].find(
      (k) =>
        b[k] === undefined || b[k] === '' || (Array.isArray(b[k]) && !(b[k] as unknown[]).length),
    );
    if (missing)
      return this.problem(
        400,
        '/msg/mandatory-element',
        'Campo obbligatorio non presente.',
        `Il campo ${missing} deve essere valorizzato`,
        '/request-missing-field',
      );
    const invalid = (field: string) =>
      this.problem(
        400,
        '/msg/invalid-format',
        'Formato campo non valido.',
        `Il campo ${field} deve essere valorizzato correttamente`,
        '/request-invalid-format',
      );
    if (!FACILITY_TYPES.includes(String(b.tipologiaStruttura)))
      return invalid('tipologiaStruttura');
    if (!CLASS_CODES.includes(String(b.tipoDocumentoLivAlto)))
      return invalid('tipoDocumentoLivAlto');
    if (CLASS_OF_TYPE[d.code] !== b.tipoDocumentoLivAlto) return invalid('tipoDocumentoLivAlto');
    if (!/^AD_PSC\d{3}$/.test(String(b.assettoOrganizzativo)))
      return invalid('assettoOrganizzativo');
    if (!CLINICAL_ACTIVITIES.includes(String(b.tipoAttivitaClinica)))
      return invalid('tipoAttivitaClinica');
    const admin = b.administrativeRequest as unknown[];
    if (!Array.isArray(admin) || admin.some((x) => !ADMINISTRATIVE_REQUESTS.includes(String(x))))
      return invalid('administrativeRequest');
    if (b.identificativoDoc !== d.documentId) return invalid('identificativoDoc');
    const wii = textOf(b.workflowInstanceId);
    const w = this.workflows.get(wii);
    if (!w || w.activity !== 'VALIDATION' || w.cdaHash !== d.hash)
      return this.problem(
        400,
        '/msg/cda-match',
        "Errore in fase di recupero dell'esito della verifica.",
        'Il CDA non risulta validato',
        '/cda-validation',
      );
    const pades = readPades(req.file!);
    if (!pades || pades.subFilter !== 'ETSI.CAdES.detached' || !pades.coversWholeFile)
      return this.problem(
        400,
        '/msg/simulatore-firma',
        'Simulatore: PDF senza firma PAdES.',
        'Il documento da pubblicare deve essere firmato in modalità PAdES',
      );
    if (d.createdAt === null || at.getTime() - d.createdAt > FIVE_DAYS_MS)
      return this.problem(
        400,
        '/msg/max-day-limit-exceed',
        'Error: document exceeded the maximum period to be published.',
        'Error: cannot publish documents older than 5 days',
        '/msg/max-day-limit-exceed',
      );
    if (this.documents.has(d.documentId))
      return this.problem(
        409,
        '/msg/simulatore-conflitto',
        'Simulatore: documento già pubblicato.',
        `Il documento ${d.documentId} è già nel Fascicolo`,
      );
    if (op === 'replacement') {
      const target = decodeURIComponent(req.path.split('/').pop() ?? '');
      const old = this.documents.get(target);
      if (!old || old.replacedBy)
        return this.problem(
          404,
          '/msg/record-not-found',
          'Record non trovato.',
          `Documento da sostituire ${target} non trovato`,
        );
      if (old.patientCf !== d.patientCf) return invalid('identificativoDocUpdate');
      old.replacedBy = d.documentId;
    }
    this.documents.set(d.documentId, { workflowInstanceId: wii, patientCf: d.patientCf });
    w.events.push(
      { eventType: 'PUBLICATION', eventStatus: 'SUCCESS', eventDate: at.toISOString() },
      { eventType: 'SEND_TO_INI', eventStatus: 'SUCCESS', eventDate: at.toISOString() },
    );
    const trace = hex(8);
    return { status: 202, body: { traceID: trace, spanID: trace, workflowInstanceId: wii } };
  }

  /** Per le prove: il documento è nel Fascicolo simulato, e da chi è stato sostituito. */
  published(documentId: string): Published | undefined {
    return this.documents.get(documentId);
  }
}
