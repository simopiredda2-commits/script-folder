import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { useOpenRecords } from '../lib/openRecords';
import { ErrorMessage, Loading, Notice, PageHeader } from '../components/common';
import { useBandPublisher } from '../components/PatientLayout';
import { PatientFacts } from '../components/PatientFacts';
import { ColourLegend, drugRowClass, originOf, OriginTag } from '../components/DrugColours';
import { ServicesSection, type PrescribedService } from '../components/Prescribed';
import { Icon } from '../components/Icon';
import {
  AifaChangeNote,
  ShortageNote,
  type AifaChange,
  type DrugShortage,
} from '../components/Shortage';
import { api, ApiError, query } from '../lib/api';
import { date, THERAPY_KIND, TIMELINE_KIND } from '../lib/format';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';
import { RegistrySection, type Registry } from './RegistrySection';

export interface Patient {
  id: string;
  firstName: string;
  lastName: string;
  sex: 'M' | 'F';
  birthDate: string;
  birthPlaceName: string | null;
  fiscalCode: string;
  phone: string | null;
  email: string | null;
  asl: string | null;
  status: string;
  /** Data del decesso, per un paziente deceduto. */
  deceasedOn?: string | null;
}

export interface Summary {
  allergie: { sostanza: string; reazione: string | null }[];
  problemiAttivi: { id: string; descrizione: string; codice: string | null; dal: string | null }[];
  pianiTerapeutici: { farmaco: string; scadenza: string }[];
  esenzioni: { codice: string; dal: string; al: string | null }[];
  /** Le esenzioni in corso oggi, con la descrizione del catalogo, per la testata (D244). */
  esenzioniInCorso?: { codice: string; descrizione: string | null; al: string | null }[];
  parametri: { data: string; parametro: string; valore: string; unita: string }[];
}

export interface TherapyRow {
  id: string;
  drugName: string;
  drugAic: string | null;
  activeIngredient: string | null;
  kind: 'chronic' | 'as_needed' | 'cycle';
  status: string;
  dose: string | null;
  doseUnit: string | null;
  frequency: string | null;
  timeOfDay: string | null;
  aifaNote: string | null;
  reserved: boolean;
  important: boolean;
  /** Carenza del farmaco secondo l'elenco AIFA, per le terapie non concluse (D202). */
  shortage?: DrugShortage | null;
  /** Le altre variazioni AIFA, per le terapie non concluse (A7, D205). */
  aifaChanges?: AifaChange[];
  /** «Confezioni per ricetta» della scheda: le confezioni con cui la terapia entra in ricetta (D250). */
  packsPerPrescription?: number;
}

/** La scheda intera, come la restituisce il servizio. */
export interface TherapyFull extends TherapyRow {
  atc: string | null;
  drugClass: string | null;
  equivalenceGroup: string | null;
  dpc: boolean;
  route: string | null;
  unitsPerDay: string | null;
  startOn: string;
  endOn: string | null;
  packsPerPrescription: number;
  indicationEntryId: string | null;
  habitualExemptionCode: string | null;
  suggestedByName: string | null;
  suggestedByFacility: string | null;
  suggestedOn: string | null;
  patientInstructions: string | null;
  notReimbursable: boolean;
  byActiveIngredient: boolean;
  notSubstitutable: boolean;
  notSubstitutableReason: string | null;
  multiPrescription: boolean;
  suggestedS: boolean;
  hospitalH: boolean;
  suspendedReason: string | null;
}

export const posology = (t: TherapyRow) =>
  [t.dose && `${t.dose} ${t.doseUnit ?? ''}`.trim(), t.frequency, t.timeOfDay]
    .filter(Boolean)
    .join(', ');

/**
 * Testata della cartella: chi è il paziente, allergie ed esenzioni sempre in vista. Ogni pagina
 * di un paziente la mostra, e aprendola il paziente entra tra le cartelle aperte (D68). Dentro la
 * cartella (D244) la passa alla fascia fissa in alto, che resta mentre si cambia pagina.
 */
export function PatientBanner({
  patient,
  summary,
}: {
  patient: Patient;
  summary?: Summary | null;
}) {
  const { open } = useOpenRecords();
  const location = useLocation();
  const publish = useBandPublisher();
  useEffect(() => {
    open({
      id: patient.id,
      lastName: patient.lastName,
      firstName: patient.firstName,
      birthDate: patient.birthDate,
      lastPath: location.pathname + location.search,
    });
    // Solo all'apertura del paziente: i cambi di pagina li segue la barra delle cartelle.
  }, [patient.id]);
  useEffect(() => {
    publish?.({ patient, summary });
  }, [publish, patient, summary]);
  return publish ? null : <PatientFacts patient={patient} summary={summary} />;
}

function Forbidden({ error, what }: { error: ApiError | null; what: string }) {
  if (error?.status === 403) return <p className="tenue">{what}: non visibile con il tuo ruolo.</p>;
  return <ErrorMessage error={error} />;
}

const FILTERS = [
  ['tutto', 'Tutto'],
  ['visite', 'Visite'],
  ['ricette', 'Ricette'],
  ['esami', 'Esami'],
] as const;

export function RecordPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { isDoctor } = useSession();
  const record = useApi<{ paziente: Patient & Partial<Registry>; riepilogo: Summary | null }>(
    `/api/pazienti/${id}`,
  );
  const therapies = useApi<{ terapie: TherapyFull[] }>(`/api/pazienti/${id}/terapie`);
  const services = useApi<{ prestazioni: PrescribedService[] }>(
    `/api/pazienti/${id}/prestazioni-prescritte`,
  );
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>('tutto');
  const timeline = useApi<{
    cronologia: {
      id: string;
      data: string;
      tipo: string;
      titolo: string;
      testo: string | null;
      annullata: boolean;
      autore: string | null;
    }[];
  }>(`/api/pazienti/${id}/cronologia${query({ tipo: filter })}`);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [repeatError, setRepeatError] = useState<ApiError | null>(null);
  const [repeatDone, setRepeatDone] = useState<string | null>(null);

  if (record.loading && !record.data) return <Loading what="dati della cartella" />;
  if (!record.data) return <ErrorMessage error={record.error} />;
  const { paziente: p, riepilogo } = record.data;
  const active = (therapies.data?.terapie ?? []).filter((t) => t.status === 'active');
  const suspended = (therapies.data?.terapie ?? []).filter((t) => t.status === 'suspended');

  async function repeat() {
    setRepeatError(null);
    try {
      const r = await api<{ ricette: unknown[] }>(`/api/pazienti/${id}/ricette/ripeti`, {
        method: 'POST',
        body: { terapie: [...selected] },
      });
      setSelected(new Set());
      setRepeatDone(
        isDoctor
          ? `${r.ricette.length === 1 ? 'Preparata 1 ricetta' : `Preparate ${r.ricette.length} ricette`} in bozza.`
          : `${r.ricette.length === 1 ? 'Preparata 1 ricetta' : `Preparate ${r.ricette.length} ricette`}: sono nella coda «da firmare» del medico.`,
      );
    } catch (e) {
      setRepeatError(e instanceof ApiError ? e : null);
    }
  }

  return (
    <>
      {/* Il nome sta nella fascia fissa della cartella (D244): qui il titolo è la voce del menu. */}
      <PageHeader
        title="Riepilogo"
        trail={
          <>
            <Link to="/pazienti">Pazienti</Link> <span aria-hidden="true">/</span>{' '}
            <span>
              {p.firstName} {p.lastName}
            </span>
          </>
        }
      />
      <PatientBanner patient={p} summary={riepilogo} />

      <div className="griglia-cartella">
        {riepilogo ? (
          <section className="riquadro" aria-labelledby="titolo-problemi">
            <h2 id="titolo-problemi">Problemi attivi</h2>
            <p>
              <Link to={`/pazienti/${id}/voci?tipo=problema`}>Problemi e diagnosi</Link>
            </p>
            {riepilogo.problemiAttivi.length === 0 ? (
              <p className="tenue">Nessun problema attivo.</p>
            ) : (
              <ul className="elenco-semplice">
                {riepilogo.problemiAttivi.map((x) => (
                  <li key={`${x.descrizione}-${x.codice}`}>
                    {x.descrizione}
                    {x.codice && <span className="codice tenue"> {x.codice}</span>}
                    {x.dal && <span className="tenue"> · dal {date(x.dal)}</span>}
                  </li>
                ))}
              </ul>
            )}
            <h3>Scadenze</h3>
            {riepilogo.pianiTerapeutici.length === 0 ? (
              <p className="tenue">Nessun piano terapeutico.</p>
            ) : (
              <ul className="elenco-semplice">
                {riepilogo.pianiTerapeutici.map((x) => (
                  <li key={`${x.farmaco}-${x.scadenza}`}>
                    Piano terapeutico {x.farmaco}: scade il {date(x.scadenza)}
                  </li>
                ))}
              </ul>
            )}
            <h3>Parametri</h3>
            <p>
              <Link to={`/pazienti/${id}/parametri`}>Andamento dei parametri</Link>
            </p>
            {riepilogo.parametri.length === 0 ? (
              <p className="tenue">Nessun parametro negli ultimi 12 mesi.</p>
            ) : (
              <dl className="parametri">
                {riepilogo.parametri.map((x) => (
                  <div key={x.parametro}>
                    <dt>{x.parametro}</dt>
                    <dd>
                      {x.valore} {x.unita}
                      <span className="parametro-data">{date(x.data)}</span>
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </section>
        ) : (
          <section className="riquadro">
            <h2>Riepilogo clinico</h2>
            <p className="tenue">Non visibile con il tuo ruolo.</p>
          </section>
        )}

        <section className="riquadro" aria-labelledby="titolo-terapia">
          {/* La legenda piccola, a destra del titolo (D246). */}
          <div className="riquadro-testa">
            <h2 id="titolo-terapia">
              <Icon name="terapia" /> Terapia in corso
            </h2>
            <ColourLegend />
          </div>
          <div className="azioni">
            {isDoctor && (
              <Link className="pulsante" to={`/pazienti/${id}/terapie/nuova`}>
                <Icon name="aggiungi" /> <span>Nuova terapia</span>
              </Link>
            )}
            <Link className="pulsante pulsante-piatto" to={`/pazienti/${id}/schema-orario`}>
              <Icon name="stampa" /> <span>Schema orario</span>
            </Link>
          </div>
          {therapies.loading && !therapies.data && <Loading what="terapie" />}
          <Forbidden error={therapies.error} what="Terapie" />
          {therapies.data && active.length === 0 && (
            <p className="tenue">Nessuna terapia in corso.</p>
          )}
          {active.length > 0 && (
            <fieldset className="terapie">
              <legend className="visivamente-nascosto">Terapie da ripetere</legend>
              <ul>
                {active.map((t) => (
                  <li
                    key={t.id}
                    className={`terapia-riga ${drugRowClass({ tipo: t.kind, stato: t.status })}`}
                  >
                    {t.kind === 'chronic' ? (
                      // L'etichetta intorno alla casella porta il bersaglio a 44 px.
                      <label className="bersaglio-casella">
                        <input
                          type="checkbox"
                          checked={selected.has(t.id)}
                          onChange={(e) => {
                            const next = new Set(selected);
                            if (e.target.checked) next.add(t.id);
                            else next.delete(t.id);
                            setSelected(next);
                          }}
                          aria-label={`Seleziona ${t.drugName} da ripetere`}
                        />
                      </label>
                    ) : (
                      <span className="segnaposto-casella" aria-hidden="true" />
                    )}
                    <div className="terapia-testo">
                      <Link to={`/pazienti/${id}/terapie/${t.id}`} className="terapia-nome">
                        {t.drugName}
                      </Link>
                      <span className="tenue">{posology(t)}</span>
                      <span>
                        {/* Il tipo lo dicono sfondo e tratto della barra, con la legenda (D248). */}
                        <span className="visivamente-nascosto">{THERAPY_KIND[t.kind]}</span>
                        <OriginTag origin={originOf(t)} />
                        {t.aifaNote && <span className="etichetta">Nota {t.aifaNote}</span>}
                        {t.reserved && <span className="etichetta">Riservata</span>}
                      </span>
                      {t.shortage && <ShortageNote shortage={t.shortage} />}
                      {(t.aifaChanges ?? []).map((c) => (
                        <AifaChangeNote key={`${c.kind}-${c.text}`} change={c} />
                      ))}
                    </div>
                    {/* Il nome apre scheda e storico: niente pulsante che lo ripeta (D246). */}
                  </li>
                ))}
              </ul>
              <div className="azioni">
                <button
                  type="button"
                  className="pulsante pulsante-primario"
                  disabled={selected.size === 0}
                  onClick={() => void repeat()}
                >
                  <Icon name="ripeti" />
                  <span>
                    Ripeti{' '}
                    {selected.size === 0
                      ? 'le terapie scelte'
                      : selected.size === 1
                        ? '1 terapia'
                        : `${selected.size} terapie`}
                  </span>
                </button>
                {isDoctor && (
                  <button
                    type="button"
                    className="pulsante"
                    onClick={() => void navigate('/ricette')}
                  >
                    <Icon name="firma" /> <span>Vai alle ricette da firmare</span>
                  </button>
                )}
              </div>
              <p className="aiuto">
                Si ripetono solo le terapie croniche; il limite di confezioni lo decidono le regole.
              </p>
            </fieldset>
          )}
          <ErrorMessage error={repeatError} />
          {repeatDone && <Notice kind="fatto">{repeatDone}</Notice>}

          {suspended.length > 0 && (
            <>
              <h3>Terapie sospese</h3>
              <ul className="elenco-semplice">
                {suspended.map((t) => (
                  <li key={t.id}>
                    <Link to={`/pazienti/${id}/terapie/${t.id}`}>{t.drugName}</Link>
                    <span className="tenue">
                      {' '}
                      · sospesa{t.suspendedReason ? `: ${t.suspendedReason}` : ''}
                    </span>
                    {t.shortage && <ShortageNote shortage={t.shortage} />}
                    {(t.aifaChanges ?? []).map((c) => (
                      <AifaChangeNote key={`${c.kind}-${c.text}`} change={c} />
                    ))}
                  </li>
                ))}
              </ul>
            </>
          )}

          <p>
            <Link to={`/pazienti/${id}/farmaci`}>
              Tutti i farmaci prescritti, con il loro storico
            </Link>
          </p>
        </section>

        <ServicesSection patientId={id!} services={services} />
      </div>

      <RegistrySection patient={p} onSaved={record.reload} />

      <section className="riquadro" aria-labelledby="titolo-cronologia">
        <h2 id="titolo-cronologia">
          <Icon name="storico" /> Cronologia
        </h2>
        <div className="schede" role="group" aria-label="Filtra la cronologia">
          {FILTERS.map(([k, label]) => (
            <button
              key={k}
              type="button"
              className="scheda"
              aria-pressed={filter === k}
              onClick={() => setFilter(k)}
            >
              {label}
            </button>
          ))}
        </div>
        <Forbidden error={timeline.error} what="Cronologia clinica" />
        {timeline.loading && !timeline.data && <Loading what="voci" />}
        {timeline.data && (
          <ol className="cronologia" aria-live="polite">
            {timeline.data.cronologia.length === 0 && <li className="tenue">Nessuna voce.</li>}
            {timeline.data.cronologia.map((v) => (
              <li key={`${v.tipo}-${v.id}`} className={v.annullata ? 'annullata' : undefined}>
                <span className="cronologia-data">{date(v.data)}</span>
                <span className="etichetta">{TIMELINE_KIND[v.tipo] ?? v.tipo}</span>
                <span>
                  <strong>{v.titolo}</strong>
                  {v.testo && <span> · {v.testo}</span>}
                  {v.annullata && <span> (annullata)</span>}
                  {v.autore && <span className="tenue"> · {v.autore}</span>}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </>
  );
}
