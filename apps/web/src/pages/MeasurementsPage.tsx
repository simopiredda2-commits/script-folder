import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { ErrorMessage, Loading, Notice, PageHeader } from '../components/common';
import { Icon } from '../components/Icon';
import { TrendChart, type TrendSeries } from '../components/TrendChart';
import { api, ApiError } from '../lib/api';
import { useCatalog, type Catalog, type Series } from '../lib/clinical';
import { date, studioToday } from '../lib/format';
import { usePersistentState } from '../lib/storage';
import { useApi } from '../lib/useApi';
import { PatientBanner, type Patient, type Summary } from './RecordPage';

const SYSTOLIC = 'Pressione sistolica';
const DIASTOLIC = 'Pressione diastolica';

interface Group {
  key: string;
  title: string;
  unit: string;
  series: TrendSeries[];
  /** Le serie del servizio, per la tabella. */
  raw: Series[];
}

/** La pressione in un solo grafico (stessa unità, due serie); gli altri parametri uno ciascuno. */
function groups(series: Series[]): Group[] {
  const toTrend = (s: Series, name: string, i: 0 | 1): TrendSeries => ({
    name,
    tone: i === 0 ? 'serie-1' : 'serie-2',
    marker: i === 0 ? 'cerchio' : 'quadrato',
    points: s.valori.map((v) => ({ data: v.data, valore: Number(v.valore) })),
  });
  const out: Group[] = [];
  const sys = series.find((s) => s.parametro === SYSTOLIC && s.unita === 'mmHg');
  const dia = series.find((s) => s.parametro === DIASTOLIC && s.unita === 'mmHg');
  if (sys || dia) {
    const raw = [sys, dia].filter((s): s is Series => !!s);
    out.push({
      key: 'pressione',
      title: 'Pressione arteriosa',
      unit: 'mmHg',
      series: [
        ...(sys ? [toTrend(sys, 'Sistolica', 0)] : []),
        ...(dia ? [toTrend(dia, 'Diastolica', sys ? 1 : 0)] : []),
      ],
      raw,
    });
  }
  for (const s of series) {
    if (s === sys || s === dia) continue;
    out.push({
      key: `${s.parametro}-${s.unita}`,
      title: s.parametro,
      unit: s.unita,
      series: [toTrend(s, s.parametro, 0)],
      raw: [s],
    });
  }
  return out;
}

const decimal = (v: string) => v.replace('.', ',');

/**
 * Parametri e misure (tappa 9): pressione, peso, altezza, BMI, glicemia, saturazione, scritti
 * insieme per la stessa visita; andamento nel tempo in grafico e in tabella. Nessun giudizio sui
 * valori e nessun calcolo (regola 3, R12): il BMI si scrive come misurato.
 */
export function MeasurementsPage() {
  const { id } = useParams<{ id: string }>();
  const record = useApi<{ paziente: Patient; riepilogo: Summary | null }>(`/api/pazienti/${id}`);
  const catalog = useCatalog();
  const data = useApi<{ parametri: Series[]; puoScrivere: boolean }>(
    `/api/pazienti/${id}/parametri`,
  );
  if (record.loading && !record.data) return <Loading what="dati della cartella" />;
  if (!record.data) return <ErrorMessage error={record.error} />;
  const p = record.data.paziente;
  const charts = groups(data.data?.parametri ?? []);

  return (
    <>
      <PageHeader
        title="Parametri"
        trail={
          <>
            <Link to={`/pazienti/${id}`}>
              {p.firstName} {p.lastName}
            </Link>{' '}
            <span aria-hidden="true">/</span> <span>Parametri</span>
          </>
        }
        actions={
          <Link className="pulsante" to={`/pazienti/${id}/voci`}>
            <Icon name="storico" /> <span>Voci cliniche</span>
          </Link>
        }
      />
      <PatientBanner patient={p} summary={record.data.riepilogo} />
      {data.data?.puoScrivere && catalog.data && (
        <MeasurementsForm
          patientId={id!}
          catalog={catalog.data}
          onSaved={() => {
            data.reload();
            record.reload();
          }}
        />
      )}
      <section className="riquadro" aria-labelledby="titolo-andamento">
        <h2 id="titolo-andamento">Andamento nel tempo</h2>
        {data.loading && !data.data && <Loading what="parametri" />}
        {data.error?.status === 403 ? (
          <p className="tenue">Parametri: non visibili con il tuo ruolo.</p>
        ) : (
          <ErrorMessage error={data.error} />
        )}
        {data.data && charts.length === 0 && <p className="tenue">Nessun parametro registrato.</p>}
        <div className="griglia-grafici">
          {charts.map((g) => (
            <div key={g.key} className="grafico-con-tabella">
              <TrendChart title={g.title} unit={g.unit} series={g.series} />
              <ValuesTable group={g} />
            </div>
          ))}
        </div>
      </section>
    </>
  );
}

/** La tabella con gli stessi valori del grafico: dal più recente. */
function ValuesTable({ group }: { group: Group }) {
  const dates = [...new Set(group.raw.flatMap((s) => s.valori.map((v) => v.data)))]
    .sort()
    .reverse();
  const names = group.series.map((s) => s.name);
  return (
    <div className="tabella-scorrevole">
      <table className="tabella">
        <caption>
          {group.title}: valori ({group.unit})
        </caption>
        <thead>
          <tr>
            <th scope="col">Data</th>
            {names.map((n) => (
              <th scope="col" key={n}>
                {group.raw.length > 1 ? n : 'Valore'}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {dates.map((d) => (
            <tr key={d}>
              <th scope="row">{date(d)}</th>
              {group.raw.map((s) => (
                <td key={s.parametro} className="numero">
                  {s.valori
                    .filter((v) => v.data === d)
                    .map((v) => decimal(v.valore))
                    .join(' · ') || '—'}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MeasurementsForm({
  patientId,
  catalog,
  onSaved,
}: {
  patientId: string;
  catalog: Catalog;
  onSaved: () => void;
}) {
  const today = studioToday();
  // Ricordati per paziente finché non si registrano, come la ricetta (D68, D129).
  const key = `bozza-parametri-${patientId}`;
  const [day, setDay, resetDay] = usePersistentState(`${key}-data`, today);
  const [values, setValues, resetValues] = usePersistentState<Record<string, string>>(key, {});
  const [reserved, setReserved, resetReserved] = usePersistentState(`${key}-riservati`, false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<number | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const misure = catalog.parametri
      .filter((m) => values[m.chiave]?.trim())
      .map((m) => ({ parametro: m.chiave, valore: values[m.chiave]!.trim() }));
    if (misure.length === 0) {
      setError(new ApiError(400, 'Scrivi almeno un valore'));
      return;
    }
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await api(`/api/pazienti/${patientId}/parametri`, {
        method: 'POST',
        body: { data: day, misure, ...(reserved ? { riservata: true } : {}) },
      });
      resetValues();
      resetReserved();
      resetDay();
      setDone(misure.length);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'Servizio non raggiungibile'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="riquadro"
      onSubmit={(e) => void submit(e)}
      aria-labelledby="titolo-nuovi-parametri"
    >
      <h2 id="titolo-nuovi-parametri">
        <Icon name="aggiungi" /> Nuovi parametri
      </h2>
      <fieldset disabled={busy}>
        <legend className="visivamente-nascosto">Parametri della stessa visita</legend>
        <div className="campi-in-riga">
          <div className="campo campo-stretto">
            <label htmlFor="parametri-data">Data</label>
            <input
              id="parametri-data"
              type="date"
              required
              max={today}
              value={day}
              onChange={(e) => setDay(e.target.value)}
            />
          </div>
        </div>
        <div className="campi-in-riga">
          {catalog.parametri.map((m) => (
            <div className="campo campo-stretto" key={m.chiave}>
              <label htmlFor={`parametro-${m.chiave}`}>
                {m.nome} <span className="tenue">({m.unita})</span>
              </label>
              <input
                id={`parametro-${m.chiave}`}
                inputMode="decimal"
                autoComplete="off"
                value={values[m.chiave] ?? ''}
                onChange={(e) => setValues((v) => ({ ...v, [m.chiave]: e.target.value }))}
              />
            </div>
          ))}
        </div>
        <p className="aiuto">
          Scrivi solo i valori misurati, con la virgola o il punto. Il BMI si scrive come valore: il
          programma non lo calcola.
        </p>
        <div className="casella">
          <input
            id="parametri-riservati"
            type="checkbox"
            checked={reserved}
            onChange={(e) => setReserved(e.target.checked)}
          />
          <label htmlFor="parametri-riservati">Riservati: li vede solo il medico</label>
        </div>
        <div className="azioni">
          <button type="submit" className="pulsante pulsante-primario">
            <Icon name="fatto" /> <span>Registra</span>
          </button>
        </div>
      </fieldset>
      <ErrorMessage error={error} />
      {done !== null && (
        <Notice kind="fatto">
          {done === 1 ? 'Registrato 1 parametro.' : `Registrati ${done} parametri.`}
        </Notice>
      )}
    </form>
  );
}
