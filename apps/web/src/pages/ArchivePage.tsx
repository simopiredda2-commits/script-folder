import { useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router';
import { ErrorMessage, Loading, Notice, PageHeader } from '../components/common';
import { Icon } from '../components/Icon';
import { api, ApiError } from '../lib/api';
import { date, dateTime, studioToday, time } from '../lib/format';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';

interface Settings {
  segreteriaLeggeDiario: boolean;
  segreteriaLeggeRiepilogo: boolean;
}

const SETTINGS: { key: keyof Settings; name: string; explanation: string }[] = [
  {
    key: 'segreteriaLeggeRiepilogo',
    name: 'La segreteria legge il riepilogo clinico',
    explanation:
      'Problemi, allergie, esenzioni, piani terapeutici e parametri. Spento per difetto.',
  },
  {
    key: 'segreteriaLeggeDiario',
    name: 'La segreteria legge il diario clinico',
    explanation: 'Note di visita e cronologia clinica. Spento per difetto.',
  },
];

type GrantKind = 'substitution' | 'group_colleague';
interface Grant {
  id: string;
  medico: { id: string; nome: string };
  tipo: { codice: GrantKind; nome: string };
  /** Giorni dello studio, compresi. */
  dal: string;
  al: string;
  motivo: string;
  stato: { codice: 'attiva' | 'futura' | 'scaduta' | 'revocata'; nome: string };
  concessaDa: string;
  concessaIl: string;
  revocataIl: string | null;
  revocabile: boolean;
}
interface GrantableKind {
  codice: GrantKind;
  nome: string;
  spiegazione: string;
  medici: { id: string; nome: string; codiceRegionale: string | null }[];
  /** Perché non c'è nessuno da autorizzare, se è così. */
  nota: string | null;
}
interface Alert {
  tipo: string;
  nome: string;
  utente: { id: string; nome: string; studio: string | null; io: boolean };
  giorno: string;
  conteggio: number;
  cartelle: number;
  primo: string;
  ultimo: string;
  descrizione: string;
}
interface Alerts {
  periodo: { giorni: number; dal: string; al: string };
  regole: {
    codice: string;
    nome: string;
    stato: 'attiva' | 'da_completare' | 'non_valida';
    soglia: string | null;
  }[];
  daCompletare: string[];
  nonValide: string[];
  fonte: string;
  avvisi: Alert[];
}

const failure = (e: unknown) =>
  e instanceof ApiError ? e : new ApiError(0, 'Servizio non raggiungibile');

/**
 * L'archivio del medico titolare (D84): che cosa vede la segreteria (D30), esportazione completa
 * in formato aperto (regola 4), autorizzazioni a sostituti e colleghi di gruppo e avvisi sugli
 * accessi anomali (tappa 14). Solo per chi è titolare di un archivio; ogni azione è registrata.
 */
export function ArchivePage() {
  const { state } = useSession();
  const own = state.status === 'ready' ? state.me.archivio : null;
  const settings = useApi<Settings>(own ? `/api/archivi/${own.id}/impostazioni` : null);
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // La casella cambia subito; se il servizio rifiuta, torna com'era (D84).
  const [local, setLocal] = useState<Settings | null>(null);
  const current = local ?? settings.data;

  if (!own) return <Navigate to="/" replace />;

  async function change(key: keyof Settings, value: boolean, name: string) {
    setError(null);
    setSaved(null);
    setBusy(true);
    setLocal({ ...current!, [key]: value });
    try {
      await api(`/api/archivi/${own!.id}/impostazioni`, {
        method: 'PATCH',
        body: { [key]: value },
      });
      setSaved(`${name}: ${value ? 'acceso' : 'spento'}.`);
      settings.reload();
    } catch (e) {
      setLocal(null);
      setError(e instanceof ApiError ? e : null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Archivio" />
      <p>
        Archivio: <strong>{own.nome}</strong>. I dati sono tuoi: decidi che cosa vede la segreteria
        e puoi scaricarli tutti quando vuoi.
      </p>
      <div className="griglia-cartella">
        <section className="riquadro" aria-labelledby="titolo-segreteria">
          <h2 id="titolo-segreteria">
            <Icon name="lucchetto" /> Che cosa vede la segreteria
          </h2>
          {settings.loading && !settings.data && <Loading what="impostazioni" />}
          <ErrorMessage error={settings.error ?? error} />
          {current && (
            <fieldset className="scelta" disabled={busy}>
              <legend className="visivamente-nascosto">Impostazioni della segreteria</legend>
              {SETTINGS.map((s) => (
                <div key={s.key} className="casella">
                  <input
                    type="checkbox"
                    id={`impostazione-${s.key}`}
                    checked={current[s.key]}
                    onChange={(e) => void change(s.key, e.target.checked, s.name)}
                  />
                  <label htmlFor={`impostazione-${s.key}`}>
                    <strong>{s.name}</strong> <span className="tenue">{s.explanation}</span>
                  </label>
                </div>
              ))}
            </fieldset>
          )}
          <p className="aiuto">
            I dati riservati restano sempre al medico. La segreteria prepara anagrafiche, agenda e
            bozze di ricette ripetute; firma e invio restano al medico.
          </p>
          {saved && <Notice kind="fatto">{saved}</Notice>}
        </section>

        <section className="riquadro" aria-labelledby="titolo-esportazione">
          <h2 id="titolo-esportazione">
            <Icon name="archivio" /> Esportazione completa
          </h2>
          <p>
            Tutti i dati dell&apos;archivio in formato aperto: pazienti, cartelle, terapie, ricette
            con i controlli, invii agli enti e registro degli accessi.
          </p>
          <ul className="elenco-azioni">
            <li>
              <a className="pulsante" href="/api/esportazione?formato=json" download>
                <Icon name="archivio" /> <span>Scarica in JSON (un file)</span>
              </a>
            </li>
            <li>
              <a className="pulsante" href="/api/esportazione?formato=csv" download>
                <Icon name="archivio" /> <span>Scarica in CSV (un file per tabella, in ZIP)</span>
              </a>
            </li>
          </ul>
          <p className="aiuto">
            Ogni esportazione è registrata nel registro degli accessi. Ogni sezione del file ha la
            sua impronta SHA-256, per controllare che sia integro.
          </p>
        </section>

        <section className="riquadro" aria-labelledby="titolo-riepiloghi">
          <h2 id="titolo-riepiloghi">
            <Icon name="storico" /> Riepiloghi
          </h2>
          <p>Visite e contatti, ricette e vaccinazioni per periodo, con l’esportazione in CSV.</p>
          <Link className="pulsante" to="/archivio/riepiloghi">
            <Icon name="storico" /> <span>Apri i riepiloghi</span>
          </Link>
        </section>

        <section className="riquadro" aria-labelledby="titolo-ppip-archivio">
          <h2 id="titolo-ppip-archivio">
            <Icon name="firma" /> Prestazioni aggiuntive
          </h2>
          <p>
            La distinta del mese per l’ASL, con il CSV e l’invio (ACN, allegato 6): da mandare entro
            il 15 del mese dopo.
          </p>
          <Link className="pulsante" to="/archivio/prestazioni-aggiuntive">
            <Icon name="firma" /> <span>Apri la distinta</span>
          </Link>
        </section>
      </div>
      <GrantsSection archiveId={own.id} />
      <AlertsSection archiveId={own.id} />
    </>
  );
}

/**
 * Autorizzazioni sull'archivio (tappa 14, D18, D21): il sostituto e i colleghi della medicina di
 * gruppo ci lavorano solo con un'autorizzazione del titolare, con periodo e motivo. Non si
 * cancellano: si revocano, e l'accesso si chiude subito.
 */
function GrantsSection({ archiveId }: { archiveId: string }) {
  const grants = useApi<{ autorizzazioni: Grant[] }>(`/api/archivi/${archiveId}/autorizzazioni`);
  const doctors = useApi<{ tipi: GrantableKind[] }>(
    `/api/archivi/${archiveId}/medici-autorizzabili`,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const list = grants.data?.autorizzazioni;

  async function revoke(g: Grant) {
    if (
      !window.confirm(
        `Revocare l’autorizzazione di ${g.medico.nome}? L’accesso all’archivio si chiude subito; l’autorizzazione resta nell’elenco come revocata.`,
      )
    )
      return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await api(`/api/archivi/${archiveId}/autorizzazioni/${g.id}/revoca`, {
        method: 'POST',
        body: {},
      });
      setDone(`Autorizzazione di ${g.medico.nome} revocata: l’accesso all’archivio è chiuso.`);
      grants.reload();
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="riquadro" aria-labelledby="titolo-autorizzazioni">
      <h2 id="titolo-autorizzazioni">
        <Icon name="lucchetto" /> Autorizzazioni sull’archivio
      </h2>
      <p>
        Il sostituto e i colleghi della medicina di gruppo lavorano sui tuoi pazienti solo con una
        tua autorizzazione, per il periodo indicato. Non esportano i dati, non leggono il registro
        degli accessi e non cambiano le impostazioni né le autorizzazioni. Un’autorizzazione non si
        cancella: si revoca, e l’accesso si chiude subito.
      </p>
      {grants.loading && !grants.data && <Loading what="dati delle autorizzazioni" />}
      <ErrorMessage error={grants.error ?? error} />
      {done && <Notice kind="fatto">{done}</Notice>}
      {list && list.length === 0 && <p className="tenue">Nessuna autorizzazione.</p>}
      {list && list.length > 0 && (
        <div className="tabella-scorrevole">
          <table className="tabella">
            <caption>Autorizzazioni date sull’archivio, prima le attive e le future</caption>
            <thead>
              <tr>
                <th scope="col">Medico</th>
                <th scope="col">Tipo</th>
                <th scope="col">Periodo</th>
                <th scope="col">Motivo</th>
                <th scope="col">Stato</th>
                <th scope="col">Azione</th>
              </tr>
            </thead>
            <tbody>
              {list.map((g) => (
                <tr key={g.id} className={g.revocabile ? undefined : 'riga-annullata'}>
                  <td>{g.medico.nome}</td>
                  <td>{g.tipo.nome}</td>
                  <td>
                    dal {date(g.dal)} al {date(g.al)}
                  </td>
                  <td>
                    {g.motivo}
                    <div className="aiuto">
                      Data da {g.concessaDa} il {dateTime(g.concessaIl)}
                    </div>
                  </td>
                  <td>
                    <span className={g.stato.codice === 'attiva' ? 'stato stato-sent' : 'stato'}>
                      {g.stato.nome}
                    </span>
                    {g.revocataIl && <div className="aiuto">il {dateTime(g.revocataIl)}</div>}
                  </td>
                  <td>
                    {g.revocabile ? (
                      <button
                        type="button"
                        className="pulsante"
                        disabled={busy}
                        onClick={() => void revoke(g)}
                      >
                        <Icon name="annulla" /> <span>Revoca</span>
                        <span className="visivamente-nascosto">
                          {` l’autorizzazione di ${g.medico.nome} dal ${date(g.dal)} al ${date(g.al)}`}
                        </span>
                      </button>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <ErrorMessage error={doctors.error} />
      {doctors.data && (
        <GrantForm
          archiveId={archiveId}
          kinds={doctors.data.tipi}
          onStart={() => setDone(null)}
          onDone={(message) => {
            setDone(message);
            grants.reload();
          }}
        />
      )}
    </section>
  );
}

function GrantForm({
  archiveId,
  kinds,
  onStart,
  onDone,
}: {
  archiveId: string;
  kinds: GrantableKind[];
  onStart: () => void;
  onDone: (message: string) => void;
}) {
  const today = studioToday();
  const [kind, setKind] = useState<GrantKind>(
    kinds.find((k) => k.medici.length > 0)?.codice ?? 'substitution',
  );
  const [doctor, setDoctor] = useState('');
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const current = kinds.find((k) => k.codice === kind);
  const doctors = current?.medici ?? [];

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    onStart();
    try {
      const { autorizzazione: g } = await api<{ autorizzazione: Grant }>(
        `/api/archivi/${archiveId}/autorizzazioni`,
        {
          method: 'POST',
          body: { medico: doctor, tipo: kind, dal: from, al: to, motivo: reason },
        },
      );
      setDoctor('');
      setTo('');
      setReason('');
      onDone(
        `${g.tipo.nome}: autorizzazione data a ${g.medico.nome} dal ${date(g.dal)} al ${date(g.al)}, ${g.stato.nome.toLowerCase()}.`,
      );
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="modulo"
      onSubmit={(e) => void submit(e)}
      aria-labelledby="titolo-nuova-autorizzazione"
    >
      <h3 id="titolo-nuova-autorizzazione">Nuova autorizzazione</h3>
      <fieldset className="scelta-in-riga" disabled={busy}>
        <legend>Tipo</legend>
        {kinds.map((k) => (
          <div key={k.codice} className="casella">
            <input
              type="radio"
              id={`autorizzazione-tipo-${k.codice}`}
              name="autorizzazione-tipo"
              checked={kind === k.codice}
              onChange={() => {
                setKind(k.codice);
                setDoctor('');
              }}
            />
            <label htmlFor={`autorizzazione-tipo-${k.codice}`}>{k.nome}</label>
          </div>
        ))}
      </fieldset>
      {current && <p className="aiuto">{current.spiegazione}</p>}
      {current?.nota && <Notice kind="info">{current.nota}</Notice>}
      <fieldset disabled={busy || doctors.length === 0}>
        <legend className="visivamente-nascosto">Medico, periodo e motivo</legend>
        <div className="campo">
          <label htmlFor="autorizzazione-medico">Medico</label>
          <select
            id="autorizzazione-medico"
            required
            value={doctor}
            onChange={(e) => setDoctor(e.target.value)}
          >
            <option value="">Da scegliere</option>
            {doctors.map((m) => (
              <option key={m.id} value={m.id}>
                {m.nome}
                {m.codiceRegionale ? ` · codice regionale ${m.codiceRegionale}` : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="campi-in-riga">
          <div className="campo">
            <label htmlFor="autorizzazione-dal">Dal</label>
            <input
              id="autorizzazione-dal"
              type="date"
              required
              min={today}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              aria-describedby="autorizzazione-periodo-aiuto"
            />
          </div>
          <div className="campo">
            <label htmlFor="autorizzazione-al">Al (compreso)</label>
            <input
              id="autorizzazione-al"
              type="date"
              required
              min={from || today}
              value={to}
              onChange={(e) => setTo(e.target.value)}
              aria-describedby="autorizzazione-periodo-aiuto"
            />
          </div>
        </div>
        <p className="aiuto" id="autorizzazione-periodo-aiuto">
          Giorni interi in ora italiana, dalla mezzanotte del primo alla fine dell’ultimo. Non si
          comincia nel passato.
        </p>
        <div className="campo">
          <label htmlFor="autorizzazione-motivo">Motivo</label>
          <input
            id="autorizzazione-motivo"
            required
            minLength={10}
            maxLength={300}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Per esempio: ferie del titolare"
            aria-describedby="autorizzazione-motivo-aiuto"
          />
          <p className="aiuto" id="autorizzazione-motivo-aiuto">
            Almeno 10 caratteri. Resta con l’autorizzazione; nel registro vanno medico, tipo e
            periodo.
          </p>
        </div>
      </fieldset>
      <ErrorMessage error={error} />
      <div className="azioni">
        <button
          type="submit"
          className="pulsante pulsante-primario"
          disabled={busy || doctors.length === 0}
        >
          <Icon name="fatto" /> <span>Autorizza</span>
        </button>
      </div>
    </form>
  );
}

const PERIODS = [7, 30, 90] as const;

/**
 * Avvisi sugli accessi anomali alle cartelle dell'archivio (Garante, linee guida sul dossier
 * sanitario, par. 7, lett. c), calcolati dal registro degli accessi con le soglie dello studio.
 * Finché una soglia è vuota, quell'avviso è spento e lo si dice.
 */
function AlertsSection({ archiveId }: { archiveId: string }) {
  const [days, setDays] = useState<number>(30);
  const alerts = useApi<Alerts>(`/api/archivi/${archiveId}/avvisi-accessi?giorni=${days}`);
  const a = alerts.data;
  const active = a ? a.regole.filter((r) => r.stato === 'attiva') : [];

  return (
    <section className="riquadro" aria-labelledby="titolo-avvisi-accessi">
      <h2 id="titolo-avvisi-accessi">
        <Icon name="avviso" /> Avvisi sugli accessi anomali
      </h2>
      <p>
        Dal registro degli accessi alle cartelle di questo archivio: chi apre più cartelle diverse
        della soglia in un giorno, chi vi accede nella fascia oraria indicata, i colleghi dell’AFT
        con più consultazioni della soglia in un giorno. Contano anche gli accessi negati. Le soglie
        le imposta l’amministratore dello studio in Strumenti › Dati dello studio.
      </p>
      <div className="campo campo-stretto">
        <label htmlFor="avvisi-periodo">Periodo</label>
        <select id="avvisi-periodo" value={days} onChange={(e) => setDays(Number(e.target.value))}>
          {PERIODS.map((d) => (
            <option key={d} value={d}>
              Ultimi {d} giorni
            </option>
          ))}
        </select>
      </div>
      {alerts.loading && !a && <Loading what="dati degli avvisi" />}
      <ErrorMessage error={alerts.error} />
      {a && (
        <>
          {a.daCompletare.length > 0 && (
            <Notice kind="avviso">
              <p>
                <strong>Soglie da completare.</strong> Finché una soglia è vuota, quell’avviso è
                spento e non si calcola:
              </p>
              <ul>
                {a.daCompletare.map((n) => (
                  <li key={n}>{n}.</li>
                ))}
              </ul>
            </Notice>
          )}
          {a.nonValide.length > 0 && (
            <Notice kind="avviso">
              <p>
                <strong>Soglie non valide</strong>, quindi spente: vanno corrette in Strumenti ›
                Dati dello studio.
              </p>
              <ul>
                {a.nonValide.map((n) => (
                  <li key={n}>{n}.</li>
                ))}
              </ul>
            </Notice>
          )}
          {active.length > 0 && (
            <>
              <p>Avvisi accesi:</p>
              <ul>
                {active.map((r) => (
                  <li key={r.codice}>
                    {r.nome}: {r.soglia}.
                  </li>
                ))}
              </ul>
              {a.avvisi.length === 0 ? (
                <Notice kind="fatto">
                  Nessun accesso anomalo dal {date(a.periodo.dal)} al {date(a.periodo.al)}.
                </Notice>
              ) : (
                <div className="tabella-scorrevole">
                  <table className="tabella">
                    <caption>
                      Accessi anomali dal {date(a.periodo.dal)} al {date(a.periodo.al)}, dai giorni
                      più recenti
                    </caption>
                    <thead>
                      <tr>
                        <th scope="col">Giorno</th>
                        <th scope="col">Utente</th>
                        <th scope="col">Avviso</th>
                        <th scope="col">Che cosa</th>
                        <th scope="col">Ore</th>
                      </tr>
                    </thead>
                    <tbody>
                      {a.avvisi.map((x) => (
                        <tr key={`${x.tipo}-${x.utente.id}-${x.giorno}`}>
                          <td>{date(x.giorno)}</td>
                          <td>
                            {x.utente.nome}
                            {x.utente.io ? ' (tu)' : ''}
                            {x.utente.studio && <div className="aiuto">{x.utente.studio}</div>}
                          </td>
                          <td>
                            <Icon name="avviso" size={18} /> {x.nome}
                          </td>
                          <td>{x.descrizione}</td>
                          <td>
                            {time(x.primo) === time(x.ultimo)
                              ? `alle ${time(x.primo)}`
                              : `dalle ${time(x.primo)} alle ${time(x.ultimo)}`}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
          <p className="aiuto">Fonte: {a.fonte}.</p>
        </>
      )}
    </section>
  );
}
