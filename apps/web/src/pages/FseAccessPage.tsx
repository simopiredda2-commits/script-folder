import { useId, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { ErrorMessage, Loading, Notice, PageHeader } from '../components/common';
import { Icon } from '../components/Icon';
import { ApiError } from '../lib/api';
import { openContextCall, type ContextDestination } from '../lib/context-call';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';
import { PatientBanner, type Patient, type Summary } from './RecordPage';

/** I nomi delle specifiche sono in maiuscolo: nell'interfaccia si scrivono come una frase. */
export function documentTypeLabel(name: string): string {
  const lower = name.toLocaleLowerCase('it');
  return lower.charAt(0).toLocaleUpperCase('it') + lower.slice(1);
}

/** Quando la regione dello studio non ha, nel programma, l'apertura del suo Fascicolo. */
const NOT_IN_REGION =
  'La regione dello studio non ha ancora, nel programma, l’apertura del suo Fascicolo dalla cartella.';

/**
 * Aprire il Fascicolo regionale del paziente dalla cartella (D220): la destinazione «fascicolo»
 * delle chiamate di contesto della regione dello studio (D297). Il servizio chiede l'accesso con le
 * credenziali del medico per i servizi della regione e restituisce un indirizzo che vale una volta.
 * Parametri e parole che nominano la regione arrivano dal suo pacchetto. Si apre in una scheda
 * nuova; se il browser la blocca, resta un collegamento da aprire a mano.
 */
export function FseAccessPage() {
  const { id } = useParams<{ id: string }>();
  const { isDoctor } = useSession();
  const record = useApi<{ paziente: Patient; riepilogo: Summary | null }>(`/api/pazienti/${id}`);
  const info = useApi<{ destinazioni: ContextDestination[] }>(
    isDoctor ? '/api/chiamate-di-contesto' : null,
  );
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [opened, setOpened] = useState<{ url: string; inTab: boolean } | null>(null);
  const fieldId = useId();

  if (record.loading && !record.data) return <Loading what="dati della cartella" />;
  if (!record.data) return <ErrorMessage error={record.error} />;
  const p = record.data.paziente;
  /** La destinazione «fascicolo» della regione dello studio; null se la regione non ce l'ha. */
  const i = info.data
    ? (info.data.destinazioni.find((d) => d.tipo === 'fascicolo') ?? null)
    : undefined;

  async function open(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setOpened(null);
    try {
      setOpened(
        await openContextCall(
          id!,
          'fascicolo',
          Object.fromEntries((i?.parametri ?? []).map((x) => [x.chiave, chosen[x.chiave] || null])),
          { title: 'Fascicolo regionale', waiting: 'Apertura del Fascicolo regionale…' },
        ),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err : null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Fascicolo regionale"
        trail={
          <>
            <Link to={`/pazienti/${id}`}>
              {p.firstName} {p.lastName}
            </Link>{' '}
            <span aria-hidden="true">/</span> <span>Fascicolo regionale</span>
          </>
        }
      />
      <PatientBanner patient={p} summary={record.data.riepilogo} />
      {!isDoctor ? (
        <Notice kind="info">
          Il Fascicolo regionale del paziente lo apre il medico, con le sue credenziali.
        </Notice>
      ) : (
        <section className="riquadro" aria-labelledby="titolo-fascicolo">
          <h2 id="titolo-fascicolo">Apri il Fascicolo Sanitario Elettronico</h2>
          {info.loading && i === undefined && <Loading what="dati del collegamento" />}
          <ErrorMessage error={info.error} />
          {i === null && <Notice kind="info">{NOT_IN_REGION}</Notice>}
          {i && <p>{i.testi.introduzione}</p>}
          {i?.simulato && <Notice kind="avviso">{i.testi.simulato}</Notice>}
          {i && !i.attivo && <Notice kind="errore">{i.testi.nonAttivo}.</Notice>}
          {i && (
            <form onSubmit={(e) => void open(e)}>
              {i.parametri.map((x) => (
                <div className="campo" key={x.chiave}>
                  <label htmlFor={`${fieldId}-${x.chiave}`}>{x.etichetta}</label>
                  <select
                    id={`${fieldId}-${x.chiave}`}
                    value={chosen[x.chiave] ?? ''}
                    onChange={(e) => setChosen({ ...chosen, [x.chiave]: e.target.value })}
                  >
                    <option value="">{x.tutti}</option>
                    {x.valori.map((t) => (
                      <option key={t.codice} value={t.codice}>
                        {documentTypeLabel(t.nome)}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
              <div className="azioni">
                <button
                  type="submit"
                  className="pulsante pulsante-primario"
                  disabled={busy || !i.attivo}
                >
                  <Icon name="archivio" /> <span>Apri il Fascicolo</span>
                </button>
              </div>
            </form>
          )}
          <ErrorMessage error={error} />
          {opened &&
            (opened.inTab ? (
              <Notice kind="fatto">Fascicolo aperto in una scheda nuova.</Notice>
            ) : (
              <Notice kind="avviso">
                <p>
                  Il browser non ha aperto la scheda nuova.{' '}
                  <a href={opened.url} target="_blank" rel="noopener noreferrer">
                    Apri il Fascicolo
                  </a>{' '}
                  (il collegamento vale una volta sola).
                </p>
              </Notice>
            ))}
        </section>
      )}
    </>
  );
}
