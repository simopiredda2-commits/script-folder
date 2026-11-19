import {
  ANAMNESIS_LABELS,
  ANAMNESIS_SECTIONS,
  CONTACT_LABELS,
  CONTACT_TYPES,
  MEASURES,
} from './clinical';
import { PATIENT_STATUSES, REMINDER_CHANNELS } from './patient-registry';
import {
  ALLERGY_AGENT_LABELS,
  ALLERGY_AGENTS,
  MOTOR_CAPACITIES,
  PROBLEM_CATEGORIES,
  PROBLEM_CATEGORY_LABELS,
  RELATIVES,
} from './pss';

/**
 * Destinazioni dell'importazione da altri programmi (tappa 15): i menu della cartella in cui
 * possono andare i dati di un file, con i campi di ciascuno. È il catalogo che il medico vede
 * quando smista le colonne del suo file. I controlli veri sono quelli dell'inserimento a mano
 * (`apps/api/src/import/destinations.ts` li chiama): qui ci sono nomi, tipi, obbligatori e i
 * nomi di colonna più comuni, solo per suggerire. Un suggerimento non decide mai da solo.
 *
 * Il programma d'origine non si nomina e non si analizza (regola 2, D142, D147): i sinonimi sono
 * parole generiche dell'italiano e dell'inglese, non intestazioni prese da un altro programma.
 */

/** Tipo del valore di un campo: decide la trasformazione proposta. */
export type ImportFieldKind =
  'text' | 'date' | 'number' | 'integer' | 'boolean' | 'choice' | 'fiscalCode' | 'code';

export interface ImportChoice {
  key: string;
  label: string;
  /** Altri modi comuni di scrivere lo stesso valore (oltre a chiave ed etichetta). */
  aliases?: readonly string[];
}

export interface ImportField {
  /** Nome del campo come nelle API (italiano). */
  key: string;
  label: string;
  kind: ImportFieldKind;
  required?: boolean;
  /** Lunghezza massima dei testi, come nel validatore. */
  max?: number;
  /** Valori ammessi (per `choice`). */
  choices?: readonly ImportChoice[];
  /** Codici numerici a lunghezza fissa: zeri iniziali persi da un foglio di calcolo (AIC, CAP). */
  digits?: number;
  /** Nomi di colonna frequenti, già normalizzati (`normalizeHeaderName`). */
  synonyms: readonly string[];
  hint?: string;
}

export const IMPORT_DESTINATION_KEYS = [
  'pazienti',
  'esenzioni',
  'problemi',
  'allergie',
  'diario',
  'anamnesi',
  'stili_di_vita',
  'esame_obiettivo',
  'capacita_motoria',
  'parametri',
  'vaccinazioni',
  'esami_laboratorio',
  'terapie',
  'ricette_passate',
] as const;
export type ImportDestinationKey = (typeof IMPORT_DESTINATION_KEYS)[number];

export interface ImportDestination {
  key: ImportDestinationKey;
  label: string;
  /** Dove compaiono i dati nella cartella. */
  menu: string;
  /** Ordine di scrittura: prima i pazienti, poi i problemi (indicazioni), poi il resto. */
  order: number;
  fields: readonly ImportField[];
  /**
   * Campi che riconoscono la stessa voce in due importazioni, quando il file non ha un
   * identificativo d'origine (insieme al codice fiscale del paziente).
   */
  naturalKey: readonly string[];
  /** Spiegazione breve per il medico. */
  notes: string;
}

/** Nome di colonna confrontabile: minuscolo, senza accenti, solo lettere e cifre. */
export function normalizeHeaderName(header: string): string {
  return header
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

const choicesOf = <K extends string>(keys: readonly K[], labels: Record<K, string>) =>
  keys.map((key) => ({ key, label: labels[key] }));

/** Codice fiscale del paziente: la chiave dell'abbinamento in ogni destinazione. */
const patientKey: ImportField = {
  key: 'codiceFiscale',
  label: 'Codice fiscale del paziente',
  kind: 'fiscalCode',
  required: true,
  synonyms: ['codicefiscale', 'cf', 'codfisc', 'codfiscale', 'codicefiscalepaziente', 'fiscalcode'],
  hint: 'Abbina la riga al paziente dell’archivio: il paziente dev’esserci già o arrivare nella stessa importazione.',
};

/** Identificativo della riga nel programma d'origine, se il file lo ha: evita i doppioni. */
const sourceId: ImportField = {
  key: 'idOrigine',
  label: 'Identificativo nel programma d’origine',
  kind: 'text',
  max: 100,
  synonyms: ['id', 'idorigine', 'identificativo', 'codiceinterno', 'progressivo'],
  hint: 'Facoltativo. Se c’è, una seconda importazione dello stesso dato non lo duplica anche se il testo è cambiato.',
};

const yesNo = (key: string, label: string, synonyms: string[], hint?: string): ImportField => ({
  key,
  label,
  kind: 'boolean',
  synonyms,
  ...(hint ? { hint } : {}),
});

const entryDate: ImportField = {
  key: 'data',
  label: 'Data della voce',
  kind: 'date',
  required: true,
  synonyms: ['data', 'datavoce', 'datavisita', 'dataregistrazione', 'del', 'date'],
  hint: 'La data clinica del file. Una riga senza data non entra: non prende la data dell’importazione.',
};

/** Campi comuni delle voci cliniche (newEntryBody): note, riservata, oscurata. */
const entryCommon: ImportField[] = [
  {
    key: 'note',
    label: 'Note',
    kind: 'text',
    max: 2000,
    synonyms: ['note', 'annotazioni', 'notes'],
  },
  yesNo('riservata', 'Riservata (visibile solo al medico)', ['riservata', 'riservato']),
  yesNo(
    'oscurata',
    'Oscurata su richiesta del paziente',
    ['oscurata', 'oscurato', 'oscuramento'],
    'Non va nel Fascicolo né ai colleghi dell’AFT (D116).',
  ),
];

const SEX_CHOICES = [
  { key: 'M', label: 'Maschile', aliases: ['maschio', 'uomo'] },
  { key: 'F', label: 'Femminile', aliases: ['femmina', 'donna'] },
] as const;

export const IMPORT_DESTINATIONS: readonly ImportDestination[] = [
  {
    key: 'pazienti',
    label: 'Pazienti: anagrafica e dati amministrativi',
    menu: 'Pannello amministrativo del paziente (anagrafica, dati SSN, recapiti, lavoro, stato, promemoria)',
    order: 1,
    naturalKey: ['codiceFiscale'],
    notes:
      'Un paziente nuovo entra nell’archivio del titolare. Se c’è già (stesso codice fiscale), si completano solo i campi vuoti: nulla di quanto c’è in cartella viene sovrascritto.',
    fields: [
      { ...patientKey, label: 'Codice fiscale', hint: undefined },
      {
        key: 'cognome',
        label: 'Cognome',
        kind: 'text',
        required: true,
        max: 100,
        synonyms: ['cognome', 'surname', 'lastname'],
      },
      {
        key: 'nome',
        label: 'Nome',
        kind: 'text',
        required: true,
        max: 100,
        synonyms: ['nome', 'name', 'firstname'],
      },
      {
        key: 'sesso',
        label: 'Sesso',
        kind: 'choice',
        required: true,
        choices: SEX_CHOICES,
        synonyms: ['sesso', 'sex', 'genere'],
      },
      {
        key: 'nascita',
        label: 'Data di nascita',
        kind: 'date',
        required: true,
        synonyms: ['datanascita', 'datadinascita', 'nascita', 'natoil', 'birthdate', 'dob'],
      },
      {
        key: 'luogoNascitaCodice',
        label: 'Codice catastale del luogo di nascita',
        kind: 'code',
        synonyms: ['codicecatastale', 'codicecomunenascita', 'belfiore', 'codiceluogonascita'],
      },
      {
        key: 'luogoNascita',
        label: 'Luogo di nascita',
        kind: 'text',
        max: 100,
        synonyms: ['luogonascita', 'luogodinascita', 'comunenascita', 'comunedinascita', 'natoa'],
      },
      {
        key: 'telefono',
        label: 'Telefono',
        kind: 'text',
        max: 40,
        synonyms: ['telefono', 'tel', 'cellulare', 'cell', 'phone', 'recapitotelefonico'],
      },
      { key: 'email', label: 'Email', kind: 'text', synonyms: ['email', 'mail', 'posta'] },
      {
        key: 'residenzaVia',
        label: 'Residenza: via',
        kind: 'text',
        max: 200,
        synonyms: ['indirizzo', 'via', 'indirizzoresidenza', 'residenza'],
      },
      {
        key: 'residenzaCivico',
        label: 'Residenza: numero civico',
        kind: 'text',
        max: 20,
        synonyms: ['civico', 'numerocivico', 'ncivico', 'num'],
      },
      {
        key: 'residenzaCap',
        label: 'Residenza: CAP',
        kind: 'code',
        digits: 5,
        synonyms: ['cap', 'capresidenza', 'codicepostale'],
      },
      {
        key: 'residenzaComune',
        label: 'Residenza: comune',
        kind: 'text',
        max: 100,
        synonyms: ['comune', 'comuneresidenza', 'citta', 'localita'],
      },
      {
        key: 'residenzaProvincia',
        label: 'Residenza: provincia (sigla)',
        kind: 'code',
        synonyms: ['provincia', 'prov', 'pr', 'provinciaresidenza'],
      },
      {
        key: 'domicilio',
        label: 'Domicilio, se diverso',
        kind: 'text',
        max: 300,
        synonyms: ['domicilio', 'indirizzodomicilio'],
      },
      { key: 'asl', label: 'ASL', kind: 'text', max: 100, synonyms: ['asl', 'aslassistenza'] },
      { key: 'distretto', label: 'Distretto', kind: 'text', max: 100, synonyms: ['distretto'] },
      {
        key: 'tipoAssistenza',
        label: 'Tipo di assistenza',
        kind: 'text',
        max: 100,
        synonyms: ['tipoassistenza', 'assistenza', 'tipologiaassistito'],
      },
      {
        key: 'stato',
        label: 'Stato del paziente',
        kind: 'choice',
        choices: PATIENT_STATUSES.map((s) => ({ key: s.key, label: s.label })),
        synonyms: ['stato', 'statopaziente', 'status'],
      },
      {
        key: 'decedutoIl',
        label: 'Data del decesso',
        kind: 'date',
        synonyms: ['datadecesso', 'decedutoil', 'decesso'],
      },
      {
        key: 'causaDecesso',
        label: 'Causa del decesso (ICD-9-CM)',
        kind: 'code',
        synonyms: ['causadecesso'],
      },
      {
        key: 'tesseraTeam',
        label: 'Tessera europea (TEAM)',
        kind: 'text',
        max: 40,
        synonyms: ['team', 'tesseraeuropea', 'tesserateam'],
      },
      {
        key: 'enteEstero',
        label: 'Ente estero',
        kind: 'text',
        max: 200,
        synonyms: ['enteestero', 'istituzioneestera'],
      },
      {
        key: 'professione',
        label: 'Professione',
        kind: 'text',
        max: 200,
        synonyms: ['professione', 'occupazione', 'lavoro', 'occupation'],
      },
      {
        key: 'condizioneProfessionale',
        label: 'Condizione professionale',
        kind: 'text',
        max: 100,
        synonyms: ['condizioneprofessionale'],
      },
      {
        key: 'emailDatoreLavoro',
        label: 'Email del datore di lavoro',
        kind: 'text',
        synonyms: ['emaildatore', 'emaildatoredilavoro', 'maildatore'],
      },
      {
        key: 'canalePromemoria',
        label: 'Canale del promemoria della ricetta',
        kind: 'choice',
        choices: REMINDER_CHANNELS.map((c) => ({ key: c.key, label: c.label })),
        synonyms: ['canalepromemoria', 'canale'],
      },
      {
        key: 'recapitoPromemoria',
        label: 'Recapito per il promemoria',
        kind: 'text',
        max: 200,
        synonyms: ['recapitopromemoria'],
      },
      {
        key: 'canaleSceltoIl',
        label: 'Data della scelta del canale',
        kind: 'date',
        synonyms: ['canalesceltoil', 'datasceltacanale'],
      },
    ],
  },
  {
    key: 'esenzioni',
    label: 'Esenzioni',
    menu: 'Pannello amministrativo del paziente › Esenzioni',
    order: 2,
    naturalKey: ['codice', 'dal'],
    notes:
      'Un’esenzione importata vale subito nei controlli delle ricette (R9, R17): controlla codici e date.',
    fields: [
      patientKey,
      {
        key: 'codice',
        label: 'Codice dell’esenzione',
        kind: 'code',
        required: true,
        synonyms: ['codice', 'codiceesenzione', 'esenzione', 'codesenzione'],
      },
      {
        key: 'dal',
        label: 'Valida dal',
        kind: 'date',
        required: true,
        synonyms: ['dal', 'datainizio', 'inizio', 'validadal', 'inizioval'],
      },
      {
        key: 'al',
        label: 'Valida fino al',
        kind: 'date',
        synonyms: ['al', 'datafine', 'fine', 'scadenza', 'validafinoal'],
      },
      {
        key: 'codiceRicetta',
        label: 'Codice da riportare in ricetta',
        kind: 'code',
        synonyms: ['codicericetta', 'codiceinricetta'],
      },
      sourceId,
    ],
  },
  {
    key: 'problemi',
    label: 'Problemi e diagnosi',
    menu: 'Patologie › Problemi e diagnosi',
    order: 3,
    naturalKey: ['data', 'descrizione', 'codice'],
    notes:
      'Il codice si controlla nel formato ICD-9-CM (es. 401.9, 250.00, V17.3): codici senza punto o di altre classificazioni non passano.',
    fields: [
      patientKey,
      entryDate,
      {
        key: 'descrizione',
        label: 'Descrizione',
        kind: 'text',
        required: true,
        max: 300,
        synonyms: ['descrizione', 'diagnosi', 'problema', 'patologia', 'description'],
      },
      {
        key: 'codice',
        label: 'Codice ICD-9-CM',
        kind: 'code',
        synonyms: ['codice', 'icd', 'icd9', 'icd9cm', 'codicediagnosi', 'codiceicd'],
      },
      {
        key: 'stato',
        label: 'Stato',
        kind: 'choice',
        choices: [
          { key: 'attivo', label: 'Attivo' },
          { key: 'risolto', label: 'Risolto' },
        ],
        synonyms: ['stato', 'statoproblema'],
      },
      {
        key: 'dal',
        label: 'Inizio del problema',
        kind: 'date',
        synonyms: ['dal', 'datainizio', 'insorgenza', 'esordio'],
      },
      {
        key: 'risoltoIl',
        label: 'Data di risoluzione',
        kind: 'date',
        synonyms: ['risoltoil', 'datarisoluzione', 'datafine', 'al'],
      },
      yesNo('quesitoAperto', 'Quesito diagnostico aperto', [
        'quesito',
        'quesitoaperto',
        'sospetto',
      ]),
      yesNo('cronico', 'Patologia cronica', ['cronico', 'cronica', 'cronicita']),
      {
        key: 'categoria',
        label: 'Categoria',
        kind: 'choice',
        choices: choicesOf(PROBLEM_CATEGORIES, PROBLEM_CATEGORY_LABELS),
        synonyms: ['categoria'],
      },
      ...entryCommon,
      sourceId,
    ],
  },
  {
    key: 'allergie',
    label: 'Allergie e reazioni avverse',
    menu: 'Cartella › Allergie e reazioni avverse (anche in testata)',
    order: 4,
    naturalKey: ['sostanza', 'codiceAgente'],
    notes:
      'Le allergie compaiono subito nella testata della cartella. Un’allergia non più attiva si importa come tale.',
    fields: [
      patientKey,
      entryDate,
      {
        key: 'sostanza',
        label: 'Sostanza o agente',
        kind: 'text',
        required: true,
        max: 200,
        synonyms: ['sostanza', 'allergene', 'agente', 'allergia', 'principioattivo'],
      },
      {
        key: 'reazione',
        label: 'Reazione',
        kind: 'text',
        max: 500,
        synonyms: ['reazione', 'manifestazione', 'sintomi'],
      },
      yesNo('daFarmaco', 'Da farmaco', ['dafarmaco', 'farmaco']),
      {
        key: 'natura',
        label: 'Allergia o intolleranza',
        kind: 'choice',
        choices: [
          { key: 'allergia', label: 'Allergia' },
          { key: 'intolleranza', label: 'Intolleranza' },
        ],
        synonyms: ['natura', 'tipo', 'tipoallergia'],
      },
      {
        key: 'agente',
        label: 'Tipo di agente',
        kind: 'choice',
        choices: choicesOf(ALLERGY_AGENTS, ALLERGY_AGENT_LABELS),
        synonyms: ['tipoagente', 'categoriaagente'],
      },
      {
        key: 'codiceAgente',
        label: 'Codice dell’agente (AIC, ATC o allergene)',
        kind: 'code',
        synonyms: ['codiceagente', 'codiceallergene', 'aic', 'atc'],
      },
      {
        key: 'criticita',
        label: 'Criticità',
        kind: 'choice',
        choices: [
          { key: 'bassa', label: 'Bassa' },
          { key: 'moderata', label: 'Moderata' },
          { key: 'alta', label: 'Alta' },
        ],
        synonyms: ['criticita', 'gravita'],
      },
      yesNo('attiva', 'Ancora attiva', ['attiva', 'attivo'], 'Se vuoto, l’allergia è attiva.'),
      ...entryCommon,
      sourceId,
    ],
  },
  {
    key: 'diario',
    label: 'Diario clinico',
    menu: 'Storia clinica › Diario clinico',
    order: 5,
    naturalKey: ['data', 'contatto', 'testo'],
    notes:
      'Ogni nota ha il suo tipo di contatto: se il file non lo dice, scegline uno valido per tutte le righe.',
    fields: [
      patientKey,
      entryDate,
      {
        key: 'contatto',
        label: 'Tipo di contatto',
        kind: 'choice',
        required: true,
        choices: choicesOf(CONTACT_TYPES, CONTACT_LABELS),
        synonyms: ['contatto', 'tipocontatto', 'tipovisita', 'modalita'],
      },
      {
        key: 'testo',
        label: 'Testo della nota',
        kind: 'text',
        required: true,
        max: 10000,
        synonyms: ['testo', 'nota', 'diario', 'descrizione', 'contenuto', 'text'],
      },
      ...entryCommon,
      sourceId,
    ],
  },
  {
    key: 'anamnesi',
    label: 'Anamnesi',
    menu: 'Storia clinica › Anamnesi',
    order: 6,
    naturalKey: ['data', 'sezione', 'testo'],
    notes: 'Parente, codice ed età all’esordio valgono solo per l’anamnesi familiare.',
    fields: [
      patientKey,
      entryDate,
      {
        key: 'sezione',
        label: 'Sezione',
        kind: 'choice',
        required: true,
        choices: choicesOf(ANAMNESIS_SECTIONS, ANAMNESIS_LABELS),
        synonyms: ['sezione', 'tipoanamnesi', 'tipo'],
      },
      {
        key: 'testo',
        label: 'Testo',
        kind: 'text',
        required: true,
        max: 5000,
        synonyms: ['testo', 'anamnesi', 'descrizione', 'contenuto'],
      },
      {
        key: 'parente',
        label: 'Parente',
        kind: 'choice',
        choices: RELATIVES.map((r) => ({ key: r.key, label: r.label })),
        synonyms: ['parente', 'familiare', 'grado'],
      },
      {
        key: 'codice',
        label: 'Codice ICD-9-CM della patologia',
        kind: 'code',
        synonyms: ['codice', 'icd', 'icd9'],
      },
      {
        key: 'etaEsordio',
        label: 'Età all’esordio',
        kind: 'integer',
        synonyms: ['etaesordio', 'eta'],
      },
      ...entryCommon,
      sourceId,
    ],
  },
  {
    key: 'stili_di_vita',
    label: 'Stili di vita e fattori di rischio',
    menu: 'Storia clinica › Stili di vita',
    order: 7,
    naturalKey: ['data', 'fattore', 'valore'],
    notes: 'Il Profilo sanitario riconosce fumo, alcol e attività fisica.',
    fields: [
      patientKey,
      entryDate,
      {
        key: 'fattore',
        label: 'Fattore',
        kind: 'text',
        required: true,
        max: 100,
        synonyms: ['fattore', 'fattorerischio', 'stiledivita', 'abitudine'],
      },
      {
        key: 'valore',
        label: 'Valore',
        kind: 'text',
        required: true,
        max: 300,
        synonyms: ['valore', 'descrizione', 'quantita'],
      },
      ...entryCommon,
      sourceId,
    ],
  },
  {
    key: 'esame_obiettivo',
    label: 'Esame obiettivo e valutazioni',
    menu: 'Storia clinica › Esame obiettivo',
    order: 8,
    naturalKey: ['data', 'testo'],
    notes: 'Una scheda di valutazione entra come testo, con il nome della scala e il punteggio.',
    fields: [
      patientKey,
      entryDate,
      {
        key: 'testo',
        label: 'Testo',
        kind: 'text',
        required: true,
        max: 5000,
        synonyms: ['testo', 'esameobiettivo', 'eo', 'descrizione'],
      },
      {
        key: 'scala',
        label: 'Scala o scheda',
        kind: 'text',
        max: 100,
        synonyms: ['scala', 'scheda'],
      },
      {
        key: 'punteggio',
        label: 'Punteggio',
        kind: 'text',
        max: 50,
        synonyms: ['punteggio', 'score'],
      },
      ...entryCommon,
      sourceId,
    ],
  },
  {
    key: 'capacita_motoria',
    label: 'Capacità motoria',
    menu: 'Storia clinica › Capacità motoria',
    order: 9,
    naturalKey: ['data', 'capacita'],
    notes: 'Valori del dizionario ufficiale del Profilo sanitario.',
    fields: [
      patientKey,
      entryDate,
      {
        key: 'capacita',
        label: 'Capacità motoria',
        kind: 'choice',
        required: true,
        choices: MOTOR_CAPACITIES.map((m) => ({ key: m.key, label: m.label })),
        synonyms: ['capacita', 'capacitamotoria', 'autonomia', 'deambulazione'],
      },
      ...entryCommon,
      sourceId,
    ],
  },
  {
    key: 'parametri',
    label: 'Parametri e misure',
    menu: 'Cartella › Parametri',
    order: 10,
    naturalKey: ['data', 'parametro', 'valore'],
    notes:
      'Due modi: una colonna «parametro» e una «valore», oppure una colonna per ogni parametro (una voce per cella piena). Le unità sono quelle della cartella.',
    fields: [
      patientKey,
      entryDate,
      {
        key: 'parametro',
        label: 'Parametro (se in una colonna)',
        kind: 'choice',
        choices: MEASURES.map((m) => ({ key: m.key, label: `${m.label} (${m.unit})` })),
        synonyms: ['parametro', 'misura', 'tipoparametro'],
      },
      {
        key: 'valore',
        label: 'Valore (insieme a «Parametro»)',
        kind: 'number',
        synonyms: ['valore', 'risultato', 'value'],
      },
      ...MEASURES.map((m): ImportField => ({
        key: `valore_${m.key}`,
        label: `${m.label} (${m.unit})`,
        kind: 'number',
        synonyms: [normalizeHeaderName(m.label), normalizeHeaderName(m.key)],
      })),
      ...entryCommon,
      sourceId,
    ],
  },
  {
    key: 'vaccinazioni',
    label: 'Vaccinazioni',
    menu: 'Storia clinica › Vaccinazioni (in cronologia)',
    order: 11,
    naturalKey: ['data', 'vaccino', 'lotto'],
    notes: 'Data di somministrazione, vaccino, lotto e dose.',
    fields: [
      patientKey,
      { ...entryDate, label: 'Data di somministrazione' },
      {
        key: 'vaccino',
        label: 'Vaccino',
        kind: 'text',
        required: true,
        max: 200,
        synonyms: ['vaccino', 'vaccinazione', 'nomevaccino'],
      },
      { key: 'lotto', label: 'Lotto', kind: 'text', max: 50, synonyms: ['lotto', 'lot'] },
      {
        key: 'dose',
        label: 'Numero della dose',
        kind: 'integer',
        synonyms: ['dose', 'numerodose', 'ndose'],
      },
      {
        key: 'campagna',
        label: 'Campagna',
        kind: 'text',
        max: 100,
        synonyms: ['campagna', 'stagione'],
      },
      ...entryCommon,
      sourceId,
    ],
  },
  {
    key: 'esami_laboratorio',
    label: 'Esami di laboratorio',
    menu: 'Cartella › Esami',
    order: 12,
    naturalKey: ['data', 'analita', 'valore'],
    notes: 'Un risultato per riga: analita, valore e unità come nel referto.',
    fields: [
      patientKey,
      { ...entryDate, label: 'Data del prelievo o del referto' },
      {
        key: 'analita',
        label: 'Analita',
        kind: 'text',
        required: true,
        max: 200,
        synonyms: ['analita', 'esame', 'parametro', 'test'],
      },
      {
        key: 'valore',
        label: 'Valore',
        kind: 'text',
        required: true,
        max: 50,
        synonyms: ['valore', 'risultato', 'esito'],
      },
      { key: 'unita', label: 'Unità di misura', kind: 'text', max: 30, synonyms: ['unita', 'um'] },
      {
        key: 'minimo',
        label: 'Limite inferiore di riferimento',
        kind: 'text',
        max: 20,
        synonyms: ['minimo', 'min', 'limiteinferiore'],
      },
      {
        key: 'massimo',
        label: 'Limite superiore di riferimento',
        kind: 'text',
        max: 20,
        synonyms: ['massimo', 'max', 'limitesuperiore'],
      },
      {
        key: 'riferimento',
        label: 'Valori di riferimento (testo)',
        kind: 'text',
        max: 200,
        synonyms: ['riferimento', 'valoririferimento', 'range'],
      },
      {
        key: 'codicePrestazione',
        label: 'Codice della prestazione',
        kind: 'code',
        synonyms: ['codiceprestazione', 'codicenomenclatore'],
      },
      ...entryCommon,
      sourceId,
    ],
  },
  {
    key: 'terapie',
    label: 'Farmaci in terapia',
    menu: 'Farmaci › Terapie (in corso, concluse o sospese)',
    order: 13,
    naturalKey: ['farmaco', 'aic', 'inizio'],
    notes:
      'La scheda della terapia con gli stessi controlli dell’inserimento a mano. Le terapie concluse entrano come concluse, con la data di fine.',
    fields: [
      patientKey,
      {
        key: 'farmaco',
        label: 'Farmaco (nome e confezione)',
        kind: 'text',
        required: true,
        max: 300,
        synonyms: ['farmaco', 'nomefarmaco', 'specialita', 'denominazione', 'drug'],
      },
      {
        key: 'aic',
        label: 'AIC (9 cifre)',
        kind: 'code',
        digits: 9,
        synonyms: ['aic', 'codiceaic', 'minsan'],
      },
      {
        key: 'principioAttivo',
        label: 'Principio attivo',
        kind: 'text',
        max: 300,
        synonyms: ['principioattivo', 'principio', 'molecola'],
      },
      { key: 'atc', label: 'ATC', kind: 'code', synonyms: ['atc', 'codiceatc'] },
      {
        key: 'tipo',
        label: 'Tipo di terapia',
        kind: 'choice',
        required: true,
        choices: [
          { key: 'cronica', label: 'Cronica' },
          { key: 'al_bisogno', label: 'Al bisogno' },
          { key: 'ciclo', label: 'Ciclo con data di fine' },
        ],
        synonyms: ['tipo', 'tipoterapia', 'cronica'],
      },
      {
        key: 'inizio',
        label: 'Inizio',
        kind: 'date',
        required: true,
        synonyms: ['inizio', 'datainizio', 'dal'],
      },
      { key: 'fine', label: 'Fine', kind: 'date', synonyms: ['fine', 'datafine', 'al'] },
      {
        key: 'stato',
        label: 'Stato',
        kind: 'choice',
        choices: [
          { key: 'in_corso', label: 'In corso' },
          { key: 'conclusa', label: 'Conclusa' },
          { key: 'sospesa', label: 'Sospesa' },
        ],
        synonyms: ['stato', 'statoterapia'],
        hint: 'Se vuoto, la terapia è in corso.',
      },
      {
        key: 'motivoSospensione',
        label: 'Motivo della sospensione',
        kind: 'text',
        max: 500,
        synonyms: ['motivosospensione', 'motivo'],
      },
      { key: 'dose', label: 'Dose', kind: 'text', max: 50, synonyms: ['dose', 'dosaggio'] },
      {
        key: 'unitaDose',
        label: 'Unità della dose',
        kind: 'text',
        max: 50,
        synonyms: ['unitadose', 'unita'],
      },
      {
        key: 'frequenza',
        label: 'Frequenza',
        kind: 'text',
        max: 100,
        synonyms: ['frequenza', 'posologia'],
      },
      {
        key: 'momento',
        label: 'Momento della giornata',
        kind: 'text',
        max: 100,
        synonyms: ['momento', 'orario'],
      },
      { key: 'via', label: 'Via di somministrazione', kind: 'text', max: 100, synonyms: ['via'] },
      {
        key: 'unitaAlGiorno',
        label: 'Unità al giorno (per il contatore R11)',
        kind: 'number',
        synonyms: ['unitaalgiorno', 'unitagiorno'],
      },
      {
        key: 'confezioni',
        label: 'Confezioni per ricetta',
        kind: 'integer',
        required: true,
        synonyms: ['confezioni', 'pezzi', 'quantita', 'nconfezioni'],
        hint: 'Da 1 a 99. Se il file non lo dice, indica un valore uguale per tutte le righe.',
      },
      {
        key: 'esenzioneAbituale',
        label: 'Esenzione abituale',
        kind: 'code',
        synonyms: ['esenzione', 'esenzioneabituale'],
      },
      { key: 'notaAifa', label: 'Nota AIFA', kind: 'code', synonyms: ['notaaifa', 'nota'] },
      {
        key: 'istruzioni',
        label: 'Istruzioni per il paziente',
        kind: 'text',
        max: 1000,
        synonyms: ['istruzioni', 'indicazioni'],
      },
      yesNo('riservata', 'Riservata (visibile solo al medico)', ['riservata', 'riservato']),
      yesNo('importante', 'Importante', ['importante']),
      yesNo('nonSostituibile', 'Non sostituibile', ['nonsostituibile']),
      {
        key: 'motivoNonSostituibile',
        label: 'Motivo della non sostituibilità (R13)',
        kind: 'text',
        max: 500,
        synonyms: ['motivononsostituibile'],
      },
      sourceId,
    ],
  },
  {
    key: 'ricette_passate',
    label: 'Farmaci e prestazioni prescritti con altri programmi',
    menu: 'Farmaci prescritti · Visite ed esami prescritti (storico, sola lettura)',
    order: 14,
    naturalKey: [
      'data',
      'tipo',
      'aic',
      'farmaco',
      'codicePrestazione',
      'descrizionePrestazione',
      'nre',
    ],
    notes:
      'Ricette fatte con un altro programma: si vedono nello storico, non si firmano, non si inviano e non si annullano verso il SAR.',
    fields: [
      patientKey,
      {
        key: 'data',
        label: 'Data della ricetta',
        kind: 'date',
        required: true,
        synonyms: ['data', 'dataricetta', 'dataprescrizione', 'del'],
      },
      {
        key: 'tipo',
        label: 'Farmaco o prestazione',
        kind: 'choice',
        required: true,
        choices: [
          { key: 'farmaco', label: 'Farmaco' },
          { key: 'prestazione', label: 'Prestazione (visita o esame)' },
        ],
        synonyms: ['tipo', 'tiporicetta', 'tipoprescrizione'],
      },
      {
        key: 'farmaco',
        label: 'Farmaco',
        kind: 'text',
        max: 300,
        synonyms: ['farmaco', 'nomefarmaco', 'specialita', 'denominazione'],
      },
      {
        key: 'aic',
        label: 'AIC (9 cifre)',
        kind: 'code',
        digits: 9,
        synonyms: ['aic', 'codiceaic'],
      },
      {
        key: 'principioAttivo',
        label: 'Principio attivo',
        kind: 'text',
        max: 300,
        synonyms: ['principioattivo', 'principio'],
      },
      { key: 'atc', label: 'ATC', kind: 'code', synonyms: ['atc'] },
      {
        key: 'quantita',
        label: 'Quantità (confezioni)',
        kind: 'integer',
        synonyms: ['quantita', 'confezioni', 'pezzi', 'qta'],
      },
      {
        key: 'posologia',
        label: 'Posologia',
        kind: 'text',
        max: 500,
        synonyms: ['posologia', 'dosaggio'],
      },
      {
        key: 'codicePrestazione',
        label: 'Codice della prestazione',
        kind: 'code',
        synonyms: ['codiceprestazione', 'codice', 'codicenomenclatore'],
      },
      {
        key: 'descrizionePrestazione',
        label: 'Descrizione della prestazione',
        kind: 'text',
        max: 300,
        synonyms: ['prestazione', 'descrizioneprestazione', 'esame', 'visita'],
      },
      { key: 'nre', label: 'NRE', kind: 'code', synonyms: ['nre', 'numeroricetta'] },
      {
        key: 'prescrittore',
        label: 'Medico prescrittore',
        kind: 'text',
        max: 200,
        synonyms: ['prescrittore', 'medico', 'medicoprescrittore'],
      },
      { key: 'note', label: 'Note', kind: 'text', max: 2000, synonyms: ['note'] },
      sourceId,
    ],
  },
];

export function importDestination(key: string): ImportDestination | undefined {
  return IMPORT_DESTINATIONS.find((d) => d.key === key);
}

/** Valori letti come «sì» e come «no» nei campi sì/no (oltre a una tabella di corrispondenza). */
export const YES_VALUES = ['sì', 'si', 's', 'vero', 'true', 'x', '1'] as const;
export const NO_VALUES = ['no', 'n', 'falso', 'false', '0'] as const;

/**
 * Come si leggono le date scritte come testo. Giorno, mese e anno (GG/MM/AAAA, anche con «-» o
 * «.») e AAAA-MM-GG non si confondono tra loro, quindi valgono insieme; il mese prima del giorno
 * non si legge. Le celle di data di un XLSX hanno già la data certa. Un anno a due cifre non si
 * legge: il secolo non si indovina.
 */
export const IMPORT_DATE_FORMATS = [
  { key: 'testo', label: 'GG/MM/AAAA o AAAA-MM-GG' },
  { key: 'seriale', label: 'Numero seriale (es. 45123)' },
] as const;
export type ImportDateFormat = (typeof IMPORT_DATE_FORMATS)[number]['key'];

/**
 * Numeri scritti come testo: la virgola o il punto separano i decimali (12,5 o 12.5). Il
 * separatore delle migliaia non si accetta: «1.234» sarebbe ambiguo.
 */
export const IMPORT_NUMBER_RULE =
  'Decimali con la virgola o con il punto (12,5 o 12.5), senza separatore delle migliaia.';

/**
 * Suggerimento di un campo per ogni colonna, dai nomi delle intestazioni: un nome uguale a un
 * sinonimo vale più di un nome che lo contiene. Ogni colonna va al più a un campo.
 */
export function suggestColumns(
  destination: ImportDestination,
  headers: readonly string[],
): Record<string, number> {
  const normalized = headers.map(normalizeHeaderName);
  const scores: { field: string; column: number; score: number }[] = [];
  for (const f of destination.fields) {
    normalized.forEach((h, column) => {
      if (!h) return;
      let score = 0;
      for (const s of f.synonyms) {
        if (h === s) score = Math.max(score, 3);
        else if (s.length >= 4 && h.includes(s)) score = Math.max(score, 1);
      }
      if (score > 0) scores.push({ field: f.key, column, score });
    });
  }
  scores.sort((a, b) => b.score - a.score || a.column - b.column);
  const out: Record<string, number> = {};
  const used = new Set<number>();
  for (const s of scores) {
    if (s.field in out || used.has(s.column)) continue;
    out[s.field] = s.column;
    used.add(s.column);
  }
  return out;
}

/** Destinazione più probabile per un foglio: quella con più campi obbligatori riconosciuti. */
export function suggestDestination(
  headers: readonly string[],
): { key: ImportDestinationKey; matched: number } | null {
  let best: { key: ImportDestinationKey; matched: number; required: number } | null = null;
  for (const d of IMPORT_DESTINATIONS) {
    const found = suggestColumns(d, headers);
    const required = d.fields.filter((f) => f.required && f.key in found).length;
    const matched = Object.keys(found).length;
    if (required === 0) continue;
    if (!best || required > best.required || (required === best.required && matched > best.matched))
      best = { key: d.key, matched, required };
  }
  return best && best.required >= 2 ? { key: best.key, matched: best.matched } : null;
}
