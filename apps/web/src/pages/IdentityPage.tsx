import { useState, type FormEvent } from 'react';
import { ErrorMessage, Loading, Notice, PageHeader } from '../components/common';
import { api, ApiError } from '../lib/api';
import { dateTime } from '../lib/format';
import { identityReturnText } from '../lib/return-reasons';
import { useApi } from '../lib/useApi';

interface IdentityState {
  disponibile: boolean;
  perIlMedico: boolean;
  puoRipristinare: boolean;
  collegata: boolean;
  codiceFiscale: string | null;
  collegataIl: string | null;
}

/**
 * Identità digitale per il ripristino (D189). Il medico non collega nulla: vale il codice fiscale
 * del suo profilo. La segreteria collega SPID o CIE una volta, a sessione aperta e con il codice a
 * 6 cifre di adesso; da lì può ripristinare da sé le credenziali.
 */
export function IdentityPage() {
  const current = useApi<IdentityState>('/api/profilo/identita');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const params = new URLSearchParams(window.location.search);
  const outcome = params.get('collegamento');

  async function link(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const raw = f.get('codice');
      const codice = (typeof raw === 'string' ? raw : '').replace(/\s/g, '');
      const r = await api<{ indirizzo: string }>('/api/profilo/identita', {
        method: 'POST',
        body: { codice },
      });
      window.location.assign(r.indirizzo);
    } catch (err) {
      setError(err instanceof ApiError ? err : null);
      setBusy(false);
    }
  }

  async function unlink() {
    setBusy(true);
    setError(null);
    try {
      await api('/api/profilo/identita', { method: 'DELETE' });
      current.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err : null);
    } finally {
      setBusy(false);
    }
  }

  if (current.loading && !current.data) return <Loading what="dati dell’identità digitale" />;
  const d = current.data;
  return (
    <>
      <PageHeader title="SPID o CIE per il ripristino" />
      {outcome === 'ok' && <Notice kind="fatto">Identità collegata.</Notice>}
      {outcome === 'errore' && (
        <Notice kind="errore">
          {identityReturnText(params.get('motivo'), 'Collegamento non riuscito')}
        </Notice>
      )}
      <ErrorMessage error={error ?? current.error} />
      {d && !d.disponibile && (
        <Notice kind="info">
          In questa installazione SPID e CIE non sono ancora collegati al servizio vero: le
          credenziali le ripristina chi gestisce il servizio.
        </Notice>
      )}
      {d?.disponibile && d.perIlMedico && (
        <Notice kind="info">
          Per il ripristino con SPID o CIE vale il codice fiscale del tuo profilo di medico: non
          serve collegare nulla. Dalla pagina di accesso, «Ripristina con SPID o CIE».
        </Notice>
      )}
      {d?.disponibile && !d.perIlMedico && !d.puoRipristinare && (
        <Notice kind="info">
          Il ripristino con SPID o CIE è per medici e segreteria: gli amministratori ripristinano le
          credenziali da un altro amministratore.
        </Notice>
      )}
      {d?.disponibile && !d.perIlMedico && d.puoRipristinare && (
        <section className="riquadro" aria-labelledby="titolo-identita">
          <h2 id="titolo-identita">La tua identità digitale</h2>
          {d.collegata ? (
            <>
              <p>
                Collegata il {dateTime(d.collegataIl)}, con il codice fiscale{' '}
                <span className="codice">{d.codiceFiscale}</span>. Se perdi la password o il codice,
                dalla pagina di accesso scegli «Ripristina con SPID o CIE».
              </p>
              <button
                type="button"
                className="pulsante"
                disabled={busy}
                onClick={() => void unlink()}
              >
                Scollega
              </button>
            </>
          ) : (
            <p>
              Non collegata: se perdi la password o il codice a 6 cifre, le credenziali le
              ripristina chi gestisce il servizio. Collegando SPID o CIE le ripristini da te.
            </p>
          )}
          <form onSubmit={(e) => void link(e)} className="modulo">
            <div className="campo">
              <label htmlFor="identita-codice">Codice a 6 cifre di adesso</label>
              <input
                id="identita-codice"
                name="codice"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9 ]{6,7}"
                required
              />
            </div>
            <button type="submit" className="pulsante pulsante-primario" disabled={busy}>
              {d.collegata ? 'Collega di nuovo con SPID o CIE' : 'Collega con SPID o CIE'}
            </button>
          </form>
        </section>
      )}
    </>
  );
}
