import { useState } from 'react';
import { Link } from 'react-router';
import { ErrorMessage, Loading, Notice } from '../components/common';
import { Icon } from '../components/Icon';
import { api, type ApiError } from '../lib/api';
import { date, dateTime, maskedFiscalCode, plural } from '../lib/format';
import { useApi } from '../lib/useApi';
import { failure } from './NewPatientPage';

/** Com'è andato l'ultimo controllo su AURA (D197). */
export type AuraOutcome =
  'aggiornato' | 'non_trovato' | 'ambiguo' | 'non_raggiungibile' | 'rifiutato' | 'spento';

export interface AuraChange {
  quando: string;
  tipo: 'esenzione' | 'scelta' | 'anagrafica' | 'stato' | 'archivio';
  variazione: 'nuova' | 'cambiata' | 'tolta';
  descrizione: string;
  avvio?: 'notte' | 'notifica' | 'manuale' | 'ricetta';
}

interface AuraState {
  disponibile: boolean;
  ambiente: 'simulator' | 'test' | 'production';
  idAura: string | null;
  controllatoIl: string | null;
  esito: AuraOutcome | null;
  messaggio: string | null;
  aggiornatoIl: string | null;
  /** Anagrafica di AURA diversa dalla cartella, da confermare (D198). */
  differenze: Difference[];
  variazioni: AuraChange[];
}

interface Difference {
  campo: string;
  etichetta: string;
  nellaCartella: string | null;
  inAura: string;
}

/** Ogni esito con un simbolo e una parola, non solo con il colore. */
const OUTCOME: Record<AuraOutcome, { text: string; kind: 'fatto' | 'avviso' | 'errore' | 'info' }> =
  {
    aggiornato: { text: 'Allineato con AURA', kind: 'fatto' },
    non_trovato: { text: 'Non trovato in AURA', kind: 'avviso' },
    ambiguo: { text: 'Più assistiti in AURA con lo stesso codice fiscale', kind: 'avviso' },
    non_raggiungibile: { text: 'AURA non raggiungibile', kind: 'avviso' },
    rifiutato: { text: 'Risposta di AURA non accettata', kind: 'errore' },
    spento: { text: 'AURA non collegata', kind: 'info' },
  };

export const CHANGE_LABEL: Record<AuraChange['variazione'], string> = {
  nuova: 'Nuova',
  cambiata: 'Cambiata',
  tolta: 'Tolta',
};

const KIND_LABEL: Record<AuraChange['tipo'], string> = {
  esenzione: 'Esenzione',
  scelta: 'Scelta del medico',
  anagrafica: 'Anagrafica',
  stato: 'Stato del paziente',
  archivio: 'Archivio',
};

/** Il decesso si dice in parole; gli altri dati come sono. */
const shown = (d: Difference, value: string | null) =>
  d.campo === 'decesso'
    ? value
      ? `Deceduto il ${date(value)}`
      : 'Non risulta deceduto'
    : (value ?? '—');

const TRIGGER_LABEL: Record<NonNullable<AuraChange['avvio']>, string> = {
  notte: 'controllo di ogni notte',
  notifica: 'notifica di AURA',
  manuale: 'aggiornamento dal pannello',
  ricetta: 'prima di una ricetta',
};

const UNAVAILABLE =
  'AURA non è ancora collegata al servizio vero: esenzioni e scelte si inseriscono a mano.';

/**
 * AURA, l'anagrafe regionale degli assistiti (D197): com'è andato l'ultimo controllo, il pulsante
 * «Aggiorna da AURA» per chi scrive nell'archivio, l'anagrafica di AURA da confermare (D198), le
 * ultime variazioni arrivate.
 */
export function AuraSection({
  patientId,
  canWrite,
  onUpdated,
}: {
  patientId: string;
  canWrite: boolean;
  /** Esenzioni o scelte cambiate: il pannello e la testata si ricaricano. */
  onUpdated: () => void;
}) {
  const st = useApi<AuraState>(`/api/pazienti/${patientId}/aura`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<{
    text: string;
    kind: 'fatto' | 'avviso' | 'errore' | 'info';
  } | null>(null);

  async function update() {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const r = await api<{ esito: AuraOutcome; messaggio: string | null; variazioni: number }>(
        `/api/pazienti/${patientId}/aura`,
        { method: 'POST' },
      );
      const o = OUTCOME[r.esito];
      setDone(
        r.esito === 'aggiornato'
          ? {
              kind: 'fatto',
              text: r.variazioni
                ? `Aggiornato da AURA: ${plural(r.variazioni, 'variazione', 'variazioni')}.`
                : 'Aggiornato da AURA: nessuna variazione.',
            }
          : { kind: o.kind, text: `${o.text}${r.messaggio ? `: ${r.messaggio}` : ''}.` },
      );
      st.reload();
      if (r.variazioni) onUpdated();
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  }

  /** Usa il dato di AURA, o tieni quello della cartella: una differenza alla volta. */
  async function choose(d: Difference, usa: boolean) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await api(`/api/pazienti/${patientId}/aura/differenze`, {
        method: 'POST',
        body: { scelte: [{ campo: d.campo, inAura: d.inAura, usa }] },
      });
      setDone({
        kind: 'fatto',
        text:
          d.campo === 'decesso'
            ? usa
              ? 'Decesso confermato.'
              : 'Decesso non confermato: non si ripropone finché AURA non manda un’altra data.'
            : usa
              ? `${d.etichetta}: ora c’è il dato di AURA.`
              : `${d.etichetta}: resta il dato della cartella.`,
      });
      st.reload();
      if (usa) onUpdated();
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  }

  const s = st.data;
  // Un servizio di prima, senza le differenze, non deve far cadere il pannello.
  const diffs = s && Array.isArray(s.differenze) ? s.differenze : [];
  return (
    <section className="riquadro" id="aura" aria-labelledby="titolo-aura">
      <h2 id="titolo-aura">
        <Icon name="ripeti" /> AURA, anagrafe regionale
      </h2>
      <p className="aiuto">
        Esenzioni e scelte del medico arrivano da AURA: a ogni variazione, ogni notte e prima di una
        ricetta con esenzione. Quelle arrivate da AURA non si modificano qui; quelle inserite a mano
        restano come sono. Se AURA dice che la scelta del medico è cessata, il paziente passa a
        «revocato» da solo. L’anagrafica di AURA entra nella cartella solo se la confermi.
      </p>
      {st.loading && !s && <Loading what="stato di AURA" />}
      <ErrorMessage error={st.error} />
      {s && (
        <>
          {!s.disponibile && <Notice kind="info">{UNAVAILABLE}</Notice>}
          {s.disponibile && s.ambiente === 'simulator' && (
            <Notice kind="info">
              Collegamento simulato: i dati arrivano dal simulatore di AURA, con assistiti
              inventati.
            </Notice>
          )}
          <dl className="dati">
            <dt>Stato</dt>
            <dd>
              {s.esito ? (
                <span className={`etichetta etichetta-${OUTCOME[s.esito].kind}`}>
                  <Icon name={OUTCOME[s.esito].kind === 'fatto' ? 'fatto' : 'avviso'} size={16} />{' '}
                  {OUTCOME[s.esito].text}
                </span>
              ) : (
                'Mai controllato'
              )}
            </dd>
            {s.messaggio && (
              <>
                <dt>Motivo</dt>
                <dd>{s.messaggio}</dd>
              </>
            )}
            <dt>Identificativo AURA</dt>
            <dd className="codice">{s.idAura ?? '—'}</dd>
            <dt>Ultimo controllo</dt>
            <dd>{s.controllatoIl ? dateTime(s.controllatoIl) : '—'}</dd>
            <dt>Allineato l’ultima volta</dt>
            <dd>{s.aggiornatoIl ? dateTime(s.aggiornatoIl) : '—'}</dd>
          </dl>
          {canWrite && s.disponibile && (
            <button
              type="button"
              className="pulsante"
              disabled={busy}
              onClick={() => void update()}
            >
              <Icon name="ripeti" />{' '}
              <span>{busy ? 'Controllo in corso…' : 'Aggiorna da AURA'}</span>
            </button>
          )}
          {diffs.length > 0 && (
            <>
              <h3 id="titolo-differenze-aura">Anagrafica diversa in AURA, da confermare</h3>
              <p className="aiuto">
                Un dato che non usi non si ripropone, finché AURA non ne manda un altro.
              </p>
              <div className="tabella-scorrevole">
                <table className="tabella" aria-labelledby="titolo-differenze-aura">
                  <thead>
                    <tr>
                      <th scope="col">Dato</th>
                      <th scope="col">Nella cartella</th>
                      <th scope="col">In AURA</th>
                      {canWrite && <th scope="col">Azioni</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {diffs.map((d) => (
                      <tr key={d.campo}>
                        <th scope="row">{d.etichetta}</th>
                        <td>{shown(d, d.nellaCartella)}</td>
                        <td>
                          <strong>{shown(d, d.inAura)}</strong>
                        </td>
                        {canWrite && (
                          <td>
                            <div className="azioni">
                              <button
                                type="button"
                                className="pulsante"
                                disabled={busy}
                                // Il nome comincia con il testo visibile, e dice di quale dato si tratta.
                                aria-label={
                                  d.campo === 'decesso'
                                    ? undefined
                                    : `Usa il dato di AURA: ${d.etichetta}`
                                }
                                onClick={() => void choose(d, true)}
                              >
                                <Icon name="fatto" />{' '}
                                <span>
                                  {d.campo === 'decesso'
                                    ? 'Conferma il decesso'
                                    : 'Usa il dato di AURA'}
                                </span>
                              </button>
                              <button
                                type="button"
                                className="pulsante pulsante-piatto"
                                disabled={busy}
                                aria-label={
                                  d.campo === 'decesso'
                                    ? undefined
                                    : `Tieni il dato della cartella: ${d.etichetta}`
                                }
                                onClick={() => void choose(d, false)}
                              >
                                <Icon name="annulla" />{' '}
                                <span>
                                  {d.campo === 'decesso'
                                    ? 'Non confermare il decesso'
                                    : 'Tieni il dato della cartella'}
                                </span>
                              </button>
                            </div>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {done && <Notice kind={done.kind}>{done.text}</Notice>}
          <ErrorMessage error={error} />
          <h3 id="titolo-variazioni-aura">Ultime variazioni da AURA</h3>
          {s.variazioni.length === 0 ? (
            <p className="tenue">Nessuna variazione arrivata da AURA.</p>
          ) : (
            <div className="tabella-scorrevole">
              <table className="tabella" aria-labelledby="titolo-variazioni-aura">
                <thead>
                  <tr>
                    <th scope="col">Quando</th>
                    <th scope="col">Che cosa</th>
                    <th scope="col">Variazione</th>
                    <th scope="col">Che cosa dice AURA</th>
                  </tr>
                </thead>
                <tbody>
                  {s.variazioni.map((v) => (
                    <tr key={`${v.quando}-${v.descrizione}`}>
                      <td>
                        {dateTime(v.quando)}
                        {v.avvio && <span className="tenue"> ({TRIGGER_LABEL[v.avvio]})</span>}
                      </td>
                      <td>{KIND_LABEL[v.tipo]}</td>
                      <td>{CHANGE_LABEL[v.variazione]}</td>
                      <th scope="row">{v.descrizione}</th>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

type Who = { id: string; cognome: string; nome: string };

interface StudioChanges {
  disponibile: boolean;
  giorni: number;
  variazioni: (AuraChange & { paziente: Who })[];
  /** Anagrafiche di AURA da confermare, il decesso per primo (D198). */
  daConfermare?: { paziente: Who; campi: string[]; decesso: string | null }[];
}

const toPanel = (p: Who) => `/pazienti/${p.id}/amministrazione#aura`;

/**
 * Pagina Oggi: le anagrafiche di AURA da confermare (il decesso in evidenza) e le variazioni
 * arrivate negli ultimi giorni, dei pazienti che l'utente vede. Senza nulla da mostrare non c'è.
 */
export function AuraChangesToday() {
  const r = useApi<StudioChanges>('/api/aura/variazioni?giorni=7');
  // Una risposta inattesa non deve far cadere la pagina Oggi.
  const list = Array.isArray(r.data?.variazioni) ? r.data.variazioni : [];
  const pending = Array.isArray(r.data?.daConfermare) ? r.data.daConfermare : [];
  if (list.length === 0 && pending.length === 0) return null;
  const deaths = pending.filter((p) => p.decesso);
  const registry = pending.filter((p) => p.campi.length > 0);
  return (
    <section aria-labelledby="titolo-aura-oggi" className="riquadro">
      <h2 id="titolo-aura-oggi">
        <Icon name="ripeti" /> Variazioni da AURA
      </h2>
      {pending.length > 0 && (
        <>
          <h3>Da confermare</h3>
          {deaths.map((p) => (
            <Notice key={`decesso-${p.paziente.id}`} kind="avviso">
              <p>
                AURA segnala il decesso di{' '}
                <Link to={toPanel(p.paziente)}>
                  {p.paziente.nome} {p.paziente.cognome}
                </Link>{' '}
                il {date(p.decesso)}: da confermare nei dati amministrativi.
              </p>
            </Notice>
          ))}
          {registry.length > 0 && (
            <ul className="elenco-semplice">
              {registry.map((p) => (
                <li key={`anagrafica-${p.paziente.id}`}>
                  <Link to={toPanel(p.paziente)}>
                    {p.paziente.nome} {p.paziente.cognome}
                  </Link>
                  : anagrafica diversa in AURA ({p.campi.join(', ')})
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {list.length === 0 ? null : (
        <>
          {pending.length > 0 && <h3>Ultime variazioni</h3>}
          <p className="tenue">
            Esenzioni, scelte e anagrafica cambiate nell’anagrafe regionale negli ultimi{' '}
            {plural(r.data?.giorni ?? 7, 'giorno', 'giorni')}.
          </p>
          <ul className="elenco-semplice">
            {list.map((v) => (
              <li key={`${v.quando}-${v.paziente.id}-${v.descrizione}`}>
                <Link to={toPanel(v.paziente)}>
                  {v.paziente.nome} {v.paziente.cognome}
                </Link>
                : {CHANGE_LABEL[v.variazione].toLowerCase()} – {v.descrizione}
                <span className="tenue"> ({dateTime(v.quando)})</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

/** Un nuovo assistito segnalato da AURA (D199). */
export interface NewPatient {
  id: string;
  cognome: string;
  nome: string;
  nascita: string;
  codiceFiscale: string;
  medico: string;
  sceltaDal: string;
  scadenza: string | null;
  segnalatoIl: string;
}

/**
 * Nuovi assistiti in AURA (D199), nella pagina Oggi: chi ha scelto un medico dello studio e non è
 * ancora nel suo archivio. Medico o segreteria lo registrano con un clic dai dati di AURA, o
 * scelgono di non registrarlo. Lo vede solo chi può registrare pazienti in quell'archivio.
 */
export function AuraNewPatientsToday() {
  const r = useApi<{ disponibile: boolean; nuovi: NewPatient[] }>('/api/aura/nuovi');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ patientId?: string; text: string } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  // Una risposta inattesa non deve far cadere la pagina Oggi.
  const list = Array.isArray(r.data?.nuovi) ? r.data.nuovi : [];
  if (list.length === 0 && !done && !error) return null;
  const existing = (error?.details as { paziente?: { id: string } | null } | undefined)?.paziente;

  async function act(n: NewPatient, register: boolean) {
    setBusy(true);
    setError(null);
    setDone(null);
    const name = `${n.nome} ${n.cognome}`;
    try {
      if (register) {
        const res = await api<{ id: string }>(`/api/aura/nuovi/${n.id}/registra`, {
          method: 'POST',
        });
        setDone({ patientId: res.id, text: `${name}: registrato con i dati di AURA.` });
      } else {
        await api(`/api/aura/nuovi/${n.id}/non-registrare`, { method: 'POST' });
        setDone({
          text: `${name}: non registrato. Non si ripropone finché AURA non manda una scelta nuova.`,
        });
      }
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
      r.reload();
    }
  }

  return (
    <section aria-labelledby="titolo-nuovi-aura" className="riquadro">
      <h2 id="titolo-nuovi-aura">
        <Icon name="aggiungi" /> Nuovi assistiti in AURA
      </h2>
      <p className="tenue">
        Hanno scelto un medico dello studio e non sono ancora nel suo archivio. «Registra» li porta
        nell’archivio con i dati di AURA; esenzioni e scelta arrivano subito dopo.
      </p>
      {list.length > 0 && (
        <div className="tabella-scorrevole">
          <table className="tabella">
            <caption>Nuovi assistiti da registrare</caption>
            <thead>
              <tr>
                <th scope="col">Assistito</th>
                <th scope="col">Nascita</th>
                <th scope="col">Codice fiscale</th>
                <th scope="col">Scelta</th>
                <th scope="col">Azioni</th>
              </tr>
            </thead>
            <tbody>
              {list.map((n) => {
                const name = `${n.nome} ${n.cognome}`;
                return (
                  <tr key={n.id}>
                    <th scope="row">{name}</th>
                    <td>{date(n.nascita)}</td>
                    <td>
                      <span className="codice">{maskedFiscalCode(n.codiceFiscale)}</span>
                    </td>
                    <td>
                      {n.medico}, dal {date(n.sceltaDal)}
                      {n.scadenza ? `; temporanea fino al ${date(n.scadenza)}` : ''}
                    </td>
                    <td>
                      <div className="azioni">
                        <button
                          type="button"
                          className="pulsante pulsante-primario"
                          disabled={busy}
                          // Il nome comincia con il testo visibile, e dice di chi si tratta.
                          aria-label={`Registra ${name}`}
                          onClick={() => void act(n, true)}
                        >
                          <Icon name="aggiungi" /> <span>Registra</span>
                        </button>
                        <button
                          type="button"
                          className="pulsante pulsante-piatto"
                          disabled={busy}
                          aria-label={`Non registrare ${name}`}
                          onClick={() => void act(n, false)}
                        >
                          <Icon name="annulla" /> <span>Non registrare</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {done && (
        <Notice kind="fatto">
          <p>
            {done.text}
            {done.patientId && (
              <>
                {' '}
                <Link to={`/pazienti/${done.patientId}`}>Apri la cartella</Link>
              </>
            )}
          </p>
        </Notice>
      )}
      <ErrorMessage error={error} />
      {existing && (
        <p>
          <Link to={`/pazienti/${existing.id}`}>Apri la cartella del paziente già registrato</Link>
        </p>
      )}
    </section>
  );
}

/** Un cambio di medico dentro lo studio da decidere (D200), per il titolare di prima. */
export interface DoctorChange {
  id: string;
  paziente: { id: string; cognome: string; nome: string };
  medico: string;
  medicoId: string;
  sceltaDal: string;
}

/** Lo stesso cambio visto dal medico scelto: chi l'ha scelto e chi decide. */
export interface IncomingDoctorChange {
  id: string;
  paziente: { cognome: string; nome: string };
  daMedico: string;
  sceltaDal: string;
}

/**
 * Cambi di medico dentro lo studio (D200), nella pagina Oggi. Il titolare dell'archivio dove il
 * paziente sta decide con un clic: «Sposta» nell'archivio del medico scelto in AURA, o «Non
 * spostare». Il medico scelto sa chi l'ha scelto e chi decide; la cartella non è nel suo archivio,
 * quindi niente collegamento.
 */
export function AuraDoctorChangesToday() {
  const r = useApi<{ daDecidere: DoctorChange[]; inArrivo: IncomingDoctorChange[] }>(
    '/api/aura/cambi-medico',
  );
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  // Una risposta inattesa non deve far cadere la pagina Oggi.
  const toDecide = Array.isArray(r.data?.daDecidere) ? r.data.daDecidere : [];
  const incoming = Array.isArray(r.data?.inArrivo) ? r.data.inArrivo : [];
  if (toDecide.length === 0 && incoming.length === 0 && !done && !error) return null;

  async function act(c: DoctorChange, move: boolean) {
    setBusy(true);
    setError(null);
    setDone(null);
    const name = `${c.paziente.nome} ${c.paziente.cognome}`;
    // Il cambio come si vede qui: se AURA nel frattempo cambia la scelta, il servizio lo dice.
    const body = { medico: c.medicoId, sceltaDal: c.sceltaDal };
    try {
      if (move) {
        await api(`/api/aura/cambi-medico/${c.id}/sposta`, { method: 'POST', body });
        setDone(`${name}: spostato nell’archivio di ${c.medico}.`);
      } else {
        await api(`/api/aura/cambi-medico/${c.id}/non-spostare`, { method: 'POST', body });
        setDone(
          `${name}: resta nel tuo archivio. Non si ripropone finché AURA non manda una scelta nuova.`,
        );
      }
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
      r.reload();
    }
  }

  return (
    <section aria-labelledby="titolo-cambi-medico" className="riquadro">
      <h2 id="titolo-cambi-medico">
        <Icon name="archivio" /> Cambi di medico nello studio
      </h2>
      {toDecide.length > 0 && (
        <>
          <h3>Da decidere</h3>
          <p className="tenue">
            Hanno scelto in AURA un altro medico dello studio. Lo spostamento nel suo archivio lo
            decidi tu: la cartella passa intera, con lo storico.
          </p>
          <div className="tabella-scorrevole">
            <table className="tabella">
              <caption>Pazienti da spostare</caption>
              <thead>
                <tr>
                  <th scope="col">Paziente</th>
                  <th scope="col">Scelta in AURA</th>
                  <th scope="col">Azioni</th>
                </tr>
              </thead>
              <tbody>
                {toDecide.map((c) => {
                  const name = `${c.paziente.nome} ${c.paziente.cognome}`;
                  return (
                    <tr key={c.id}>
                      <th scope="row">{name}</th>
                      <td>
                        {c.medico}, dal {date(c.sceltaDal)}
                      </td>
                      <td>
                        <div className="azioni">
                          <button
                            type="button"
                            className="pulsante pulsante-primario"
                            disabled={busy}
                            // Il nome comincia con il testo visibile, e dice chi e dove.
                            aria-label={`Sposta ${name} nell’archivio di ${c.medico}`}
                            onClick={() => void act(c, true)}
                          >
                            <Icon name="archivio" /> <span>Sposta</span>
                          </button>
                          <button
                            type="button"
                            className="pulsante pulsante-piatto"
                            disabled={busy}
                            aria-label={`Non spostare ${name}`}
                            onClick={() => void act(c, false)}
                          >
                            <Icon name="annulla" /> <span>Non spostare</span>
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
      {incoming.length > 0 && (
        <>
          <h3>Ti hanno scelto</h3>
          <ul className="elenco-semplice">
            {incoming.map((c) => (
              <li key={c.id}>
                {c.paziente.nome} {c.paziente.cognome} ti ha scelto in AURA dal {date(c.sceltaDal)}:
                è ancora nell’archivio di {c.daMedico}, che decide lo spostamento.
              </li>
            ))}
          </ul>
        </>
      )}
      {done && <Notice kind="fatto">{done}</Notice>}
      <ErrorMessage error={error} />
    </section>
  );
}
