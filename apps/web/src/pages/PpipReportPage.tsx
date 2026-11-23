import { useEffect, useRef, useState, type FormEvent } from 'react';
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
  /** Il paziente è ancora in questo archivio: altrimenti la sua cartella è di un altro medico. */
  pazienteNellArchivio: boolean;
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
  /** Da quando la prestazione sta partendo con un invio della distinta (D232). */
  inInvioDal: string | null;
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
  /** «manuale» se l'esito l'ha segnato il titolare: consegna fuori dal programma (D232). */
  ambiente: string;
}

interface Distinta {
  mese: string;
  scadenza: string;
  righe: Row[];
  perVoce: { codice: string; descrizione: string; quantita: number; importo: number | null }[];
  totale: number | null;
  daInviare: number;
  inInvio: { dal: string; interrotto: boolean; righe: number } | null;
  invii: Report[];
  puoInviare: boolean;
  puoAnnullare: boolean;
  invioAttivo: boolean;
  invioSimulato: boolean;
  formati: { id: string; titolo: string; fonte: string }[];
}

const OUTCOME: Record<Report['esito'], string> = {
  accepted: 'Accolta',
  rejected: 'Rifiutata',
  unreachable: 'Portale non raggiungibile',
};

/** L'esito che il titolare ha segnato a mano (D232). */
const MANUAL_OUTCOME: Record<Report['esito'], string> = {
  accepted: 'Consegnata all’ASL (segnato a mano)',
  rejected: 'Rifiutata (segnato a mano)',
  unreachable: 'Non arrivata all’ASL (segnato a mano)',
};

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Il mese scritto nel campo: «AAAA-MM» dal selettore del mese, oppure «MM/AAAA» dove il browser
 * mostra un campo di testo (Safari e Firefox da computer).
 */
export function parseMonth(text: string): string | null {
  const t = text.trim();
  if (MONTH.test(t)) return t;
  const m = /^(\d{1,2})\s*[/.-]\s*(\d{4})$/.exec(t);
  if (!m) return null;
  const month = `${m[2]}-${m[1]!.padStart(2, '0')}`;
  return MONTH.test(month) ? month : null;
}

const failure = (err: unknown) =>
  err instanceof ApiError ? err : new ApiError(0, 'Servizio non raggiungibile');

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
  // L'archivio dell'indirizzo; se non c'è, il proprio (in medicina di gruppo se ne vedono altri).
  const mine = state.status === 'ready' ? state.me.archivio?.id : undefined;
  const own =
    list.find((a) => a.id === params.get('archivio')) ??
    list.find((a) => a.id === mine) ??
    list[0] ??
    null;
  const d = useApi<Distinta>(own ? `/api/archivi/${own.id}/ppip?mese=${mese}` : null);
  const [monthError, setMonthError] = useState<string | null>(null);
  const [format, setFormat] = useState('acn-allegato-6');
  // «Ho controllato» e «Ho consegnato» valgono per le prestazioni viste quando si spuntano: se la
  // distinta cambia (mese, archivio, righe), si tolgono da sole (D239).
  const [checkedFor, setCheckedFor] = useState<string | null>(null);
  const [deliveredFor, setDeliveredFor] = useState<string | null>(null);
  const [reference, setReference] = useState('');
  const [sending, setSending] = useState(false);
  // Dopo un'azione si aspetta la distinta ricaricata: fino ad allora i pulsanti restano spenti,
  // così un secondo clic non trova la distinta di prima (D239).
  const [staleData, setStaleData] = useState<Distinta | null | undefined>(undefined);
  const [confirming, setConfirming] = useState<'arrivata' | 'non_arrivata' | null>(null);
  const [sendError, setSendError] = useState<ApiError | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const result = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (staleData !== undefined && (d.data !== staleData || d.error)) setStaleData(undefined);
  }, [d.data, d.error, staleData]);
  // Dopo l'azione il fuoco va al risultato: il pulsante premuto può non esserci più (WCAG 2.4.3).
  useEffect(() => {
    if (sent || sendError) result.current?.focus();
  }, [sent, sendError]);

  if (archives.loading && !archives.data) return <Loading what="archivi" />;
  if (archives.data && !own) return <Navigate to="/" replace />;
  if (!own) return <ErrorMessage error={archives.error} />;

  const go = (month: string, archive = own.id) =>
    setParams(
      { mese: month, ...(list.length > 1 ? { archivio: archive } : {}) },
      { replace: true },
    );

  /** Le prestazioni da inviare che il titolare vede: partono solo quelle (D232). */
  const toSend = (d.data?.righe ?? []).filter((r) => !r.inviata && !r.inInvioDal).map((r) => r.id);
  const seenKey = `${own.id}|${mese}|${[...toSend].sort().join(',')}`;
  const checked = checkedFor === seenKey;
  const delivered = deliveredFor === seenKey;
  const busy = sending || staleData !== undefined;

  /** Una richiesta della distinta; dopo, la distinta si ricarica e il controllo si rifà. */
  async function act(run: () => Promise<string>) {
    setSending(true);
    setSendError(null);
    setSent(null);
    setConfirming(null);
    try {
      setSent(await run());
    } catch (err) {
      setSendError(failure(err));
    } finally {
      setCheckedFor(null);
      setDeliveredFor(null);
      setStaleData(d.data ?? null);
      setSending(false);
      d.reload();
    }
  }

  const send = () =>
    act(async () => {
      const r = await api<{ esito: Report['esito']; protocollo: string | null; righe: number }>(
        `/api/archivi/${own.id}/ppip/invio`,
        { method: 'POST', body: { mese, righe: toSend } },
      );
      return r.esito === 'accepted'
        ? `Distinta inviata: ${plural(r.righe, 'prestazione', 'prestazioni')}, protocollo ${r.protocollo}.`
        : `Distinta non accolta: ${OUTCOME[r.esito].toLowerCase()}. Le prestazioni restano da inviare.`;
    });

  const deliver = () =>
    act(async () => {
      const r = await api<{ righe: number }>(`/api/archivi/${own.id}/ppip/consegna`, {
        method: 'POST',
        body: { mese, righe: toSend, ...(reference.trim() ? { riferimento: reference } : {}) },
      });
      setReference('');
      return `Distinta segnata come consegnata all’ASL: ${plural(r.righe, 'prestazione', 'prestazioni')}.`;
    });

  const settle = (esito: 'arrivata' | 'non_arrivata') =>
    act(async () => {
      const r = await api<{ righe: number }>(`/api/archivi/${own.id}/ppip/esito`, {
        method: 'POST',
        body: { mese, esito, ...(reference.trim() ? { riferimento: reference } : {}) },
      });
      setReference('');
      return esito === 'arrivata'
        ? `Segnato: la distinta è arrivata all’ASL (${plural(r.righe, 'prestazione', 'prestazioni')}).`
        : `Segnato: la distinta non è arrivata. ${plural(r.righe, 'prestazione torna', 'prestazioni tornano')} da inviare.`;
    });

  const x = d.data;
  const noAddress = (x?.righe ?? []).filter((r) => !r.inviata && !r.indirizzo).length;
  return (
    <>
      <PageHeader
        title="Prestazioni aggiuntive"
        trail={
          ownsArchive ? (
            <>
              <Link to="/archivio?sezione=prestazioni">Archivio</Link>{' '}
              <span aria-hidden="true">/</span> <span>Prestazioni aggiuntive</span>
            </>
          ) : undefined
        }
      />
      <form
        className="riquadro"
        aria-labelledby="titolo-mese-ppip"
        onSubmit={(e) => {
          e.preventDefault();
          const month = parseMonth(monthInput);
          setMonthError(month ? null : 'Scrivi il mese come MM/AAAA, per esempio 10/2026.');
          if (month) {
            setMonthInput(month);
            go(month);
          }
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
              placeholder="MM/AAAA"
              aria-invalid={monthError ? true : undefined}
              aria-describedby={monthError ? 'ppip-mese-errore' : undefined}
              value={monthInput}
              onChange={(e) => setMonthInput(e.target.value)}
            />
            {monthError && (
              <p id="ppip-mese-errore" className="errore-campo">
                {monthError}
              </p>
            )}
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
          medicina generale 2022-2024, allegato 6, comma 4). Per le prestazioni soggette ad
          autorizzazione vanno con la distinta anche l’autorizzazione e il modulo regionale delle
          prestazioni multiple autorizzate (comma 5). In Piemonte l’accordo regionale prevede la
          rendicontazione su supporto digitale (AIR 2024, artt. 30 e 36): come, lo diranno Regione e
          ASL.
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
                <table className="tabella tabella-distinta">
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
                          {r.pazienteNellArchivio ? (
                            <Link to={`/pazienti/${r.paziente}/prestazioni-aggiuntive`}>
                              {r.cognome} {r.nome}
                            </Link>
                          ) : (
                            <>
                              {r.cognome} {r.nome}{' '}
                              <span className="tenue">(ora assistito di un altro medico)</span>
                            </>
                          )}
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
                          ) : r.inInvioDal ? (
                            <>
                              <Icon name="avviso" /> In invio
                            </>
                          ) : (
                            <>
                              <Icon name="avviso" /> Da inviare
                              {x.puoAnnullare && (
                                <AnnulFromReport
                                  archiveId={own.id}
                                  row={r}
                                  onDone={(m) => {
                                    setSent(m);
                                    setStaleData(d.data ?? null);
                                    d.reload();
                                  }}
                                />
                              )}
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
            {noAddress > 0 && (
              <Notice kind="avviso">
                {plural(
                  noAddress,
                  'prestazione da inviare non ha',
                  'prestazioni da inviare non hanno',
                )}{' '}
                l’indirizzo dell’assistito, che la distinta deve avere (ACN, allegato 6, comma 4):
                va completato nell’anagrafica del paziente.
              </Notice>
            )}
            {x.inInvio && (
              <Notice kind="avviso">
                {x.inInvio.interrotto
                  ? `Un invio cominciato il ${dateTime(x.inInvio.dal)} è rimasto senza risposta: ${x.inInvio.righe === 1 ? 'la prestazione resta' : `le ${x.inInvio.righe} prestazioni restano`} «in invio». Chiedi all’ASL se la distinta è arrivata, poi segnalo qui.`
                  : `Invio in corso dal ${dateTime(x.inInvio.dal)}: aspetta la risposta del portale.`}
              </Notice>
            )}
            {x.puoInviare ? (
              <>
                {x.inInvio?.interrotto && (
                  <div className="azioni">
                    <div className="campo">
                      <label htmlFor="ppip-riferimento-esito">
                        Riferimento dell’ASL (facoltativo)
                      </label>
                      <input
                        id="ppip-riferimento-esito"
                        maxLength={200}
                        value={reference}
                        onChange={(e) => setReference(e.target.value)}
                      />
                    </div>
                    <button
                      type="button"
                      className="pulsante"
                      disabled={busy || confirming !== null}
                      onClick={() => setConfirming('arrivata')}
                    >
                      <Icon name="fatto" /> <span>È arrivata all’ASL</span>
                    </button>
                    <button
                      type="button"
                      className="pulsante"
                      disabled={busy || confirming !== null}
                      onClick={() => setConfirming('non_arrivata')}
                    >
                      <Icon name="annulla" /> <span>Non è arrivata: torna da inviare</span>
                    </button>
                  </div>
                )}
                {x.inInvio?.interrotto && confirming && (
                  // L'esito non si cambia dopo: si rilegge e si conferma (WCAG 3.3.4, D239).
                  <div className="conferma-esito" role="group" aria-label="Conferma dell’esito">
                    <p>
                      {confirming === 'arrivata' ? (
                        <>
                          Confermi che la distinta è <strong>arrivata</strong> all’ASL
                          {reference.trim() ? (
                            <>
                              {' '}
                              con il riferimento <strong>{reference.trim()}</strong>
                            </>
                          ) : (
                            ', senza un riferimento'
                          )}
                          ? Le prestazioni risultano partite e non si annullano più.
                        </>
                      ) : (
                        <>
                          Confermi che la distinta <strong>non è arrivata</strong> all’ASL? Le
                          prestazioni tornano da inviare: se in realtà fosse arrivata, mandarla di
                          nuovo farebbe un doppione.
                        </>
                      )}
                    </p>
                    <div className="azioni">
                      <button
                        type="button"
                        className="pulsante pulsante-primario"
                        disabled={busy}
                        onClick={() => void settle(confirming)}
                      >
                        <Icon name="fatto" /> <span>Sì, confermo</span>
                      </button>
                      <button
                        type="button"
                        className="pulsante"
                        disabled={busy}
                        onClick={() => setConfirming(null)}
                      >
                        <Icon name="annulla" /> <span>Torna indietro</span>
                      </button>
                    </div>
                  </div>
                )}
                {x.invioAttivo ? (
                  x.invioSimulato && (
                    <Notice kind="info">
                      Invio simulato: il collegamento vero si scrive quando Regione e ASL diranno
                      come si manda la distinta. Intanto la distinta si scarica in CSV.
                    </Notice>
                  )
                ) : (
                  <Notice kind="info">
                    L’invio dal programma non è ancora collegato: si completa quando Regione e ASL
                    diranno come si manda la distinta. Scarica la distinta in CSV, consegnala
                    all’ASL e segnala qui come consegnata.
                  </Notice>
                )}
                {x.daInviare > 0 && !x.inInvio && (
                  <>
                    {x.invioAttivo && (
                      <>
                        <div className="casella">
                          <input
                            id="ppip-controllata"
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => setCheckedFor(e.target.checked ? seenKey : null)}
                          />
                          <label htmlFor="ppip-controllata">
                            Ho controllato la distinta: le prestazioni da inviare sono quelle
                            eseguite
                          </label>
                        </div>
                        <div className="azioni">
                          <button
                            type="button"
                            className="pulsante pulsante-primario"
                            disabled={!checked || busy}
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
                    <details className="consegna-distinta">
                      <summary>Consegnata all’ASL fuori dal programma</summary>
                      <p className="aiuto">
                        Per esempio con il CSV sul portale o nello strumento dell’ASL. Le
                        prestazioni da inviare risultano partite e non si annullano più.
                      </p>
                      <div className="casella">
                        <input
                          id="ppip-consegnata"
                          type="checkbox"
                          checked={delivered}
                          onChange={(e) => setDeliveredFor(e.target.checked ? seenKey : null)}
                        />
                        <label htmlFor="ppip-consegnata">
                          Ho consegnato all’ASL la distinta con queste prestazioni
                        </label>
                      </div>
                      <div className="campo">
                        <label htmlFor="ppip-riferimento">
                          Riferimento della consegna (facoltativo)
                        </label>
                        <input
                          id="ppip-riferimento"
                          maxLength={200}
                          value={reference}
                          onChange={(e) => setReference(e.target.value)}
                        />
                      </div>
                      <div className="azioni">
                        <button
                          type="button"
                          className="pulsante"
                          disabled={!delivered || busy}
                          onClick={() => void deliver()}
                        >
                          <Icon name="fatto" />{' '}
                          <span>
                            Segna come consegnate{' '}
                            {plural(x.daInviare, 'prestazione', 'prestazioni')}
                          </span>
                        </button>
                      </div>
                    </details>
                  </>
                )}
              </>
            ) : (
              <p className="tenue">La distinta la manda il medico titolare dell’archivio.</p>
            )}
            <div ref={result} tabIndex={-1} className="esito-distinta">
              {sent && <Notice kind="fatto">{sent}</Notice>}
              <ErrorMessage error={sendError} />
            </div>
            {x.invii.length > 0 && (
              <>
                <h3>Invii del mese</h3>
                <ul className="elenco-semplice">
                  {x.invii.map((i) => (
                    <li key={i.id}>
                      <Icon name={i.esito === 'accepted' ? 'fatto' : 'avviso'} />{' '}
                      {dateTime(i.inviataIl)}:{' '}
                      {i.ambiente === 'manuale' ? MANUAL_OUTCOME[i.esito] : OUTCOME[i.esito]}
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

/**
 * Annullamento dalla distinta, con un motivo: anche per un paziente passato poi a un altro medico,
 * la cui cartella qui non si apre più (D232).
 */
function AnnulFromReport({
  archiveId,
  row,
  onDone,
}: {
  archiveId: string;
  row: Row;
  onDone: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  async function annul(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api(`/api/archivi/${archiveId}/ppip/${row.id}/annulla`, {
        method: 'POST',
        body: { motivo: reason },
      });
      setOpen(false);
      onDone(`Prestazione ${row.codice} di ${row.cognome} ${row.nome} annullata.`);
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <br />
      <button
        type="button"
        className="pulsante pulsante-piatto"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name="annulla" /> <span>Annulla</span>{' '}
        <span className="visivamente-nascosto">
          {row.codice} di {row.cognome} {row.nome} del {date(row.data)}
        </span>
      </button>
      {open && (
        <form className="modulo-in-riga" onSubmit={(e) => void annul(e)}>
          <div className="campo">
            <label htmlFor={`motivo-distinta-${row.id}`}>Motivo dell’annullamento</label>
            <input
              id={`motivo-distinta-${row.id}`}
              required
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <button type="submit" className="pulsante pulsante-primario" disabled={busy}>
            <Icon name="annulla" /> <span>Conferma l’annullamento</span>
          </button>
        </form>
      )}
      <ErrorMessage error={error} />
    </>
  );
}
