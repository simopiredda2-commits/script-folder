import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import {
  DataVersions,
  ErrorMessage,
  Loading,
  Notice,
  PageHeader,
  type DatasetVersion,
} from '../components/common';
import { Icon } from '../components/Icon';
import { isSuspended, ShortageNote, SuspendedNote } from '../components/Shortage';
import { api, ApiError, query } from '../lib/api';
import { date, studioToday, THERAPY_KIND } from '../lib/format';
import { usePersistentState } from '../lib/storage';
import {
  dailyUnits,
  DOSE_UNITS,
  FREQUENCIES,
  patientReading,
  ROUTES,
  TIMES_OF_DAY,
} from '../lib/therapy';
import { useCatalog } from '../lib/clinical';
import {
  hasPosologyParts,
  listPath,
  matchingPosology,
  matchingSuggestor,
  posologyPatch,
  suggestorLabel,
  useStudioList,
  type ListItem,
} from '../lib/studio-lists';
import { useApi } from '../lib/useApi';
import { drugFacts, useDebounced, type Drug } from './PrescriptionEditor';
import { PatientBanner, type Patient, type Summary, type TherapyFull } from './RecordPage';

type Kind = 'chronic' | 'as_needed' | 'cycle';
type Typology = 'none' | 'S' | 'H';

/** La scheda come la si compila: testi come sullo schermo, convertiti solo al salvataggio. */
export interface TherapyDraft {
  drugAic: string | null;
  drugName: string;
  activeIngredient: string | null;
  atc: string | null;
  drugClass: string | null;
  equivalenceGroup: string | null;
  dpc: boolean;
  dose: string;
  doseUnit: string;
  frequency: string;
  timeOfDay: string;
  route: string;
  unitsPerDay: string;
  /** Vero finché il medico non corregge a mano le unità al giorno: allora si ricalcolano. */
  unitsAuto: boolean;
  kind: Kind;
  startOn: string;
  endOn: string;
  packs: string;
  indicationEntryId: string;
  habitualExemptionCode: string;
  aifaNote: string;
  patientInstructions: string;
  suggestedByName: string;
  suggestedByFacility: string;
  suggestedOn: string;
  important: boolean;
  reserved: boolean;
  notReimbursable: boolean;
  byActiveIngredient: boolean;
  notSubstitutable: boolean;
  notSubstitutableReason: string;
  multiPrescription: boolean;
  typology: Typology;
  /**
   * Terapia conclusa (tappa 15): per una scheda nuova, una terapia già finita registrata per lo
   * storico; per una scheda salvata, lo stato della terapia. Con «conclusa» la data di fine è
   * obbligatoria e non può essere nel futuro.
   */
  concluded: boolean;
}

type DbDrug = Drug & { equivalenceGroup: string | null };

/** I campi del farmaco presi dalla banca dati: gli stessi per la ricerca e per una ricetta passata. */
export function drugPatch(d: DbDrug): Partial<TherapyDraft> {
  return {
    drugAic: d.aic,
    drugName: [d.name, d.pack].filter(Boolean).join(' '),
    activeIngredient: d.activeIngredient,
    atc: d.atc,
    drugClass: d.drugClass,
    equivalenceGroup: d.equivalenceGroup ?? null,
    dpc: d.dpc,
    // La nota viene dalla banca dati; si conferma a ogni ricetta (R7).
    aifaNote: d.aifaNote ?? '',
  };
}

const comma = (v: string | null) => (v ?? '').replace('.', ',');
const sameUnits = (a: string, b: string | null) => a.replace(',', '.') === (b ?? '');

export function emptyDraft(today: string): TherapyDraft {
  return {
    drugAic: null,
    drugName: '',
    activeIngredient: null,
    atc: null,
    drugClass: null,
    equivalenceGroup: null,
    dpc: false,
    dose: '',
    doseUnit: '',
    frequency: '',
    timeOfDay: '',
    route: '',
    unitsPerDay: '',
    unitsAuto: true,
    kind: 'chronic',
    startOn: today,
    endOn: '',
    packs: '1',
    indicationEntryId: '',
    habitualExemptionCode: '',
    aifaNote: '',
    patientInstructions: '',
    suggestedByName: '',
    suggestedByFacility: '',
    suggestedOn: '',
    important: false,
    reserved: false,
    notReimbursable: false,
    byActiveIngredient: false,
    notSubstitutable: false,
    notSubstitutableReason: '',
    multiPrescription: false,
    typology: 'none',
    concluded: false,
  };
}

export function draftFromTherapy(t: TherapyFull): TherapyDraft {
  const computed = dailyUnits(t.dose, t.frequency, t.kind);
  return {
    drugAic: t.drugAic,
    drugName: t.drugName,
    activeIngredient: t.activeIngredient,
    atc: t.atc,
    drugClass: t.drugClass,
    equivalenceGroup: t.equivalenceGroup,
    dpc: t.dpc,
    dose: t.dose ?? '',
    doseUnit: t.doseUnit ?? '',
    frequency: t.frequency ?? '',
    timeOfDay: t.timeOfDay ?? '',
    route: t.route ?? '',
    unitsPerDay: comma(t.unitsPerDay),
    unitsAuto: (t.unitsPerDay ?? null) === computed,
    kind: t.kind,
    startOn: t.startOn,
    endOn: t.endOn ?? '',
    packs: String(t.packsPerPrescription),
    indicationEntryId: t.indicationEntryId ?? '',
    habitualExemptionCode: t.habitualExemptionCode ?? '',
    aifaNote: t.aifaNote ?? '',
    patientInstructions: t.patientInstructions ?? '',
    suggestedByName: t.suggestedByName ?? '',
    suggestedByFacility: t.suggestedByFacility ?? '',
    suggestedOn: t.suggestedOn ?? '',
    important: t.important,
    reserved: t.reserved,
    notReimbursable: t.notReimbursable,
    byActiveIngredient: t.byActiveIngredient,
    notSubstitutable: t.notSubstitutable,
    notSubstitutableReason: t.notSubstitutableReason ?? '',
    multiPrescription: t.multiPrescription,
    typology: t.suggestedS ? 'S' : t.hospitalH ? 'H' : 'none',
    concluded: t.status === 'ended',
  };
}

/** Gli stessi controlli formali del servizio, detti prima di salvare e vicino al campo. */
export function validateDraft(d: TherapyDraft, today = studioToday()): Record<string, string> {
  const e: Record<string, string> = {};
  if (!d.drugName.trim()) e.drugName = 'Scegli un farmaco dalla banca dati o scrivine il nome.';
  if (!/^\d{1,2}$/.test(d.packs.trim()) || Number(d.packs) < 1)
    e.packs = 'Da 1 a 99 confezioni per ricetta.';
  if (d.unitsPerDay.trim() && !/^\d+(?:[.,]\d+)?$/.test(d.unitsPerDay.trim()))
    e.unitsPerDay = 'Un numero, per esempio 1 o 0,5; vuoto se non si può dire.';
  if (!d.startOn) e.startOn = 'Manca la data di inizio.';
  if (d.kind === 'cycle' && !d.endOn) e.endOn = 'Ciclo con data di fine: manca la data di fine.';
  else if (d.endOn && d.startOn && d.endOn < d.startOn)
    e.endOn = 'La fine non può venire prima dell’inizio.';
  // Una terapia conclusa ha la data di fine vera: c'è e non è nel futuro (tappa 15).
  if (d.concluded && !e.endOn) {
    if (!d.endOn) e.endOn = 'Terapia conclusa: manca la data di fine.';
    else if (d.endOn > today) e.endOn = 'Terapia conclusa: la data di fine è nel futuro.';
  }
  if (d.notSubstitutable && !d.notSubstitutableReason.trim())
    e.notSubstitutableReason = 'Non sostituibile: serve una sintetica motivazione (R13).';
  if (d.typology === 'S' && !d.suggestedByName.trim())
    e.suggestedByName = 'Suggerita (S): servono i dati del medico suggeritore.';
  return e;
}

const orNull = (v: string) => (v.trim() === '' ? null : v.trim());

/** Il corpo per il servizio: la scheda intera (PUT o POST). */
export function draftBody(d: TherapyDraft) {
  return {
    drugAic: d.drugAic,
    drugName: d.drugName.trim(),
    activeIngredient: d.activeIngredient,
    atc: d.atc,
    drugClass: d.drugClass,
    equivalenceGroup: d.equivalenceGroup,
    dpc: d.dpc,
    dose: orNull(d.dose),
    doseUnit: orNull(d.doseUnit),
    frequency: orNull(d.frequency),
    timeOfDay: orNull(d.timeOfDay),
    route: orNull(d.route),
    unitsPerDay: orNull(d.unitsPerDay),
    kind: d.kind,
    startOn: d.startOn,
    endOn: orNull(d.endOn),
    packsPerPrescription: Number(d.packs),
    indicationEntryId: orNull(d.indicationEntryId),
    habitualExemptionCode: orNull(d.habitualExemptionCode),
    aifaNote: orNull(d.aifaNote),
    patientInstructions: orNull(d.patientInstructions),
    suggestedByName: orNull(d.suggestedByName),
    suggestedByFacility: orNull(d.suggestedByFacility),
    suggestedOn: orNull(d.suggestedOn),
    important: d.important,
    reserved: d.reserved,
    notReimbursable: d.notReimbursable,
    byActiveIngredient: d.byActiveIngredient,
    notSubstitutable: d.notSubstitutable,
    notSubstitutableReason: d.notSubstitutable ? orNull(d.notSubstitutableReason) : null,
    multiPrescription: d.multiPrescription,
    suggestedS: d.typology === 'S',
    hospitalH: d.typology === 'H',
  };
}

/** Le voci dell'elenco, più il valore già salvato se non è tra queste (non si perde). */
function choices(list: readonly string[], current: string): string[] {
  return current && !list.includes(current) ? [...list, current] : [...list];
}

function Field({
  id,
  label,
  error,
  help,
  children,
  narrow,
}: {
  id: string;
  label: string;
  error?: string;
  help?: ReactNode;
  children: ReactNode;
  narrow?: boolean;
}) {
  return (
    <div className={narrow ? 'campo campo-stretto' : 'campo'}>
      <label htmlFor={id}>{label}</label>
      {children}
      {help && (
        <p className="aiuto" id={`${id}-aiuto`}>
          {help}
        </p>
      )}
      {error && (
        <p className="errore-campo" id={`${id}-errore`}>
          <Icon name="avviso" size={18} /> {error}
        </p>
      )}
    </div>
  );
}

/** Attributi di accessibilità del campo: errore e aiuto collegati. */
function described(id: string, error?: string, help?: boolean) {
  const ids = [help ? `${id}-aiuto` : null, error ? `${id}-errore` : null].filter(Boolean);
  return {
    id,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': ids.length ? ids.join(' ') : undefined,
  } as const;
}

/** Interruttore della scheda: nome e una riga di spiegazione (prototipo della scheda). */
function Switch({
  id,
  checked,
  onChange,
  name,
  explanation,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  name: string;
  explanation: string;
}) {
  return (
    <div className="casella">
      <input
        type="checkbox"
        id={id}
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <label htmlFor={id}>
        <strong>{name}</strong> <span className="tenue">{explanation}</span>
      </label>
    </div>
  );
}

/** Il farmaco: dalla banca dati (AIC, principio attivo, ATC, classe) o, se manca, col nome. */
function DrugChooser({
  onChoose,
  error,
}: {
  onChoose: (patch: Partial<TherapyDraft>) => void;
  error?: string;
}) {
  const [text, setText] = useState('');
  const [freeName, setFreeName] = useState('');
  const [freeIngredient, setFreeIngredient] = useState('');
  const q = useDebounced(text);
  const search = useApi<{ farmaci: DbDrug[]; versioni: DatasetVersion[] }>(
    q ? `/api/farmaci${query({ q })}` : null,
  );
  return (
    <>
      <div role="search" className="ricerca">
        <label htmlFor="cerca-farmaco">Farmaco, principio attivo, codice AIC o ATC</label>
        <div className="ricerca-campo">
          <Icon name="cerca" />
          <input
            id="cerca-farmaco"
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoComplete="off"
            aria-describedby={error ? 'drugName-errore' : undefined}
          />
        </div>
      </div>
      {error && (
        <p className="errore-campo" id="drugName-errore">
          <Icon name="avviso" size={18} /> {error}
        </p>
      )}
      {search.data && (
        <DataVersions versions={search.data.versioni} label="Banche dati dei farmaci" />
      )}
      <ErrorMessage error={search.error} />
      <ul className="risultati" aria-live="polite">
        {search.data?.farmaci.map((d) => (
          <li key={d.aic} className="risultato">
            <div>
              <strong>{d.name ?? d.activeIngredient}</strong>
              <div className="tenue">{drugFacts(d).join(' · ')}</div>
              <div className="codice tenue">AIC {d.aic}</div>
              {isSuspended(d.adminState) && <SuspendedNote />}
              {d.shortage && <ShortageNote shortage={d.shortage} />}
            </div>
            <button type="button" className="pulsante" onClick={() => onChoose(drugPatch(d))}>
              <Icon name="fatto" /> <span>Scegli</span>
            </button>
          </li>
        ))}
        {q && search.data && search.data.farmaci.length === 0 && (
          <li className="tenue">Nessun farmaco per «{q}».</li>
        )}
      </ul>
      <details className="farmaco-libero">
        <summary>Il farmaco non è in banca dati</summary>
        <div className="campi-riga">
          <div className="campo">
            <label htmlFor="farmaco-libero-nome">Nome del farmaco</label>
            <input
              id="farmaco-libero-nome"
              value={freeName}
              onChange={(e) => setFreeName(e.target.value)}
            />
          </div>
          <div className="campo">
            <label htmlFor="farmaco-libero-principio">Principio attivo</label>
            <input
              id="farmaco-libero-principio"
              value={freeIngredient}
              onChange={(e) => setFreeIngredient(e.target.value)}
            />
          </div>
        </div>
        <p className="aiuto">
          Senza codice AIC le regole che leggono la banca dati non possono controllare il farmaco.
        </p>
        <button
          type="button"
          className="pulsante"
          disabled={!freeName.trim()}
          onClick={() =>
            onChoose({
              drugAic: null,
              drugName: freeName.trim(),
              activeIngredient: freeIngredient.trim() || null,
              atc: null,
              drugClass: null,
              equivalenceGroup: null,
              dpc: false,
            })
          }
        >
          <Icon name="fatto" /> <span>Usa questo nome</span>
        </button>
      </details>
    </>
  );
}

/**
 * Posologie dello studio (tappa 14): scegliendone una si riempiono le parti che ha (dose, unità,
 * frequenza, momento, via); le altre restano come sono, e tutto si può correggere. La scelta mostra
 * la posologia che i campi hanno già, se c'è. Finché l'elenco non arriva (items null) non si vede
 * nulla: la scheda funziona anche senza.
 */
export function StudioPosologyField({
  items,
  draft,
  onChoose,
}: {
  items: ListItem<'posologia'>[] | null;
  draft: Pick<TherapyDraft, 'dose' | 'doseUnit' | 'frequency' | 'timeOfDay' | 'route'>;
  onChoose: (patch: Partial<TherapyDraft>) => void;
}) {
  if (!items) return null;
  const usable = items.filter((p) => hasPosologyParts(p.dati));
  if (usable.length === 0)
    return (
      <p className="aiuto">
        Le posologie dello studio si preparano in{' '}
        <Link to={listPath('posologia')}>Strumenti › Elenchi dello studio</Link>.
      </p>
    );
  return (
    <Field
      id="posologiaStudio"
      label="Posologia dello studio"
      help="Riempie dose, unità, frequenza, momento e via come nell’elenco dello studio; poi si possono correggere."
    >
      <select
        {...described('posologiaStudio', undefined, true)}
        value={matchingPosology(usable, draft)}
        onChange={(e) => {
          const p = usable.find((x) => x.id === e.target.value);
          if (p) onChoose(posologyPatch(p.dati));
        }}
      >
        <option value="">Scegli una posologia dello studio</option>
        {usable.map((p) => (
          <option key={p.id} value={p.id}>
            {p.etichetta}
          </option>
        ))}
      </select>
    </Field>
  );
}

/** Medici suggeritori dello studio (tappa 14): scegliendone uno si riempiono medico e struttura. */
export function StudioSuggestorField({
  items,
  name,
  facility,
  onChoose,
}: {
  items: ListItem<'suggeritore'>[] | null;
  name: string;
  facility: string;
  onChoose: (patch: Partial<TherapyDraft>) => void;
}) {
  if (!items) return null;
  if (items.length === 0)
    return (
      <p className="aiuto">
        I medici suggeritori dello studio si preparano in{' '}
        <Link to={listPath('suggeritore')}>Strumenti › Elenchi dello studio</Link>.
      </p>
    );
  return (
    <Field
      id="suggeritoreStudio"
      label="Dall’elenco dello studio"
      help="Riempie medico e struttura; poi si possono correggere."
    >
      <select
        {...described('suggeritoreStudio', undefined, true)}
        value={matchingSuggestor(items, name, facility)}
        onChange={(e) => {
          const s = items.find((x) => x.id === e.target.value);
          if (s)
            onChoose({ suggestedByName: s.dati.nome, suggestedByFacility: s.dati.struttura ?? '' });
        }}
      >
        <option value="">Scegli un medico suggeritore</option>
        {items.map((s) => (
          <option key={s.id} value={s.id}>
            {suggestorLabel(s.dati)}
          </option>
        ))}
      </select>
    </Field>
  );
}

/**
 * Scheda della terapia, nuova o da modificare (requisiti, «Scheda della terapia»). Si salva la
 * scheda intera; quello che si sta scrivendo è ricordato per paziente, come la ricetta (D68).
 */
export function TherapyForm() {
  const { id, therapyId } = useParams<{ id: string; therapyId?: string }>();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const record = useApi<{ paziente: Patient; riepilogo: Summary | null }>(`/api/pazienti/${id}`);
  // Le vie con il codice del dizionario ufficiale vengono dal dominio (tappa 11).
  const routes = useCatalog().data?.vieSomministrazione ?? ROUTES;
  const therapies = useApi<{ terapie: TherapyFull[] }>(
    therapyId ? `/api/pazienti/${id}/terapie` : null,
  );
  // Elenchi dello studio (tappa 14): posologie e medici suggeritori, scelte che riempiono i campi.
  const posologies = useStudioList('posologia');
  const suggestors = useStudioList('suggeritore');
  const existing = therapyId ? therapies.data?.terapie.find((t) => t.id === therapyId) : null;
  const [draft, setDraft, resetDraft] = usePersistentState<TherapyDraft | null>(
    `terapia:${id}:${therapyId ?? 'nuova'}`,
    null,
  );
  const [changingDrug, setChangingDrug] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<ApiError | null>(null);
  const [saving, setSaving] = useState(false);
  // Una scheda nuova può partire dal farmaco di una ricetta fatta con un altro programma (tappa
  // 15): solo con un codice AIC che la banca dati in vigore oggi conosce, e con i dati di oggi.
  const baseAic = !therapyId ? params.get('aic') : null;
  const fromPast = params.get('da') === 'altro-programma';
  const base = useApi<{ farmaco: DbDrug | null }>(
    baseAic && /^\d{9}$/.test(baseAic) ? `/api/farmaci/${baseAic}` : null,
  );
  const baseApplied = useRef(false);
  const [baseOutcome, setBaseOutcome] = useState<'applicato' | 'tenuto' | 'sconosciuto' | null>(
    null,
  );

  // Si parte dalla scheda salvata (modifica) o da una scheda vuota (nuova).
  useEffect(() => {
    if (draft) return;
    if (!therapyId) setDraft(emptyDraft(studioToday()));
    else if (existing) setDraft(draftFromTherapy(existing));
  }, [draft, therapyId, existing, setDraft]);

  // Il farmaco di partenza entra solo in una scheda nuova ancora senza farmaco: una scheda già
  // iniziata con un altro farmaco resta com'è, e lo si dice.
  useEffect(() => {
    if (baseApplied.current || !draft || !base.data) return;
    baseApplied.current = true;
    const drug = base.data.farmaco;
    if (!drug) setBaseOutcome('sconosciuto');
    else if (draft.drugName) setBaseOutcome(draft.drugAic === drug.aic ? 'applicato' : 'tenuto');
    else {
      setDraft({ ...draft, ...drugPatch(drug) });
      setBaseOutcome('applicato');
    }
  }, [draft, base.data, setDraft]);

  if (record.loading && !record.data) return <Loading what="dati della cartella" />;
  if (!record.data) return <ErrorMessage error={record.error} />;
  if (therapyId && !existing && !draft) {
    if (therapies.loading || !therapies.data) return <Loading what="dati della terapia" />;
    return <ErrorMessage error={therapies.error ?? new ApiError(404, 'Terapia non trovata')} />;
  }
  if (!draft) return <Loading what="dati della terapia" />;

  const p = record.data.paziente;
  const summary = record.data.riepilogo;
  const d = draft;
  const back = therapyId ? `/pazienti/${id}/terapie/${therapyId}` : `/pazienti/${id}`;

  /** Ogni modifica passa di qui: se le unità al giorno sono automatiche, si ricalcolano. */
  const update = (patch: Partial<TherapyDraft>) =>
    setDraft((prev) => {
      const next = { ...prev!, ...patch };
      if (next.unitsAuto)
        next.unitsPerDay = comma(dailyUnits(next.dose, next.frequency, next.kind));
      return next;
    });
  const computedUnits = dailyUnits(d.dose, d.frequency, d.kind);

  const problems = summary?.problemiAttivi ?? [];
  const exemptions = summary?.esenzioni ?? [];
  const chooseDrug = !d.drugName || changingDrug;

  async function save() {
    setError(null);
    const found = validateDraft(d);
    setErrors(found);
    if (Object.keys(found).length > 0) {
      document.getElementById('problemi-scheda')?.focus();
      return;
    }
    setSaving(true);
    try {
      const body = draftBody(d);
      // «Già conclusa» vale solo per una scheda nuova: una terapia in corso si conclude con
      // «Concludi», dalla sua scheda.
      const r = therapyId
        ? await api<{ id: string }>(`/api/pazienti/${id}/terapie/${therapyId}`, {
            method: 'PUT',
            body,
          })
        : await api<{ id: string }>(`/api/pazienti/${id}/terapie`, {
            method: 'POST',
            body: d.concluded ? { ...body, concluded: true } : body,
          });
      resetDraft();
      void navigate(`/pazienti/${id}/terapie/${r.id}`, {
        state: {
          avviso: therapyId
            ? 'Scheda della terapia salvata.'
            : d.concluded
              ? 'Terapia conclusa registrata.'
              : 'Terapia aggiunta.',
        },
      });
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'Salvataggio non riuscito'));
    } finally {
      setSaving(false);
    }
  }

  const serverIssues =
    error && Array.isArray(error.details)
      ? (error.details as { message?: unknown }[])
          .map((i) => i.message)
          .filter((m): m is string => typeof m === 'string')
      : [];
  const errorList = Object.values(errors);

  return (
    <>
      <PageHeader
        title={therapyId ? `Modifica: ${existing?.drugName ?? d.drugName}` : 'Nuova terapia'}
        trail={
          <>
            <Link to={`/pazienti/${id}`}>
              {p.firstName} {p.lastName}
            </Link>{' '}
            <span aria-hidden="true">/</span>{' '}
            {therapyId ? (
              <>
                <Link to={back}>Scheda della terapia</Link> <span aria-hidden="true">/</span>{' '}
                <span>Modifica</span>
              </>
            ) : (
              <span>Nuova terapia</span>
            )}
          </>
        }
      />
      <PatientBanner patient={p} summary={summary} />
      {baseOutcome === 'applicato' && fromPast && (
        <Notice kind="info">
          Farmaco di una ricetta fatta con un altro programma, con i dati della banca dati in vigore
          oggi (AIC <span className="codice">{baseAic}</span>). Completa come si prende: la
          posologia della ricetta di prima non si copia.
        </Notice>
      )}
      {baseOutcome === 'sconosciuto' && (
        <Notice kind="avviso">
          Il codice AIC <span className="codice">{baseAic}</span> non è nella banca dati dei farmaci
          in vigore oggi: non si può usare come base. Scegli il farmaco qui sotto.
        </Notice>
      )}
      {baseOutcome === 'tenuto' && (
        <Notice kind="avviso">
          C’era già una scheda nuova iniziata con «{d.drugName}»: è rimasta com’era. Per partire dal
          farmaco della ricetta fatta con un altro programma, annulla le modifiche e riprova.
        </Notice>
      )}

      <form
        className="scheda-terapia"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div
          id="problemi-scheda"
          tabIndex={-1}
          role={errorList.length > 0 ? 'alert' : undefined}
          className={errorList.length > 0 ? 'messaggio messaggio-errore' : undefined}
        >
          {errorList.length > 0 && (
            <>
              <Icon name="avviso" />
              <div>
                <p>La scheda non si può salvare:</p>
                <ul>
                  {errorList.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              </div>
            </>
          )}
        </div>

        <div className="griglia-cartella">
          <div>
            <section className="riquadro" aria-labelledby="titolo-farmaco">
              <h2 id="titolo-farmaco">Il farmaco</h2>
              {d.drugName && (
                <div className="farmaco-scelto">
                  <p>
                    <strong>{d.drugName}</strong>
                  </p>
                  <p className="tenue">
                    {[
                      d.activeIngredient && `principio attivo ${d.activeIngredient}`,
                      d.atc && `ATC ${d.atc}`,
                      d.drugClass && `classe ${d.drugClass}`,
                      d.dpc && 'in DPC',
                    ]
                      .filter(Boolean)
                      .join(' · ') || 'Farmaco scritto a mano, senza dati della banca dati'}
                  </p>
                  {d.drugAic && <p className="codice tenue">AIC {d.drugAic}</p>}
                  {!changingDrug && (
                    <button
                      type="button"
                      className="pulsante"
                      onClick={() => setChangingDrug(true)}
                    >
                      <Icon name="ripeti" /> <span>Cambia farmaco</span>
                    </button>
                  )}
                </div>
              )}
              {chooseDrug && (
                <>
                  <DrugChooser
                    error={errors.drugName}
                    onChoose={(patch) => {
                      update(patch);
                      setChangingDrug(false);
                    }}
                  />
                  {changingDrug && (
                    <button
                      type="button"
                      className="pulsante pulsante-piatto"
                      onClick={() => setChangingDrug(false)}
                    >
                      <Icon name="annulla" /> <span>Tieni il farmaco di prima</span>
                    </button>
                  )}
                </>
              )}
            </section>

            <section className="riquadro" aria-labelledby="titolo-come">
              <h2 id="titolo-come">Come si prende</h2>
              <StudioPosologyField
                items={posologies.data?.voci ?? null}
                draft={d}
                onChoose={update}
              />
              <div className="campi-riga">
                <Field id="dose" label="Dose" narrow>
                  <input
                    {...described('dose')}
                    inputMode="decimal"
                    value={d.dose}
                    onChange={(e) => update({ dose: e.target.value })}
                  />
                </Field>
                <Field id="doseUnit" label="Unità">
                  <select
                    {...described('doseUnit')}
                    value={d.doseUnit}
                    onChange={(e) => update({ doseUnit: e.target.value })}
                  >
                    <option value="">Non indicata</option>
                    {choices(DOSE_UNITS, d.doseUnit).map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </Field>
                <Field id="frequency" label="Frequenza">
                  <select
                    {...described('frequency')}
                    value={d.frequency}
                    onChange={(e) => update({ frequency: e.target.value })}
                  >
                    <option value="">Non indicata</option>
                    {choices(FREQUENCIES, d.frequency).map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </Field>
                <Field id="timeOfDay" label="Momento">
                  <select
                    {...described('timeOfDay')}
                    value={d.timeOfDay}
                    onChange={(e) => update({ timeOfDay: e.target.value })}
                  >
                    <option value="">Non indicato</option>
                    {choices(TIMES_OF_DAY, d.timeOfDay).map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </Field>
                <Field id="route" label="Via">
                  <select
                    {...described('route')}
                    value={d.route}
                    onChange={(e) => update({ route: e.target.value })}
                  >
                    <option value="">Non indicata</option>
                    {choices(routes, d.route).map((v) => (
                      <option key={v}>{v}</option>
                    ))}
                  </select>
                </Field>
              </div>
              <div className="anteprima">
                <p className="anteprima-titolo">Come la legge il paziente</p>
                <p aria-live="polite">{patientReading(d) || '—'}</p>
              </div>

              <fieldset className="scelta scelta-in-riga">
                <legend>Tipo di terapia</legend>
                {(Object.keys(THERAPY_KIND) as Kind[]).map((k) => (
                  <div key={k} className="casella">
                    <input
                      type="radio"
                      id={`tipo-${k}`}
                      name="tipo-terapia"
                      checked={d.kind === k}
                      onChange={() => update({ kind: k })}
                    />
                    <label htmlFor={`tipo-${k}`}>{THERAPY_KIND[k]}</label>
                  </div>
                ))}
              </fieldset>
              {!therapyId && (
                <Switch
                  id="giaConclusa"
                  checked={d.concluded}
                  onChange={(v) => update({ concluded: v })}
                  name="Terapia già conclusa"
                  explanation="Si registra per lo storico, con la data di fine vera: non si ripete e non va nello schema orario."
                />
              )}
              {therapyId && d.concluded && (
                <p className="aiuto">
                  Terapia conclusa: la data di fine resta obbligatoria. Per riprendere lo stesso
                  farmaco serve una terapia nuova.
                </p>
              )}
              <div className="campi-riga">
                <Field id="startOn" label="Dal" error={errors.startOn}>
                  <input
                    {...described('startOn', errors.startOn)}
                    type="date"
                    value={d.startOn}
                    onChange={(e) => update({ startOn: e.target.value })}
                  />
                </Field>
                <Field
                  id="endOn"
                  label={
                    d.concluded
                      ? 'Conclusa il (obbligatoria)'
                      : d.kind === 'cycle'
                        ? 'Al (obbligatoria per il ciclo)'
                        : 'Al (facoltativa)'
                  }
                  error={errors.endOn}
                >
                  <input
                    {...described('endOn', errors.endOn)}
                    type="date"
                    value={d.endOn}
                    max={d.concluded ? studioToday() : undefined}
                    onChange={(e) => update({ endOn: e.target.value })}
                  />
                </Field>
              </div>
              <Field
                id="unitsPerDay"
                label="Unità al giorno, per il contatore (R11)"
                error={errors.unitsPerDay}
                help={
                  d.unitsAuto
                    ? computedUnits
                      ? 'Calcolata da dose e frequenza; puoi correggerla.'
                      : 'Non si calcola: al bisogno, oppure dose o frequenza mancanti. Senza, il contatore non conta.'
                    : `Corretta a mano${computedUnits ? `; dal calcolo verrebbe ${comma(computedUnits)}` : ''}.`
                }
              >
                <div className="campo-con-pulsante">
                  <input
                    {...described('unitsPerDay', errors.unitsPerDay, true)}
                    inputMode="decimal"
                    value={d.unitsPerDay}
                    onChange={(e) =>
                      update({
                        unitsPerDay: e.target.value,
                        unitsAuto: sameUnits(e.target.value, computedUnits),
                      })
                    }
                  />
                  {!d.unitsAuto && (
                    <button
                      type="button"
                      className="pulsante"
                      onClick={() => update({ unitsAuto: true })}
                    >
                      <Icon name="ripeti" /> <span>Ricalcola</span>
                    </button>
                  )}
                </div>
              </Field>
              <Field id="indication" label="Indicazione">
                <select
                  {...described('indication')}
                  value={d.indicationEntryId}
                  onChange={(e) => update({ indicationEntryId: e.target.value })}
                >
                  <option value="">Nessuna indicazione</option>
                  {problems.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.descrizione}
                      {x.codice ? ` · ${x.codice}` : ''}
                    </option>
                  ))}
                  {d.indicationEntryId && !problems.some((x) => x.id === d.indicationEntryId) && (
                    <option value={d.indicationEntryId}>
                      Indicazione registrata (problema non più tra gli attivi)
                    </option>
                  )}
                </select>
              </Field>
              <Field
                id="patientInstructions"
                label="Istruzioni per il paziente"
                help="Vanno sul promemoria e sullo schema orario."
              >
                <textarea
                  {...described('patientInstructions', undefined, true)}
                  rows={2}
                  value={d.patientInstructions}
                  onChange={(e) => update({ patientInstructions: e.target.value })}
                />
              </Field>
            </section>
          </div>

          <div>
            <section className="riquadro" aria-labelledby="titolo-in-ricetta">
              <h2 id="titolo-in-ricetta">In ricetta</h2>
              <div className="campi-riga">
                <Field id="packs" label="Confezioni per ricetta" error={errors.packs} narrow>
                  <input
                    {...described('packs', errors.packs)}
                    inputMode="numeric"
                    value={d.packs}
                    onChange={(e) => update({ packs: e.target.value })}
                  />
                </Field>
                <Field id="habitualExemptionCode" label="Esenzione abituale">
                  <select
                    {...described('habitualExemptionCode')}
                    value={d.habitualExemptionCode}
                    onChange={(e) => update({ habitualExemptionCode: e.target.value })}
                  >
                    <option value="">Nessuna</option>
                    {exemptions.map((x) => (
                      <option key={x.codice} value={x.codice}>
                        {x.codice}
                        {x.al ? ` · valida fino al ${date(x.al)}` : ''}
                      </option>
                    ))}
                    {d.habitualExemptionCode &&
                      !exemptions.some((x) => x.codice === d.habitualExemptionCode) && (
                        <option value={d.habitualExemptionCode}>
                          {d.habitualExemptionCode} (non tra le esenzioni del paziente)
                        </option>
                      )}
                  </select>
                </Field>
                <Field
                  id="aifaNote"
                  label="Nota AIFA"
                  help="Da confermare a ogni ricetta (R7)."
                  narrow
                >
                  <input
                    {...described('aifaNote', undefined, true)}
                    value={d.aifaNote}
                    onChange={(e) => update({ aifaNote: e.target.value })}
                  />
                </Field>
              </div>
              <Switch
                id="perPrincipio"
                checked={d.byActiveIngredient}
                onChange={(v) => update({ byActiveIngredient: v })}
                name="Per principio attivo"
                explanation="In ricetta va il principio attivo: il farmacista può dare un equivalente dello stesso gruppo."
              />
              <Switch
                id="nonSostituibile"
                checked={d.notSubstitutable}
                onChange={(v) => update({ notSubstitutable: v })}
                name="Non sostituibile"
                explanation="Vincola il farmacista a questo medicinale; serve una sintetica motivazione (R13)."
              />
              {d.notSubstitutable && (
                <Field
                  id="notSubstitutableReason"
                  label="Motivazione della non sostituibilità"
                  error={errors.notSubstitutableReason}
                >
                  <textarea
                    {...described('notSubstitutableReason', errors.notSubstitutableReason)}
                    rows={2}
                    value={d.notSubstitutableReason}
                    onChange={(e) => update({ notSubstitutableReason: e.target.value })}
                  />
                </Field>
              )}
              <Switch
                id="nonRimborsabile"
                checked={d.notReimbursable}
                onChange={(v) => update({ notReimbursable: v })}
                name="Non rimborsabile SSN"
                explanation="Si prescrive solo su ricetta bianca, a carico del paziente (R8)."
              />
              <Switch
                id="multiprescrizione"
                checked={d.multiPrescription}
                onChange={(v) => update({ multiPrescription: v })}
                name="Multiprescrizione"
                explanation="Fino a 6 confezioni, solo con le condizioni di R3 o R4: le controllano le regole."
              />
              <fieldset className="scelta scelta-in-riga">
                <legend>Tipologia sulla ricetta</legend>
                {(
                  [
                    ['none', 'Nessuna'],
                    ['S', 'Suggerita (S)'],
                    ['H', 'Ricovero (H)'],
                  ] as const
                ).map(([v, label]) => (
                  <div key={v} className="casella">
                    <input
                      type="radio"
                      id={`tipologia-${v}`}
                      name="tipologia"
                      checked={d.typology === v}
                      onChange={() => update({ typology: v })}
                    />
                    <label htmlFor={`tipologia-${v}`}>{label}</label>
                  </div>
                ))}
              </fieldset>
              <p className="aiuto">Suggerita (S) richiede i dati del medico suggeritore.</p>
            </section>

            <section className="riquadro" aria-labelledby="titolo-in-cartella">
              <h2 id="titolo-in-cartella">In cartella</h2>
              <Switch
                id="importante"
                checked={d.important}
                onChange={(v) => update({ important: v })}
                name="Importante"
                explanation="Sempre visibile nella testata della cartella."
              />
              <Switch
                id="riservata"
                checked={d.reserved}
                onChange={(v) => update({ reserved: v })}
                name="Riservata"
                explanation="Visibile solo al medico; esclusa da segreteria e portale paziente."
              />
            </section>

            <section className="riquadro" aria-labelledby="titolo-suggeritore">
              <h2 id="titolo-suggeritore">Medico suggeritore</h2>
              <p className="aiuto">
                Si compila quando la terapia arriva da uno specialista o da una dimissione.
              </p>
              <StudioSuggestorField
                items={suggestors.data?.voci ?? null}
                name={d.suggestedByName}
                facility={d.suggestedByFacility}
                onChoose={update}
              />
              <Field id="suggestedByName" label="Medico" error={errors.suggestedByName}>
                <input
                  {...described('suggestedByName', errors.suggestedByName)}
                  value={d.suggestedByName}
                  onChange={(e) => update({ suggestedByName: e.target.value })}
                />
              </Field>
              <div className="campi-riga">
                <Field id="suggestedByFacility" label="Struttura">
                  <input
                    {...described('suggestedByFacility')}
                    value={d.suggestedByFacility}
                    onChange={(e) => update({ suggestedByFacility: e.target.value })}
                  />
                </Field>
                <Field id="suggestedOn" label="Data">
                  <input
                    {...described('suggestedOn')}
                    type="date"
                    value={d.suggestedOn}
                    onChange={(e) => update({ suggestedOn: e.target.value })}
                  />
                </Field>
              </div>
            </section>
          </div>
        </div>

        {error && (
          <div className="messaggio messaggio-errore" role="alert">
            <Icon name="avviso" />
            <div>
              <p>{error.message}</p>
              {serverIssues.length > 0 && (
                <ul>
                  {serverIssues.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        )}
        <div className="azioni barra-azioni">
          <button type="submit" className="pulsante pulsante-primario" disabled={saving}>
            <Icon name="fatto" /> <span>{saving ? 'Salvataggio…' : 'Salva la scheda'}</span>
          </button>
          <button
            type="button"
            className="pulsante"
            onClick={() => {
              resetDraft();
              void navigate(back);
            }}
          >
            <Icon name="annulla" /> <span>Annulla le modifiche</span>
          </button>
        </div>
      </form>
    </>
  );
}

/**
 * Conclusione di una terapia in corso o sospesa, con la data di fine vera (tappa 15). Non è la
 * sospensione: la terapia conclusa non si riprende; resta tra i farmaci prescritti con il suo
 * storico, e per lo stesso farmaco serve una terapia nuova.
 */
export function ConcludeTherapyPanel({
  patientId,
  therapy,
  onDone,
  onCancel,
}: {
  patientId: string;
  therapy: TherapyFull;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const today = studioToday();
  const [end, setEnd] = useState(today);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  /** Gli stessi controlli del servizio, detti prima di mandare. */
  function problem(): string | null {
    if (!end) return 'Scrivi la data di fine.';
    if (end > today)
      return 'La data di fine non può essere nel futuro: una fine prevista va nel campo «Al» della scheda.';
    if (end < therapy.startOn) return 'La fine non può venire prima dell’inizio.';
    return null;
  }

  return (
    <form
      className="riquadro pannello-sospensione"
      aria-labelledby="titolo-conclusione"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        const p = problem();
        if (p) {
          setError(new ApiError(400, p));
          return;
        }
        setBusy(true);
        setError(null);
        api(`/api/pazienti/${patientId}/terapie/${therapy.id}/concludi`, {
          method: 'POST',
          body: { fine: end },
        })
          .then(() =>
            onDone(
              `Terapia conclusa il ${date(end)}: è tra le terapie sospese o concluse dei farmaci prescritti.`,
            ),
          )
          .catch((err: unknown) =>
            setError(err instanceof ApiError ? err : new ApiError(0, 'Servizio non raggiungibile')),
          )
          .finally(() => setBusy(false));
      }}
    >
      <h2 id="titolo-conclusione">Concludi la terapia</h2>
      <p className="aiuto">
        La terapia finisce: non si ripete, non va nello schema orario e resta tra i farmaci
        prescritti con il suo storico. Non è una sospensione: una terapia conclusa non si riprende.
      </p>
      <div className="campo campo-stretto">
        <label htmlFor="fine-terapia">Conclusa il</label>
        <input
          id="fine-terapia"
          type="date"
          min={therapy.startOn}
          max={today}
          value={end}
          onChange={(e) => setEnd(e.target.value)}
        />
      </div>
      <ErrorMessage error={error} />
      <div className="azioni">
        <button type="submit" className="pulsante pulsante-primario" disabled={busy}>
          <Icon name="fatto" /> <span>Concludi la terapia</span>
        </button>
        <button type="button" className="pulsante" onClick={onCancel}>
          <Icon name="annulla" /> <span>Non concludere</span>
        </button>
      </div>
    </form>
  );
}
