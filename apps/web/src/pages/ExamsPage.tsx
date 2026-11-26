import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { ErrorMessage, Loading, Notice, PageHeader } from '../components/common';
import { Icon } from '../components/Icon';
import { api, ApiError } from '../lib/api';
import { useCatalog } from '../lib/clinical';
import { date, studioToday } from '../lib/format';
import { usePersistentState } from '../lib/storage';
import { useApi } from '../lib/useApi';
import { labRange } from './ClinicalEntriesPage';
import { PatientBanner, type Patient } from './RecordPage';

interface LabResult {
  id: string;
  data: string;
  esame: string;
  valore: string;
  unita: string | null;
  minimo: string | null;
  massimo: string | null;
  intervallo: string | null;
}

const COLUMNS = 3;
/** Limite di righe se il catalogo non è ancora arrivato; il servizio ripete il controllo. */
const FALLBACK_ROWS = 100;

/** Un risultato del referto come lo si scrive: testi come sullo schermo. */
interface ResultRow {
  key: string;
  esame: string;
  valore: string;
  unita: string;
  minimo: string;
  massimo: string;
  intervallo: string;
  codicePrestazione: string;
}

interface ReportDraft {
  data: string;
  note: string;
  riservata: boolean;
  righe: ResultRow[];
}

const newRow = (): ResultRow => ({
  key: crypto.randomUUID(),
  esame: '',
  valore: '',
  unita: '',
  minimo: '',
  massimo: '',
  intervallo: '',
  codicePrestazione: '',
});

const orUndefined = (v: string) => (v.trim() === '' ? undefined : v.trim());

/** Il corpo per il servizio: le righe vuote non partono. */
export function reportBody(d: ReportDraft) {
  return {
    data: d.data,
    note: orUndefined(d.note),
    riservata: d.riservata || undefined,
    risultati: d.righe
      .filter((r) => r.esame.trim() || r.valore.trim())
      .map((r) => ({
        esame: r.esame.trim(),
        valore: r.valore.trim(),
        unita: orUndefined(r.unita),
        minimo: orUndefined(r.minimo),
        massimo: orUndefined(r.massimo),
        intervallo: orUndefined(r.intervallo),
        codicePrestazione: orUndefined(r.codicePrestazione),
      })),
  };
}

/**
 * Nuovo referto di laboratorio (tappa 15): la data e uno o più esami, ognuno con valore, unità e
 * l'intervallo stampato sul referto. Si registrano insieme: un esame sbagliato li ferma tutti, e
 * il servizio dice quale. Quello che si sta scrivendo è ricordato per paziente (D68, D129).
 */
function NewReportForm({ patientId, onSaved }: { patientId: string; onSaved: () => void }) {
  const today = studioToday();
  const max = useCatalog().data?.limiti.risultatiReferto ?? FALLBACK_ROWS;
  const [d, setD, resetD] = usePersistentState<ReportDraft>(`bozza-referto-${patientId}`, {
    data: today,
    note: '',
    riservata: false,
    righe: [newRow()],
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const setRow = (key: string, patch: Partial<ResultRow>) =>
    setD((x) => ({ ...x, righe: x.righe.map((r) => (r.key === key ? { ...r, ...patch } : r)) }));
  // I problemi del servizio: i controlli formali (problemi) o i dati non validi (dettagli).
  const details = error?.details as { problemi?: unknown } | { message?: unknown }[] | undefined;
  const problems = Array.isArray(details)
    ? details.map((i) => i.message).filter((m): m is string => typeof m === 'string')
    : Array.isArray(details?.problemi)
      ? details.problemi.filter((m): m is string => typeof m === 'string')
      : [];

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const body = reportBody(d);
      const r = await api<{ ids: string[] }>(`/api/pazienti/${patientId}/esami`, {
        method: 'POST',
        body,
      });
      resetD();
      setDone(r.ids.length);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'Servizio non raggiungibile'));
    } finally {
      setBusy(false);
    }
  }

  const field = (
    row: ResultRow,
    k: Exclude<keyof ResultRow, 'key'>,
    label: string,
    props: Record<string, unknown> = {},
  ) => {
    const id = `referto-${k}-${row.key}`;
    return (
      <div className={`campo${props.stretto ? ' campo-stretto' : ''}`}>
        <label htmlFor={id}>{label}</label>
        <input
          id={id}
          value={row[k]}
          onChange={(e) => setRow(row.key, { [k]: e.target.value })}
          aria-describedby={
            k === 'minimo' || k === 'massimo' ? 'referto-intervallo-aiuto' : undefined
          }
          {...Object.fromEntries(Object.entries(props).filter(([p]) => p !== 'stretto'))}
        />
      </div>
    );
  };

  return (
    <form className="riquadro" onSubmit={(e) => void submit(e)} aria-labelledby="titolo-referto">
      <h2 id="titolo-referto">
        <Icon name="aggiungi" /> Nuovo referto di laboratorio
      </h2>
      <fieldset disabled={busy}>
        <legend className="visivamente-nascosto">Dati del referto</legend>
        <div className="campi-in-riga">
          <div className="campo campo-stretto">
            <label htmlFor="referto-data">Data del referto</label>
            <input
              id="referto-data"
              type="date"
              required
              max={today}
              value={d.data}
              onChange={(e) => setD((x) => ({ ...x, data: e.target.value }))}
            />
          </div>
        </div>
        <p className="aiuto" id="referto-intervallo-aiuto">
          Per ogni esame il valore come sul referto (un numero o un testo, per esempio «negativo»).
          Minimo e massimo sono numeri; un intervallo scritto in altro modo va nel testo. Il valore
          non si confronta con l’intervallo.
        </p>
        {d.righe.map((row, i) => (
          <fieldset key={row.key}>
            <legend>Esame {i + 1}</legend>
            <div className="campi-in-riga">
              {field(row, 'esame', 'Esame', { required: true, maxLength: 200 })}
              {field(row, 'valore', 'Valore', { required: true, maxLength: 100, stretto: true })}
              {field(row, 'unita', 'Unità di misura', { maxLength: 30, stretto: true })}
            </div>
            <div className="campi-in-riga">
              {field(row, 'minimo', 'Minimo', {
                inputMode: 'decimal',
                maxLength: 20,
                stretto: true,
              })}
              {field(row, 'massimo', 'Massimo', {
                inputMode: 'decimal',
                maxLength: 20,
                stretto: true,
              })}
              {field(row, 'intervallo', 'Oppure come è scritto sul referto', { maxLength: 200 })}
              {field(row, 'codicePrestazione', 'Codice della prestazione', {
                className: 'codice',
                maxLength: 40,
                stretto: true,
              })}
            </div>
            {d.righe.length > 1 && (
              <button
                type="button"
                className="pulsante pulsante-piatto"
                onClick={() =>
                  setD((x) => ({ ...x, righe: x.righe.filter((r) => r.key !== row.key) }))
                }
              >
                <Icon name="annulla" /> <span>Togli l’esame {i + 1}</span>
              </button>
            )}
          </fieldset>
        ))}
        <div className="azioni">
          <button
            type="button"
            className="pulsante"
            disabled={d.righe.length >= max}
            onClick={() => setD((x) => ({ ...x, righe: [...x.righe, newRow()] }))}
          >
            <Icon name="aggiungi" /> <span>Aggiungi un esame</span>
          </button>
          {d.righe.length >= max && (
            <span className="tenue">
              Al massimo {max} esami per volta: gli altri si registrano dopo.
            </span>
          )}
        </div>
        <div className="campi-in-riga">
          <div className="campo">
            <label htmlFor="referto-note">Note</label>
            <input
              id="referto-note"
              maxLength={2000}
              value={d.note}
              onChange={(e) => setD((x) => ({ ...x, note: e.target.value }))}
            />
          </div>
        </div>
        <div className="casella">
          <input
            id="referto-riservata"
            type="checkbox"
            checked={d.riservata}
            onChange={(e) => setD((x) => ({ ...x, riservata: e.target.checked }))}
          />
          <label htmlFor="referto-riservata">Riservati: li vede solo il medico</label>
        </div>
        <div className="azioni">
          <button type="submit" className="pulsante pulsante-primario">
            <Icon name="fatto" /> <span>Registra il referto</span>
          </button>
        </div>
      </fieldset>
      {error && (
        <div className="messaggio messaggio-errore" role="alert">
          <Icon name="avviso" />
          <div>
            <p>{problems.length ? 'Il referto non si può registrare:' : error.message}</p>
            {problems.length > 0 && (
              <ul>
                {problems.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
      {done !== null && (
        <Notice kind="fatto">
          {done === 1 ? 'Registrato 1 esame.' : `Registrati ${done} esami.`}
        </Notice>
      )}
    </form>
  );
}

/**
 * Esami di laboratorio: gli ultimi tre referti affiancati, con l'intervallo stampato sul referto.
 * Nessun «sopra» o «sotto»: un confronto automatico è da validare con il consulente regolatorio
 * (regola 3, D71). Dalla tappa 15 il medico aggiunge qui i referti; un risultato sbagliato si
 * annulla dalle voci cliniche, come le altre voci.
 */
export function ExamsPage() {
  const { id } = useParams<{ id: string }>();
  const record = useApi<{ paziente: Patient }>(`/api/pazienti/${id}`);
  const exams = useApi<{ esami: LabResult[]; puoScrivere?: boolean }>(`/api/pazienti/${id}/esami`);
  if (record.loading && !record.data) return <Loading what="dati della cartella" />;
  if (!record.data) return <ErrorMessage error={record.error} />;
  const p = record.data.paziente;
  const rows = exams.data?.esami ?? [];
  const dates = [...new Set(rows.map((r) => r.data))].sort().reverse().slice(0, COLUMNS);
  const analytes = [...new Set(rows.map((r) => r.esame))].sort((a, b) => a.localeCompare(b, 'it'));
  const cell = (analyte: string, d: string) =>
    rows.find((r) => r.esame === analyte && r.data === d);
  const range = (analyte: string) => {
    const r = rows.find((x) => x.esame === analyte);
    return r ? labRange(r) : '';
  };

  return (
    <>
      <PageHeader
        title="Esami di laboratorio"
        trail={
          <>
            <Link to={`/pazienti/${id}`}>
              {p.firstName} {p.lastName}
            </Link>{' '}
            <span aria-hidden="true">/</span> <span>Esami di laboratorio</span>
          </>
        }
      />
      <PatientBanner patient={p} />
      {/* Qui i risultati; la prescrizione degli esami sta in Specialistica (D279). */}
      <p className="tenue">
        Qui si registrano e si leggono i risultati. Gli esami, anche quelli del sangue, si
        prescrivono in <Link to={`/pazienti/${id}/specialistica`}>Specialistica</Link>: si cercano
        per nome nel catalogo regionale, o si sceglie un pacchetto dello studio.
      </p>
      {exams.data?.puoScrivere && <NewReportForm patientId={id!} onSaved={exams.reload} />}
      <section className="riquadro" aria-labelledby="titolo-risultati">
        <h2 id="titolo-risultati">Risultati</h2>
        <ErrorMessage error={exams.error} />
        {exams.loading && !exams.data && <Loading what="esami" />}
        {exams.data && rows.length === 0 && <p className="tenue">Nessun risultato registrato.</p>}
        {dates.length > 0 && (
          <div className="tabella-scorrevole">
            <table className="tabella">
              <caption>
                Ultimi {dates.length === 1 ? 'referto' : `${dates.length} referti`}; l’ultimo è del{' '}
                {date(dates[0])}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Esame</th>
                  {dates.map((d) => (
                    <th scope="col" key={d}>
                      {date(d)}
                    </th>
                  ))}
                  <th scope="col">Intervallo del laboratorio</th>
                </tr>
              </thead>
              <tbody>
                {analytes.map((a) => (
                  <tr key={a}>
                    <th scope="row">{a}</th>
                    {dates.map((d) => {
                      const c = cell(a, d);
                      return (
                        <td key={d} className="numero">
                          {c ? `${c.valore}${c.unita ? ` ${c.unita}` : ''}` : '—'}
                        </td>
                      );
                    })}
                    <td>{range(a)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Notice kind="info">
          I valori si leggono accanto all’intervallo stampato sul referto. Il confronto automatico
          con l’intervallo non c’è: va prima validato con il consulente regolatorio.
        </Notice>
        {exams.data?.puoScrivere && (
          <p className="aiuto">
            Un risultato scritto male non si corregge: si annulla con il motivo da{' '}
            <Link to={`/pazienti/${id}/voci?tipo=esame_laboratorio`}>
              Voci cliniche, Esami di laboratorio
            </Link>{' '}
            e si registra di nuovo.
          </p>
        )}
      </section>
    </>
  );
}
