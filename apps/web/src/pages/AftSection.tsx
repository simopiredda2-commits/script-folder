import { useState, type FormEvent } from 'react';
import { ErrorMessage, Loading, Notice } from '../components/common';
import { Icon } from '../components/Icon';
import { api, ApiError } from '../lib/api';
import { date, dateTime } from '../lib/format';
import { useApi } from '../lib/useApi';

interface Member {
  nome: string;
  studio: string;
  codiceRegionale: string | null;
  stato: 'membro' | 'invitato';
  condivide: boolean;
  io: boolean;
}
interface Overview {
  aft: {
    id: string;
    nome: string;
    asl: string | null;
    codice: string | null;
    condivido: boolean;
    dal: string;
    membri: Member[];
  } | null;
  inviti: { id: string; aft: string; asl: string | null; invitatoIl: string }[];
  puoCreare: boolean;
  tipologieAttivita: { codice: string; nome: string }[];
  motiviComuni: string[];
}
interface Summary {
  paziente: { cognome: string; nome: string; codiceFiscale: string; nascita: string };
  medicoCurante: string | null;
  consultatoIl: string;
  /** Solo i dati da questa data: il paziente non ha consentito di condividere quelli precedenti. */
  soloDal: string | null;
  riepilogo: { allergie: string[]; problemi: string[]; terapie: string[]; parametri: string[] };
}
interface Consultation {
  quando: string;
  esito: 'consentito' | 'negato';
  paziente: string;
  medico: string | null;
  studio: string | null;
  motivo: string | null;
  regola: string | null;
}

const failure = (e: unknown) =>
  e instanceof ApiError ? e : new ApiError(0, 'Servizio non raggiungibile');

const SECTION_LABELS: [keyof Summary['riepilogo'], string][] = [
  ['allergie', 'Allergie e reazioni'],
  ['problemi', 'Problemi'],
  ['terapie', 'Terapie in corso'],
  ['parametri', 'Parametri'],
];

/**
 * AFT (tappa 12, D161): i medici dell'aggregazione che usano il programma. Ognuno decide se
 * condividere il riepilogo dei suoi pazienti che hanno dato il consenso; chi consulta scrive il
 * motivo, e la consultazione va nel registro del medico curante.
 */
export function AftSection() {
  const overview = useApi<Overview>('/api/aft');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  if (overview.loading && !overview.data) return <Loading what="AFT" />;
  if (!overview.data) return <ErrorMessage error={overview.error} />;
  const o = overview.data;

  const run = async (path: string, body: unknown = {}) => {
    setBusy(true);
    setError(null);
    try {
      await api(path, { method: 'POST', body });
      overview.reload();
      return true;
    } catch (e) {
      setError(failure(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <section className="riquadro" aria-labelledby="titolo-aft">
        <h2 id="titolo-aft">
          <Icon name="pazienti" /> Aggregazione funzionale territoriale
        </h2>
        <p>
          I medici dell’AFT che usano il programma possono vedere il riepilogo di un paziente di un
          collega, per esempio nell’ambulatorio dell’AFT. Solo se il medico curante condivide i suoi
          pazienti e solo per i pazienti che hanno dato il consenso. Si vedono allergie, problemi,
          terapie in corso e parametri, senza le voci oscurate o riservate. Ogni consultazione va
          nel registro del medico curante, con il motivo.
        </p>
        {error && <ErrorMessage error={error} />}
        {o.inviti.map((i) => (
          <Notice key={i.id} kind="info">
            <p>
              Invito nell’AFT <strong>{i.aft}</strong>
              {i.asl ? ` (${i.asl})` : ''}, del {date(i.invitatoIl)}.
            </p>
            <p className="azioni">
              <button
                type="button"
                className="pulsante"
                disabled={busy}
                onClick={() => void run(`/api/aft/inviti/${i.id}/accetta`)}
              >
                Accetta l’invito
              </button>
              <button
                type="button"
                className="pulsante pulsante-piatto"
                disabled={busy}
                onClick={() => void run(`/api/aft/inviti/${i.id}/rifiuta`)}
              >
                Rifiuta
              </button>
            </p>
          </Notice>
        ))}
        {o.aft ? (
          <Membership o={o} busy={busy} run={run} />
        ) : o.puoCreare ? (
          <CreateAft busy={busy} run={run} />
        ) : (
          <Notice kind="info">L’AFT riguarda i medici titolari dello studio.</Notice>
        )}
      </section>
      {o.aft && <ConsultForm kinds={o.tipologieAttivita} reasons={o.motiviComuni} />}
      {o.aft && <Consultations />}
      {o.aft && <Activities />}
    </>
  );
}

function CreateAft({
  busy,
  run,
}: {
  busy: boolean;
  run: (path: string, body?: unknown) => Promise<boolean>;
}) {
  const [name, setName] = useState('');
  const [asl, setAsl] = useState('');
  const [code, setCode] = useState('');
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run('/api/aft', { nome: name, asl: asl || undefined, codice: code || undefined });
  };
  return (
    <form onSubmit={submit} className="modulo">
      <p>
        Non sei in un’AFT del programma. Puoi crearla e invitare i colleghi con il loro codice
        regionale: entrano solo se accettano.
      </p>
      <div className="campo">
        <label htmlFor="aft-nome">Nome dell’AFT</label>
        <input
          id="aft-nome"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          minLength={3}
        />
      </div>
      <div className="campo">
        <label htmlFor="aft-asl">Azienda sanitaria (facoltativo)</label>
        <input id="aft-asl" value={asl} onChange={(e) => setAsl(e.target.value)} />
      </div>
      <div className="campo">
        <label htmlFor="aft-codice">Codice dell’AFT (facoltativo)</label>
        <input id="aft-codice" value={code} onChange={(e) => setCode(e.target.value)} />
      </div>
      <button type="submit" className="pulsante" disabled={busy}>
        Crea l’AFT
      </button>
    </form>
  );
}

function Membership({
  o,
  busy,
  run,
}: {
  o: Overview;
  busy: boolean;
  run: (path: string, body?: unknown) => Promise<boolean>;
}) {
  const a = o.aft!;
  const [code, setCode] = useState('');
  // La casella cambia subito; se il servizio rifiuta, torna com'era.
  const [sharing, setSharing] = useState(a.condivido);
  const toggle = async (on: boolean) => {
    setSharing(on);
    if (!(await run(`/api/aft/${a.id}/condivisione`, { condivide: on }))) setSharing(!on);
  };
  const invite = async (e: FormEvent) => {
    e.preventDefault();
    if (await run(`/api/aft/${a.id}/inviti`, { codiceRegionale: code })) setCode('');
  };
  return (
    <>
      <p>
        <strong>{a.nome}</strong>
        {a.asl ? ` · ${a.asl}` : ''}
        {a.codice ? ` · codice ${a.codice}` : ''}. Sei membro dal {date(a.dal)}.
      </p>
      <table className="tabella">
        <caption>Medici dell’AFT nel programma</caption>
        <thead>
          <tr>
            <th scope="col">Medico</th>
            <th scope="col">Studio</th>
            <th scope="col">Codice regionale</th>
            <th scope="col">Stato</th>
            <th scope="col">Condivide</th>
          </tr>
        </thead>
        <tbody>
          {a.membri.map((m, i) => (
            <tr key={i}>
              <td>
                {m.nome}
                {m.io ? ' (tu)' : ''}
              </td>
              <td>{m.studio}</td>
              <td>{m.codiceRegionale ?? '—'}</td>
              <td>{m.stato === 'membro' ? 'Membro' : 'Invitato, in attesa'}</td>
              <td>{m.condivide ? 'Sì' : 'No'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <fieldset className="modulo">
        <legend>La mia condivisione</legend>
        <div className="casella">
          <input
            id="aft-condivido"
            type="checkbox"
            checked={sharing}
            disabled={busy}
            onChange={(e) => void toggle(e.target.checked)}
          />
          <label htmlFor="aft-condivido">
            Condivido con i medici dell’AFT il riepilogo dei miei pazienti che hanno dato il
            consenso
          </label>
        </div>
        <p className="tenue">
          Il consenso del paziente si registra nella sua cartella, in «Privacy»: «Condivisione del
          riepilogo con i medici dell’AFT».
        </p>
      </fieldset>
      <form onSubmit={(e) => void invite(e)} className="modulo">
        <div className="campo">
          <label htmlFor="aft-invito">Invita un medico titolare: codice regionale</label>
          <input id="aft-invito" value={code} onChange={(e) => setCode(e.target.value)} required />
        </div>
        <button type="submit" className="pulsante" disabled={busy}>
          Invita
        </button>
      </form>
      <p>
        <button
          type="button"
          className="pulsante pulsante-piatto"
          disabled={busy}
          onClick={() => {
            if (
              window.confirm('Uscire dall’AFT? La condivisione dei tuoi pazienti finisce subito.')
            )
              void run(`/api/aft/${a.id}/esci`);
          }}
        >
          Esci dall’AFT
        </button>
      </p>
    </>
  );
}

function ConsultForm({
  kinds,
  reasons,
}: {
  kinds: Overview['tipologieAttivita'];
  reasons: string[];
}) {
  const [cf, setCf] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSummary(null);
    try {
      setSummary(
        await api<Summary>('/api/aft/consultazione', {
          method: 'POST',
          body: { codiceFiscale: cf, motivo: reason },
        }),
      );
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="riquadro" aria-labelledby="titolo-consulta-aft">
      <h2 id="titolo-consulta-aft">
        <Icon name="cerca" /> Riepilogo di un paziente di un collega
      </h2>
      <form onSubmit={(e) => void submit(e)} className="modulo">
        <div className="campo">
          <label htmlFor="aft-codice-fiscale">Codice fiscale del paziente</label>
          <input
            id="aft-codice-fiscale"
            value={cf}
            onChange={(e) => setCf(e.target.value.toUpperCase())}
            required
            minLength={16}
            maxLength={16}
            className="codice"
            autoComplete="off"
          />
        </div>
        <div className="campo">
          <label htmlFor="aft-motivo">Motivo dell’accesso</label>
          <input
            id="aft-motivo"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            minLength={10}
            maxLength={300}
            placeholder="Per esempio: visita nell’ambulatorio serale dell’AFT"
            list="aft-motivi-comuni"
          />
          <datalist id="aft-motivi-comuni">
            {reasons.map((r) => (
              <option key={r} value={r} />
            ))}
          </datalist>
        </div>
        <button type="submit" className="pulsante" disabled={busy}>
          Mostra il riepilogo
        </button>
      </form>
      {error && <ErrorMessage error={error} />}
      {summary && (
        <article aria-labelledby="titolo-riepilogo-aft">
          <h3 id="titolo-riepilogo-aft">
            {summary.paziente.cognome} {summary.paziente.nome}
          </h3>
          <p>
            <span className="codice">{summary.paziente.codiceFiscale}</span> · nato/a il{' '}
            {date(summary.paziente.nascita)} · medico curante {summary.medicoCurante ?? '—'}
          </p>
          <Notice kind="info">
            <p>
              Riepilogo condiviso con il consenso del paziente. La consultazione del{' '}
              {dateTime(summary.consultatoIl)} è nel registro del medico curante, con il motivo; il
              paziente può sapere chi ha consultato i suoi dati, quando e da quale studio.
            </p>
            <p>
              Il riepilogo può non essere completo: il paziente può aver chiesto di non condividere
              alcune informazioni, e contiene solo quanto il medico curante ha registrato nel
              programma. Non certifica lo stato di salute.
            </p>
            {summary.soloDal && (
              <p>
                Contiene solo i dati dal {date(summary.soloDal)}: il paziente non ha consentito di
                condividere quelli precedenti.
              </p>
            )}
          </Notice>
          {SECTION_LABELS.map(([key, label]) => {
            const items = summary.riepilogo[key];
            return (
              <section key={key} aria-label={label}>
                <h4>{label}</h4>
                {items.length === 0 ? (
                  <p className="tenue">Nessuna voce.</p>
                ) : (
                  <ul>
                    {items.map((x, i) => (
                      <li key={i}>{x}</li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
          <ActivityForm fiscalCode={summary.paziente.codiceFiscale} kinds={kinds} />
        </article>
      )}
    </section>
  );
}

/**
 * L'attività svolta per il paziente del collega, con orario, tipologia ed esito: va nel registro di
 * AFT e nella cronologia della cartella del medico curante (DGR Piemonte 31-8647/2024, art. 22).
 */
function ActivityForm({
  fiscalCode,
  kinds,
}: {
  fiscalCode: string;
  kinds: Overview['tipologieAttivita'];
}) {
  const [kind, setKind] = useState(kinds[0]?.codice ?? '');
  const [outcome, setOutcome] = useState('');
  const [notes, setNotes] = useState('');
  const [when, setWhen] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/aft/attivita', {
        method: 'POST',
        body: {
          codiceFiscale: fiscalCode,
          tipologia: kind,
          esito: outcome,
          note: notes || undefined,
          quando: when ? new Date(when).toISOString() : undefined,
        },
      });
      setDone(true);
      setOutcome('');
      setNotes('');
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={(e) => void submit(e)} className="modulo" aria-labelledby="titolo-attivita-aft">
      <h4 id="titolo-attivita-aft">Registra l’attività svolta</h4>
      <p className="tenue">
        Va nel registro di AFT e nella cartella del medico curante, che così ne è informato.
      </p>
      {error && <ErrorMessage error={error} />}
      {done && (
        <Notice kind="fatto">
          Attività registrata: il medico curante la vede nella cronologia.
        </Notice>
      )}
      <div className="campo">
        <label htmlFor="aft-tipologia">Tipologia</label>
        <select id="aft-tipologia" value={kind} onChange={(e) => setKind(e.target.value)}>
          {kinds.map((k) => (
            <option key={k.codice} value={k.codice}>
              {k.nome}
            </option>
          ))}
        </select>
      </div>
      <div className="campo">
        <label htmlFor="aft-esito">Esito</label>
        <input
          id="aft-esito"
          value={outcome}
          onChange={(e) => setOutcome(e.target.value)}
          required
          minLength={3}
          maxLength={500}
        />
      </div>
      <div className="campo">
        <label htmlFor="aft-note">Note per il medico curante (facoltative)</label>
        <textarea id="aft-note" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
      </div>
      <div className="campo">
        <label htmlFor="aft-quando">Data e ora (se non è adesso)</label>
        <input
          id="aft-quando"
          type="datetime-local"
          value={when}
          onChange={(e) => setWhen(e.target.value)}
        />
      </div>
      <button type="submit" className="pulsante" disabled={busy}>
        Registra l’attività
      </button>
    </form>
  );
}

interface Activity {
  quando: string;
  paziente: string;
  medico: string;
  tipologia: string;
  esito: string;
  note: string | null;
}

/** Le attività dei colleghi dell'AFT sui pazienti del medico curante. */
function Activities() {
  const list = useApi<{ attivita: Activity[] }>('/api/aft/attivita');
  if (list.loading && !list.data) return <Loading what="attività dei colleghi" />;
  if (!list.data) return <ErrorMessage error={list.error} />;
  const rows = list.data.attivita;
  return (
    <section className="riquadro" aria-labelledby="titolo-attivita-colleghi">
      <h2 id="titolo-attivita-colleghi">
        <Icon name="storico" /> Attività dei colleghi sui miei pazienti
      </h2>
      {rows.length === 0 ? (
        <p className="tenue">Nessuna attività.</p>
      ) : (
        <table className="tabella" aria-labelledby="titolo-attivita-colleghi">
          <thead>
            <tr>
              <th scope="col">Quando</th>
              <th scope="col">Paziente</th>
              <th scope="col">Medico</th>
              <th scope="col">Tipologia</th>
              <th scope="col">Esito e note</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>{dateTime(r.quando)}</td>
                <td>{r.paziente}</td>
                <td>{r.medico}</td>
                <td>{r.tipologia}</td>
                <td>
                  {r.esito}
                  {r.note ? `. ${r.note}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function Consultations() {
  const list = useApi<{ consultazioni: Consultation[] }>('/api/aft/consultazioni');
  if (list.loading && !list.data) return <Loading what="consultazioni" />;
  if (!list.data) return <ErrorMessage error={list.error} />;
  const rows = list.data.consultazioni;
  return (
    <section className="riquadro" aria-labelledby="titolo-consultazioni-aft">
      <h2 id="titolo-consultazioni-aft">
        <Icon name="storico" /> Consultazioni dei colleghi sui miei pazienti
      </h2>
      {rows.length === 0 ? (
        <p className="tenue">Nessuna consultazione.</p>
      ) : (
        <table className="tabella" aria-labelledby="titolo-consultazioni-aft">
          <thead>
            <tr>
              <th scope="col">Quando</th>
              <th scope="col">Paziente</th>
              <th scope="col">Medico e studio</th>
              <th scope="col">Motivo</th>
              <th scope="col">Esito</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>{dateTime(r.quando)}</td>
                <td>{r.paziente}</td>
                <td>
                  {r.medico ?? '—'}
                  {r.studio ? `, ${r.studio}` : ''}
                </td>
                <td>{r.motivo ?? '—'}</td>
                <td>
                  {r.esito === 'consentito' ? 'Consentito' : 'Negato'}
                  {r.esito === 'negato' && r.regola ? `: ${r.regola}` : ''}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
