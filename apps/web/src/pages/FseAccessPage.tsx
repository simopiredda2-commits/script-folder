import { useId, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { ErrorMessage, Loading, Notice, PageHeader } from '../components/common';
import { Icon } from '../components/Icon';
import { api, ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';
import { PatientBanner, type Patient, type Summary } from './RecordPage';

interface FseAccessInfo {
  /** Filtri dell'elenco dei documenti, come nelle specifiche della regione dello studio. */
  tipiDocumento: { codice: string; nome: string }[];
  simulato: boolean;
  attivo: boolean;
  /** Le parole della regione dello studio (D297): a chi si chiede l'accesso, con chi si attiva. */
  testi?: { introduzione: string; simulato: string; nonAttivo: string };
  /** Solo se la regione dello studio non ha, nel programma, l'apertura del suo Fascicolo. */
  nota?: string;
}

/** I nomi delle specifiche sono in maiuscolo: nell'interfaccia si scrivono come una frase. */
export function documentTypeLabel(name: string): string {
  const lower = name.toLocaleLowerCase('it');
  return lower.charAt(0).toLocaleUpperCase('it') + lower.slice(1);
}

/**
 * Prepara la scheda nuova prima della richiesta, mentre il clic è ancora «del medico»: dopo
 * un'attesa molti browser bloccano le finestre nuove. Senza legame con questa pagina (opener),
 * perché vi si apre un sito della Regione.
 */
function reserveTab(): Window | null {
  let tab: Window | null;
  try {
    tab = window.open('', '_blank');
  } catch {
    return null;
  }
  if (!tab) return null;
  try {
    tab.opener = null;
    tab.document.title = 'Fascicolo regionale';
    tab.document.body.textContent = 'Apertura del Fascicolo regionale…';
  } catch {
    // La scheda c'è ma non si scrive: resta vuota fino all'indirizzo.
  }
  return tab;
}

/**
 * Aprire il Fascicolo regionale del paziente dalla cartella (D220), con il servizio di accesso
 * della regione dello studio (D297): il servizio chiede l'accesso con le credenziali del medico per
 * i servizi della regione e restituisce un indirizzo che vale una volta. Le parole che nominano la
 * regione arrivano dal suo pacchetto. Si apre in una scheda nuova; se il browser la blocca, resta
 * un collegamento da aprire a mano.
 */
export function FseAccessPage() {
  const { id } = useParams<{ id: string }>();
  const { isDoctor } = useSession();
  const record = useApi<{ paziente: Patient; riepilogo: Summary | null }>(`/api/pazienti/${id}`);
  const info = useApi<FseAccessInfo>(isDoctor ? '/api/fascicolo-regionale' : null);
  const [documentType, setDocumentType] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [opened, setOpened] = useState<{ url: string; inTab: boolean } | null>(null);
  const selectId = useId();

  if (record.loading && !record.data) return <Loading what="dati della cartella" />;
  if (!record.data) return <ErrorMessage error={record.error} />;
  const p = record.data.paziente;
  const i = info.data;

  async function open(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setOpened(null);
    const tab = reserveTab();
    try {
      const r = await api<{ indirizzo: string; simulato: boolean }>(
        `/api/pazienti/${id}/fascicolo-regionale`,
        { method: 'POST', body: { tipoDocumento: documentType || null } },
      );
      // L'indirizzo completo: la scheda vuota non ha un indirizzo da cui partire.
      const url = new URL(r.indirizzo, window.location.href).href;
      if (tab) tab.location.replace(url);
      setOpened({ url, inTab: tab !== null });
    } catch (err) {
      tab?.close();
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
          {info.loading && !i && <Loading what="dati del collegamento" />}
          <ErrorMessage error={info.error} />
          {i?.nota && <Notice kind="info">{i.nota}.</Notice>}
          {i?.testi && <p>{i.testi.introduzione}</p>}
          {i?.testi && i.simulato && <Notice kind="avviso">{i.testi.simulato}</Notice>}
          {i?.testi && !i.attivo && <Notice kind="errore">{i.testi.nonAttivo}.</Notice>}
          {i?.testi && (
            <form onSubmit={(e) => void open(e)}>
              <div className="campo">
                <label htmlFor={selectId}>Documenti da mostrare</label>
                <select
                  id={selectId}
                  value={documentType}
                  onChange={(e) => setDocumentType(e.target.value)}
                >
                  <option value="">Tutti i documenti</option>
                  {i.tipiDocumento.map((t) => (
                    <option key={t.codice} value={t.codice}>
                      {documentTypeLabel(t.nome)}
                    </option>
                  ))}
                </select>
              </div>
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
