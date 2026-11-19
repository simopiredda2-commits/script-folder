import { useState, type FormEvent } from 'react';
import { ErrorMessage, Notice, PageHeader } from '../components/common';
import { Icon } from '../components/Icon';
import { Logo } from '../components/Logo';
import { api, ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';

/** Regole della password, dal servizio: l'interfaccia non le riscrive. */
interface Rules {
  lunghezzaMinima: number;
  lunghezzaMassima: number;
  obbligato: boolean;
}

/** Valore di un campo del modulo come testo. */
const field = (f: FormData, name: string): string => {
  const v = f.get(name);
  return typeof v === 'string' ? v : '';
};

const closedText = (n: number) =>
  n === 0
    ? 'Password cambiata.'
    : n === 1
      ? 'Password cambiata. Chiusa l’altra sessione aperta con il tuo utente.'
      : `Password cambiata. Chiuse le altre ${n} sessioni aperte con il tuo utente.`;

/**
 * Cambio della propria password (tappa 14): dal menu dell'utente, accanto a «Esci», e dopo il primo
 * accesso con la password temporanea, quando è l'unica schermata (`forced`). Serve la password
 * attuale; dopo il cambio le altre sessioni dell'utente si chiudono, questa resta aperta.
 */
export function PasswordPage({ forced = false }: { forced?: boolean }) {
  const { state, refresh, logout } = useSession();
  const rules = useApi<Rules>('/api/profilo/password');
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [visible, setVisible] = useState(false);
  const username = state.status === 'ready' ? (state.me.nomeUtente ?? '') : '';
  const min = rules.data?.lunghezzaMinima;
  const max = rules.data?.lunghezzaMassima;
  const type = visible ? 'text' : 'password';

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setError(null);
    setDone(null);
    if (field(f, 'nuova') !== field(f, 'ripeti')) {
      setError(new ApiError(0, 'Le due nuove password non sono uguali: riscrivile'));
      return;
    }
    setBusy(true);
    try {
      const r = await api<{ altreSessioniChiuse: number }>('/api/profilo/password', {
        method: 'POST',
        body: { passwordAttuale: field(f, 'attuale'), nuovaPassword: field(f, 'nuova') },
      });
      form.reset();
      setVisible(false);
      // Con la password temporanea, dopo il cambio si apre il programma.
      if (forced) await refresh();
      else setDone(closedText(r.altreSessioniChiuse));
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'Servizio non raggiungibile'));
    } finally {
      setBusy(false);
    }
  }

  const form = (
    <form className="modulo" onSubmit={(e) => void submit(e)}>
      <div className="campo">
        <label htmlFor="password-utente">Nome utente</label>
        <input
          id="password-utente"
          name="utente"
          className="codice"
          autoComplete="username"
          value={username}
          readOnly
        />
      </div>
      <div className="campo">
        <label htmlFor="password-attuale">
          {forced ? 'Password temporanea ricevuta' : 'Password attuale'}
        </label>
        <input
          id="password-attuale"
          name="attuale"
          type={type}
          autoComplete="current-password"
          required
        />
      </div>
      <div className="campo">
        <label htmlFor="password-nuova">Nuova password</label>
        <input
          id="password-nuova"
          name="nuova"
          type={type}
          autoComplete="new-password"
          required
          minLength={min}
          maxLength={max}
          aria-describedby="password-regole"
        />
        <p className="aiuto" id="password-regole">
          {min && max ? `Da ${min} a ${max} caratteri. ` : ''}
          Spazi e lettere accentate valgono: una frase di più parole si ricorda meglio. Non può
          essere il nome utente né la password attuale.
        </p>
      </div>
      <div className="campo">
        <label htmlFor="password-ripeti">Ripeti la nuova password</label>
        <input
          id="password-ripeti"
          name="ripeti"
          type={type}
          autoComplete="new-password"
          required
          minLength={min}
          maxLength={max}
        />
      </div>
      <div className="casella">
        <input
          id="password-mostra"
          type="checkbox"
          checked={visible}
          onChange={(e) => setVisible(e.target.checked)}
        />
        <label htmlFor="password-mostra">Mostra le password mentre le scrivo</label>
      </div>
      <ErrorMessage error={error} />
      <div className="azioni">
        <button type="submit" className="pulsante pulsante-primario" disabled={busy}>
          <Icon name="fatto" /> <span>Cambia la password</span>
        </button>
        {forced && (
          <button type="button" className="pulsante" onClick={() => void logout()}>
            <Icon name="esci" /> <span>Esci</span>
          </button>
        )}
      </div>
    </form>
  );

  if (forced)
    return (
      <div className="accesso">
        <main className="accesso-scheda" id="contenuto">
          <div className="accesso-marchio">
            <Logo size={40} />
          </div>
          <h1>Cambia la password</h1>
          <Notice kind="info">
            <p>
              La password che hai ricevuto è temporanea: per continuare scegline una tua, che
              conosci solo tu.
            </p>
          </Notice>
          {form}
        </main>
      </div>
    );

  return (
    <>
      <PageHeader title="Cambia la password" />
      <section className="riquadro" aria-labelledby="titolo-password">
        <h2 id="titolo-password">
          <Icon name="lucchetto" /> La password del programma
        </h2>
        <p>
          Serve la password attuale. Dopo il cambio le altre sessioni aperte con il tuo utente si
          chiudono; questa resta aperta. Il secondo fattore non cambia.
        </p>
        {form}
        {done && <Notice kind="fatto">{done}</Notice>}
      </section>
    </>
  );
}
