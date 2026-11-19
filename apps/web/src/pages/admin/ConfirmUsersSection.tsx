import { useState } from 'react';
import { ErrorMessage, Loading, Notice } from '../../components/common';
import { Icon } from '../../components/Icon';
import { api, ApiError } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { useApi } from '../../lib/useApi';
import { TemporaryPassword } from './UsersSection';

interface PendingUser {
  id: string;
  nomeUtente: string;
  nome: string;
  email: string | null;
  ruoli: { codice: string; nome: string }[];
  stato: 'attivo' | 'sospeso';
  inAttesaDiConferma: boolean;
  creatoIl: string;
  /**
   * Chi ha creato o cambiato l'utente, e quando: si conferma quella richiesta. Senza nome se
   * l'utente l'ha riattivato chi gestisce il servizio, sul server.
   */
  richiesta: { da: string | null; il: string | null };
  /** Alla conferma il titolare riceve la password temporanea da consegnare di persona. */
  passwordAllaConferma: boolean;
  medico: { nome: string | null; cognome: string | null; codiceFiscale: string | null } | null;
}
/** Segreteria già confermata come utente, sull'archivio del titolare (D181). */
interface ArchiveSecretary {
  id: string;
  nomeUtente: string;
  nome: string;
  archivio: { id: string; nome: string };
}
interface Pending {
  utenti: PendingUser[];
  /** Da confermare per il mio archivio: finché non lo faccio, non lo vede. */
  perArchivio?: ArchiveSecretary[];
  /** Lavora sul mio archivio: la posso togliere. */
  sulMioArchivio?: ArchiveSecretary[];
}
interface Result {
  utente: PendingUser;
  passwordTemporanea?: string;
  avvisi?: string[];
}

type Kind = 'conferma' | 'rifiuta';

const roleNames = (u: PendingUser) => u.ruoli.map((r) => r.nome).join(', ');

const QUESTIONS: Record<Kind, (u: PendingUser) => string> = {
  conferma: (u) =>
    `Confermare ${u.nome} (${u.nomeUtente}) con i ruoli: ${roleNames(u)}? Potrà lavorare con i dati dei pazienti dello studio.${
      u.passwordAllaConferma
        ? ' Riceverai una password temporanea da consegnare di persona.'
        : ' Entrerà con la sua password e il suo secondo fattore.'
    }`,
  rifiuta: (u) =>
    `Rifiutare ${u.nome} (${u.nomeUtente})? Resta sospeso e non entra; se l’amministratore lo riattiva, torna in questo elenco.`,
};

/**
 * Utenti da confermare (tappa 14), per i medici titolari: chi l'amministratore crea, o a chi dà un
 * ruolo con i dati dei pazienti, non entra finché un titolare attivo dello studio non lo conferma.
 * Si conferma la richiesta che si legge: se nel frattempo l'amministratore la cambia, il servizio
 * rifiuta e l'elenco si rilegge. La password temporanea, quando c'è, si vede una volta sola.
 */
export function ConfirmUsersSection() {
  const pending = useApi<Pending>('/api/studio/utenti/da-confermare');
  const [shown, setShown] = useState<{ nome: string; nomeUtente: string; password: string } | null>(
    null,
  );
  const [outcome, setOutcome] = useState<string[] | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  if (pending.loading && !pending.data) return <Loading what="utenti da confermare" />;
  if (!pending.data) return <ErrorMessage error={pending.error} />;
  const users = pending.data.utenti;
  const toConfirm = pending.data.perArchivio ?? [];
  const onMine = pending.data.sulMioArchivio ?? [];

  /** La segreteria sul mio archivio: la confermo o la tolgo (D181). */
  async function decideArchive(u: ArchiveSecretary, confirm: boolean) {
    const question = confirm
      ? `Confermare ${u.nome} (${u.nomeUtente}) per il tuo archivio «${u.archivio.nome}»? Vedrà i tuoi pazienti come segreteria, con le impostazioni del tuo archivio.`
      : `Togliere ${u.nome} (${u.nomeUtente}) dal tuo archivio «${u.archivio.nome}»? Non vedrà più i tuoi pazienti; gli archivi degli altri titolari non cambiano.`;
    if (!window.confirm(question)) return;
    setBusy(true);
    setError(null);
    setOutcome(null);
    setShown(null);
    try {
      const r = await api<{ avvisi?: string[] }>(
        `/api/studio/utenti/${u.id}/archivio/${confirm ? 'conferma' : 'rifiuta'}`,
        { method: 'POST', body: {} },
      );
      setOutcome(r.avvisi ?? []);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'Servizio non raggiungibile'));
    } finally {
      setBusy(false);
      pending.reload();
    }
  }

  async function act(u: PendingUser, kind: Kind) {
    if (!window.confirm(QUESTIONS[kind](u))) return;
    setBusy(true);
    setError(null);
    setOutcome(null);
    setShown(null);
    try {
      const r = await api<Result>(`/api/studio/utenti/${u.id}/${kind}`, {
        method: 'POST',
        body: kind === 'conferma' ? { richiestaIl: u.richiesta.il } : {},
      });
      if (r.passwordTemporanea)
        setShown({
          nome: r.utente.nome,
          nomeUtente: r.utente.nomeUtente,
          password: r.passwordTemporanea,
        });
      setOutcome(r.avvisi ?? []);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'Servizio non raggiungibile'));
    } finally {
      setBusy(false);
      // Anche dopo un rifiuto del servizio (richiesta cambiata): l'elenco com'è adesso.
      pending.reload();
    }
  }

  return (
    <section className="riquadro" aria-labelledby="titolo-conferme">
      <h2 id="titolo-conferme">
        <Icon name="pazienti" /> Utenti da confermare
      </h2>
      <p>
        Chi l’amministratore crea, o a chi dà un ruolo con i dati dei pazienti (medico titolare,
        medico sostituto, segreteria), non entra finché un medico titolare dello studio non lo
        conferma. Conferma solo chi conosci e solo i ruoli che deve avere; se non lo riconosci,
        rifiuta: resta sospeso. Conferme e rifiuti vanno nel registro delle azioni di
        amministrazione.
      </p>
      {shown && <TemporaryPassword shown={shown} onClose={() => setShown(null)} />}
      {outcome && outcome.length > 0 && (
        <Notice kind="fatto">
          {outcome.map((x) => (
            <p key={x}>{x}</p>
          ))}
        </Notice>
      )}
      <ErrorMessage error={error} />
      {users.length === 0 ? (
        <p className="tenue">Nessun utente da confermare.</p>
      ) : (
        <div className="tabella-scorrevole">
          <table className="tabella">
            <caption>Utenti in attesa della conferma di un medico titolare</caption>
            <thead>
              <tr>
                <th scope="col">Utente</th>
                <th scope="col">Ruoli</th>
                <th scope="col">Richiesta</th>
                <th scope="col">Alla conferma</th>
                <th scope="col">Azioni</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <th scope="row">
                    {u.nome}
                    <br />
                    <span className="codice">{u.nomeUtente}</span>
                    {u.email && (
                      <>
                        <br />
                        <span className="tenue">{u.email}</span>
                      </>
                    )}
                    {u.medico?.codiceFiscale && (
                      <>
                        <br />
                        <span className="codice">{u.medico.codiceFiscale}</span>
                      </>
                    )}
                  </th>
                  <td>{roleNames(u)}</td>
                  <td>
                    {/* Senza nome: l'ha riattivato chi gestisce il servizio, sul server. */}
                    {u.richiesta.da ? `Di ${u.richiesta.da}` : 'Da chi gestisce il servizio'}
                    {u.richiesta.il && <>, il {dateTime(u.richiesta.il)}</>}
                    <br />
                    <span className="tenue">Utente creato il {dateTime(u.creatoIl)}</span>
                  </td>
                  <td>
                    {u.passwordAllaConferma
                      ? 'Ricevi la password temporanea, da consegnare di persona; il secondo fattore si attiva al primo accesso.'
                      : 'Rientra con la sua password e il suo secondo fattore.'}
                  </td>
                  <td>
                    <ul className="elenco-azioni">
                      <li>
                        <button
                          type="button"
                          className="pulsante pulsante-primario"
                          disabled={busy}
                          onClick={() => void act(u, 'conferma')}
                        >
                          <Icon name="fatto" /> <span>Conferma</span>{' '}
                          <span className="visivamente-nascosto">{u.nome}</span>
                        </button>
                      </li>
                      <li>
                        <button
                          type="button"
                          className="pulsante pulsante-piatto"
                          disabled={busy}
                          onClick={() => void act(u, 'rifiuta')}
                        >
                          <Icon name="annulla" /> <span>Rifiuta</span>{' '}
                          <span className="visivamente-nascosto">{u.nome}</span>
                        </button>
                      </li>
                    </ul>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(toConfirm.length > 0 || onMine.length > 0) && (
        <>
          <h3>Segreteria sul tuo archivio</h3>
          <p>
            In medicina di gruppo ogni titolare conferma la segreteria per il suo archivio: finché
            non la confermi, non vede i tuoi pazienti. La puoi anche togliere; gli archivi degli
            altri titolari non cambiano.
          </p>
          <ul className="elenco-azioni">
            {toConfirm.map((u) => (
              <li key={`da-${u.id}`}>
                <span>
                  {u.nome} <span className="codice">{u.nomeUtente}</span>:{' '}
                  <strong>
                    <Icon name="avviso" /> da confermare
                  </strong>
                </span>{' '}
                <button
                  type="button"
                  className="pulsante pulsante-primario"
                  disabled={busy}
                  onClick={() => void decideArchive(u, true)}
                >
                  <Icon name="fatto" /> <span>Conferma per il mio archivio</span>{' '}
                  <span className="visivamente-nascosto">{u.nome}</span>
                </button>{' '}
                <button
                  type="button"
                  className="pulsante pulsante-piatto"
                  disabled={busy}
                  onClick={() => void decideArchive(u, false)}
                >
                  <Icon name="annulla" /> <span>Non sul mio archivio</span>{' '}
                  <span className="visivamente-nascosto">{u.nome}</span>
                </button>
              </li>
            ))}
            {onMine.map((u) => (
              <li key={`sul-${u.id}`}>
                <span>
                  {u.nome} <span className="codice">{u.nomeUtente}</span>: lavora sul tuo archivio
                </span>{' '}
                <button
                  type="button"
                  className="pulsante pulsante-piatto"
                  disabled={busy}
                  onClick={() => void decideArchive(u, false)}
                >
                  <Icon name="annulla" /> <span>Togli dal mio archivio</span>{' '}
                  <span className="visivamente-nascosto">{u.nome}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
