/**
 * Documento CDA2 del Profilo Sanitario Sintetico (tappa 11). Struttura e codici dall'esempio
 * ufficiale del Ministero (`it-fse-support`, `doc/esempi/CDA/PSS.xml`) e dallo schematron 4.0;
 * i codici delle tabelle sono nei dizionari copiati in `fse-ufficiale/` (D131). Il documento si
 * controlla con lo schematron ufficiale prima di uscire (D132).
 *
 * Qui solo la scrittura: che cosa entra nel Profilo lo decide la composizione (dominio), con le
 * voci oscurate sempre fuori (DM 7/9/2023, art. 4, c. 3) e la verifica del medico.
 */

import { createHash } from 'node:crypto';

export interface InstanceId {
  root: string;
  extension: string;
}

/** Indirizzo con i codici ISTAT: «100» è l'Italia (come nell'esempio ufficiale). */
export interface CdaAddress {
  /** Codice ISTAT del comune (sei cifre), per «censusTract». */
  istatCode: string;
  city: string;
  /** Sigla della provincia. */
  province?: string | null;
  postalCode?: string | null;
  street?: string | null;
}

export interface CdaPerson {
  fiscalCode: string;
  firstName: string;
  lastName: string;
}

export interface CdaTelecoms {
  phone?: string | null;
  email?: string | null;
  pec?: string | null;
}

export type CdaStatus = 'active' | 'completed';

export interface CdaAllergy {
  id: string;
  /**
   * Tipo dal dizionario ActCode (ObservationIntoleranceType): ALG, DALG, FALG, EALG, DINT…
   * `label` è il nome in italiano per il testo leggibile; il codice resta quello ufficiale.
   */
  type: { code: string; display: string; label?: string };
  /** Agente: codice AIC, ATC o del dizionario degli allergeni; senza codice, solo il testo. */
  agent: { code: string; system: 'AIC' | 'ATC' | 'ALLERGENI'; display: string } | { text: string };
  status: 'active' | 'inactive';
  onsetOn?: string | null;
  endOn?: string | null;
  criticality?: 'L' | 'M' | 'H' | null;
  /** Reazione e note, in chiaro (sezione «Note e commenti»). */
  comment?: string | null;
}

export interface CdaTherapy {
  id: string;
  drug: { aic?: string | null; atc?: string | null; name: string; atcName?: string | null };
  /** Via di somministrazione, codice HL7 RouteOfAdministration; `label` in italiano per la lettura. */
  route: { code: string; display: string; label?: string };
  startOn: string;
  endOn?: string | null;
  status: CdaStatus;
  /** Come si prende, in chiaro. */
  dosage?: string | null;
}

export interface CdaProblem {
  id: string;
  /** ICD-9-CM, oppure dizionario «Organi mancanti» (ICD-10). */
  code: { code: string; system: 'ICD9CM' | 'ORGANI_MANCANTI'; display: string };
  text: string;
  state: 'active' | 'resolved';
  chronic: boolean;
  onsetOn?: string | null;
  resolvedOn?: string | null;
}

export interface CdaFamilyCondition {
  id: string;
  /** Parentela, codice RoleCode HL7 (FTH, MTH, SIS…). */
  relative: { code: string; display: string; sex?: 'M' | 'F' | null };
  /** Patologia in ICD-9-CM. */
  code: { code: string; display: string };
  text: string;
  onsetAge?: number | null;
}

export interface CdaVital {
  id: string;
  /** Codice LOINC (peso, altezza, BMI, pressione). */
  loinc: string;
  label: string;
  value: string;
  /** Unità UCUM. */
  unit: string;
  measuredOn: string;
}

export interface CdaLifestyle {
  id: string;
  loinc: string;
  label: string;
  text: string;
  recordedOn: string;
}

export interface PssCdaInput {
  document: {
    id: InstanceId;
    setId: InstanceId;
    version: number;
    /** Versione precedente sostituita da questa (relatedDocument RPLC). */
    replaces?: InstanceId | null;
    createdAt: Date;
    confidentiality: 'N' | 'R' | 'V';
  };
  patient: CdaPerson & {
    sex: 'M' | 'F';
    birthDate: string;
    /** Comune di nascita in Italia; per i nati all'estero si scrive solo lo Stato. */
    birthPlace?: CdaAddress | null;
    address?: CdaAddress | null;
  };
  author: CdaPerson & { prefix?: string | null; telecoms: CdaTelecoms; time: Date };
  custodian: {
    id: InstanceId;
    name: string;
    address: CdaAddress;
  };
  legalAuthenticatorTime: Date;
  /** Momento a cui si riferisce il profilo (documentationOf/serviceEvent). */
  serviceTime: Date;
  allergies: CdaAllergy[] | { absent: 'no-known-allergies' | 'no-allergy-info' };
  therapies: CdaTherapy[] | { absent: 'no-known-medications' | 'no-medication-info' };
  problems: CdaProblem[] | { absent: 'no-known-problems' | 'no-problem-info' };
  familyHistory: CdaFamilyCondition[] | { absent: 'no-known-problems' | 'no-problem-info' };
  vitals: CdaVital[];
  lifestyle: CdaLifestyle[];
  motorCapacity?: { code: string; display: string; since: string } | null;
}

/* ------------------------------------------------------------------------------------------ */
/* Codici (dall'esempio ufficiale, dallo schematron 4.0 e dai dizionari di fse-ufficiale/).    */

const OID = {
  loinc: '2.16.840.1.113883.6.1',
  icd9: '2.16.840.1.113883.6.103',
  aic: '2.16.840.1.113883.2.9.6.1.5',
  atc: '2.16.840.1.113883.6.73',
  allergens: '2.16.840.1.113883.2.9.77.22.11.2',
  missingOrgans: '2.16.840.1.113883.2.9.77.22.11.17',
  chronicity: '2.16.840.1.113883.2.9.77.22.11.10',
  clinicalStatus: '2.16.840.1.113883.2.9.77.22.11.11',
  authorCode: '2.16.840.1.113883.2.9.77.22.11.13',
  motorCapacity: '2.16.840.1.113883.2.9.77.22.11.15',
  actCode: '2.16.840.1.113883.5.4',
  /** Value set ObservationIntoleranceType: la guida v1.5 lo vuole per l'assenza di allergie (D281). */
  intoleranceType: '2.16.840.1.113883.1.11.19700',
  observationValue: '2.16.840.1.113883.5.1063',
  roleCode: '2.16.840.1.113883.5.111',
  gender: '2.16.840.1.113883.5.1',
  confidentiality: '2.16.840.1.113883.5.25',
  route: '2.16.840.1.113883.5.112',
  absentAllergies: '2.16.840.1.113883.11.22.9',
  absentMedications: '2.16.840.1.113883.11.22.15',
  absentProblems: '2.16.840.1.113883.11.22.17',
  fiscalCode: '2.16.840.1.113883.2.9.4.3.2',
} as const;

const TPL = {
  document: '2.16.840.1.113883.2.9.10.1.4.1.1',
  allergies: '2.16.840.1.113883.2.9.10.1.4.2.1',
  therapies: '2.16.840.1.113883.2.9.10.1.4.2.2',
  problems: '2.16.840.1.113883.2.9.10.1.4.2.4',
  lifestyle: '2.16.840.1.113883.2.9.10.1.4.2.6',
  vitals: '2.16.840.1.113883.2.9.10.1.4.2.8',
  functional: '2.16.840.1.113883.2.9.10.1.4.2.13',
  family: '2.16.840.1.113883.2.9.10.1.4.2.16',
  allergyConcern: '2.16.840.1.113883.2.9.10.1.4.3.1.1',
  allergyObservation: '2.16.840.1.113883.2.9.10.1.4.3.1.3',
  allergyAbsent: '2.16.840.1.113883.2.9.10.1.4.3.1.4',
  criticality: '2.16.840.1.113883.2.9.10.1.4.3.1.5.3',
  status: '2.16.840.1.113883.2.9.10.1.4.3.1.6',
  comment: '2.16.840.1.113883.2.9.10.1.4.3.1.7',
  medication: '2.16.840.1.113883.2.9.10.1.4.3.2.1',
  medicationProduct: '2.16.840.1.113883.2.9.10.1.4.3.2.2',
  medicationAbsent: '2.16.840.1.113883.2.9.10.1.4.3.2.3',
  medicationMaterial: '2.16.840.1.113883.10.22.4.3',
  problemConcern: '2.16.840.1.113883.2.9.10.1.4.3.4.1',
  problemObservation: '2.16.840.1.113883.2.9.10.1.4.3.4.2',
  chronicity: '2.16.840.1.113883.2.9.10.1.4.3.4.5',
  lifestyleObservation: '2.16.840.1.113883.2.9.10.1.4.3.6.1',
  vitalObservation: '2.16.840.1.113883.2.9.10.1.4.3.8.2',
  functionalOrganizer: '2.16.840.1.113883.2.9.10.1.4.3.14.1',
  motorCapacity: '2.16.840.1.113883.2.9.10.1.4.3.14.2',
  familyOrganizer: '2.16.840.1.113883.2.9.10.1.4.3.16.1',
  familyObservation: '2.16.840.1.113883.2.9.10.1.4.3.16.2',
  familyAge: '2.16.840.1.113883.2.9.10.1.4.3.16.3',
  familyAbsent: '2.16.840.1.113883.2.9.10.1.4.3.16.4',
} as const;

/**
 * Versione della guida nel templateId del documento: la v1.5 di HL7 Italia, come il titolo dello
 * schematron 4.0 del Ministero (D281). Il Gateway sceglie schematron e trasformazione dalla radice
 * del modello, non da questa versione.
 */
export const PSS_TEMPLATE_VERSION = '1.5';
export const PSS_LOINC = '60591-5';

const ABSENT_LABELS: Record<string, string> = {
  'no-known-allergies': 'No known allergies',
  'no-allergy-info': 'No information about allergies',
  'no-known-medications': 'No known medications',
  'no-medication-info': 'No information about medications',
  'no-known-problems': 'No known problems',
  'no-problem-info': 'No information about current problems',
};
const ABSENT_TEXT: Record<string, string> = {
  'no-known-allergies': 'Nessuna allergia nota.',
  'no-allergy-info': 'Nessuna informazione sulle allergie.',
  'no-known-medications': 'Nessuna terapia nota.',
  'no-medication-info': 'Nessuna informazione sulle terapie.',
  'no-known-problems': 'Nessun problema noto.',
  'no-problem-info': 'Nessuna informazione.',
};
const CRITICALITY = { L: 'Low', M: 'Moderate', H: 'High' } as const;
const CRITICALITY_IT = { L: 'bassa', M: 'moderata', H: 'alta' } as const;

/* ------------------------------------------------------------------------------------------ */

const XML_TEXT: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const XML_ATTR: Record<string, string> = { ...XML_TEXT, '"': '&quot;' };
/** Testo per un elemento XML. */
export const xmlText = (v: string) => v.replace(/[&<>]/g, (c) => XML_TEXT[c]!);
/** Testo per un attributo XML. */
export const xmlAttr = (v: string) => v.replace(/[&<>"]/g, (c) => XML_ATTR[c]!);

/** Data e ora nel fuso di Roma, nel formato HL7 TS: «20261118103000+0100». */
export function hl7Time(d: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Rome',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'longOffset',
    })
      .formatToParts(d)
      .map((p) => [p.type, p.value]),
  );
  const offset = /GMT([+-])(\d{2}):?(\d{2})?/.exec(parts.timeZoneName ?? '');
  const zone = offset ? `${offset[1]}${offset[2]}${offset[3] ?? '00'}` : '+0000';
  return `${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}${parts.second}${zone}`;
}

/** Data «AAAA-MM-GG» nel formato HL7 a precisione di giorno. */
export const hl7Date = (iso: string) => iso.slice(0, 10).replaceAll('-', '');

const attrs = (a: Record<string, string | number | null | undefined>) =>
  Object.entries(a)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => ` ${k}="${xmlAttr(String(v))}"`)
    .join('');

const el = (name: string, a: Record<string, string | number | null | undefined>, body = '') =>
  body ? `<${name}${attrs(a)}>${body}</${name}>` : `<${name}${attrs(a)}/>`;

const tid = (root: string) => el('templateId', { root });
const ref = (id: string) => `<reference value="#${xmlAttr(id)}"/>`;
const lowHigh = (low?: string | null, high?: string | null) =>
  (low ? el('low', { value: low }) : el('low', { nullFlavor: 'UNK' })) +
  (high ? el('high', { value: high }) : '');

function addr(a: CdaAddress, use?: string): string {
  return el(
    'addr',
    { use },
    el('country', {}, '100') +
      (a.province ? el('county', {}, xmlText(a.province)) : '') +
      el('city', {}, xmlText(a.city)) +
      el('censusTract', {}, xmlText(a.istatCode)) +
      (a.postalCode ? el('postalCode', {}, xmlText(a.postalCode)) : '') +
      (a.street ? el('streetAddressLine', {}, xmlText(a.street)) : ''),
  );
}

/** Indirizzo completo per il paziente (lo schematron chiede tutti i campi, ERRORE-11). */
const completeAddress = (a: CdaAddress | null | undefined) =>
  a && a.postalCode && a.street ? a : null;

function telecoms(t: CdaTelecoms): string {
  return (
    (t.phone ? el('telecom', { use: 'WP', value: `tel:${t.phone.replace(/\s+/g, '')}` }) : '') +
    (t.email ? el('telecom', { use: 'WP', value: `mailto:${t.email}` }) : '') +
    (t.pec ? el('telecom', { use: 'WP', value: `mailto:${t.pec}` }) : '')
  );
}

function name(p: CdaPerson, prefix?: string | null): string {
  return el(
    'name',
    {},
    el('family', {}, xmlText(p.lastName)) +
      el('given', {}, xmlText(p.firstName)) +
      (prefix ? el('prefix', {}, xmlText(prefix)) : ''),
  );
}

const cfId = (cf: string) =>
  el('id', { root: OID.fiscalCode, extension: cf, assigningAuthorityName: 'MEF' });

/** Identificativo di una voce: la radice è l'identificativo della voce in cartella. */
const entryId = (id: string) => el('id', { root: id });

/** Spazio dei nomi del programma per gli identificativi che ricava (UUID scelto una volta). */
const ID_NAMESPACE = Buffer.from('6f1c2a4e8d3b4f0a9c5e7b21d4a8e3f6', 'hex');

/**
 * Identificativo ricavato dal nome, sempre lo stesso: UUID della versione 5 (RFC 9562, SHA-1).
 * La guida v1.5 vuole in ogni `id` un OID o un UUID (D281): servono per le osservazioni dentro le
 * voci e per le voci di assenza, che in cartella non hanno un identificativo loro.
 */
export function derivedUuid(name: string): string {
  const h = createHash('sha1').update(ID_NAMESPACE).update(name, 'utf8').digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
/** L'osservazione dentro una voce: dall'identificativo della voce. */
const observationId = (entry: string) => el('id', { root: derivedUuid(`${entry}/osservazione`) });
/** Una voce di assenza: dall'identificativo del documento. */
const absenceId = (doc: string, what: string) => el('id', { root: derivedUuid(`${doc}/${what}`) });

function section(
  key: string,
  template: string,
  code: string,
  display: string,
  title: string,
  text: string,
  entries: string,
): string {
  return el(
    'component',
    {},
    el(
      'section',
      { ID: key },
      tid(template) +
        el('code', { code, codeSystem: OID.loinc, codeSystemName: 'LOINC', displayName: display }) +
        el('title', {}, xmlText(title)) +
        el('text', {}, text) +
        entries,
    ),
  );
}

/** Data del testo leggibile, come la legge un medico italiano: 2026-11-18 → 18/11/2026. */
export function itDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/** Unità UCUM come si scrivono per chi legge (il valore codificato resta in UCUM). */
const UCUM_LABELS: Record<string, string> = { 'mm[Hg]': 'mmHg', 'kg/m2': 'kg/m²' };
export const unitLabel = (ucum: string) => UCUM_LABELS[ucum] ?? ucum;

/** Tabella del testo leggibile; la prima colonna porta l'ID richiamato dalle voci. */
function table(head: string[], rows: { id: string; cells: string[] }[]): string {
  return el(
    'table',
    {},
    el('thead', {}, el('tr', {}, head.map((h) => el('th', {}, xmlText(h))).join(''))) +
      el(
        'tbody',
        {},
        rows
          .map((r) =>
            el(
              'tr',
              {},
              r.cells
                .map((c, i) =>
                  el('td', {}, i === 0 ? el('content', { ID: r.id }, xmlText(c)) : xmlText(c)),
                )
                .join(''),
            ),
          )
          .join(''),
      ),
  );
}

const statusObservation = (refId: string, active: boolean) =>
  el(
    'entryRelationship',
    { typeCode: 'REFR', inversionInd: 'false' },
    el(
      'observation',
      { classCode: 'OBS', moodCode: 'EVN' },
      tid(TPL.status) +
        el('code', {
          code: '33999-4',
          codeSystem: OID.loinc,
          codeSystemName: 'LOINC',
          displayName: 'Stato',
        }) +
        el('text', {}, ref(refId)) +
        el('statusCode', { code: 'completed' }) +
        el('value', {
          'xsi:type': 'CE',
          code: active ? 'LA16666-2' : 'LA18632-2',
          codeSystem: OID.clinicalStatus,
          displayName: active ? 'Active' : 'Inactive',
        }),
    ),
  );

const commentAct = (refId: string) =>
  el(
    'entryRelationship',
    { typeCode: 'SUBJ', inversionInd: 'true' },
    el(
      'act',
      { classCode: 'ACT', moodCode: 'EVN' },
      tid(TPL.comment) +
        el('code', {
          code: '48767-8',
          codeSystem: OID.loinc,
          codeSystemName: 'LOINC',
          displayName: 'Annotation Comment',
        }) +
        el('text', {}, ref(refId)) +
        el('statusCode', { code: 'completed' }),
    ),
  );

/* ------------------------------------------------------------------------------------------ */
/* Sezioni                                                                                     */

function allergiesSection(input: PssCdaInput['allergies'], doc: string): string {
  if (!Array.isArray(input)) {
    const refId = 'all-assenza';
    const entry = el(
      'entry',
      {},
      el(
        'act',
        { classCode: 'ACT', moodCode: 'EVN' },
        tid(TPL.allergyConcern) +
          absenceId(doc, 'allergie-assenza') +
          el('code', { nullFlavor: 'NA' }) +
          el('statusCode', { code: 'active' }) +
          el('effectiveTime', {}, lowHigh(null)) +
          el(
            'entryRelationship',
            { typeCode: 'SUBJ' },
            el(
              'observation',
              { classCode: 'OBS', moodCode: 'EVN' },
              tid(TPL.allergyAbsent) +
                absenceId(doc, 'allergie-assenza/osservazione') +
                el('code', {
                  code: 'OINT',
                  codeSystem: OID.intoleranceType,
                  codeSystemName: 'ObservationIntoleranceType',
                  displayName: 'intolerance',
                }) +
                el('text', {}, ref(refId)) +
                el('statusCode', { code: 'completed' }) +
                el('effectiveTime', {}, lowHigh(null)) +
                el(
                  'value',
                  {
                    'xsi:type': 'CD',
                    code: input.absent,
                    codeSystem: OID.absentAllergies,
                    displayName: ABSENT_LABELS[input.absent],
                  },
                  el('originalText', {}, ref(refId)),
                ),
            ),
          ),
      ),
    );
    return section(
      'ALLERGIE_INTOLLERANZE',
      TPL.allergies,
      '48765-2',
      'Allergie, Reazioni Avverse',
      'Allergie e Intolleranze',
      el('paragraph', {}, el('content', { ID: refId }, xmlText(ABSENT_TEXT[input.absent]!))),
      entry,
    );
  }
  const rows = input.map((a, i) => ({
    id: `all-${i + 1}`,
    cells: [
      'text' in a.agent ? a.agent.text : a.agent.display,
      a.type.label ?? a.type.display,
      a.status === 'active' ? 'Attiva' : 'Non attiva',
      a.criticality ? CRITICALITY_IT[a.criticality] : '',
      a.comment ?? '',
    ],
  }));
  const entries = input
    .map((a, i) => {
      const refId = `all-${i + 1}`;
      const agent =
        'text' in a.agent
          ? el('code', { nullFlavor: 'NI' }, el('originalText', {}, ref(refId)))
          : el(
              'code',
              {
                code: a.agent.code,
                codeSystem:
                  a.agent.system === 'AIC'
                    ? OID.aic
                    : a.agent.system === 'ATC'
                      ? OID.atc
                      : OID.allergens,
                displayName: a.agent.display,
              },
              el('originalText', {}, ref(refId)),
            );
      const completed = a.status === 'inactive';
      return el(
        'entry',
        {},
        el(
          'act',
          { classCode: 'ACT', moodCode: 'EVN' },
          tid(TPL.allergyConcern) +
            entryId(a.id) +
            el('code', { nullFlavor: 'NA' }) +
            el('statusCode', { code: completed ? 'completed' : 'active' }) +
            el(
              'effectiveTime',
              {},
              lowHigh(
                a.onsetOn ? hl7Date(a.onsetOn) : null,
                completed ? hl7Date(a.endOn ?? a.onsetOn ?? '') || null : null,
              ),
            ) +
            el(
              'entryRelationship',
              { typeCode: 'SUBJ' },
              el(
                'observation',
                { classCode: 'OBS', moodCode: 'EVN' },
                tid(TPL.allergyObservation) +
                  observationId(a.id) +
                  el('code', {
                    code: '52473-6',
                    codeSystem: OID.loinc,
                    codeSystemName: 'LOINC',
                    displayName: 'Allergia o causa della reazione',
                  }) +
                  el('text', {}, ref(refId)) +
                  el('statusCode', { code: 'completed' }) +
                  el('effectiveTime', {}, lowHigh(a.onsetOn ? hl7Date(a.onsetOn) : null)) +
                  el('value', {
                    'xsi:type': 'CD',
                    code: a.type.code,
                    codeSystem: OID.actCode,
                    codeSystemName: 'ObservationIntoleranceType',
                    displayName: a.type.display,
                  }) +
                  el(
                    'participant',
                    { typeCode: 'CSM' },
                    el(
                      'participantRole',
                      { classCode: 'MANU' },
                      el('playingEntity', { classCode: 'MMAT' }, agent),
                    ),
                  ) +
                  (a.criticality
                    ? el(
                        'entryRelationship',
                        { typeCode: 'SUBJ', inversionInd: 'true' },
                        el(
                          'observation',
                          { classCode: 'OBS', moodCode: 'EVN' },
                          tid(TPL.criticality) +
                            el('code', {
                              code: 'SEV',
                              codeSystem: OID.actCode,
                              codeSystemName: 'ActCode',
                              displayName: 'Criticality',
                            }) +
                            el('text', {}, ref(refId)) +
                            el('statusCode', { code: 'completed' }) +
                            el('value', {
                              'xsi:type': 'CD',
                              code: a.criticality,
                              codeSystem: OID.observationValue,
                              codeSystemName: 'ObservationValue',
                              displayName: CRITICALITY[a.criticality],
                            }),
                        ),
                      )
                    : '') +
                  statusObservation(refId, a.status === 'active') +
                  (a.comment ? commentAct(refId) : ''),
              ),
            ),
        ),
      );
    })
    .join('');
  return section(
    'ALLERGIE_INTOLLERANZE',
    TPL.allergies,
    '48765-2',
    'Allergie, Reazioni Avverse',
    'Allergie e Intolleranze',
    table(['Agente', 'Tipo', 'Stato', 'Criticità', 'Reazione e note'], rows),
    entries,
  );
}

function therapiesSection(input: PssCdaInput['therapies'], doc: string): string {
  const title = 'Terapie farmacologiche';
  if (!Array.isArray(input)) {
    const refId = 'ter-assenza';
    const entry = el(
      'entry',
      {},
      el(
        'substanceAdministration',
        { classCode: 'SBADM', moodCode: 'EVN' },
        tid(TPL.medicationAbsent) +
          absenceId(doc, 'terapie-assenza') +
          el('code', {
            code: input.absent,
            codeSystem: OID.absentMedications,
            displayName: ABSENT_LABELS[input.absent],
          }) +
          el('text', {}, ref(refId)) +
          el('statusCode', { code: 'completed' }) +
          el('effectiveTime', { 'xsi:type': 'IVL_TS' }, lowHigh(null)) +
          el(
            'consumable',
            {},
            el(
              'manufacturedProduct',
              {},
              el('manufacturedMaterial', {}, el('code', { nullFlavor: 'NA' })),
            ),
          ),
      ),
    );
    return section(
      'TERAPIE_FARMACOLOGICHE',
      TPL.therapies,
      '10160-0',
      'HISTORY OF MEDICATION USE',
      title,
      el('paragraph', {}, el('content', { ID: refId }, xmlText(ABSENT_TEXT[input.absent]!))),
      entry,
    );
  }
  const rows = input.map((t, i) => ({
    id: `ter-${i + 1}`,
    cells: [
      t.drug.name,
      t.drug.aic ?? '',
      t.drug.atc ?? '',
      t.dosage ?? '',
      t.route.label ?? t.route.display,
      `dal ${itDate(t.startOn)}${t.endOn ? ` al ${itDate(t.endOn)}` : ''}`,
    ],
  }));
  const entries = input
    .map((t, i) => {
      const refId = `ter-${i + 1}`;
      const main = t.drug.aic
        ? {
            code: t.drug.aic,
            codeSystem: OID.aic,
            codeSystemName: 'AIC',
            displayName: t.drug.name,
          }
        : {
            code: t.drug.atc!,
            codeSystem: OID.atc,
            codeSystemName: 'ATC',
            displayName: t.drug.atcName ?? t.drug.name,
          };
      const translation =
        t.drug.aic && t.drug.atc
          ? el('translation', {
              code: t.drug.atc,
              codeSystem: OID.atc,
              codeSystemName: 'ATC',
              displayName: t.drug.atcName ?? t.drug.atc,
            })
          : '';
      return el(
        'entry',
        {},
        el(
          'substanceAdministration',
          { classCode: 'SBADM', moodCode: 'EVN' },
          tid(TPL.medication) +
            entryId(t.id) +
            el('text', {}, ref(refId)) +
            el('statusCode', { code: t.status }) +
            el(
              'effectiveTime',
              { 'xsi:type': 'IVL_TS' },
              lowHigh(
                hl7Date(t.startOn),
                t.status === 'completed' ? hl7Date(t.endOn ?? t.startOn) : null,
              ),
            ) +
            el('routeCode', {
              code: t.route.code,
              codeSystem: OID.route,
              codeSystemName: 'HL7 RouteOfAdministration',
              displayName: t.route.display,
            }) +
            el(
              'consumable',
              {},
              el(
                'manufacturedProduct',
                { classCode: 'MANU' },
                tid(TPL.medicationProduct) +
                  el(
                    'manufacturedMaterial',
                    {},
                    tid(TPL.medicationMaterial) +
                      el('code', main, el('originalText', {}, ref(refId)) + translation),
                  ),
              ),
            ),
        ),
      );
    })
    .join('');
  return section(
    'TERAPIE_FARMACOLOGICHE',
    TPL.therapies,
    '10160-0',
    'HISTORY OF MEDICATION USE',
    title,
    table(['Farmaco', 'AIC', 'ATC', 'Come si prende', 'Via', 'Periodo'], rows),
    entries,
  );
}

function problemsSection(input: PssCdaInput['problems'], doc: string): string {
  const title = 'Lista dei problemi';
  if (!Array.isArray(input)) {
    const refId = 'pro-assenza';
    const entry = el(
      'entry',
      {},
      el(
        'act',
        { classCode: 'ACT', moodCode: 'EVN' },
        tid(TPL.problemConcern) +
          absenceId(doc, 'problemi-assenza') +
          el('code', { nullFlavor: 'NA' }) +
          el('statusCode', { code: 'active' }) +
          el('effectiveTime', {}, lowHigh(null)) +
          el(
            'entryRelationship',
            { typeCode: 'SUBJ', inversionInd: 'false' },
            el(
              'observation',
              { classCode: 'OBS', moodCode: 'EVN' },
              tid(TPL.problemObservation) +
                absenceId(doc, 'problemi-assenza/osservazione') +
                el('code', {
                  code: '75326-9',
                  codeSystem: OID.loinc,
                  codeSystemName: 'LOINC',
                  displayName: 'Problem',
                }) +
                el('text', {}, ref(refId)) +
                el('statusCode', { code: 'completed' }) +
                el('effectiveTime', {}, lowHigh(null)) +
                el(
                  'value',
                  {
                    'xsi:type': 'CD',
                    code: input.absent,
                    codeSystem: OID.absentProblems,
                    displayName: ABSENT_LABELS[input.absent],
                  },
                  el('originalText', {}, ref(refId)),
                ),
            ),
          ),
      ),
    );
    return section(
      'LISTA_PROBLEMI',
      TPL.problems,
      '11450-4',
      'Lista dei Problemi',
      title,
      el('paragraph', {}, el('content', { ID: refId }, xmlText(ABSENT_TEXT[input.absent]!))),
      entry,
    );
  }
  const rows = input.map((p, i) => ({
    id: `pro-${i + 1}`,
    cells: [
      p.text,
      p.code.code,
      p.state === 'active' ? 'Attivo' : 'Risolto',
      p.chronic ? 'Cronico' : 'Acuto',
      p.onsetOn ? itDate(p.onsetOn) : '',
    ],
  }));
  const entries = input
    .map((p, i) => {
      const refId = `pro-${i + 1}`;
      const resolved = p.state === 'resolved';
      const low = p.onsetOn ? hl7Date(p.onsetOn) : null;
      const high = resolved ? hl7Date(p.resolvedOn ?? p.onsetOn ?? '') || null : null;
      return el(
        'entry',
        {},
        el(
          'act',
          { classCode: 'ACT', moodCode: 'EVN' },
          tid(TPL.problemConcern) +
            entryId(p.id) +
            el('code', { nullFlavor: 'NA' }) +
            el('statusCode', { code: resolved ? 'completed' : 'active' }) +
            el('effectiveTime', {}, lowHigh(low, high)) +
            el(
              'entryRelationship',
              { typeCode: 'SUBJ', inversionInd: 'false' },
              el(
                'observation',
                { classCode: 'OBS', moodCode: 'EVN' },
                tid(TPL.problemObservation) +
                  observationId(p.id) +
                  el('code', {
                    code: '75326-9',
                    codeSystem: OID.loinc,
                    codeSystemName: 'LOINC',
                    displayName: 'Problem',
                  }) +
                  el('text', {}, ref(refId)) +
                  el('statusCode', { code: 'completed' }) +
                  el('effectiveTime', {}, lowHigh(low, high)) +
                  el(
                    'value',
                    {
                      'xsi:type': 'CD',
                      code: p.code.code,
                      codeSystem: p.code.system === 'ICD9CM' ? OID.icd9 : OID.missingOrgans,
                      codeSystemName:
                        p.code.system === 'ICD9CM' ? 'ICD-9CM' : 'OrganiMancanti_ICD10_PSSIT',
                      displayName: p.code.display,
                    },
                    el('originalText', {}, ref(refId)),
                  ) +
                  statusObservation(refId, !resolved) +
                  el(
                    'entryRelationship',
                    { typeCode: 'REFR', inversionInd: 'false' },
                    el(
                      'observation',
                      { classCode: 'OBS', moodCode: 'EVN' },
                      tid(TPL.chronicity) +
                        el('code', {
                          code: '89261-2',
                          codeSystem: OID.loinc,
                          codeSystemName: 'LOINC',
                          displayName: 'Clinical Course',
                        }) +
                        el('text', {}, ref(refId)) +
                        el('statusCode', { code: 'completed' }) +
                        el('value', {
                          'xsi:type': 'CE',
                          code: p.chronic ? 'LA28752-6' : 'LA18821-1',
                          codeSystem: OID.chronicity,
                          displayName: p.chronic ? 'Chronic' : 'Acute',
                        }),
                    ),
                  ),
              ),
            ),
        ),
      );
    })
    .join('');
  return section(
    'LISTA_PROBLEMI',
    TPL.problems,
    '11450-4',
    'Lista dei Problemi',
    title,
    table(['Problema', 'Codice', 'Stato', 'Decorso', 'Dal'], rows),
    entries,
  );
}

function familySection(input: PssCdaInput['familyHistory'], doc: string): string {
  const title = 'Anamnesi familiare';
  if (!Array.isArray(input)) {
    const refId = 'fam-assenza';
    const entry = el(
      'entry',
      {},
      el(
        'observation',
        { classCode: 'OBS', moodCode: 'EVN' },
        tid(TPL.familyAbsent) +
          absenceId(doc, 'anamnesi-familiare-assenza') +
          el('code', {
            code: '10157-6',
            codeSystem: OID.loinc,
            codeSystemName: 'LOINC',
            displayName: 'Storia di malattie di membri familiari',
          }) +
          el('text', {}, ref(refId)) +
          el('statusCode', { code: 'completed' }) +
          el(
            'value',
            {
              'xsi:type': 'CD',
              code: input.absent,
              codeSystem: OID.absentProblems,
              displayName: ABSENT_LABELS[input.absent],
            },
            el('originalText', {}, ref(refId)),
          ),
      ),
    );
    return section(
      'ANAMNESI_FAMILIARE',
      TPL.family,
      '10157-6',
      'Storia di malattie di membri familiari',
      title,
      el('paragraph', {}, el('content', { ID: refId }, xmlText(ABSENT_TEXT[input.absent]!))),
      entry,
    );
  }
  const rows = input.map((f, i) => ({
    id: `fam-${i + 1}`,
    cells: [
      f.text,
      f.relative.display,
      f.code.code,
      f.onsetAge != null ? `${f.onsetAge} anni` : '',
    ],
  }));
  const entries = input
    .map((f, i) => {
      const refId = `fam-${i + 1}`;
      return el(
        'entry',
        {},
        el(
          'organizer',
          { classCode: 'CLUSTER', moodCode: 'EVN' },
          tid(TPL.familyOrganizer) +
            entryId(f.id) +
            el('code', {
              code: '10157-6',
              codeSystem: OID.loinc,
              codeSystemName: 'LOINC',
              displayName: 'Storia di malattie di membri familiari',
            }) +
            el('statusCode', { code: 'completed' }) +
            el(
              'subject',
              { typeCode: 'SBJ' },
              el(
                'relatedSubject',
                { classCode: 'PRS' },
                el('code', {
                  code: f.relative.code,
                  codeSystem: OID.roleCode,
                  codeSystemName: 'RoleCode',
                  displayName: f.relative.display,
                }) +
                  (f.relative.sex
                    ? el(
                        'subject',
                        {},
                        el('administrativeGenderCode', {
                          code: f.relative.sex,
                          codeSystem: OID.gender,
                          displayName: f.relative.sex === 'M' ? 'Maschio' : 'Femmina',
                        }),
                      )
                    : ''),
              ),
            ) +
            el(
              'component',
              {},
              el(
                'observation',
                { classCode: 'OBS', moodCode: 'EVN' },
                tid(TPL.familyObservation) +
                  observationId(f.id) +
                  el('code', {
                    code: '52797-8',
                    codeSystem: OID.loinc,
                    codeSystemName: 'LOINC',
                    displayName: 'Diagnosi codice ICD',
                  }) +
                  el('text', {}, ref(refId)) +
                  el('statusCode', { code: 'completed' }) +
                  el('effectiveTime', { nullFlavor: 'UNK' }) +
                  el(
                    'value',
                    {
                      'xsi:type': 'CD',
                      code: f.code.code,
                      codeSystem: OID.icd9,
                      codeSystemName: 'ICD-9CM',
                      displayName: f.code.display,
                    },
                    el('originalText', {}, ref(refId)),
                  ) +
                  (f.onsetAge != null
                    ? el(
                        'entryRelationship',
                        { typeCode: 'SUBJ' },
                        el(
                          'observation',
                          { classCode: 'OBS', moodCode: 'EVN' },
                          tid(TPL.familyAge) +
                            el('code', {
                              code: '35267-4',
                              codeSystem: OID.loinc,
                              codeSystemName: 'LOINC',
                              displayName: 'Età diagnosi patologia',
                            }) +
                            el('statusCode', { code: 'completed' }) +
                            el('value', { 'xsi:type': 'PQ', value: f.onsetAge, unit: 'a' }),
                        ),
                      )
                    : ''),
              ),
            ),
        ),
      );
    })
    .join('');
  return section(
    'ANAMNESI_FAMILIARE',
    TPL.family,
    '10157-6',
    'Storia di malattie di membri familiari',
    title,
    table(['Patologia', 'Parente', 'Codice', 'Età all’esordio'], rows),
    entries,
  );
}

function vitalsSection(input: CdaVital[]): string {
  if (!input.length) return '';
  const rows = input.map((v, i) => ({
    id: `par-${i + 1}`,
    cells: [v.label, `${v.value} ${unitLabel(v.unit)}`, itDate(v.measuredOn)],
  }));
  const entries = input
    .map((v, i) =>
      el(
        'entry',
        {},
        el(
          'observation',
          { classCode: 'OBS', moodCode: 'EVN' },
          tid(TPL.vitalObservation) +
            entryId(v.id) +
            el('code', {
              code: v.loinc,
              codeSystem: OID.loinc,
              codeSystemName: 'LOINC',
              displayName: v.label,
            }) +
            el('text', {}, ref(`par-${i + 1}`)) +
            el('statusCode', { code: 'completed' }) +
            el('effectiveTime', { value: hl7Date(v.measuredOn) }) +
            el('value', { 'xsi:type': 'PQ', value: v.value, unit: v.unit }),
        ),
      ),
    )
    .join('');
  return section(
    'PARAMETRI_VITALI',
    TPL.vitals,
    '8716-3',
    'Parametri vitali',
    'Parametri vitali',
    table(['Parametro', 'Valore', 'Data'], rows),
    entries,
  );
}

function lifestyleSection(input: CdaLifestyle[]): string {
  if (!input.length) return '';
  const rows = input.map((l, i) => ({
    id: `sti-${i + 1}`,
    cells: [l.label, l.text, itDate(l.recordedOn)],
  }));
  const entries = input
    .map((l, i) => {
      const refId = `sti-${i + 1}`;
      return el(
        'entry',
        {},
        el(
          'observation',
          { classCode: 'OBS', moodCode: 'EVN' },
          tid(TPL.lifestyleObservation) +
            entryId(l.id) +
            el('code', {
              code: l.loinc,
              codeSystem: OID.loinc,
              codeSystemName: 'LOINC',
              displayName: l.label,
            }) +
            el('text', {}, ref(refId)) +
            el('statusCode', { code: 'completed' }) +
            el('effectiveTime', { value: hl7Date(l.recordedOn) }) +
            el(
              'value',
              { 'xsi:type': 'CD', nullFlavor: 'OTH' },
              el('originalText', {}, ref(refId)),
            ),
        ),
      );
    })
    .join('');
  return section(
    'STILE_DI_VITA',
    TPL.lifestyle,
    '29762-2',
    'Stile di vita',
    'Stili di vita',
    table(['Fattore', 'Che cosa', 'Data'], rows),
    entries,
  );
}

function functionalSection(input: PssCdaInput['motorCapacity']): string {
  if (!input) return '';
  const refId = 'fun-1';
  const entry = el(
    'entry',
    { typeCode: 'DRIV' },
    el(
      'organizer',
      { classCode: 'BATTERY', moodCode: 'EVN' },
      tid(TPL.functionalOrganizer) +
        el('statusCode', { code: 'completed' }) +
        el(
          'component',
          {},
          el(
            'observation',
            { classCode: 'OBS', moodCode: 'EVN' },
            tid(TPL.motorCapacity) +
              el('code', {
                code: '75246-9',
                codeSystem: OID.loinc,
                codeSystemName: 'LOINC',
                displayName: 'Activity',
              }) +
              el('text', {}, ref(refId)) +
              el('statusCode', { code: 'completed' }) +
              el('effectiveTime', {}, el('low', { value: hl7Date(input.since) })) +
              el('value', {
                'xsi:type': 'CD',
                code: input.code,
                codeSystem: OID.motorCapacity,
                codeSystemName: 'CapacitàMotoria_PSSIT',
                displayName: input.display,
              }),
          ),
        ),
    ),
  );
  return section(
    'STATO_FUNZIONALE_PAZIENTE',
    TPL.functional,
    '47420-5',
    'Nota di valutazione dello stato funzionale',
    'Stato funzionale del paziente',
    el(
      'paragraph',
      {},
      el(
        'content',
        { ID: refId },
        xmlText(`Capacità motoria: ${input.display} (dal ${input.since}).`),
      ),
    ),
    entry,
  );
}

/* ------------------------------------------------------------------------------------------ */

/** Il documento CDA2 del Profilo Sanitario Sintetico, come testo XML. */
export function buildPssCda(input: PssCdaInput): string {
  const { document: d, patient: p, author: a } = input;
  const docKey = `${d.id.root}^${d.id.extension}`;
  const patientAddress = completeAddress(p.address);
  const header =
    el('realmCode', { code: 'IT' }) +
    el('typeId', { root: '2.16.840.1.113883.1.3', extension: 'POCD_MT000040UV02' }) +
    el('templateId', {
      root: TPL.document,
      extension: PSS_TEMPLATE_VERSION,
      assigningAuthorityName: 'HL7 Italia',
    }) +
    el('id', { root: d.id.root, extension: d.id.extension }) +
    el('code', {
      code: PSS_LOINC,
      codeSystem: OID.loinc,
      codeSystemName: 'LOINC',
      displayName: 'Profilo Sanitario Sintetico',
    }) +
    el('title', {}, 'Profilo Sanitario Sintetico') +
    el('effectiveTime', { value: hl7Time(d.createdAt) }) +
    el('confidentialityCode', {
      code: d.confidentiality,
      codeSystem: OID.confidentiality,
      codeSystemName: 'HL7 Confidentiality',
    }) +
    el('languageCode', { code: 'it-IT' }) +
    el('setId', { root: d.setId.root, extension: d.setId.extension }) +
    el('versionNumber', { value: d.version }) +
    el(
      'recordTarget',
      {},
      el(
        'patientRole',
        {},
        cfId(p.fiscalCode) +
          (patientAddress ? addr(patientAddress, 'H') : '') +
          el(
            'patient',
            {},
            name(p) +
              el('administrativeGenderCode', {
                code: p.sex,
                codeSystem: OID.gender,
                codeSystemName: 'HL7 AdministrativeGender',
                displayName: p.sex === 'M' ? 'Maschio' : 'Femmina',
              }) +
              el('birthTime', { value: hl7Date(p.birthDate) }) +
              (p.birthPlace
                ? el(
                    'birthplace',
                    {},
                    el(
                      'place',
                      {},
                      el(
                        'addr',
                        {},
                        el('country', {}, '100') +
                          (p.birthPlace.province
                            ? el('county', {}, xmlText(p.birthPlace.province))
                            : '') +
                          el('city', {}, xmlText(p.birthPlace.city)) +
                          el('censusTract', {}, xmlText(p.birthPlace.istatCode)),
                      ),
                    ),
                  )
                : ''),
          ),
      ),
    ) +
    el(
      'author',
      {},
      el('time', { value: hl7Time(a.time) }) +
        el(
          'assignedAuthor',
          {},
          cfId(a.fiscalCode) +
            el('code', {
              code: 'MMG',
              codeSystem: OID.authorCode,
              codeSystemName: 'assignedAuthorCode_PSSIT',
              displayName: 'Medico di Medicina Generale',
            }) +
            telecoms(a.telecoms) +
            el('assignedPerson', {}, name(a, a.prefix)),
        ),
    ) +
    el(
      'custodian',
      {},
      el(
        'assignedCustodian',
        {},
        el(
          'representedCustodianOrganization',
          {},
          el('id', { root: input.custodian.id.root, extension: input.custodian.id.extension }) +
            el('name', {}, xmlText(input.custodian.name)) +
            // L'uso dell'indirizzo lo vuole la guida v1.5 (D281); il Ministero non lo vincola.
            addr(input.custodian.address, 'WP'),
        ),
      ),
    ) +
    el(
      'legalAuthenticator',
      {},
      el('time', { value: hl7Time(input.legalAuthenticatorTime) }) +
        el('signatureCode', { code: 'S' }) +
        el(
          'assignedEntity',
          {},
          cfId(a.fiscalCode) + telecoms(a.telecoms) + el('assignedPerson', {}, name(a, a.prefix)),
        ),
    ) +
    el(
      'documentationOf',
      {},
      el('serviceEvent', {}, el('effectiveTime', { value: hl7Time(input.serviceTime) })),
    ) +
    (d.replaces
      ? el(
          'relatedDocument',
          { typeCode: 'RPLC' },
          el(
            'parentDocument',
            {},
            el('id', { root: d.replaces.root, extension: d.replaces.extension }),
          ),
        )
      : '');
  const body =
    allergiesSection(input.allergies, docKey) +
    therapiesSection(input.therapies, docKey) +
    problemsSection(input.problems, docKey) +
    familySection(input.familyHistory, docKey) +
    vitalsSection(input.vitals) +
    lifestyleSection(input.lifestyle) +
    functionalSection(input.motorCapacity);
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    `<ClinicalDocument xmlns="urn:hl7-org:v3" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    header +
    el('component', {}, el('structuredBody', {}, body)) +
    '</ClinicalDocument>'
  );
}
