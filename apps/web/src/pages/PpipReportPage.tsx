import { useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { ErrorMessage, Loading, Notice, PageHeader } from '../components/common';
import { Icon } from '../components/Icon';
import { api, ApiError } from '../lib/api';
import { date, dateTime, money, plural, studioToday } from '../lib/format';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';

interface Row {
  id: string;
  paziente: string;
  data: string;
  cognome: string;
  nome: string;
  indirizzo: string | null;
  codiceFiscale: string;
  codice: string;
  descrizione: string;
  quantita: number;
  luogo: string;
  autorizzazione: string | null;
  importo: number | null;
  inviata: boolean;
  protocolloInvio: string | null;
}

interface Report {
  id: string;
  esito: 'accepted' | 'rejected' | 'unreachable';
  protocollo: string | null;
  messaggio: string | null;
  righe: number;
  totale: number | null;
  inviataIl: string;
  inviataDa: string;
}

interface Distinta {
  mese: string;
  scadenza: string;
  righe: Row[];
  perVoce: { codice: string; descrizione: string; quantita: number; importo: number | null }[];
  totale: number | null;
  daInviare: number;
  invii: Report[];
  puoInviare: boolean;
  invioSimulato: boolean;
  formati: { id: string; titolo: string; fonte: string }[];
}

const OUTCOME: Record<Report['esito'], string> = {
  accepted: 'Accolta',
  rejected: 'Rifiutata',
  unreachable: 'Portale non raggiungibile',
};

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Il mese prima di quello dello studio: la distinta si manda per il mese finito. */
function lastMonth(): string {
  const [y, m] = studioToday().split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** «ottobre 2026». */
function monthName(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Intl.DateTimeFormat('it-IT', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(y, m - 1, 1)));
}

/**
 * Distinta mensile delle prestazioni aggiuntive dell'archivio (PPIP, D212): per ogni prestazione
 * data, nome, cognome, indirizzo e codice fiscale dell'assistito (ACN, allegato 6, comma 4), con
 * i totali per voce e la scadenza del 15 del mese dopo. CSV nei formati dei dati; l'invio all'ASL
 * lo fa il titolare, oggi con il simulatore. Mese e archivio restano nell'indirizzo.
 */
export function PpipReportPage() {
  const { state } = useSession();
  const ownsArchive = state.status === 'ready' && !!state.me.archivio;
  const archives = useApi<{ archivi: { id: string; nome: string }[] }>('/api/ppip/archivi');
  const [params, setParams] = useSearchParams();
  const mese = MONTH.test(params.get('mese') ?? '') ? params.get('mese')! : lastMonth();
  const [monthInput, setMonthInput] = useState(mese);
  const list = archives.data?.archivi ?? [];
  const own = list.find((a) => a.id === params.get('archivio')) ?? list[0] ?? null;
  const d = useApi<Distinta>(own ? `/api/archivi/${own.id}/ppip?mese=${mese}` : null);
  const [format, setFormat] = useState('acn-allegato-6');
  const [checked, setChecked] = useState(false);
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<ApiError | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  if (archives.loading && !archives.data) return <Loading what="archivi" />;
  if (archives.data && !own) return <Navigate to="/" replace />;
  if (!own) return <ErrorMessage error={archives.error} />;

  const go = (month: string, archive = own.id) =>
    setParams(
      { mese: month, ...(list.length > 1 ? { archivio: archive } : {}) },
      { replace: true },
    );

  async function send() {
    setSending(true);
    setSendError(null);
    setSent(null);
    try {
      const r = await api<{ esito: Report['esito']; protocollo: string | null; righe: number }>(
        `/api/archivi/${own!.id}/ppip/invio`,
        { method: 'POST', body: { mese } },
      );
      setSent(
        r.esito === 'accepted'
          ? `Distinta inviata: ${plural(r.righe, 'prestazione', 'prestazioni')}, protocollo ${r.protocollo}.`
          : `Distinta non accolta: ${OUTCOME[r.esito].toLowerCase()}. Le prestazioni restano da inviare.`,
      );
      setChecked(false);
      d.reload();
    } catch (err) {
      setSendError(err instanceof ApiError ? err : new ApiError(0, 'Servizio non raggiungibile'));
    } finally {
      setSending(false);
    }
  }

  const x = d.data;
  return (
    <>
      <PageHeader
        title="Prestazioni aggiuntive"
        trail={
          ownsArchive ? (
            <>
              <Link to="/archivio">Archivio</Link> <span aria-hidden="true">/</span>{' '}
              <span>Prestazioni aggiuntive</span>
            </>
          ) : undefined
        }
      />
      <form
        className="riquadro"
        aria-labelledby="titolo-mese-ppip"
        onSubmit={(e) => {
          e.preventDefault();
          if (MONTH.test(monthInput)) go(monthInput);
        }}
      >
        <h2 id="titolo-mese-ppip">Mese delle prestazioni</h2>
        {list.length > 1 && (
          <div className="campo">
            <label htmlFor="ppip-archivio">Archivio</label>
            <select id="ppip-archivio" value={own.id} onChange={(e) => go(mese, e.target.value)}>
              {list.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.nome}
                </option>
              ))}
            </select>
          </div>
        )}
        <div className="campi-in-riga">
          <div className="campo campo-stretto">
            <label htmlFor="ppip-mese">Mese</label>
            <input
              id="ppip-mese"
              type="month"
              required
              value={monthInput}
              onChange={(e) => setMonthInput(e.target.value)}
            />
          </div>
        </div>
        <div className="azioni">
          <button type="submit" className="pulsante pulsante-primario">
            <Icon name="cerca" /> <span>Mostra la distinta</span>
          </button>
        </div>
        <p className="aiuto">
          Il medico manda all’ASL, entro il 15 di ogni mese, la distinta delle prestazioni del mese
          prima, con data, nome, cognome, indirizzo e codice fiscale dell’assistito (ACN della
          medicina generale 2022-2024, allegato 6, comma 4). In Piemonte passa dal portale regionale
          (AIR 2024).
        </p>
      </form>

      {d.loading && !x && <Loading what="distinta" />}
      <ErrorMessage error={d.error} />
      {x && (
        <>
          <p role="status">
            Distinta di {monthName(x.mese)}: {plural(x.righe.length, 'prestazione', 'prestazioni')}
            {x.totale !== null ? `, ${money(x.totale)}` : ''}; da inviare entro il{' '}
            {date(x.scadenza)}. {plural(x.daInviare, 'prestazione', 'prestazioni')} ancora da
            inviare.
          </p>
          <section className="riquadro" aria-labelledby="titolo-distinta">
            <h2 id="titolo-distinta">Prestazioni del mese</h2>
            {x.righe.length === 0 ? (
              <p className="tenue">Nessuna prestazione aggiuntiva registrata nel mese.</p>
            ) : (
              <div className="tabella-scorrevole">
                <table className="tabella">
                  <caption>Distinta di {monthName(x.mese)}, una riga per prestazione</caption>
                  <thead>
                    <tr>
                      <th scope="col">Data</th>
                      <th scope="col">Assistito</th>
                      <th scope="col">Prestazione</th>
                      <th scope="col" className="numero">
                        Quantità
                      </th>
                      <th scope="col">Dove</th>
                      <th scope="col" className="numero">
                        Importo
                      </th>
                      <th scope="col">Invio</th>
                    </tr>
                  </thead>
                  <tbody>
                    {x.righe.map((r) => (
                      <tr key={r.id}>
                        <td>{date(r.data)}</td>
                        <td>
                          <Link to={`/pazienti/${r.paziente}/prestazioni-aggiuntive`}>
                            {r.cognome} {r.nome}
                          </Link>
                          <br />
                          <span className="codice">{r.codiceFiscale}</span>
                          {r.indirizzo && (
                            <>
                              <br />
                              <span className="tenue">{r.indirizzo}</span>
                            </>
                          )}
                        </td>
                        <td>
                          <span className="codice">{r.codice}</span> {r.descrizione}
                          {r.autorizzazione && (
                            <>
                              <br />
                              <span className="tenue">Autorizzazione: {r.autorizzazione}</span>
                            </>
                          )}
                        </td>
                        <td className="numero">{r.quantita}</td>
                        <td>{r.luogo}</td>
                        <td className="numero">{r.importo !== null ? money(r.importo) : '—'}</td>
                        <td>
                          {r.inviata ? (
                            <>
                              <Icon name="fatto" /> Inviata
                              {r.protocolloInvio ? ` (${r.protocolloInvio})` : ''}
                            </>
                          ) : (
                            <>
                              <Icon name="avviso" /> Da inviare
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          {x.perVoce.length > 0 && (
            <section className="riquadro" aria-labelledby="titolo-per-voce">
              <h2 id="titolo-per-voce">Per prestazione</h2>
              <table className="tabella">
                <caption>Quantità e importo per voce del catalogo</caption>
                <thead>
                  <tr>
                    <th scope="col">Prestazione</th>
                    <th scope="col" className="numero">
                      Quantità
                    </th>
                    <th scope="col" className="numero">
                      Importo
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {x.perVoce.map((v) => (
                    <tr key={v.codice}>
                      <td>
                        <span className="codice">{v.codice}</span> {v.descrizione}
                      </td>
                      <td className="numero">{v.quantita}</td>
                      <td className="numero">{v.importo !== null ? money(v.importo) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">Totale</th>
                    <td className="numero">{x.perVoce.reduce((s, v) => s + v.quantita, 0)}</td>
                    <td className="numero">{x.totale !== null ? money(x.totale) : '—'}</td>
                  </tr>
                </tfoot>
              </table>
            </section>
          )}

          <section className="riquadro" aria-labelledby="titolo-invio-ppip">
            <h2 id="titolo-invio-ppip">Esportazione e invio</h2>
            <div className="campi-in-riga">
              {x.formati.length > 1 && (
                <div className="campo">
                  <label htmlFor="ppip-formato">Formato del CSV</label>
                  <select
                    id="ppip-formato"
                    value={format}
                    onChange={(e) => setFormat(e.target.value)}
                  >
                    {x.formati.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.titolo}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <div className="azioni">
              <a
                className="pulsante"
                href={`/api/archivi/${own.id}/ppip/esportazione?mese=${x.mese}&formato=${format}`}
                download
              >
                <Icon name="archivio" /> <span>Scarica la distinta in CSV</span>
              </a>
            </div>
            <p className="aiuto">
              {x.formati.find((f) => f.id === format)?.fonte} Ogni scaricamento resta nel registro
              degli accessi, paziente per paziente.
            </p>
            {x.puoInviare ? (
              <>
                {x.invioSimulato && (
                  <Notice kind="info">
                    Invio simulato: il collegamento con il portale regionale si completa quando
                    Regione e ASL diranno come (D212). Intanto la distinta si scarica in CSV.
                  </Notice>
                )}
                {x.daInviare > 0 && (
                  <>
                    <div className="casella">
                      <input
                        id="ppip-controllata"
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => setChecked(e.target.checked)}
                      />
                      <label htmlFor="ppip-controllata">
                        Ho controllato la distinta: le prestazioni da inviare sono quelle eseguite
                      </label>
                    </div>
                    <div className="azioni">
                      <button
                        type="button"
                        className="pulsante pulsante-primario"
                        disabled={!checked || sending}
                        onClick={() => void send()}
                      >
                        <Icon name="firma" />{' '}
                        <span>
                          Invia all’ASL {plural(x.daInviare, 'prestazione', 'prestazioni')}
                        </span>
                      </button>
                    </div>
                  </>
                )}
              </>
            ) : (
              <p className="tenue">La distinta la manda il medico titolare dell’archivio.</p>
            )}
            {sent && <Notice kind="fatto">{sent}</Notice>}
            <ErrorMessage error={sendError} />
            {x.invii.length > 0 && (
              <>
                <h3>Invii del mese</h3>
                <ul className="elenco-semplice">
                  {x.invii.map((i) => (
                    <li key={i.id}>
                      <Icon name={i.esito === 'accepted' ? 'fatto' : 'avviso'} />{' '}
                      {dateTime(i.inviataIl)}: {OUTCOME[i.esito]}
                      {i.protocollo ? `, protocollo ${i.protocollo}` : ''},{' '}
                      {plural(i.righe, 'prestazione', 'prestazioni')}
                      {i.totale !== null ? `, ${money(i.totale)}` : ''}
                      {i.messaggio ? ` (${i.messaggio})` : ''} · {i.inviataDa}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
        </>
      )}
    </>
  );
}
