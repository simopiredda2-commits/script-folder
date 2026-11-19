import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ErrorMessage, Loading, Notice } from '../../components/common';
import { Icon } from '../../components/Icon';
import { api, ApiError } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { useApi } from '../../lib/useApi';

type RoleCode = 'owner_doctor' | 'secretary' | 'substitute_doctor' | 'administrator';
interface RoleOption {
  codice: RoleCode;
  nome: string;
}
interface Doctor {
  codiceFiscale: string | null;
  codiceRegionale: string | null;
  asl: string | null;
  nome: string | null;
  cognome: string | null;
  /** Correzione del codice fiscale che aspetta il medico (D181): fino ad allora vale l'altro. */
  correzioneCodiceFiscale?: { proposto: string; da: string | null; il: string | null } | null;
}
interface User {
  id: string;
  nomeUtente: string;
  nome: string;
  email: string | null;
  ruoli: RoleOption[];
  stato: 'attivo' | 'sospeso';
  secondoFattoreAttivo: boolean;
  bloccatoFinoA: string | null;
  tentativiFalliti: number;
  passwordDaCambiare: boolean;
  passwordCambiataIl: string | null;
  creatoIl: string;
  medico: Doctor | null;
  archivio: { id: string; nome: string } | null;
  /** Per la segreteria: archivio per archivio, la decisione del suo titolare (D181). */
  archiviSegreteria?:
    | {
        archivio: { id: string; nome: string };
        stato: 'confermata' | 'rifiutata' | 'da_confermare';
        da: string | null;
        il: string | null;
      }[]
    | null;
  io: boolean;
  /** Ruolo con i dati dei pazienti dato dall'amministratore: non entra finché un titolare non conferma. */
  inAttesaDiConferma: boolean;
  richiestaDiConferma: { da: string | null; il: string } | null;
  confermato: { da: string | null; il: string } | null;
  /**
   * Medici e segreteria: password, secondo fattore e sblocco dopo i tentativi falliti li fa chi
   * gestisce il servizio, sul server.
   */
  ripristinoDalServizio: boolean;
  /** Titolare con pazienti: non si sospende e, se è sospeso, non si riattiva da qui. */
  titolareConPazienti: boolean;
  /** L'ultimo titolare attivo e confermato: non si sospende da qui. */
  ultimoTitolare: boolean;
  /** In attesa, e nessun titolare può confermarlo: lo conferma chi gestisce il servizio. */
  confermaDalServizio: boolean;
  /** Sospeso da chi gestisce il servizio, sul server: da qui non si riattiva. */
  sospesoDalServizio: boolean;
}
interface Users {
  utenti: User[];
  ruoli: RoleOption[];
}
interface Result {
  utente: User;
  passwordTemporanea?: string;
  sessioniChiuse?: number;
  avvisi?: string[];
}

type RowAction =
  | 'sospendi'
  | 'riattiva'
  | 'password-temporanea'
  | 'azzera-secondo-fattore'
  | 'sblocca'
  | 'codice-fiscale/ritira';

const DOCTOR_ROLES: RoleCode[] = ['owner_doctor', 'substitute_doctor'];
const isDoctor = (roles: RoleCode[]) => roles.some((r) => DOCTOR_ROLES.includes(r));

const failure = (e: unknown) =>
  e instanceof ApiError ? e : new ApiError(0, 'Servizio non raggiungibile');

/** Che cosa chiede la conferma e che cosa dice l'esito, per ogni azione della riga. */
const ROW_ACTIONS: Record<
  RowAction,
  { label: string; confirm: (u: User) => string; done: (n: string, closed: number) => string }
> = {
  sospendi: {
    label: 'Sospendi',
    confirm: ({ nome: n }) =>
      `Sospendere ${n}? Le sue sessioni si chiudono subito e non potrà accedere finché non viene riattivato. Non si cancella nulla.`,
    done: (n, k) => `Utente sospeso: ${n}. Sessioni chiuse: ${k}.`,
  },
  riattiva: {
    label: 'Riattiva',
    confirm: (u) =>
      u.inAttesaDiConferma
        ? `Riattivare ${u.nome}? Resta in attesa della conferma di un medico titolare: entra solo dopo, e la richiesta torna nell’elenco dei titolari.`
        : `Riattivare ${u.nome}? Potrà accedere di nuovo con la sua password e il secondo fattore.`,
    done: (n) => `Utente riattivato: ${n}.`,
  },
  'password-temporanea': {
    label: 'Password temporanea',
    confirm: ({ nome: n }) =>
      `Dare a ${n} una password temporanea nuova? Quella di adesso smette di valere, le sue sessioni si chiudono e al prossimo accesso dovrà sceglierne una sua.`,
    done: (n, k) => `Password temporanea creata per ${n}. Sessioni chiuse: ${k}.`,
  },
  'azzera-secondo-fattore': {
    label: 'Azzera il secondo fattore',
    confirm: ({ nome: n }) =>
      `Azzerare il secondo fattore di ${n}? Le sue sessioni si chiudono; al prossimo accesso lo attiverà di nuovo con l’app di autenticazione.`,
    done: (n, k) => `Secondo fattore azzerato per ${n}. Sessioni chiuse: ${k}.`,
  },
  'codice-fiscale/ritira': {
    label: 'Ritira la correzione del codice fiscale',
    confirm: ({ nome: n }) =>
      `Ritirare la correzione del codice fiscale di ${n}? Resta il codice di adesso; il medico non avrà più niente da confermare.`,
    done: (n) => `Correzione del codice fiscale ritirata: per ${n} resta il codice di prima.`,
  },
  sblocca: {
    label: 'Sblocca',
    confirm: ({ nome: n }) =>
      `Sbloccare ${n}? I tentativi falliti tornano a zero e può riprovare subito.`,
    done: (n) => `Utente sbloccato: ${n}.`,
  },
};

/**
 * Perché per medici e segreteria qui non ci sono password temporanea, azzeramento e sblocco: una
 * riga breve per utente; il motivo è nell'introduzione della sezione, una volta sola.
 */
const RESTORE_BY_SERVICE =
  'Password, secondo fattore e sblocco: li ripristina chi gestisce il servizio, sul server.';
const OWNER_WITH_PATIENTS =
  'Ha pazienti nel suo archivio: per sospenderlo, prima il medico esporta i suoi dati, poi lo fa chi gestisce il servizio.';
const OWNER_WITH_PATIENTS_SUSPENDED =
  'Ha pazienti nel suo archivio: lo riattiva chi gestisce il servizio, sul server.';
const LAST_OWNER =
  'È l’ultimo medico titolare attivo e confermato: senza di lui nessuno conferma gli utenti dal programma. Per sospenderlo prima va confermato un altro titolare, oppure lo fa chi gestisce il servizio, sul server.';
const SUSPENDED_BY_SERVICE =
  'L’ha sospeso chi gestisce il servizio, sul server: lo riattiva solo lui, perché da qui si annullerebbe una decisione presa sul server.';

interface FormValues {
  nomeUtente: string;
  nome: string;
  email: string;
  ruoli: RoleCode[];
  medicoNome: string;
  medicoCognome: string;
  codiceFiscale: string;
  codiceRegionale: string;
  asl: string;
}

const EMPTY: FormValues = {
  nomeUtente: '',
  nome: '',
  email: '',
  ruoli: [],
  medicoNome: '',
  medicoCognome: '',
  codiceFiscale: '',
  codiceRegionale: '',
  asl: '',
};

const valuesOf = (u: User): FormValues => ({
  nomeUtente: u.nomeUtente,
  nome: u.nome,
  email: u.email ?? '',
  ruoli: u.ruoli.map((r) => r.codice),
  medicoNome: u.medico?.nome ?? '',
  medicoCognome: u.medico?.cognome ?? '',
  codiceFiscale: u.medico?.codiceFiscale ?? '',
  codiceRegionale: u.medico?.codiceRegionale ?? '',
  asl: u.medico?.asl ?? '',
});

const doctorOf = (v: FormValues) => ({
  codiceFiscale: v.codiceFiscale,
  nome: v.medicoNome,
  cognome: v.medicoCognome,
  codiceRegionale: v.codiceRegionale,
  asl: v.asl,
});

/** I messaggi sui campi non validi, quando il servizio li manda nei dettagli. */
function IssueDetails({ error }: { error: ApiError | null }) {
  const issues = Array.isArray(error?.details) ? (error.details as { message?: unknown }[]) : [];
  const messages = issues
    .map((i) => i.message)
    .filter((m): m is string => typeof m === 'string' && m.length > 0);
  if (messages.length === 0) return null;
  return (
    <ul className="aiuto">
      {messages.map((m) => (
        <li key={m}>{m}</li>
      ))}
    </ul>
  );
}

/**
 * Utenti dello studio, ruoli, dati del medico, sospensione, password temporanea, secondo fattore
 * (tappa 14). Solo per l'amministratore; ogni azione va nel registro delle azioni di
 * amministrazione, che leggono anche i medici titolari. La password temporanea si vede una volta.
 */
export function UsersSection() {
  const users = useApi<Users>('/api/studio/utenti');
  const [shown, setShown] = useState<{ nome: string; nomeUtente: string; password: string } | null>(
    null,
  );
  const [outcome, setOutcome] = useState<{ text: string; avvisi: string[] } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  if (users.loading && !users.data) return <Loading what="utenti dello studio" />;
  if (!users.data) return <ErrorMessage error={users.error} />;
  const data = users.data;
  const editingUser = data.utenti.find((u) => u.id === editing) ?? null;

  const begin = () => {
    setBusy(true);
    setError(null);
    setOutcome(null);
  };
  const finish = (r: Result, text: string) => {
    if (r.passwordTemporanea)
      setShown({
        nome: r.utente.nome,
        nomeUtente: r.utente.nomeUtente,
        password: r.passwordTemporanea,
      });
    setOutcome({ text, avvisi: r.avvisi ?? [] });
    users.reload();
  };

  async function act(u: User, kind: RowAction) {
    const a = ROW_ACTIONS[kind];
    if (!window.confirm(a.confirm(u))) return;
    begin();
    try {
      const r = await api<Result>(`/api/studio/utenti/${u.id}/${kind}`, {
        method: 'POST',
        body: {},
      });
      finish(r, a.done(u.nome, r.sessioniChiuse ?? 0));
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  }

  async function create(v: FormValues): Promise<boolean> {
    begin();
    try {
      const r = await api<Result>('/api/studio/utenti', {
        method: 'POST',
        body: {
          nomeUtente: v.nomeUtente,
          nome: v.nome,
          email: v.email,
          ruoli: v.ruoli,
          ...(isDoctor(v.ruoli) ? { medico: doctorOf(v) } : {}),
        },
      });
      finish(r, `Utente creato: ${r.utente.nome}.`);
      return true;
    } catch (e) {
      setError(failure(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function save(u: User, v: FormValues): Promise<boolean> {
    begin();
    try {
      const r = await api<Result>(`/api/studio/utenti/${u.id}`, {
        method: 'PATCH',
        body: {
          nome: v.nome,
          email: v.email,
          ...(u.io ? {} : { ruoli: v.ruoli }),
          ...(isDoctor(v.ruoli) ? { medico: doctorOf(v) } : {}),
        },
      });
      finish(r, `Modifiche salvate: ${r.utente.nome}.`);
      setEditing(null);
      return true;
    } catch (e) {
      setError(failure(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <section className="riquadro" aria-labelledby="titolo-userssection">
        <h2 id="titolo-userssection">
          <Icon name="pazienti" /> Utenti e ruoli
        </h2>
        <p>
          Chi lavora nello studio e con quali ruoli. Un utente non si cancella: si sospende. Ogni
          azione va nel registro delle azioni di amministrazione, che leggono anche i medici
          titolari. I tuoi ruoli e le tue credenziali li cambia un altro amministratore.
        </p>
        <p>
          Chi lavora con i dati dei pazienti (medici e segreteria), creato qui o con un ruolo nuovo,
          entra solo dopo la conferma di un medico titolare dello studio, sempre: anche il primo
          medico titolare. Quando nello studio non c’è un titolare attivo e confermato che possa
          farlo, la conferma la fa chi gestisce il servizio, sul server. Password, secondo fattore e
          sblocco dopo i tentativi falliti di medici e segreteria li fa chi gestisce il servizio,
          sul server: da qui l’amministratore potrebbe entrare al posto loro. Il blocco, altrimenti,
          finisce da solo allo scadere del tempo.
        </p>
        {shown && <TemporaryPassword shown={shown} onClose={() => setShown(null)} />}
        {outcome && <Notice kind="fatto">{outcome.text}</Notice>}
        {outcome && outcome.avvisi.length > 0 && (
          <Notice kind="info">
            {outcome.avvisi.map((x) => (
              <p key={x}>{x}</p>
            ))}
          </Notice>
        )}
        <ErrorMessage error={error} />
        <IssueDetails error={error} />
        <div className="tabella-scorrevole">
          <table className="tabella">
            <caption>Utenti dello studio</caption>
            <thead>
              <tr>
                <th scope="col">Utente</th>
                <th scope="col">Ruoli</th>
                <th scope="col">Stato</th>
                <th scope="col">Dati del medico</th>
                <th scope="col">Archivio</th>
                <th scope="col">Azioni</th>
              </tr>
            </thead>
            <tbody>
              {data.utenti.map((u) => (
                <tr key={u.id}>
                  <th scope="row">
                    {u.nome}
                    {u.io ? ' (tu)' : ''}
                    <br />
                    <span className="codice">{u.nomeUtente}</span>
                    {u.email && (
                      <>
                        <br />
                        <span className="tenue">{u.email}</span>
                      </>
                    )}
                  </th>
                  <td>{u.ruoli.map((r) => r.nome).join(', ')}</td>
                  <td>
                    <UserStatus u={u} />
                  </td>
                  <td>
                    {u.medico ? (
                      <ul className="opzioni">
                        <li>
                          {u.medico.nome ?? '—'} {u.medico.cognome ?? ''}
                        </li>
                        <li>
                          <span className="codice">{u.medico.codiceFiscale ?? '—'}</span>
                        </li>
                        {u.medico.correzioneCodiceFiscale && (
                          <li>
                            <strong>
                              <Icon name="avviso" /> Correzione in attesa del medico:
                            </strong>{' '}
                            <span className="codice">
                              {u.medico.correzioneCodiceFiscale.proposto}
                            </span>
                            . Finché il medico non la conferma vale il codice di adesso.
                          </li>
                        )}
                        <li>Codice regionale: {u.medico.codiceRegionale ?? 'da completare'}</li>
                        {u.medico.asl && <li>{u.medico.asl}</li>}
                      </ul>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>
                    {u.archiviSegreteria ? (
                      <ul className="opzioni">
                        {u.archiviSegreteria.map((a) => (
                          <li key={a.archivio.id}>
                            {a.archivio.nome}:{' '}
                            {a.stato === 'confermata'
                              ? 'confermata dal titolare'
                              : a.stato === 'rifiutata'
                                ? 'non ci lavora'
                                : 'da confermare dal titolare'}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      (u.archivio?.nome ?? '—')
                    )}
                  </td>
                  <td>
                    <ul className="elenco-azioni">
                      <li>
                        <button
                          type="button"
                          className="pulsante"
                          disabled={busy}
                          aria-pressed={editing === u.id}
                          onClick={() => setEditing(editing === u.id ? null : u.id)}
                        >
                          <span>Modifica</span>{' '}
                          <span className="visivamente-nascosto">{u.nome}</span>
                        </button>
                      </li>
                      {!u.io &&
                        rowActions(u).map((kind) => (
                          <li key={kind}>
                            <button
                              type="button"
                              className="pulsante pulsante-piatto"
                              disabled={busy}
                              onClick={() => void act(u, kind)}
                            >
                              <span>{ROW_ACTIONS[kind].label}</span>{' '}
                              <span className="visivamente-nascosto">per {u.nome}</span>
                            </button>
                          </li>
                        ))}
                    </ul>
                    {!u.io && u.ripristinoDalServizio && (
                      <p className="aiuto">{RESTORE_BY_SERVICE}</p>
                    )}
                    {!u.io && u.sospesoDalServizio && (
                      <p className="aiuto">{SUSPENDED_BY_SERVICE}</p>
                    )}
                    {!u.io && u.titolareConPazienti && !u.sospesoDalServizio && (
                      <p className="aiuto">
                        {u.stato === 'attivo' ? OWNER_WITH_PATIENTS : OWNER_WITH_PATIENTS_SUSPENDED}
                      </p>
                    )}
                    {!u.io && u.ultimoTitolare && !u.titolareConPazienti && (
                      <p className="aiuto">{LAST_OWNER}</p>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {editingUser && (
        <UserForm
          key={editingUser.id}
          mode="modifica"
          title={`Modifica di ${editingUser.nome}`}
          initial={valuesOf(editingUser)}
          roles={data.ruoli}
          ownRoles={editingUser.io}
          busy={busy}
          onSubmit={(v) => save(editingUser, v)}
          onCancel={() => setEditing(null)}
        />
      )}
      <UserForm
        mode="nuovo"
        title="Nuovo utente"
        initial={EMPTY}
        roles={data.ruoli}
        ownRoles={false}
        busy={busy}
        onSubmit={create}
      />
    </>
  );
}

/**
 * Le azioni che hanno senso per l'utente della riga, nell'ordine in cui si mostrano. Per medici e
 * segreteria niente password temporanea, azzeramento del secondo fattore né sblocco; un titolare
 * con pazienti non si sospende e non si riattiva da qui, l'ultimo titolare attivo e confermato non
 * si sospende, chi è sospeso da chi gestisce il servizio non si riattiva da qui. Il servizio lo
 * controlla comunque.
 */
function rowActions(u: User): RowAction[] {
  const out: RowAction[] = [];
  if (u.stato !== 'attivo') {
    if (!u.titolareConPazienti && !u.sospesoDalServizio) out.push('riattiva');
  } else if (!u.titolareConPazienti && !u.ultimoTitolare) out.push('sospendi');
  if (!u.ripristinoDalServizio) {
    out.push('password-temporanea');
    if (u.secondoFattoreAttivo) out.push('azzera-secondo-fattore');
    if (u.bloccatoFinoA || u.tentativiFalliti > 0) out.push('sblocca');
  }
  if (u.medico?.correzioneCodiceFiscale) out.push('codice-fiscale/ritira');
  return out;
}

function UserStatus({ u }: { u: User }) {
  return (
    <ul className="opzioni">
      <li>
        {u.stato === 'attivo' ? (
          'Attivo'
        ) : (
          <strong>
            <Icon name="blocco" />{' '}
            {u.sospesoDalServizio ? 'Sospeso da chi gestisce il servizio' : 'Sospeso'}
          </strong>
        )}
      </li>
      {u.inAttesaDiConferma && (
        <li>
          <strong>
            <Icon name="storico" /> In attesa di conferma di un titolare
          </strong>
          {u.richiestaDiConferma && (
            <>
              {' '}
              (richiesta{u.richiestaDiConferma.da ? ` di ${u.richiestaDiConferma.da}` : ''} del{' '}
              {dateTime(u.richiestaDiConferma.il)})
            </>
          )}
        </li>
      )}
      {u.inAttesaDiConferma && u.confermaDalServizio && (
        <li>
          Nessun medico titolare attivo e confermato può confermarlo: lo conferma chi gestisce il
          servizio, sul server.
        </li>
      )}
      {u.confermato && (
        <li className="tenue">
          Confermato {u.confermato.da ? `da ${u.confermato.da}` : 'da chi gestisce il servizio'} il{' '}
          {dateTime(u.confermato.il)}
        </li>
      )}
      {u.bloccatoFinoA && (
        <li>
          <strong>
            <Icon name="lucchetto" /> Bloccato fino al {dateTime(u.bloccatoFinoA)}
          </strong>
        </li>
      )}
      {!u.bloccatoFinoA && u.tentativiFalliti > 0 && (
        <li>Tentativi falliti: {u.tentativiFalliti}</li>
      )}
      <li>
        Secondo fattore: {u.secondoFattoreAttivo ? 'attivo' : 'si attiva al prossimo accesso'}
      </li>
      {u.passwordDaCambiare ? (
        <li>
          <Icon name="avviso" /> Password temporanea: va cambiata al prossimo accesso
        </li>
      ) : (
        u.passwordCambiataIl && (
          <li className="tenue">Password cambiata il {dateTime(u.passwordCambiataIl)}</li>
        )
      )}
    </ul>
  );
}

/**
 * La password temporanea, una volta sola: si consegna di persona, poi si nasconde. La usano
 * l'amministratore (utenti senza dati dei pazienti) e il titolare che conferma un utente.
 */
export function TemporaryPassword({
  shown,
  onClose,
}: {
  shown: { nome: string; nomeUtente: string; password: string };
  onClose: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  // Chi usa un lettore di schermo o la tastiera arriva subito alla password.
  useEffect(() => {
    ref.current?.focus();
  }, [shown]);
  return (
    <section ref={ref} tabIndex={-1} aria-labelledby="titolo-password-temporanea">
      <Notice kind="avviso">
        <p id="titolo-password-temporanea">
          <strong>Password temporanea di {shown.nome}</strong> (nome utente{' '}
          <span className="codice">{shown.nomeUtente}</span>):
        </p>
        <p className="segreto codice">{shown.password}</p>
        <p>
          Consegnala di persona, a voce o su carta: non mandarla per email o per messaggio. Si vede
          solo adesso; se va persa se ne crea un’altra. Al primo accesso l’utente la usa una volta,
          attiva il secondo fattore e sceglie la sua password.
        </p>
        <p>
          <button type="button" className="pulsante" onClick={onClose}>
            <Icon name="fatto" /> <span>Consegnata: nascondi la password</span>
          </button>
        </p>
      </Notice>
    </section>
  );
}

/** Modulo di un utente: nuovo (con il nome utente) o in modifica (il nome utente non cambia). */
function UserForm({
  mode,
  title,
  initial,
  roles,
  ownRoles,
  busy,
  onSubmit,
  onCancel,
}: {
  mode: 'nuovo' | 'modifica';
  title: string;
  initial: FormValues;
  roles: RoleOption[];
  ownRoles: boolean;
  busy: boolean;
  onSubmit: (v: FormValues) => Promise<boolean>;
  onCancel?: () => void;
}) {
  const [v, setV] = useState<FormValues>(initial);
  const set = (patch: Partial<FormValues>) => setV((x) => ({ ...x, ...patch }));
  const id = (name: string) => `utente-${mode}-${name}`;
  const titleId = id('titolo');

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (v.ruoli.length === 0) return;
    if ((await onSubmit(v)) && mode === 'nuovo') setV(EMPTY);
  }

  const input = (
    name: keyof Omit<FormValues, 'ruoli'>,
    label: string,
    props: {
      required?: boolean;
      type?: string;
      maxLength?: number;
      minLength?: number;
      pattern?: string;
      code?: boolean;
      help?: string;
      upper?: boolean;
    } = {},
  ) => (
    <div className="campo">
      <label htmlFor={id(name)}>{label}</label>
      <input
        id={id(name)}
        type={props.type ?? 'text'}
        className={props.code ? 'codice' : undefined}
        required={props.required}
        maxLength={props.maxLength ?? 120}
        minLength={props.minLength}
        pattern={props.pattern}
        autoComplete="off"
        aria-describedby={props.help ? id(`${name}-aiuto`) : undefined}
        value={v[name]}
        onChange={(e) =>
          set({ [name]: props.upper ? e.target.value.toUpperCase() : e.target.value })
        }
      />
      {props.help && (
        <p className="aiuto" id={id(`${name}-aiuto`)}>
          {props.help}
        </p>
      )}
    </div>
  );

  return (
    <form className="riquadro" onSubmit={(e) => void submit(e)} aria-labelledby={titleId}>
      <h2 id={titleId}>
        <Icon name={mode === 'nuovo' ? 'aggiungi' : 'firma'} /> {title}
      </h2>
      {mode === 'nuovo' && (
        <p>
          La password temporanea si crea da sola. Per un amministratore si vede qui, una volta sola,
          appena creato l’utente. Medici e segreteria aspettano la conferma di un medico titolare
          dello studio, che riceve la password e la consegna di persona; se nessun titolare attivo e
          confermato può confermare (per esempio il primo titolare di uno studio nuovo), la conferma
          e la password le dà chi gestisce il servizio, sul server. Il secondo fattore si attiva al
          primo accesso.
        </p>
      )}
      <fieldset disabled={busy}>
        <legend className="visivamente-nascosto">Dati dell’utente</legend>
        {mode === 'nuovo' &&
          input('nomeUtente', 'Nome utente', {
            required: true,
            code: true,
            minLength: 3,
            maxLength: 64,
            pattern: '[A-Za-z0-9][A-Za-z0-9._\\-]{2,63}',
            help: 'Da 3 a 64 caratteri: lettere, cifre, punto, trattino e trattino basso. Si scrive all’accesso, in minuscolo, e non si cambia.',
          })}
        <div className="campi-in-riga">
          {input('nome', 'Nome mostrato', {
            required: true,
            help: 'Come compare nel programma, per esempio «Dott.ssa Elena Marchi».',
          })}
          {input('email', 'Email (facoltativa)', { type: 'email', maxLength: 200 })}
        </div>
      </fieldset>
      <fieldset className="scelta-in-riga" disabled={busy || ownRoles}>
        <legend>Ruoli</legend>
        {roles.map((r) => (
          <div key={r.codice} className="casella">
            <input
              type="checkbox"
              id={id(`ruolo-${r.codice}`)}
              checked={v.ruoli.includes(r.codice)}
              onChange={(e) =>
                set({
                  ruoli: e.target.checked
                    ? [...v.ruoli, r.codice]
                    : v.ruoli.filter((x) => x !== r.codice),
                })
              }
            />
            <label htmlFor={id(`ruolo-${r.codice}`)}>{r.nome}</label>
          </div>
        ))}
      </fieldset>
      {ownRoles ? (
        <p className="aiuto">I tuoi ruoli li cambia un altro amministratore.</p>
      ) : (
        v.ruoli.length === 0 && (
          <p className="aiuto">
            Scegli almeno un ruolo. La segreteria vede l’anagrafica e le terapie non riservate di
            tutti gli archivi dello studio; un medico titolare ha il suo archivio; un sostituto
            lavora su un archivio solo con l’autorizzazione del titolare; l’amministratore gestisce
            lo studio, senza accesso clinico se non è anche medico.
          </p>
        )
      )}
      {isDoctor(v.ruoli) && (
        <fieldset disabled={busy}>
          <legend>Dati del medico</legend>
          <div className="campi-in-riga">
            {input('medicoNome', 'Nome', { required: true, maxLength: 100 })}
            {input('medicoCognome', 'Cognome', { required: true, maxLength: 100 })}
            {input('codiceFiscale', 'Codice fiscale', {
              required: true,
              code: true,
              upper: true,
              minLength: 16,
              maxLength: 16,
              pattern: '[A-Za-z0-9]{16}',
            })}
          </div>
          <div className="campi-in-riga">
            {input('codiceRegionale', 'Codice regionale (se noto)', { code: true, maxLength: 40 })}
            {input('asl', 'Azienda sanitaria (se nota)')}
          </div>
          <p className="aiuto">
            Nome e cognome come nel codice fiscale. Il codice regionale serve per le ricette e per
            l’AFT: se non è ancora noto si aggiunge dopo.
          </p>
        </fieldset>
      )}
      <div className="azioni">
        <button
          type="submit"
          className="pulsante pulsante-primario"
          disabled={busy || v.ruoli.length === 0}
        >
          <Icon name="fatto" />{' '}
          <span>{mode === 'nuovo' ? 'Crea l’utente' : 'Salva le modifiche'}</span>
        </button>
        {onCancel && (
          <button type="button" className="pulsante" onClick={onCancel} disabled={busy}>
            Annulla
          </button>
        )}
      </div>
    </form>
  );
}
