import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import {
  DataVersions,
  ErrorMessage,
  Loading,
  Notice,
  PageHeader,
  type DatasetVersion,
} from '../components/common';
import { Icon } from '../components/Icon';
import type { PrescribedDrug } from '../components/Prescribed';
import {
  AddDrugButton,
  byGroup,
  packages as packsText,
  PackStepper,
  PrescribedDrugList,
} from '../components/PrescribedDrugs';
import {
  cycleText,
  NOTE_KIND_TEXT,
  ServiceResultText,
  type ServiceNote,
  type ServiceResultData,
} from '../components/ServiceResult';
import { RegistryNote, type DrugRegistry } from '../components/Registries';
import {
  isSuspended,
  ShortageNote,
  SuspendedNote,
  type DrugShortage,
} from '../components/Shortage';
import {
  afterRaoChoice,
  RaoConditionField,
  raoChoiceOf,
  type RaoTable,
} from '../components/RaoCondition';
import { RedPrintedNotice, type RedPrinted } from '../components/RedFormPrint';
import { ReminderPanel } from '../components/ReminderPanel';
import { SendPanel } from '../components/SendPanel';
import {
  choiceBody,
  choiceFromTherapy,
  choiceSummary,
  NO_CHOICE,
  TherapyChoiceFields,
  type ChoiceDraft,
} from '../components/TherapyChoiceFields';
import { api, ApiError, query } from '../lib/api';
import { ACCESS_TYPE, date, money, PRIORITY, REMINDER_CHANNEL } from '../lib/format';
import { readStored, removeStored, usePersistentState, writeStored } from '../lib/storage';
import { useMoreBelow } from '../lib/useMoreBelow';
import {
  count,
  listPath,
  packageLines,
  useStudioList,
  type ListItem,
  type PackageLine,
  type PackageService,
} from '../lib/studio-lists';
import { useApi } from '../lib/useApi';
import { useSession } from '../lib/session';
import {
  PatientBanner,
  posology,
  type Patient,
  type SubstitutionReason,
  type Summary,
  type TherapyRow,
} from './RecordPage';
import { capitalized, useRegionalService } from '../lib/regional-service';

export interface Drug {
  aic: string;
  name: string | null;
  pack: string | null;
  activeIngredient: string | null;
  atc: string | null;
  drugClass: string | null;
  price: string | null;
  aifaNote: string | null;
  dpc: boolean;
  planRequired: boolean | null;
  /** Ditta titolare dell'AIC: per i generici, il fornitore (D151). */
  holder: string | null;
  /** Lista di trasparenza AIFA (D202): prezzo di riferimento e differenza dal prezzo al pubblico. */
  referencePrice?: string | null;
  priceDifference?: string | null;
  /** Annotazione della lista di trasparenza, in parole. */
  transparencyRemark?: string | null;
  /** Carenza secondo l'elenco AIFA in vigore (D202). */
  shortage?: DrugShortage | null;
  /** Stato amministrativo della confezione nell'anagrafica AIFA in vigore (D205). */
  adminState?: string | null;
  /**
   * Regime di fornitura con le parole dell'anagrafica AIFA (colonna FORNITURA): dice anche se il
   * farmaco è senza obbligo di prescrizione (D261).
   */
  supplyRegime?: string | null;
  /** Registri e piani terapeutici AIFA attivi per lo stesso ATC (D206). */
  registries?: DrugRegistry[];
}

export type Service = ServiceResultData;

interface Line {
  key: string;
  therapyId?: string;
  drugAic?: string | null;
  drugName?: string | null;
  activeIngredient?: string | null;
  /** Codice del catalogo regionale. */
  serviceCode?: string | null;
  /** Codice del nomenclatore, «codice DM» (D154). */
  serviceNationalCode?: string | null;
  serviceDescription?: string | null;
  /** Numero della nota del nomenclatore (numeroNota, D276); assente: lo dà l'elenco in uso. */
  serviceNote?: string | null;
  /** Lettera della condizione o dell'indicazione della nota, scelta dal medico (D276). */
  serviceNoteLetter?: string;
  /** Sedute del ciclo (numsedute, D276), come le scrive il medico. */
  sessions?: string;
  /** Che cosa dice il catalogo della prestazione: si mostra, non parte con la ricetta (D276). */
  catalog?: CatalogInfo;
  quantity: number;
  aifaNote?: string | null;
  posologyText?: string;
  byActiveIngredient?: boolean;
  notSubstitutable?: boolean;
  notSubstitutableReason?: string;
  /** Codice della motivazione di non sostituibilità, da 1 a 4 (R13, D273). */
  notSubstitutableCode?: string;
  /** Ricetta bianca ripetibile, solo se diverso dalla regola del farmaco (D93). */
  repeatCount?: string;
  validityMonths?: string;
  /**
   * Tipo di terapia segnato sulla riga (D283). Assente: com'è nella terapia collegata, o nessuna
   * terapia per un farmaco nuovo.
   */
  therapyChoice?: ChoiceDraft;
}

/** Tariffa, ciclo e nota della prestazione nel catalogo e nell'elenco delle note in uso (D276). */
interface CatalogInfo {
  fee: string | null;
  cycle: boolean;
  maxSessions: number | null;
  note: ServiceNote | null;
}

/**
 * Le lettere delle condizioni o delle indicazioni di una nota, come la nota le scrive («A) …;
 * B) …»): maiuscole, o minuscole se la nota non ne ha di maiuscole. Senza lettere, nessuna scelta.
 */
export function noteLetters(text: string): string[] {
  const found = (re: RegExp) => [...text.matchAll(re)].map((m) => m[1]!.toUpperCase());
  const upper = found(/(?:^|[\s.;:,])([A-Z])\)\s/g);
  const letters = upper.length ? upper : found(/(?:^|[\s.;:,])([a-z])\)\s/g);
  return [...new Set(letters)];
}

const SEARCH_DELAY_MS = 250;
/** Chiave stabile di una riga, anche dopo un ricaricamento (lo stato è ricordato). */
const newKey = () => crypto.randomUUID();

/** Ricerca con un piccolo ritardo, per non interrogare il servizio a ogni tasto. */
export function useDebounced(value: string, ms = SEARCH_DELAY_MS): string {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

interface PriorVoice {
  ricetta: {
    id: string;
    stato: string;
    nre: string | null;
    inviataIl: string | null;
    cartaceaIl: string | null;
    preparataIl: string;
    etichettaErogazione: string | null;
  };
}

/**
 * La stessa prestazione già prescritta (il caso di Simone: il paziente dice di non averla
 * prenotata). Si vede subito quando e con che NRE, e lo stato presso l'ente se è stato verificato.
 */
function AlreadyPrescribed({
  patientId,
  code,
  description,
}: {
  patientId: string;
  code: string | null;
  description: string | null;
}) {
  const q = query({ prestazione: code, descrizione: code ? null : description });
  const h = useApi<{ voci: PriorVoice[] }>(`/api/pazienti/${patientId}/storico-prescrizioni${q}`);
  const prior = (h.data?.voci ?? []).filter(
    (v) => v.ricetta.stato === 'sent' || v.ricetta.stato === 'paper',
  );
  const last = prior[0];
  if (!last) return null;
  const r = last.ricetta;
  return (
    <Notice kind="avviso">
      <p>
        Già prescritta{prior.length > 1 ? ` ${prior.length} volte; l’ultima` : ''} il{' '}
        {date(r.inviataIl ?? r.cartaceaIl ?? r.preparataIl)}
        {r.nre && (
          <>
            {' '}
            (NRE <span className="codice">{r.nre}</span>)
          </>
        )}
        {r.etichettaErogazione
          ? `. Presso l’ente: ${r.etichettaErogazione.toLowerCase()}.`
          : '. Stato presso l’ente non ancora verificato.'}{' '}
        Prima di prescriverla di nuovo, verifica lo stato nello{' '}
        <Link to={`/pazienti/${patientId}/prestazioni${q}`}>storico della prestazione</Link>.
      </p>
    </Notice>
  );
}

/**
 * Il principio attivo, quando il nome non lo dice già: cercando «ramipril» i marchi (ALAMUT,
 * KRUPIL) e le associazioni non si capiscono senza (D256). Come nella ricerca delle banche dati.
 */
export function ingredientOf(d: Pick<Drug, 'name' | 'activeIngredient'>): string | null {
  const ingredient = d.activeIngredient?.trim();
  if (!ingredient) return null;
  return d.name?.toUpperCase().includes(ingredient.toUpperCase()) ? null : ingredient;
}

/**
 * Descrizione breve di un farmaco della banca dati: confezione, ditta, classe, regime di
 * fornitura, nota, DPC, piano, prezzi. Il regime con le parole dell'anagrafica AIFA: con classe C
 * e farmaci senza obbligo di prescrizione nella banca dati è ciò che li distingue (D261).
 */
export function drugFacts(d: Drug): string[] {
  return [
    d.pack,
    d.holder && `ditta ${d.holder}`,
    d.drugClass && `classe ${d.drugClass}`,
    d.supplyRegime?.trim(),
    d.aifaNote && `Nota ${d.aifaNote}`,
    d.dpc && 'in DPC',
    d.planRequired && 'piano terapeutico obbligatorio',
    d.price && money(d.price),
    d.referencePrice && `prezzo di riferimento ${money(d.referencePrice)}`,
    d.priceDifference &&
      Number(d.priceDifference) > 0 &&
      `differenza dal riferimento ${money(d.priceDifference)}`,
    d.transparencyRemark,
  ].filter((x): x is string => !!x);
}

/**
 * Una riga in ricetta, chiusa (D242): che cosa c'è senza aprirla. Confezioni e posologia per i
 * farmaci, quantità e codici per le prestazioni; le scelte che vincolano il farmacista si dicono.
 */
export function lineSummary(
  l: {
    quantity: number;
    posologyText?: string;
    byActiveIngredient?: boolean;
    notSubstitutable?: boolean;
    notSubstitutableCode?: string;
    repeatCount?: string;
    validityMonths?: string;
    serviceCode?: string | null;
    serviceNationalCode?: string | null;
    serviceNote?: string | null;
    serviceNoteLetter?: string;
    sessions?: string;
  },
  mode: 'farmaci' | 'specialistica',
  white = false,
): string {
  if (mode === 'specialistica')
    return [
      `quantità ${l.quantity}`,
      l.serviceCode && `catalogo ${l.serviceCode}`,
      l.serviceNationalCode && `nomenclatore (DM) ${l.serviceNationalCode}`,
      l.serviceNote && `nota ${[l.serviceNote, l.serviceNoteLetter].filter(Boolean).join(' ')}`,
      l.sessions && `${l.sessions} sedute`,
    ]
      .filter(Boolean)
      .join(' · ');
  return [
    `${l.quantity} ${l.quantity === 1 ? 'confezione' : 'confezioni'}`,
    l.posologyText?.trim() || 'posologia non indicata',
    l.byActiveIngredient && 'per principio attivo',
    l.notSubstitutable &&
      (l.notSubstitutableCode
        ? `non sostituibile, motivazione ${l.notSubstitutableCode}`
        : 'non sostituibile'),
    white && l.repeatCount && `ripetibile ${l.repeatCount} volte`,
    white && l.validityMonths && `validità ${l.validityMonths} mesi`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * La riga di una terapia in corso: il farmaco della terapia, con la sua posologia e le confezioni
 * per ricetta della sua scheda, come «Ripeti le terapie scelte» (D250).
 */
function therapyLine(t: TherapyRow): Omit<Line, 'key'> {
  return {
    therapyId: t.id,
    drugAic: t.drugAic,
    drugName: t.drugName,
    activeIngredient: t.activeIngredient,
    aifaNote: t.aifaNote,
    quantity: t.packsPerPrescription ?? 1,
    posologyText: posology(t),
    // «Come va in ricetta» della scheda: per principio attivo e non sostituibile, con la
    // motivazione, entrano con la terapia, come nelle ripetizioni (D273).
    ...(t.byActiveIngredient ? { byActiveIngredient: true } : {}),
    ...(t.notSubstitutable
      ? {
          notSubstitutable: true,
          notSubstitutableReason: t.notSubstitutableReason ?? '',
          notSubstitutableCode: t.notSubstitutableCode ?? '',
        }
      : {}),
  };
}

/**
 * Lo stesso farmaco di una riga già in ricetta (D250): la stessa terapia; altrimenti la stessa
 * confezione (AIC); senza AIC lo stesso nome. Così «Aggiungi» non ripete una riga: cambia le
 * confezioni di quella che c'è.
 */
export function sameDrug(
  a: Pick<Line, 'therapyId' | 'drugAic' | 'drugName'>,
  b: Pick<Line, 'therapyId' | 'drugAic' | 'drugName'>,
): boolean {
  if (a.therapyId && b.therapyId) return a.therapyId === b.therapyId;
  if (a.drugAic && b.drugAic) return a.drugAic === b.drugAic;
  return !a.drugAic && !b.drugAic && !!a.drugName && a.drugName === b.drugName;
}

/** Le confezioni di tutte le righe della ricetta (D250): il totale che vedono le regole R2–R4. */
export const totalPacks = (lines: readonly Pick<Line, 'quantity'>[]) =>
  lines.reduce((n, l) => n + l.quantity, 0);

/**
 * La riga da aggiungere per un farmaco prescritto: c'è per ogni farmaco (D249). La terapia in
 * corso porta la sua posologia ed entra nel suo storico (D65). Una terapia sospesa o conclusa, o
 * un farmaco prescritto senza terapia, entra come farmaco, senza posologia: per confezione se ha
 * l'AIC, altrimenti per principio attivo o, se manca anche quello, per nome. Che cosa manca lo
 * dicono i controlli della ricetta.
 */
export function lineFromPrescribed(
  d: PrescribedDrug,
  therapies: readonly TherapyRow[],
): Omit<Line, 'key'> {
  if (d.terapia?.stato === 'active') {
    const t = therapies.find((x) => x.id === d.terapia!.id);
    if (t) return therapyLine(t);
  }
  return {
    drugAic: d.aic,
    drugName: d.farmaco,
    activeIngredient: d.principioAttivo,
    aifaNote: d.notaAifa,
    quantity: 1,
    ...(!d.aic && d.principioAttivo ? { byActiveIngredient: true } : {}),
  };
}

/** Quanti risultati, o che sono solo i primi e conviene precisare (audit, D259). */
export function resultsText(
  q: string,
  data: { farmaci?: unknown[]; prestazioni?: unknown[]; altri?: boolean },
): string {
  const n = (data.farmaci ?? data.prestazioni ?? []).length;
  if (n === 0) return `Nessun risultato per «${q}».`;
  if (data.altri) return `Primi ${n} risultati: precisa la ricerca (dosaggio, forma o marchio).`;
  return n === 1 ? '1 risultato.' : `${n} risultati.`;
}

/**
 * Una riga che la segreteria può preparare (D259): una terapia cronica in corso, come in «Ripeti
 * le terapie scelte». Il servizio lo controlla di nuovo.
 */
export function repeatable(line: Pick<Line, 'therapyId'>, therapies: readonly TherapyRow[]) {
  const t = therapies.find((x) => x.id === line.therapyId);
  return !!t && t.kind === 'chronic' && t.status === 'active' && !t.reserved;
}

/** Dove si ricorda la ricetta in corso di un paziente, nella scheda del browser (D68). */
const draftKey = (patientId: string, mode: 'farmaci' | 'specialistica', field: string) =>
  `ricetta:${patientId}:${mode}:${field}`;

/** La ricetta in corso del paziente è già preparata: non si aggiungono righe (D249). */
export const currentPrescriptionLocked = (patientId: string) =>
  readStored(draftKey(patientId, 'farmaci', 'bozza'), null) !== null;

/**
 * Aggiunge una riga alla ricetta in corso del paziente da un'altra pagina, come «Aggiungi» nella
 * ricetta (D249). Se la ricetta è già preparata non aggiunge niente e dà false.
 */
export function addToCurrentPrescription(patientId: string, line: Omit<Line, 'key'>): boolean {
  if (currentPrescriptionLocked(patientId)) return false;
  const key = draftKey(patientId, 'farmaci', 'righe');
  const lines = readStored<Line[]>(key, []);
  // Il farmaco già in ricetta non si ripete: le confezioni si cambiano nella ricetta (D250).
  if (!lines.some((l) => sameDrug(l, line)))
    writeStored(key, [...lines, { ...line, key: newKey() }]);
  return true;
}

/** Ricette già fatte: dopo, nell'editor si ricomincia da capo (D278). */
const FINISHED_STATUSES = new Set(['sent', 'cancelled', 'paper']);
/** Che cosa l'editor ricorda della ricetta in corso, campo per campo (D68). */
const DRAFT_FIELDS = [
  'bozza',
  'righe',
  'tipo',
  'esenzione',
  'canale',
  'accesso',
  'priorita',
  'quesito',
  'rao',
  'oscurato',
] as const;

/** Una riga di una ricetta già fatta, come la dà l'elenco delle ricette del paziente (D278). */
export interface PastLine {
  therapyId: string | null;
  drugAic: string | null;
  drugName: string | null;
  activeIngredient: string | null;
  serviceCode: string | null;
  serviceNationalCode: string | null;
  serviceDescription: string | null;
  serviceNote?: string | null;
  serviceNoteLetter?: string | null;
  sessions?: number | null;
  quantity: number;
  aifaNote: string | null;
  byActiveIngredient: boolean;
  notSubstitutable: boolean;
  notSubstitutableReason: string | null;
  notSubstitutableCode?: string | null;
  posologyText: string | null;
  repeatCount: number | null;
  validityMonths: number | null;
}

/** Una ricetta già fatta, con le righe (D278). */
export interface PastPrescription {
  id: string;
  kind: string;
  status: string;
  exemptionCode: string | null;
  accessType: 'first' | 'subsequent' | null;
  priority: string | null;
  diagnosticQuestion: string | null;
  /** La condizione RAO scelta (D285): si ripropone, se la tabella c'è ancora. */
  raoConditionKey?: string | null;
  righe: PastLine[];
}

/** Che cosa dice il catalogo in uso di una prestazione, dalla ricerca (D276, D278). */
async function catalogInfoFor(code: string): Promise<CatalogInfo | null> {
  const found = await api<{ prestazioni: Service[] }>(`/api/prestazioni${query({ q: code })}`);
  const s = found.prestazioni.find(
    (x) => x.regionalCode.trim().toUpperCase() === code.trim().toUpperCase(),
  );
  return s
    ? { fee: s.fee, cycle: !!s.cycle, maxSessions: s.sessions ?? null, note: s.note ?? null }
    : null;
}

/**
 * «Rinnova» una ricetta già fatta (D278, richiesta della Dr.ssa Rocca): le sue righe vanno nella
 * ricetta in corso del paziente, da rivedere e firmare. Non si manda niente.
 * - Le righe già in ricetta non si ripetono.
 * - Con la ricetta in corso vuota vanno anche tipo, esenzione e, per la specialistica, accesso,
 *   priorità e quesito.
 * - Per le prestazioni la nota del nomenclatore è quella dell'elenco in uso; la lettera resta
 *   solo se la nota è la stessa.
 * - Una terapia che non è più in corso non resta collegata.
 * - Se la ricetta di prima è già fatta (inviata, annullata o stampata su ricetta rossa) si
 *   ricomincia da capo, come con «Nuova ricetta da capo».
 * Dà dove aprire la ricetta e quante righe ha aggiunto; null se la ricetta in corso è ancora da
 * finire: in bozza, da firmare, in invio o in errore.
 */
export async function renewIntoCurrentPrescription(
  patientId: string,
  past: PastPrescription,
  activeTherapyIds: ReadonlySet<string>,
): Promise<{ mode: 'farmaci' | 'specialistica'; added: number } | null> {
  const mode = past.kind === 'specialist_ssn' ? 'specialistica' : 'farmaci';
  const key = (field: string) => draftKey(patientId, mode, field);
  const previous = readStored<{ status?: string } | null>(key('bozza'), null);
  if (previous) {
    if (!FINISHED_STATUSES.has(previous.status ?? '')) return null;
    for (const field of DRAFT_FIELDS) removeStored(key(field));
  }
  const current = readStored<Line[]>(key('righe'), []);
  const sameService = (a: Pick<Line, 'serviceCode'>, b: Pick<Line, 'serviceCode'>) =>
    !!a.serviceCode && a.serviceCode.trim().toUpperCase() === b.serviceCode?.trim().toUpperCase();
  const added: Line[] = [];
  for (const l of past.righe) {
    let line: Omit<Line, 'key'>;
    if (mode === 'specialistica') {
      const catalog = l.serviceCode ? await catalogInfoFor(l.serviceCode) : null;
      const note = catalog?.note ?? null;
      line = {
        serviceCode: l.serviceCode,
        serviceNationalCode: l.serviceNationalCode,
        serviceDescription: l.serviceDescription,
        quantity: l.quantity,
        ...(note ? { serviceNote: note.note } : {}),
        ...(note && l.serviceNote === note.note && l.serviceNoteLetter
          ? { serviceNoteLetter: l.serviceNoteLetter }
          : {}),
        ...(l.sessions ? { sessions: String(l.sessions) } : {}),
        ...(catalog ? { catalog } : {}),
      };
      if ([...current, ...added].some((x) => sameService(x, line))) continue;
    } else {
      line = {
        ...(l.therapyId && activeTherapyIds.has(l.therapyId) ? { therapyId: l.therapyId } : {}),
        drugAic: l.drugAic,
        drugName: l.drugName,
        activeIngredient: l.activeIngredient,
        quantity: l.quantity,
        aifaNote: l.aifaNote,
        ...(l.posologyText ? { posologyText: l.posologyText } : {}),
        ...(l.byActiveIngredient ? { byActiveIngredient: true } : {}),
        ...(l.notSubstitutable
          ? {
              notSubstitutable: true,
              notSubstitutableCode: l.notSubstitutableCode ?? '',
              notSubstitutableReason: l.notSubstitutableReason ?? '',
            }
          : {}),
        ...(past.kind === 'white'
          ? {
              repeatCount: l.repeatCount === null ? '' : String(l.repeatCount),
              validityMonths: l.validityMonths === null ? '' : String(l.validityMonths),
            }
          : {}),
      };
      if ([...current, ...added].some((x) => sameDrug(x, line))) continue;
    }
    added.push({ ...line, key: newKey() });
  }
  if (current.length === 0) {
    writeStored(key('tipo'), past.kind);
    if (past.exemptionCode) writeStored(key('esenzione'), past.exemptionCode);
    if (mode === 'specialistica') {
      if (past.accessType) writeStored(key('accesso'), past.accessType);
      if (past.priority) writeStored(key('priorita'), past.priority);
      if (past.diagnosticQuestion) writeStored(key('quesito'), past.diagnosticQuestion);
      if (past.raoConditionKey && past.accessType === 'first')
        writeStored(key('rao'), past.raoConditionKey);
    }
  }
  writeStored(key('righe'), [...current, ...added]);
  return { mode, added: added.length };
}

export function PrescriptionEditor({ mode }: { mode: 'farmaci' | 'specialistica' }) {
  const { id } = useParams<{ id: string }>();
  const record = useApi<{
    paziente: Patient;
    riepilogo: Summary | null;
    /** Codici della terapia del dolore (R23, D272): solo per la ricetta farmaceutica del SSN. */
    codiciTerapiaDolore?: string[];
    /** Codici della motivazione di non sostituibilità di R13 in vigore oggi (D273). */
    motivazioniNonSostituibilita?: SubstitutionReason[];
  }>(`/api/pazienti/${id}`);
  const therapies = useApi<{ terapie: TherapyRow[] }>(
    mode === 'farmaci' ? `/api/pazienti/${id}/terapie` : null,
  );
  // Il tipo di terapia di una riga collegata parte dalla scheda com'è adesso (D283).
  const therapyById = new Map((therapies.data?.terapie ?? []).map((t) => [t.id, t]));
  const baseOf = (therapyId: string | undefined) => {
    const t = therapyId ? therapyById.get(therapyId) : undefined;
    return t ? choiceFromTherapy(t) : undefined;
  };
  // I farmaci prescritti stanno qui, dove si prescrive (D246): ultima ricetta, tipo, storico.
  const prescribed = useApi<{ farmaci?: PrescribedDrug[] }>(
    mode === 'farmaci' ? `/api/pazienti/${id}/farmaci-prescritti` : null,
  );
  // L'elenco si mostra quando anche le terapie sono lette: prima il pulsante «Aggiungi» delle
  // terapie in corso comparirebbe dopo, spostando le righe sotto il cursore (D242, D246).
  // I due riquadri scorrono da soli: un'ombra in fondo dice che sotto c'è altro (D249).
  const searchBox = useMoreBelow();
  const lineBox = useMoreBelow();
  const prescribedList = prescribed.data?.farmaci;
  const prescribedDrugs = therapies.loading ? undefined : prescribedList;
  // Solo se i farmaci prescritti non si leggono si aggiunge dalla terapia in corso, come prima:
  // mentre si leggono, niente, perché l'elenco di ripiego sparirebbe subito.
  const fromTherapies = !prescribed.loading && !prescribedList;
  // La ricetta in corso è ricordata per paziente (D68): si passa a un'altra cartella e si torna.
  const k = (field: string) => draftKey(id!, mode, field);
  const [kind, setKind, resetKind] = usePersistentState(
    k('tipo'),
    mode === 'farmaci' ? 'pharma_ssn' : 'specialist_ssn',
  );
  const [lines, setLines, resetLines] = usePersistentState<Line[]>(k('righe'), []);
  const [exemption, setExemption, resetExemption] = usePersistentState(k('esenzione'), '');
  const [channel, setChannel, resetChannel] = usePersistentState(k('canale'), '');
  const [accessType, setAccessType, resetAccess] = usePersistentState(k('accesso'), 'first');
  // Senza la scelta del medico la classe resta vuota (D285): R14 la chiede prima dell'invio.
  const [priority, setPriority, resetPriority] = usePersistentState(k('priorita'), '');
  const [question, setQuestion, resetQuestion] = usePersistentState(k('quesito'), '');
  // La condizione RAO scelta dal medico (D285): la chiave della tabella.
  const [raoCondition, setRaoCondition, resetRao] = usePersistentState(k('rao'), '');
  const [obscured, setObscured, resetObscured] = usePersistentState(k('oscurato'), false);
  // «Cercalo in Specialistica» dalla ricerca dei farmaci porta qui la stessa ricerca (D279).
  const [params] = useSearchParams();
  const [text, setText] = useState(
    mode === 'specialistica' ? (params.get('cerca') ?? '').slice(0, 100) : '',
  );
  const q = useDebounced(text);
  const search = useApi<{
    farmaci?: Drug[];
    prestazioni?: Service[];
    /** Più risultati di quelli mostrati: si precisa la ricerca (audit, D259). */
    altri?: boolean;
    versioni: DatasetVersion[];
  }>(
    q.trim()
      ? `/api/${mode === 'farmaci' ? 'farmaci' : 'prestazioni'}${query({ q: q.trim() })}`
      : null,
  );
  const versions = useApi<{ versioni: DatasetVersion[] }>(`/api/banche-dati`);
  // Le tabelle RAO delle prestazioni in ricetta (D285): solo specialistica SSN, primo accesso.
  const raoCodes = [
    ...new Set(lines.map((l) => l.serviceCode?.trim()).filter((c): c is string => !!c)),
  ].sort();
  const raoActive = mode === 'specialistica' && kind === 'specialist_ssn' && accessType === 'first';
  const raoTables = useApi<{ tabelle: RaoTable[] }>(
    raoActive && raoCodes.length
      ? `/api/rao/tabelle${query({ prestazioni: raoCodes.join(',') })}`
      : null,
  );
  const raoList = raoActive && raoCodes.length ? (raoTables.data?.tabelle ?? []) : [];
  // Una condizione che non è più del primo accesso o di una prestazione in ricetta si toglie.
  const raoStale =
    !!raoCondition &&
    (!raoActive ||
      raoCodes.length === 0 ||
      (!raoTables.loading &&
        !!raoTables.data &&
        !raoChoiceOf(raoTables.data.tabelle, raoCondition)));
  useEffect(() => {
    if (raoStale) setRaoCondition('');
  }, [raoStale, setRaoCondition]);
  // Elenchi dello studio (tappa 14): i pacchetti nella specialistica, le posologie nei farmaci.
  const packages = useStudioList(mode === 'specialistica' ? 'pacchetto' : null);
  const posologies = useStudioList(mode === 'farmaci' ? 'posologia' : null);
  const [draft, setDraft, resetDraft] = usePersistentState<{
    id: string;
    status: string;
    lineIds: Record<string, string>;
    nre?: string;
    /** La ricetta rossa stampata sul modulo del Poligrafico (D270). */
    red?: RedPrinted;
  } | null>(k('bozza'), null);
  // Il medico firma e invia in un passo (D255). Non si ricorda: tornando alla bozza, il medico
  // vede i controlli e firma con il pulsante.
  const { isDoctor } = useSession();
  // La segreteria prepara solo le ripetizioni delle terapie croniche in corso (requisiti, «Ruoli»;
  // audit, D259): «Aggiungi» c'è solo su quelle; la ricerca resta per consultare.
  const repeatOnly = !isDoctor;
  const [oneStep, setOneStep] = useState(false);
  const lineHeading = useRef<HTMLHeadingElement>(null);
  // La bozza è nata qui, adesso, da un clic: il pannello dei controlli prende il fuoco (D259). Una
  // bozza ricordata, ritrovata tornando alla pagina, no.
  const [arrived, setArrived] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [justAdded, setJustAdded] = useState<Omit<Line, 'key'> | null>(null);
  /**
   * Una bozza lasciata non resta nel servizio (audit, D259): si annulla, con il motivo, e non
   * finisce fra i farmaci prescritti. Una ricetta già partita o stampata non si tocca.
   */
  const dropDraft = async (reason: string) => {
    if (!draft || !['draft', 'to_sign', 'error'].includes(draft.status)) return true;
    try {
      await api(`/api/ricette/${draft.id}/annulla`, { method: 'POST', body: { motivo: reason } });
      return true;
    } catch (e) {
      // Già annullata o partita nel frattempo: non c'è niente da annullare.
      if (e instanceof ApiError && e.status === 409) return true;
      setError(e instanceof ApiError ? e : null);
      return false;
    }
  };
  const startOver = async () => {
    if (!(await dropDraft('Lasciata con «Nuova ricetta da capo»'))) return;
    for (const reset of [resetKind, resetLines, resetExemption, resetChannel, resetAccess]) reset();
    for (const reset of [resetPriority, resetQuestion, resetRao, resetDraft, resetObscured])
      reset();
    setOneStep(false);
    setError(null);
  };
  /**
   * Dopo l'arresto sui controlli si corregge la ricetta senza rifarla (audit, D259): la bozza si
   * annulla e le righe tornano modificabili, con le confezioni, la posologia e le scelte di prima.
   */
  const editAgain = async () => {
    if (!(await dropDraft('Modificata prima dell’invio'))) return;
    resetDraft();
    setOneStep(false);
    setError(null);
  };
  // Le righe in ricetta restano chiuse: si aprono col clic sulla riga (D242).
  const [openLines, setOpenLines] = useState<ReadonlySet<string>>(() => new Set());
  const toggleLine = (key: string) =>
    setOpenLines((open) => {
      const next = new Set(open);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  // La pagina in una schermata (D242): la cornice prende l'altezza dello schermo e le due colonne
  // scorrono ciascuna nel suo riquadro. Gli stili sono in global.css, solo per gli schermi larghi
  // e alti abbastanza: altrove la pagina scorre come le altre.
  useEffect(() => {
    document.documentElement.classList.add('schermo-unico');
    return () => document.documentElement.classList.remove('schermo-unico');
  }, []);

  if (record.loading && !record.data) return <Loading what="dati della cartella" />;
  if (!record.data) return <ErrorMessage error={record.error} />;
  const p = record.data.paziente;
  // Codici della motivazione di non sostituibilità di R13 in vigore oggi (D273); vuoto prima.
  const reasons = record.data.motivazioniNonSostituibilita ?? [];
  const exemptions = record.data.riepilogo?.esenzioni ?? [];
  const versionKinds =
    mode === 'farmaci' ? ['farmaci', 'farmaci_classe', 'farmaci_dpc'] : ['prestazioni'];
  const shownVersions = (search.data?.versioni ?? versions.data?.versioni)?.filter((v) =>
    versionKinds.includes(v.kind),
  );

  const add = (l: Omit<Line, 'key'>) => {
    setLines((ls) =>
      mode === 'farmaci' && ls.some((x) => sameDrug(x, l)) ? ls : [...ls, { ...l, key: newKey() }],
    );
    // «Aggiungi» lascia il posto a «− N +»: il fuoco va lì, non torna in cima (audit 14, D259).
    setJustAdded(l);
  };
  // Le posologie dello studio, come suggerimenti nella posologia delle righe dei farmaci.
  const posologyTexts = [...new Set((posologies.data?.voci ?? []).map((p) => p.etichetta))];
  const update = (key: string, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  async function save(sign = false) {
    setError(null);
    try {
      const body = {
        kind,
        exemptionCode: exemption || null,
        reminderChannel: channel || null,
        ...(mode === 'specialistica'
          ? {
              accessType,
              priority: priority || null,
              diagnosticQuestion: question || null,
              ...(raoActive && raoChoiceOf(raoList, raoCondition) ? { raoCondition } : {}),
            }
          : {}),
        ...(kind !== 'white' && obscured ? { obscured: true } : {}),
        lines: lines.map(
          ({
            key: _k,
            catalog: _c,
            posologyText,
            notSubstitutableReason,
            notSubstitutableCode,
            repeatCount,
            validityMonths,
            sessions,
            serviceNoteLetter,
            therapyChoice,
            ...l
          }) => ({
            ...l,
            // Il tipo di terapia della riga, solo se cambia qualcosa della terapia (D283).
            ...(mode === 'farmaci'
              ? { therapyChoice: choiceBody(therapyChoice, baseOf(l.therapyId)) }
              : {}),
            // Nota con la lettera e sedute del ciclo, solo per la specialistica (D276).
            ...(mode === 'specialistica'
              ? {
                  sessions: sessions ? Number(sessions) : null,
                  serviceNoteLetter: l.serviceNote ? serviceNoteLetter || null : null,
                }
              : {}),
            posologyText: posologyText || null,
            notSubstitutableReason: notSubstitutableReason || null,
            notSubstitutableCode: l.notSubstitutable ? notSubstitutableCode || null : null,
            ...(kind === 'white'
              ? {
                  repeatCount: repeatCount ? Number(repeatCount) : null,
                  validityMonths: validityMonths ? Number(validityMonths) : null,
                }
              : {}),
          }),
        ),
      };
      const r = await api<{ id: string }>(`/api/pazienti/${id}/ricette`, { method: 'POST', body });
      const list = await api<{
        ricette: {
          id: string;
          status: string;
          righe: {
            id: string;
            position: number;
            drugName: string | null;
            serviceDescription: string | null;
          }[];
        }[];
      }>(`/api/pazienti/${id}/ricette`);
      const created = list.ricette.find((x) => x.id === r.id);
      setOneStep(sign);
      setArrived(true);
      setDraft({
        id: r.id,
        status: created?.status ?? 'draft',
        lineIds: Object.fromEntries(
          (created?.righe ?? []).map((l) => [l.id, l.drugName ?? l.serviceDescription ?? '']),
        ),
      });
    } catch (e) {
      setError(e instanceof ApiError ? e : null);
    }
  }

  const title = mode === 'farmaci' ? 'Nuova ricetta' : 'Ricetta specialistica';
  const locked = draft !== null;
  // Un farmaco già in ricetta ha «− N +» al posto di «Aggiungi» (D250): le confezioni si scelgono
  // dove si sceglie il farmaco, e il totale in ricetta cambia con loro.
  const drugAction = (line: Omit<Line, 'key'>, name: string, button: ReactNode) => {
    const inPrescription = lines.find((x) => sameDrug(x, line));
    return inPrescription ? (
      <PackStepper
        name={name}
        quantity={inPrescription.quantity}
        disabled={locked}
        autoFocus={justAdded !== null && sameDrug(justAdded, line)}
        onChange={(quantity) => update(inPrescription.key, { quantity })}
      />
    ) : (
      button
    );
  };
  // Titolo e dati del paziente: in una riga sola quando la pagina sta in una schermata (D242).
  const header = (
    <div className="testata-ricetta">
      <PageHeader
        title={title}
        trail={
          <>
            <Link to={`/pazienti/${id}`}>
              {p.firstName} {p.lastName}
            </Link>{' '}
            <span aria-hidden="true">/</span> <span>{title}</span>
          </>
        }
      />
      <PatientBanner patient={p} summary={record.data.riepilogo} />
    </div>
  );

  // Paziente deceduto: la ricetta non si fa (R19, D199). Lo si dice subito, con il rimedio.
  if (p.status === 'deceased')
    return (
      <>
        {header}
        <Notice kind="errore">
          <p>
            <strong>
              Il paziente risulta deceduto{p.deceasedOn ? ` il ${date(p.deceasedOn)}` : ''}: la
              ricetta non si fa.
            </strong>{' '}
            Se lo stato è sbagliato, correggilo nei{' '}
            <Link to={`/pazienti/${id}/amministrazione`}>dati amministrativi</Link> della cartella.
          </p>
        </Notice>
      </>
    );

  if (repeatOnly && mode === 'specialistica')
    return (
      <>
        {header}
        <Notice kind="info">
          <p>
            La ricetta specialistica la prepara il medico. La segreteria prepara le ripetizioni
            delle terapie croniche, dalla <Link to={`/pazienti/${id}/ricetta`}>Nuova ricetta</Link>.
          </p>
        </Notice>
      </>
    );

  return (
    <>
      {header}

      <div className="griglia-ricetta">
        <section
          className="riquadro ombre-scorrimento"
          aria-labelledby="titolo-cerca"
          ref={searchBox}
        >
          <h2 id="titolo-cerca">
            {mode === 'farmaci' ? 'Banca dati farmaci' : 'Catalogo regionale'}
          </h2>
          {/* Con la tastiera, un salto a «In ricetta» senza passare da ogni risultato: compare
              quando prende il fuoco (suggerimento S6 dell'audit, D259). */}
          <a
            className="salta salta-riquadro"
            href="#titolo-ricetta"
            onClick={(e) => {
              e.preventDefault();
              lineHeading.current?.focus();
            }}
          >
            Vai a «In ricetta»
          </a>
          {mode === 'farmaci' && (
            <fieldset className="scelta scelta-in-riga" disabled={locked}>
              <legend>Tipo di ricetta</legend>
              {[
                ['pharma_ssn', 'Farmaceutica SSN'],
                ['white', 'Bianca (a carico del paziente)'],
              ].map(([v, label]) => (
                <div key={v} className="casella">
                  <input
                    type="radio"
                    id={`tipo-${v}`}
                    name="tipo"
                    value={v}
                    checked={kind === v}
                    onChange={() => setKind(v!)}
                  />
                  <label htmlFor={`tipo-${v}`}>{label}</label>
                </div>
              ))}
            </fieldset>
          )}
          {repeatOnly && mode === 'farmaci' && (
            <p className="aiuto" id="solo-ripetizioni">
              La segreteria prepara solo le ripetizioni delle terapie croniche in corso: si
              aggiungono dai farmaci prescritti, qui sotto. La ricerca serve a consultare la banca
              dati.
            </p>
          )}
          <div role="search" className="ricerca">
            <label htmlFor="cerca-voce">
              {mode === 'farmaci'
                ? 'Farmaco, principio attivo, codice AIC o ATC'
                : 'Prestazione, branca o codice'}
            </label>
            <div className="ricerca-campo">
              <Icon name="cerca" />
              <input
                id="cerca-voce"
                type="search"
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={locked}
                autoComplete="off"
              />
            </div>
          </div>
          <DataVersions
            versions={shownVersions}
            label={mode === 'farmaci' ? 'Banche dati dei farmaci' : 'Catalogo'}
            compact
          />
          <ErrorMessage error={search.error} />
          {/* Il numero, non tutto l'elenco, a chi usa un lettore di schermo (audit 15, D259). */}
          <p role="status" className="tenue stato-ricerca">
            {q && search.data ? resultsText(q, search.data) : ''}
          </p>
          {/* Un esame cercato fra i farmaci (D279): si prescrive fra visite ed esami (D282). */}
          {mode === 'farmaci' && q && search.data && (search.data.farmaci ?? []).length === 0 && (
            <p className="tenue">
              Cerchi un esame o una visita? Si prescrivono in «Visite ed esami da prescrivere»:{' '}
              <Link to={`/pazienti/${id}/specialistica${query({ cerca: q })}`}>
                cerca «{q}» fra visite ed esami
              </Link>
              .
            </p>
          )}
          <ul className="risultati">
            {search.data?.farmaci?.map((d) => {
              const line = {
                drugAic: d.aic,
                drugName: [d.name, d.pack].filter(Boolean).join(' '),
                activeIngredient: d.activeIngredient,
                aifaNote: d.aifaNote,
                quantity: 1,
              };
              return (
                <li key={d.aic} className="risultato">
                  <div>
                    <strong>{d.name ?? d.activeIngredient}</strong>
                    <div className="tenue">
                      {[ingredientOf(d), ...drugFacts(d)].filter(Boolean).join(' · ')}
                    </div>
                    <div className="codice tenue">AIC {d.aic}</div>
                    {isSuspended(d.adminState) && <SuspendedNote />}
                    {d.shortage && <ShortageNote shortage={d.shortage} />}
                    <RegistryNote registries={d.registries ?? []} />
                  </div>
                  {!repeatOnly &&
                    drugAction(
                      line,
                      line.drugName,
                      <button
                        type="button"
                        className="pulsante"
                        disabled={locked}
                        onClick={() => add(line)}
                      >
                        <Icon name="aggiungi" /> <span>Aggiungi</span>
                        <span className="visivamente-nascosto"> {line.drugName}</span>
                      </button>,
                    )}
                </li>
              );
            })}
            {search.data?.prestazioni?.map((s) => (
              <li key={s.regionalCode} className="risultato">
                <ServiceResultText s={s} />
                <button
                  type="button"
                  className="pulsante"
                  disabled={locked}
                  onClick={() =>
                    add({
                      serviceCode: s.regionalCode,
                      serviceNationalCode: s.nationalCode,
                      serviceDescription: s.description,
                      ...(s.note ? { serviceNote: s.note.note } : {}),
                      catalog: {
                        fee: s.fee,
                        cycle: !!s.cycle,
                        maxSessions: s.sessions ?? null,
                        note: s.note ?? null,
                      },
                      quantity: 1,
                    })
                  }
                >
                  <Icon name="aggiungi" /> <span>Aggiungi</span>
                  <span className="visivamente-nascosto"> {s.description}</span>
                </button>
              </li>
            ))}
          </ul>
          {mode === 'specialistica' && (
            <PackagePicker
              packages={packages.data?.voci ?? null}
              inPrescription={lines.map((l) => l.serviceCode)}
              disabled={locked}
              onAdd={(added) =>
                setLines((ls) => [...ls, ...added.map((l) => ({ ...l, key: newKey() }))])
              }
            />
          )}
          {mode === 'specialistica' && (
            <ManualServiceForm disabled={locked} onAdd={(l) => add({ ...l, quantity: 1 })} />
          )}
          {mode === 'farmaci' && prescribedDrugs && prescribedDrugs.length > 0 && (
            <>
              {/* I farmaci prescritti (D246): in vista nome, tipo e ultima ricetta; il resto e
                  lo storico col «+». «Aggiungi» su ogni farmaco (D249). Prima le terapie in
                  corso, come nei gruppi della pagina. */}
              <h3 id="titolo-farmaci-prescritti">Farmaci prescritti</h3>
              <PrescribedDrugList
                drugs={byGroup(prescribedDrugs)}
                patientId={id!}
                label="titolo-farmaci-prescritti"
                action={(d) => {
                  const line = lineFromPrescribed(d, therapies.data?.terapie ?? []);
                  if (repeatOnly && !repeatable(line, therapies.data?.terapie ?? [])) return null;
                  return drugAction(
                    line,
                    d.farmaco,
                    <AddDrugButton name={d.farmaco} disabled={locked} onClick={() => add(line)} />,
                  );
                }}
              />
              <p className="collegamento-solo aiuto">
                <Link to={`/pazienti/${id}/farmaci`}>
                  Tutti i farmaci prescritti, con le ricette fatte con altri programmi
                </Link>
              </p>
            </>
          )}
          {/* Chi non legge i farmaci prescritti aggiunge dalla terapia in corso, come prima. */}
          {mode === 'farmaci' && fromTherapies && (therapies.data?.terapie ?? []).length > 0 && (
            <>
              <h3>Dalla terapia in corso</h3>
              <ul className="risultati">
                {therapies
                  .data!.terapie.filter(
                    (t) => t.status === 'active' && (!repeatOnly || t.kind === 'chronic'),
                  )
                  .map((t) => (
                    <li key={t.id} className="risultato">
                      <div>
                        <strong>{t.drugName}</strong>
                        <div className="tenue">{posology(t)}</div>
                      </div>
                      {drugAction(
                        therapyLine(t),
                        t.drugName,
                        <button
                          type="button"
                          className="pulsante"
                          disabled={locked}
                          onClick={() => add(therapyLine(t))}
                        >
                          <Icon name="aggiungi" /> <span>Aggiungi</span>
                        </button>,
                      )}
                    </li>
                  ))}
              </ul>
            </>
          )}
        </section>

        <section
          className="riquadro ombre-scorrimento"
          aria-labelledby="titolo-ricetta"
          ref={lineBox}
        >
          {/* «Ricomincia» svuota questa lista: sta accanto al titolo, così in fondo restano solo i
              pulsanti della firma e della bozza, in una riga anche a 1280 px (D255). */}
          <div className="riquadro-testa">
            <h2 id="titolo-ricetta" ref={lineHeading} tabIndex={-1}>
              In ricetta
            </h2>
            {!draft && lines.length > 0 && (
              <button
                type="button"
                className="pulsante pulsante-piatto"
                onClick={() => void startOver()}
              >
                <Icon name="ripeti" /> <span>Ricomincia</span>
              </button>
            )}
          </div>
          {/* Il totale delle confezioni, che cambia con «− N +» e con il campo della riga (D250):
              è quello che contano i limiti per ricetta (R2–R4) quando si prepara la ricetta. */}
          {mode === 'farmaci' && lines.length > 0 && (
            <p className="totale-confezioni" aria-live="polite">
              <span className="contatore">{packsText(totalPacks(lines))}</span> in ricetta
            </p>
          )}
          {lines.length === 0 && (
            <p className="tenue">
              {repeatOnly
                ? 'Aggiungi una terapia cronica in corso dai farmaci prescritti.'
                : mode === 'farmaci'
                  ? 'Aggiungi un farmaco dalla ricerca.'
                  : 'Aggiungi una prestazione dalla ricerca.'}
            </p>
          )}
          <ol className="righe-ricetta">
            {lines.map((l, n) => {
              const name = l.drugName ?? l.serviceDescription;
              const open = openLines.has(l.key);
              return (
                <li key={l.key} className={`riga-ricetta${open ? ' aperta' : ''}`}>
                  <div className="riga-ricetta-testa">
                    <button
                      type="button"
                      className="riga-ricetta-apri"
                      aria-expanded={open}
                      aria-controls={`dettagli-${l.key}`}
                      onClick={() => toggleLine(l.key)}
                    >
                      <Icon name="apri" />
                      <span className="riga-ricetta-testo">
                        <strong className="riga-ricetta-nome">
                          {n + 1}. {name}
                        </strong>
                        <span className="tenue">
                          {[
                            lineSummary(l, mode, kind === 'white'),
                            mode === 'farmaci' &&
                              choiceSummary(l.therapyChoice, baseOf(l.therapyId)),
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      </span>
                    </button>
                    {l.aifaNote && <span className="etichetta">Nota {l.aifaNote}</span>}
                    {mode === 'specialistica' && l.serviceNote && (
                      <span className="etichetta">Nota {l.serviceNote}</span>
                    )}
                  </div>
                  {mode === 'specialistica' && (l.serviceCode || l.serviceDescription) && (
                    <AlreadyPrescribed
                      patientId={id!}
                      code={l.serviceCode ?? null}
                      description={l.serviceDescription ?? null}
                    />
                  )}
                  <fieldset
                    id={`dettagli-${l.key}`}
                    className="riga-ricetta-dettagli"
                    disabled={locked}
                    hidden={!open}
                  >
                    <legend className="visivamente-nascosto">
                      Dettagli della riga {n + 1}: {name}
                    </legend>
                    {mode === 'specialistica' && l.serviceCode && (
                      <p className="codice tenue">
                        Catalogo {l.serviceCode}
                        {l.serviceNationalCode
                          ? ` · nomenclatore (DM) ${l.serviceNationalCode}`
                          : ' · nomenclatore (DM) dal catalogo in uso'}
                      </p>
                    )}
                    {mode === 'specialistica' && l.catalog && (
                      <CatalogDetails line={l} onChange={(patch) => update(l.key, patch)} />
                    )}
                    <div className="campi-riga">
                      <div className="campo campo-stretto">
                        <label htmlFor={`q-${l.key}`}>
                          {mode === 'farmaci' ? 'Confezioni' : 'Quantità'}
                        </label>
                        <input
                          id={`q-${l.key}`}
                          type="number"
                          min={1}
                          max={99}
                          value={l.quantity}
                          onChange={(e) =>
                            update(l.key, { quantity: Math.max(1, Number(e.target.value) || 1) })
                          }
                        />
                      </div>
                      {mode === 'farmaci' && (
                        <div className="campo">
                          <label htmlFor={`p-${l.key}`}>Posologia</label>
                          <input
                            id={`p-${l.key}`}
                            list={posologyTexts.length ? 'posologie-studio' : undefined}
                            value={l.posologyText ?? ''}
                            onChange={(e) => update(l.key, { posologyText: e.target.value })}
                          />
                        </div>
                      )}
                    </div>
                    {mode === 'farmaci' && (
                      <>
                        <div className="casella">
                          <input
                            type="checkbox"
                            id={`pa-${l.key}`}
                            checked={!!l.byActiveIngredient}
                            // Per principio attivo e non sostituibile non vanno insieme (R13, D273).
                            disabled={
                              reasons.length > 0 && !!l.notSubstitutable && !l.byActiveIngredient
                            }
                            onChange={(e) =>
                              update(l.key, { byActiveIngredient: e.target.checked })
                            }
                          />
                          <label htmlFor={`pa-${l.key}`}>
                            Per principio attivo{' '}
                            <span className="tenue">· il farmacista può dare un equivalente</span>
                          </label>
                        </div>
                        <div className="casella">
                          <input
                            type="checkbox"
                            id={`ns-${l.key}`}
                            checked={!!l.notSubstitutable}
                            disabled={
                              reasons.length > 0 &&
                              !l.notSubstitutable &&
                              (!!l.byActiveIngredient || !l.drugAic)
                            }
                            onChange={(e) => update(l.key, { notSubstitutable: e.target.checked })}
                          />
                          <label htmlFor={`ns-${l.key}`}>
                            Non sostituibile{' '}
                            <span className="tenue">
                              {reasons.length > 0
                                ? '· vincola il farmacista al farmaco con l’AIC; serve il codice della motivazione (R13)'
                                : '· vincola il farmacista; serve una motivazione (R13)'}
                            </span>
                          </label>
                        </div>
                        {l.notSubstitutable && reasons.length > 0 && (
                          <div className="campo">
                            <label htmlFor={`nsc-${l.key}`}>
                              Motivazione (linee guida del Sistema TS)
                            </label>
                            <select
                              id={`nsc-${l.key}`}
                              value={l.notSubstitutableCode ?? ''}
                              onChange={(e) =>
                                update(l.key, { notSubstitutableCode: e.target.value })
                              }
                            >
                              <option value="">Scegli la motivazione</option>
                              {reasons.map((r) => (
                                <option key={r.codice} value={r.codice}>
                                  {r.codice} · {r.descrizione}
                                </option>
                              ))}
                            </select>
                          </div>
                        )}
                        {l.notSubstitutable && (
                          <div className="campo">
                            <label htmlFor={`nsm-${l.key}`}>
                              {reasons.length > 0
                                ? 'Precisazione, facoltativa'
                                : 'Motivazione della non sostituibilità'}
                            </label>
                            <input
                              id={`nsm-${l.key}`}
                              value={l.notSubstitutableReason ?? ''}
                              onChange={(e) =>
                                update(l.key, { notSubstitutableReason: e.target.value })
                              }
                            />
                          </div>
                        )}
                        {kind === 'white' && (
                          <div className="campi-riga">
                            <div className="campo campo-stretto">
                              <label htmlFor={`rip-${l.key}`}>Ripetibile (volte)</label>
                              <input
                                id={`rip-${l.key}`}
                                inputMode="numeric"
                                value={l.repeatCount ?? ''}
                                onChange={(e) =>
                                  update(l.key, { repeatCount: e.target.value.replace(/\D/g, '') })
                                }
                                aria-describedby={`rip-aiuto-${l.key}`}
                              />
                            </div>
                            <div className="campo campo-stretto">
                              <label htmlFor={`val-${l.key}`}>Validità (mesi)</label>
                              <input
                                id={`val-${l.key}`}
                                inputMode="numeric"
                                value={l.validityMonths ?? ''}
                                onChange={(e) =>
                                  update(l.key, {
                                    validityMonths: e.target.value.replace(/\D/g, ''),
                                  })
                                }
                                aria-describedby={`rip-aiuto-${l.key}`}
                              />
                            </div>
                            <p className="aiuto" id={`rip-aiuto-${l.key}`}>
                              Solo se diversi dalla regola del farmaco: altrimenti vale quella, e il
                              SAC controlla le ripetizioni.
                            </p>
                          </div>
                        )}
                        <TherapyChoiceFields
                          id={l.key}
                          value={l.therapyChoice ?? baseOf(l.therapyId) ?? NO_CHOICE}
                          base={baseOf(l.therapyId)}
                          white={kind === 'white'}
                          proposal={!isDoctor}
                          onChange={(patch) =>
                            update(l.key, {
                              therapyChoice: {
                                ...(l.therapyChoice ?? baseOf(l.therapyId) ?? NO_CHOICE),
                                ...patch,
                              },
                            })
                          }
                        />
                      </>
                    )}
                    <button
                      type="button"
                      className="pulsante pulsante-piatto"
                      onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                    >
                      <Icon name="annulla" /> <span>Togli dalla ricetta</span>
                    </button>
                  </fieldset>
                </li>
              );
            })}
          </ol>
          {posologyTexts.length > 0 && (
            <datalist id="posologie-studio">
              {posologyTexts.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          )}

          <fieldset className="dati-ricetta" disabled={locked}>
            <legend>Dati della ricetta</legend>
            {mode === 'specialistica' && (
              <>
                <fieldset className="scelta scelta-in-riga">
                  <legend>Tipo di accesso</legend>
                  {Object.entries(ACCESS_TYPE).map(([v, label]) => (
                    <div key={v} className="casella">
                      <input
                        type="radio"
                        id={`accesso-${v}`}
                        name="accesso"
                        checked={accessType === v}
                        onChange={() => setAccessType(v)}
                      />
                      <label htmlFor={`accesso-${v}`}>{label}</label>
                    </div>
                  ))}
                </fieldset>
                {raoList.length > 0 && (
                  <RaoConditionField
                    tables={raoList}
                    value={raoCondition}
                    priority={priority}
                    onChange={(choice) => {
                      const before = raoChoiceOf(raoList, raoCondition);
                      setRaoCondition(choice?.key ?? '');
                      if (!choice) return;
                      const next = afterRaoChoice(choice, before, question);
                      setPriority(next.priority);
                      setQuestion(next.question);
                    }}
                  />
                )}
                <fieldset className="scelta scelta-in-riga">
                  <legend>Classe di priorità</legend>
                  {Object.entries(PRIORITY).map(([v, label]) => (
                    <div key={v} className="casella">
                      <input
                        type="radio"
                        id={`priorita-${v}`}
                        name="priorita"
                        checked={priority === v}
                        onChange={() => setPriority(v)}
                      />
                      <label htmlFor={`priorita-${v}`}>{label}</label>
                    </div>
                  ))}
                </fieldset>
                <div className="campo">
                  <label htmlFor="quesito">Quesito diagnostico</label>
                  <textarea
                    id="quesito"
                    rows={2}
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                  />
                  <p className="aiuto">Obbligatorio sulla ricetta specialistica (R14).</p>
                </div>
              </>
            )}
            {/* L'esenzione resta sempre in vista (D242). */}
            <div className="campo">
              <label htmlFor="esenzione">Esenzione</label>
              <select
                id="esenzione"
                value={exemption}
                onChange={(e) => setExemption(e.target.value)}
              >
                <option value="">Nessuna</option>
                {exemptions.map((e) => (
                  <option key={e.codice} value={e.codice}>
                    {e.codice}
                  </option>
                ))}
                {/* Stupefacenti per la terapia del dolore: il codice va nel campo dell'esenzione
                    (specifiche del Sistema TS, «Nota STUP»; D272). */}
                {kind === 'pharma_ssn' &&
                  (record.data.codiciTerapiaDolore ?? [])
                    .filter((c) => !exemptions.some((e) => e.codice === c))
                    .map((c) => (
                      <option key={c} value={c}>
                        {c} · terapia del dolore
                      </option>
                    ))}
              </select>
            </div>
            {/*
              Promemoria e oscuramento, usati di rado: chiusi in una riga che dice la scelta in
              corso, si aprono col clic (D242).
            */}
            <details className="altre-opzioni">
              <summary>
                <Icon name="apri" />
                <span>
                  Altre opzioni:{' '}
                  <span className="tenue">
                    {[
                      channel
                        ? `promemoria: ${(REMINDER_CHANNEL[channel] ?? channel).toLowerCase()}`
                        : 'promemoria con il canale del paziente',
                      kind !== 'white' &&
                        (obscured ? 'nome e indirizzo oscurati' : 'nome e indirizzo in chiaro'),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
              </summary>
              <div className="campo">
                <label htmlFor="canale">Promemoria al paziente</label>
                <select id="canale" value={channel} onChange={(e) => setChannel(e.target.value)}>
                  <option value="">Il canale scelto dal paziente</option>
                  {Object.entries(REMINDER_CHANNEL).map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </select>
                <p className="aiuto">
                  Solo i canali scelti dal paziente e i suoi recapiti o dei delegati (R15, R16).
                </p>
              </div>
              {kind !== 'white' && (
                <div className="casella">
                  <input
                    type="checkbox"
                    id="oscurato"
                    checked={obscured}
                    onChange={(e) => setObscured(e.target.checked)}
                  />
                  <label htmlFor="oscurato">
                    <strong>Oscura nome e indirizzo</strong>{' '}
                    <span className="tenue">
                      Lo chiede il paziente: non compaiono sul promemoria né all’erogatore; il
                      codice fiscale resta.
                    </span>
                  </label>
                </div>
              )}
            </details>
          </fieldset>
          <ErrorMessage error={error} />
          {/* I pulsanti restano in vista in fondo al riquadro, anche quando la ricetta scorre (D242). */}
          {/* Il medico firma e invia in un passo; «Salva in bozza» per l'anteprima o per dopo (D255). */}
          {!draft && (
            <div className="azioni azioni-ricetta">
              {isDoctor ? (
                <>
                  <button
                    type="button"
                    className="pulsante pulsante-primario"
                    disabled={lines.length === 0}
                    onClick={() => void save(true)}
                  >
                    <Icon name="firma" /> <span>Firma e invia</span>
                  </button>
                  <button
                    type="button"
                    className="pulsante"
                    disabled={lines.length === 0}
                    onClick={() => void save()}
                  >
                    <Icon name="ricette" /> <span>Salva in bozza</span>
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="pulsante pulsante-primario"
                  disabled={lines.length === 0}
                  onClick={() => void save()}
                >
                  <Icon name="ricette" /> <span>Prepara la ricetta</span>
                </button>
              )}
            </div>
          )}
          {draft && draft.status === 'sent' && (
            <>
              <Notice kind="fatto">
                Ricetta inviata.
                {draft.nre && (
                  <>
                    {' '}
                    NRE <span className="codice">{draft.nre}</span>
                  </>
                )}
              </Notice>
              <ReminderPanel prescriptionId={draft.id} patientId={id!} kind={kind} />
            </>
          )}
          {draft &&
            draft.status === 'paper' &&
            (draft.red ? (
              <RedPrintedNotice red={draft.red} />
            ) : (
              <Notice kind="fatto">Ricetta rossa pronta per la stampa.</Notice>
            ))}
          {draft && draft.status !== 'sent' && draft.status !== 'paper' && (
            <>
              {!oneStep && (
                <Notice kind="fatto">
                  Ricetta preparata in bozza. Si controlla e poi si firma.
                </Notice>
              )}
              <SendPanel
                prescriptionId={draft.id}
                status={draft.status}
                lineNames={draft.lineIds}
                preview={kind !== 'white'}
                redForm={kind === 'pharma_ssn' || kind === 'specialist_ssn'}
                autoSign={oneStep}
                focusOnArrival={arrived}
                onEdit={() => void editAgain()}
                onChange={(status, nre, red) =>
                  // La ricetta rossa stampata: il PDF resta in vista al posto del pannello (D270).
                  setDraft({ ...draft, status, ...(nre ? { nre } : {}), ...(red ? { red } : {}) })
                }
              />
            </>
          )}
          {draft && (
            <div className="azioni">
              <button type="button" className="pulsante" onClick={() => void startOver()}>
                <Icon name="ripeti" /> <span>Nuova ricetta da capo</span>
              </button>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

interface PackageOutcome {
  name: string;
  added: number;
  missing: PackageService[];
  already: PackageService[];
  noCatalog: boolean;
}

/**
 * Pacchetti dello studio (tappa 14): «Aggiungi un pacchetto» mette in ricetta le sue prestazioni,
 * cercate nel catalogo in vigore come dalla ricerca delle prestazioni, con i due codici (D154).
 * Quelle che il catalogo in vigore non ha non si aggiungono e si dicono; quelle già in ricetta non
 * si ripetono. Finché l'elenco non arriva (packages null) non si vede nulla.
 */
export function PackagePicker({
  packages,
  inPrescription,
  disabled,
  onAdd,
}: {
  packages: ListItem<'pacchetto'>[] | null;
  inPrescription: (string | null | undefined)[];
  disabled: boolean;
  onAdd: (lines: PackageLine[]) => void;
}) {
  const [chosen, setChosen] = useState('');
  const [outcome, setOutcome] = useState<PackageOutcome | null>(null);
  if (!packages) return null;
  if (packages.length === 0)
    return (
      <p className="aiuto">
        I pacchetti di prestazioni dello studio si preparano in{' '}
        <Link to={listPath('pacchetto')}>Strumenti › Elenchi dello studio</Link>.
      </p>
    );
  const pkg = packages.find((p) => p.id === chosen);
  const addPackage = () => {
    if (!pkg) return;
    const r = packageLines(pkg, inPrescription);
    if (r.add.length) onAdd(r.add);
    setOutcome({
      name: pkg.etichetta,
      added: r.add.length,
      missing: r.missing,
      already: r.already,
      noCatalog: pkg.catalogo === null,
    });
  };
  return (
    <fieldset disabled={disabled}>
      <legend>Aggiungi un pacchetto</legend>
      <div className="campo">
        <label htmlFor="pacchetto-studio">Pacchetto dello studio</label>
        <select
          id="pacchetto-studio"
          value={chosen}
          onChange={(e) => {
            setChosen(e.target.value);
            setOutcome(null);
          }}
        >
          <option value="">Scegli un pacchetto</option>
          {packages.map((p) => (
            <option key={p.id} value={p.id}>
              {p.etichetta} ({count(p.dati.prestazioni.length, 'prestazione', 'prestazioni')})
            </option>
          ))}
        </select>
      </div>
      <div className="azioni">
        <button type="button" className="pulsante" disabled={!pkg} onClick={addPackage}>
          <Icon name="aggiungi" /> <span>Aggiungi in ricetta</span>
        </button>
      </div>
      {outcome && outcome.added > 0 && (
        <Notice kind="fatto">
          {outcome.added === 1 ? 'Aggiunta' : 'Aggiunte'}{' '}
          {count(outcome.added, 'prestazione', 'prestazioni')} del pacchetto «{outcome.name}».
        </Notice>
      )}
      {outcome && outcome.missing.length > 0 && (
        <Notice kind="avviso">
          <p>
            {outcome.noCatalog
              ? 'Nessun catalogo delle prestazioni in uso: le prestazioni del pacchetto non si possono cercare e non si aggiungono:'
              : outcome.missing.length === 1
                ? 'Non aggiunta, perché non è nel catalogo in vigore oggi:'
                : 'Non aggiunte, perché non sono nel catalogo in vigore oggi:'}
          </p>
          <ul>
            {outcome.missing.map((s) => (
              <li key={s.codice}>
                <span className="codice">{s.codice}</span> {s.descrizione}
              </li>
            ))}
          </ul>
          <p>
            Cercale nel catalogo, oppure aggiorna il pacchetto in{' '}
            <Link to={listPath('pacchetto')}>Strumenti › Elenchi dello studio</Link>.
          </p>
        </Notice>
      )}
      {outcome && outcome.already.length > 0 && (
        <Notice kind="info">
          Già in ricetta, non {outcome.already.length === 1 ? 'aggiunta' : 'aggiunte'} di nuovo:{' '}
          {outcome.already.map((s) => s.codice).join(', ')}.
        </Notice>
      )}
    </fieldset>
  );
}

/**
 * Prestazione scritta a mano (D154): solo se il catalogo del programma non ha ancora un codice
 * nuovo. Il servizio delle ricette della regione controlla i due codici sul catalogo che la
 * regione ha trasmesso; all'invio il programma avvisa (R18) e chiede un motivo, che resta
 * registrato.
 */
function ManualServiceForm({
  disabled,
  onAdd,
}: {
  disabled: boolean;
  onAdd: (l: {
    serviceCode: string;
    serviceNationalCode: string;
    serviceDescription: string;
  }) => void;
}) {
  const service = useRegionalService();
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [national, setNational] = useState('');
  const [description, setDescription] = useState('');
  const ready = code.trim() && national.trim() && description.trim();
  if (!open) {
    return (
      <p>
        <button
          type="button"
          className="pulsante pulsante-piatto"
          disabled={disabled}
          onClick={() => setOpen(true)}
        >
          <Icon name="aggiungi" /> <span>Prestazione non ancora nel catalogo: scrivila a mano</span>
        </button>
      </p>
    );
  }
  return (
    <fieldset className="modulo-a-mano" disabled={disabled}>
      <legend>Prestazione scritta a mano</legend>
      <p className="aiuto">
        Solo se il catalogo del programma non è ancora aggiornato. {capitalized(service.il)}{' '}
        controlla i due codici sul catalogo della regione e rifiuta la ricetta se non li trova;
        all’invio serve un motivo.
      </p>
      <div className="campo">
        <label htmlFor="a-mano-catalogo">Codice del catalogo regionale</label>
        <input
          id="a-mano-catalogo"
          className="codice"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
      </div>
      <div className="campo">
        <label htmlFor="a-mano-nomenclatore">Codice del nomenclatore (DM)</label>
        <input
          id="a-mano-nomenclatore"
          className="codice"
          value={national}
          onChange={(e) => setNational(e.target.value)}
        />
      </div>
      <div className="campo">
        <label htmlFor="a-mano-descrizione">Descrizione, come nel catalogo della Regione</label>
        <input
          id="a-mano-descrizione"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="azioni">
        <button
          type="button"
          className="pulsante"
          disabled={!ready}
          onClick={() => {
            onAdd({
              serviceCode: code.trim(),
              serviceNationalCode: national.trim(),
              serviceDescription: description.trim(),
            });
            setCode('');
            setNational('');
            setDescription('');
            setOpen(false);
          }}
        >
          <Icon name="aggiungi" /> <span>Aggiungi in ricetta</span>
        </button>
        <button type="button" className="pulsante pulsante-piatto" onClick={() => setOpen(false)}>
          <span>Chiudi</span>
        </button>
      </div>
    </fieldset>
  );
}

/**
 * Che cosa dice il catalogo della prestazione scelta (D276): la tariffa indicativa, a titolo
 * informativo; per i cicli le sedute, facoltative e non oltre il massimo del catalogo; la nota del
 * nomenclatore con il suo testo e, se la nota ha le lettere, la scelta della condizione.
 */
function CatalogDetails({
  line,
  onChange,
}: {
  line: Line;
  onChange: (patch: Partial<Line>) => void;
}) {
  const c = line.catalog!;
  const note = c.note;
  const letters = note ? noteLetters(note.text) : [];
  return (
    <div className="catalogo-riga">
      {c.fee && (
        <p className="tenue">
          Tariffa indicativa del catalogo: {money(c.fee)}, a titolo informativo
        </p>
      )}
      {c.cycle && (
        <div className="campo campo-stretto">
          <label htmlFor={`sedute-${line.key}`}>
            Sedute <span className="tenue">· {cycleText(c.maxSessions).toLowerCase()}</span>
          </label>
          <input
            id={`sedute-${line.key}`}
            type="number"
            min={1}
            {...(c.maxSessions ? { max: c.maxSessions } : {})}
            value={line.sessions ?? ''}
            onChange={(e) => onChange({ sessions: e.target.value })}
          />
        </div>
      )}
      {note && (
        <div className="nota-nomenclatore">
          <p>
            <strong>
              Nota {note.note}, {NOTE_KIND_TEXT[note.kind]}
            </strong>
            {note.kind === 'condizione'
              ? ' · in ricetta va il numero della nota, con il quesito diagnostico'
              : ' · in ricetta basta il quesito diagnostico'}
          </p>
          <p className="tenue">{note.text}</p>
          {letters.length > 0 && (
            <div className="campo campo-stretto">
              <label htmlFor={`lettera-${line.key}`}>
                {note.kind === 'condizione' ? 'Condizione' : 'Indicazione'}
              </label>
              <select
                id={`lettera-${line.key}`}
                value={line.serviceNoteLetter ?? ''}
                onChange={(e) => onChange({ serviceNoteLetter: e.target.value })}
              >
                <option value="">Non indicata</option>
                {letters.map((x) => (
                  <option key={x} value={x}>
                    {x}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
