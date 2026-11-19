import { useEffect, useState, type FormEvent } from 'react';
import { ErrorMessage, Notice } from '../components/common';
import { Logo } from '../components/Logo';
import { Signature } from '../components/Signature';
import { api, ApiError } from '../lib/api';
import { identityReturnText } from '../lib/return-reasons';
import { rememberedWorkstation } from '../lib/storage';

/** Il ripristino aperto dopo SPID o CIE, come lo dice il servizio. */
interface Recovery {
  nome: string;
  nomeUtente: string;
  metodo: string | null;
  secondoFattoreAttivo: boolean;
  bloccatoFinoA: string | null;
  scadenza: string;
  lunghezzaMinima: number;
  lunghezzaMassima: number;
}

/** Valore di un campo del modulo come testo. */
const field = (f: FormData, name: string): string => {
  const v = f.get(name);
  return typeof v === 'string' ? v : '';
};

/**
 * Ripristino delle credenziali con SPID o CIE (D189), senza sessione: il nome utente, poi SPID o
 * CIE; se il codice fiscale riconosciuto è quello dell'utente, una password nuova e, se serve, il
 * secondo fattore da riattivare. Gli esiti del ritorno arrivano nell'indirizzo (`esito`, `motivo`).
 */
export function RecoveryPage() {
  const params = new URLSearchParams(window.location.search);
  // Nell'indirizzo c'è solo il codice del motivo; il testo è del programma (D193).
  const returnedError =
    params.get('esito') === 'errore' ? identityReturnText(params.get('motivo')) : null;
  const [open, setOpen] = useState<Recovery | null>(null);
  const [checked, setChecked] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ secondoFattoreAzzerato: boolean } | null>(null);

  useEffect(() => {
    if (returnedError) {
      setChecked(true);
      return;
    }
    api<Recovery>('/api/ripristino/stato')
      .then(setOpen)
      .catch(() => setOpen(null))
      .finally(() => setChecked(true));
  }, [returnedError]);

  async function start(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ indirizzo: string }>('/api/ripristino', {
        method: 'POST',
        body: { nomeUtente: field(f, 'utente'), postazione: field(f, 'postazione') },
      });
      window.location.assign(r.indirizzo);
    } catch (err) {
      setError(err instanceof ApiError ? err : null);
      setBusy(false);
    }
  }

  async function choose(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(null);
    if (field(f, 'nuova') !== field(f, 'ripeti')) {
      setError(new ApiError(0, 'Le due nuove password non sono uguali: riscrivile'));
      return;
    }
    setBusy(true);
    try {
      const r = await api<{ secondoFattoreAzzerato: boolean }>('/api/ripristino/password', {
        method: 'POST',
        body: { nuovaPassword: field(f, 'nuova'), azzeraSecondoFattore: f.get('azzera') === 'si' },
      });
      setDone(r);
    } catch (err) {
      setError(err instanceof ApiError ? err : null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="accesso">
      <main className="accesso-scheda" id="contenuto">
        <div className="accesso-marchio">
          <Logo size={40} />
          <Signature />
        </div>
        <h1>Ripristino con SPID o CIE</h1>
        {returnedError && <Notice kind="errore">{returnedError}</Notice>}
        <ErrorMessage error={error} />
        {!checked && <p role="status">Controllo del ripristino…</p>}
        {done && (
          <>
            <Notice kind="fatto">
              Credenziali ripristinate: entra con la password nuova.
              {done.secondoFattoreAzzerato &&
                ' Al primo accesso attiverai di nuovo il codice a 6 cifre.'}
            </Notice>
            <a className="pulsante pulsante-primario" href="/">
              Vai all’accesso
            </a>
          </>
        )}
        {checked && !done && open && (
          <form onSubmit={(e) => void choose(e)} className="modulo">
            <p>
              Riconosciuto con {open.metodo === 'cie' ? 'la CIE' : 'SPID'}:{' '}
              <strong>{open.nome}</strong> ({open.nomeUtente}). Scegli una password nuova, da{' '}
              {open.lunghezzaMinima} a {open.lunghezzaMassima} caratteri.
              {open.bloccatoFinoA && ' Il blocco del conto si toglie.'} Tutte le sessioni aperte con
              questo utente si chiudono.
            </p>
            <div className="campo">
              <label htmlFor="ripristino-nuova">Nuova password</label>
              <input
                id="ripristino-nuova"
                name="nuova"
                type="password"
                autoComplete="new-password"
                minLength={open.lunghezzaMinima}
                maxLength={open.lunghezzaMassima}
                required
              />
            </div>
            <div className="campo">
              <label htmlFor="ripristino-ripeti">Ripeti la nuova password</label>
              <input
                id="ripristino-ripeti"
                name="ripeti"
                type="password"
                autoComplete="new-password"
                required
              />
            </div>
            {open.secondoFattoreAttivo && (
              <div className="casella">
                <input id="ripristino-azzera" name="azzera" type="checkbox" value="si" />
                <label htmlFor="ripristino-azzera">
                  Ho perso anche l’app del codice a 6 cifre: al prossimo accesso la riattivo
                </label>
              </div>
            )}
            <button type="submit" className="pulsante pulsante-primario" disabled={busy}>
              Salva la password nuova
            </button>
          </form>
        )}
        {checked && !done && !open && (
          <form onSubmit={(e) => void start(e)} className="modulo">
            <p>
              Per medici e segreteria che hanno perso la password o il codice a 6 cifre, o hanno il
              conto bloccato. Si entra con SPID o con la carta d’identità elettronica: se è la
              persona dell’utente, si sceglie una password nuova. La segreteria deve aver collegato
              prima la sua identità, dal suo profilo.
            </p>
            <div className="campo">
              <label htmlFor="ripristino-utente">Nome utente</label>
              <input id="ripristino-utente" name="utente" autoComplete="username" required />
            </div>
            <div className="campo">
              <label htmlFor="ripristino-postazione">Postazione</label>
              <input
                id="ripristino-postazione"
                name="postazione"
                defaultValue={rememberedWorkstation()}
                required
              />
            </div>
            <button type="submit" className="pulsante pulsante-primario" disabled={busy}>
              Entra con SPID o CIE
            </button>
          </form>
        )}
        <p>
          <a href="/">Torna all’accesso</a>
        </p>
      </main>
    </div>
  );
}
