import { useState, type FormEvent } from 'react';
import { ErrorMessage, Notice } from '../components/common';
import { Logo } from '../components/Logo';
import { Signature } from '../components/Signature';
import { api, ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { rememberedWorkstation, rememberWorkstation } from '../lib/storage';

type Step =
  | { kind: 'password' }
  | { kind: 'code'; token: string }
  | { kind: 'enroll'; token: string; secret: string; otpauth: string };

/** Valore di un campo del modulo come testo. */
const field = (f: FormData, name: string): string => {
  const v = f.get(name);
  return typeof v === 'string' ? v : '';
};

/** Il segreto in gruppi di quattro, per copiarlo a mano nell'app di autenticazione. */
const grouped = (s: string) => s.match(/.{1,4}/g)?.join(' ') ?? s;

export function LoginPage() {
  const { refresh } = useSession();
  const [step, setStep] = useState<Step>({ kind: 'password' });
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  async function submitPassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ passo: string; passaggio: string; segreto?: string; otpauth?: string }>(
        '/api/accesso',
        {
          method: 'POST',
          body: {
            username: field(f, 'utente'),
            password: field(f, 'password'),
            postazione: field(f, 'postazione'),
          },
        },
      );
      // La password è giusta: questo browser ricorda la postazione per la prossima volta.
      rememberWorkstation(field(f, 'postazione'));
      setStep(
        r.passo === 'attiva-secondo-fattore'
          ? { kind: 'enroll', token: r.passaggio, secret: r.segreto!, otpauth: r.otpauth! }
          : { kind: 'code', token: r.passaggio },
      );
    } catch (err) {
      setError(err instanceof ApiError ? err : null);
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: FormEvent<HTMLFormElement>, token: string) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    try {
      await api('/api/accesso/codice', {
        method: 'POST',
        body: { passaggio: token, codice: field(f, 'codice').replace(/\s/g, '') },
      });
      await refresh();
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
        <h1>Accesso</h1>
        <ErrorMessage error={error} />
        {step.kind === 'password' && (
          <form onSubmit={(e) => void submitPassword(e)} className="modulo">
            <div className="campo">
              <label htmlFor="utente">Nome utente</label>
              <input id="utente" name="utente" autoComplete="username" required />
            </div>
            <div className="campo">
              <label htmlFor="password">Password</label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
              />
            </div>
            <div className="campo">
              <label htmlFor="postazione">Postazione</label>
              <input
                id="postazione"
                name="postazione"
                defaultValue={rememberedWorkstation()}
                required
              />
              <p className="aiuto">
                Il nome del computer o del tablet: resta nel registro degli accessi, e questo
                browser lo ricorda per il prossimo accesso.
              </p>
            </div>
            <button type="submit" className="pulsante pulsante-primario" disabled={busy}>
              Continua
            </button>
            <p>
              <a href="/ripristino">
                Password o codice persi, o conto bloccato? Ripristina con SPID o CIE
              </a>
            </p>
          </form>
        )}
        {step.kind !== 'password' && (
          <form onSubmit={(e) => void submitCode(e, step.token)} className="modulo">
            {step.kind === 'enroll' && (
              <Notice kind="info">
                <p>
                  Primo accesso: attiva il secondo fattore. Nell’app di autenticazione aggiungi un
                  account con questo codice, poi scrivi qui il codice a 6 cifre che l’app mostra.
                </p>
                <p className="segreto codice" aria-label="Codice da inserire nell'app">
                  {grouped(step.secret)}
                </p>
              </Notice>
            )}
            <div className="campo">
              <label htmlFor="codice">Codice a 6 cifre</label>
              <input
                id="codice"
                name="codice"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9 ]{6,7}"
                required
              />
            </div>
            <button type="submit" className="pulsante pulsante-primario" disabled={busy}>
              Entra
            </button>
          </form>
        )}
      </main>
    </div>
  );
}

/** Sessione bloccata per inattività: si sblocca con il codice a 6 cifre (D31). */
export function LockScreen() {
  const { refresh, logout } = useSession();
  const [error, setError] = useState<ApiError | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api('/api/accesso/sblocca', {
        method: 'POST',
        body: { codice: field(f, 'codice').replace(/\s/g, '') },
      });
      setError(null);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err : null);
    }
  }

  return (
    <div className="accesso">
      <main className="accesso-scheda" id="contenuto">
        <div className="accesso-marchio">
          <Logo size={40} />
        </div>
        <h1>Sessione bloccata</h1>
        <p>
          Dopo qualche minuto senza attività la sessione si blocca. Per continuare scrivi il codice
          a 6 cifre.
        </p>
        <ErrorMessage error={error} />
        <form onSubmit={(e) => void submit(e)} className="modulo">
          <div className="campo">
            <label htmlFor="codice-sblocco">Codice a 6 cifre</label>
            <input
              id="codice-sblocco"
              name="codice"
              inputMode="numeric"
              autoComplete="one-time-code"
              required
            />
          </div>
          <div className="azioni">
            <button type="submit" className="pulsante pulsante-primario">
              Sblocca
            </button>
            <button type="button" className="pulsante" onClick={() => void logout()}>
              Esci
            </button>
          </div>
        </form>
      </main>
    </div>
  );
}
