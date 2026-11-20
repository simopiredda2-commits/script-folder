import { useEffect, useState } from 'react';
import { secondFactorCode, type Ready } from './bridge';

type Code = Awaited<ReturnType<typeof secondFactorCode>>;

const group = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;

/**
 * Il riquadro della dimostrazione (D221), fuori dall'interfaccia del programma: utenti di prova,
 * password, codice del secondo fattore di chi sta entrando, ripartenza da capo.
 */
export function DemoPanel({ ready, seconds }: { ready: Ready; seconds: number }) {
  const [open, setOpen] = useState(true);
  const [code, setCode] = useState<Code>(null);

  useEffect(() => {
    let alive = true;
    const tick = () =>
      void secondFactorCode().then((c) => {
        if (alive) setCode(c);
      });
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  if (!open)
    return (
      <button
        type="button"
        className="dimo-apri"
        onClick={() => setOpen(true)}
        aria-expanded="false"
      >
        Dimostrazione
        {code && <span className="dimo-codice-breve">{group(code.code)}</span>}
      </button>
    );

  return (
    <aside className="dimo" aria-labelledby="dimo-titolo">
      <div className="dimo-testata">
        <h2 id="dimo-titolo">Dimostrazione</h2>
        <span className="dimo-etichetta">Dati inventati</span>
        <button
          type="button"
          className="dimo-chiudi"
          onClick={() => setOpen(false)}
          aria-expanded="true"
          aria-label="Riduci il riquadro della dimostrazione"
        >
          Riduci
        </button>
      </div>
      <p>
        Programma, database e simulatori girano in questo browser (avvio in {seconds} s). Niente
        esce dal computer. Pazienti inventati: non scrivere dati di persone vere.
      </p>
      <section aria-labelledby="dimo-utenti">
        <h3 id="dimo-utenti">Per entrare</h3>
        <table>
          <thead>
            <tr>
              <th scope="col">Nome utente</th>
              <th scope="col">Ruolo</th>
            </tr>
          </thead>
          <tbody>
            {ready.users.map((u) => (
              <tr key={u.username}>
                <td>
                  <code>{u.username}</code>
                </td>
                <td>{u.roles.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          Password di tutti: <code>{ready.password}</code>. Postazione: un nome qualsiasi, per
          esempio <code>Ambulatorio</code>.
        </p>
      </section>
      <section aria-labelledby="dimo-codice" aria-live="polite">
        <h3 id="dimo-codice">Secondo fattore</h3>
        {code ? (
          <p>
            Codice per <code>{code.username}</code>:{' '}
            <strong className="dimo-codice">{group(code.code)}</strong>{' '}
            <span className="dimo-tenue">(cambia fra {code.secondsLeft} s)</span>
          </p>
        ) : (
          <p className="dimo-tenue">
            Dopo la password il programma chiede di collegare un’app di autenticazione: qui
            comparirà il codice che l’app mostrerebbe.
          </p>
        )}
      </section>
      <p className="dimo-tenue">
        Si riparte da capo ricaricando la pagina. I PDF si aprono in un visore qui dentro; stampa e
        download non sono attivi nella dimostrazione.
      </p>
      <button type="button" className="dimo-ricomincia" onClick={() => location.reload()}>
        Ricomincia da capo
      </button>
    </aside>
  );
}
