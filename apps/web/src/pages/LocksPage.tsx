import { useState } from 'react';
import { ErrorMessage, Loading, Notice, PageHeader } from '../components/common';
import { api, ApiError } from '../lib/api';
import { dateTime } from '../lib/format';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';

interface Lock {
  id: string;
  utente: { id: string; nome: string; nomeUtente: string };
  proprio: boolean;
  motivo: 'passwords' | 'codes';
  motivoTesto: string;
  tentativi: number;
  bloccatoIl: string;
  bloccatoFinoA: string;
  indirizzi: string[];
  postazioni: string[];
}

interface Locks {
  totale: number;
  blocchi: Lock[];
}

/** Che cosa fare, in parole: dipende da chi ha sbagliato che cosa. */
function advice(l: Lock): string {
  if (l.motivo === 'codes')
    return l.proprio
      ? 'Chi ha scritto i codici conosceva la tua password, oppure aveva una tua sessione aperta. Se non eri tu, cambia la password e avvisa chi gestisce il servizio.'
      : 'Chi ha scritto i codici conosceva la password di questo utente, oppure aveva una sua sessione aperta. Se i tentativi non sono suoi, va cambiata la password.';
  return l.proprio
    ? 'Se non eri tu, qualcuno conosce il tuo nome utente e prova a indovinare la password. Da un’altra postazione si entra comunque appena finisce il blocco.'
    : 'Se i tentativi non sono suoi, qualcuno conosce il nome utente e prova a indovinare la password.';
}

/**
 * Blocchi del conto dopo i tentativi sbagliati (D181, D188): i propri e, per un medico titolare,
 * quelli degli utenti dello studio. Restano finché chi li riceve non li segna come visti; segnare
 * non cambia nulla per gli altri.
 */
export function LocksPage() {
  const { refresh } = useSession();
  const locks = useApi<Locks>('/api/blocchi');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  async function markSeen(ids: string[]) {
    setBusy(true);
    setError(null);
    try {
      await api('/api/blocchi/visti', { method: 'POST', body: { blocchi: ids } });
      locks.reload();
      await refresh();
    } catch (e) {
      setError(e instanceof ApiError ? e : null);
    } finally {
      setBusy(false);
    }
  }

  if (locks.loading && !locks.data) return <Loading what="blocchi del conto" />;
  const data = locks.data;
  return (
    <>
      <PageHeader title="Blocchi del conto" />
      <ErrorMessage error={error ?? locks.error} />
      <p>
        Un conto si blocca dopo troppe password sbagliate o troppi codici a 6 cifre sbagliati di
        seguito. Qui ci sono i blocchi del tuo conto e, per i medici titolari, quelli degli utenti
        dello studio: ognuno li segna come visti per sé.
      </p>
      {data && data.blocchi.length === 0 && <Notice kind="fatto">Nessun blocco da vedere.</Notice>}
      {data && data.blocchi.length > 0 && (
        <>
          {data.totale > data.blocchi.length && (
            <Notice kind="info">
              Sono mostrati i {data.blocchi.length} blocchi più recenti su {data.totale}: segnati
              questi, compaiono gli altri.
            </Notice>
          )}
          <ul className="elenco-blocchi">
            {data.blocchi.map((l) => (
              <li key={l.id} className="riquadro">
                <h2 className="titolo-blocco">
                  {l.proprio ? 'Il tuo conto' : `${l.utente.nome} (${l.utente.nomeUtente})`}
                </h2>
                <Notice kind="avviso">
                  Bloccato il {dateTime(l.bloccatoIl)} fino alle {dateTime(l.bloccatoFinoA)}, dopo{' '}
                  {l.tentativi} {l.motivoTesto} di seguito.
                </Notice>
                <dl className="dati-fissi">
                  <div>
                    <dt>Indirizzi dei tentativi</dt>
                    <dd className="codice">{l.indirizzi.join(', ') || 'non noti'}</dd>
                  </div>
                  <div>
                    <dt>Postazioni scritte</dt>
                    <dd>{l.postazioni.join(', ') || 'nessuna'}</dd>
                  </div>
                </dl>
                <p>{advice(l)}</p>
              </li>
            ))}
          </ul>
          <button
            type="button"
            className="pulsante pulsante-primario"
            disabled={busy}
            onClick={() => void markSeen(data.blocchi.map((l) => l.id))}
          >
            Segna come visti
          </button>
        </>
      )}
    </>
  );
}
