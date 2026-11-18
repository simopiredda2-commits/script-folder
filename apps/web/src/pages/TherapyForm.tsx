import { useEffect, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import {
  DataVersions,
  ErrorMessage,
  Loading,
  PageHeader,
  type DatasetVersion,
} from '../components/common';
import { Icon } from '../components/Icon';
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
}

type DbDrug = Drug & { equivalenceGroup: string | null };

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
  };
}

/** Gli stessi controlli formali del servizio, detti prima di salvare e vicino al campo. */
export function validateDraft(d: TherapyDraft): Record<string, string> {
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
            </div>
            <button
              type="button"
              className="pulsante"
              onClick={() =>
                onChoose({
                  drugAic: d.aic,
                  drugName: [d.name, d.pack].filter(Boolean).join(' '),
                  activeIngredient: d.activeIngredient,
                  atc: d.atc,
                  drugClass: d.drugClass,
                  equivalenceGroup: d.equivalenceGroup ?? null,
                  dpc: d.dpc,
                  // La nota viene dalla banca dati; si conferma a ogni ricetta (R7).
                  aifaNote: d.aifaNote ?? '',
                })
              }
            >
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
 * Scheda della terapia, nuova o da modificare (requisiti, «Scheda della terapia»). Si salva la
 * scheda intera; quello che si sta scrivendo è ricordato per paziente, come la ricetta (D68).
 */
export function TherapyForm() {
  const { id, therapyId } = useParams<{ id: string; therapyId?: string }>();
  const navigate = useNavigate();
  const record = useApi<{ paziente: Patient; riepilogo: Summary | null }>(`/api/pazienti/${id}`);
  const therapies = useApi<{ terapie: TherapyFull[] }>(
    therapyId ? `/api/pazienti/${id}/terapie` : null,
  );
  const existing = therapyId ? therapies.data?.terapie.find((t) => t.id === therapyId) : null;
  const [draft, setDraft, resetDraft] = usePersistentState<TherapyDraft | null>(
    `terapia:${id}:${therapyId ?? 'nuova'}`,
    null,
  );
  const [changingDrug, setChangingDrug] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<ApiError | null>(null);
  const [saving, setSaving] = useState(false);

  // Si parte dalla scheda salvata (modifica) o da una scheda vuota (nuova).
  useEffect(() => {
    if (draft) return;
    if (!therapyId) setDraft(emptyDraft(studioToday()));
    else if (existing) setDraft(draftFromTherapy(existing));
  }, [draft, therapyId, existing, setDraft]);

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
      const r = therapyId
        ? await api<{ id: string }>(`/api/pazienti/${id}/terapie/${therapyId}`, {
            method: 'PUT',
            body,
          })
        : await api<{ id: string }>(`/api/pazienti/${id}/terapie`, { method: 'POST', body });
      resetDraft();
      void navigate(`/pazienti/${id}/terapie/${r.id}`, {
        state: { avviso: therapyId ? 'Scheda della terapia salvata.' : 'Terapia aggiunta.' },
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
                    {choices(ROUTES, d.route).map((v) => (
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
                  label={d.kind === 'cycle' ? 'Al (obbligatoria per il ciclo)' : 'Al (facoltativa)'}
                  error={errors.endOn}
                >
                  <input
                    {...described('endOn', errors.endOn)}
                    type="date"
                    value={d.endOn}
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
