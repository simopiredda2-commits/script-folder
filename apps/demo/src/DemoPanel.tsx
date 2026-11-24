import { START_URL } from './start';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ACCESS_CHANGED, secondFactorCode, type Ready } from './bridge';
import { autoReduce } from './panel-state';

type Code = Awaited<ReturnType<typeof secondFactorCode>>['code'];

const group = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;

/**
 * Il riquadro della dimostrazione (D221), fuori dall'interfaccia del programma: utenti di prova,
 * password, codice del secondo fattore di chi sta entrando, ripartenza da capo.
 */
export function DemoPanel({ ready, seconds }: { ready: Ready; seconds: number }) {
  const [open, setOpen] = useState(true);
  const [code, setCode] = useState<Code>(null);
  /** La sessione per cui il riquadro ha già deciso se ridursi. */
  const decidedFor = useRef<number | null>(null);
  /** Quando lo si è aperto a mano l'ultima volta. */
  const openedByHand = useRef(0);
  const pill = useRef<HTMLButtonElement>(null);

  // Ridotto, il pulsante sta in basso a destra, nel piede del programma: il piede gli fa posto
  // della sua larghezza, così non copre né le scritte del piede né il contenuto (richiesta di
  // Simone del 23/11/2026). La larghezza cambia con il codice.
  useLayoutEffect(() => {
    const root = document.documentElement;
    const button = pill.current;
    if (open || !button) return;
    root.style.setProperty('--dimo-posto', `${Math.ceil(button.getBoundingClientRect().width)}px`);
    root.classList.add('dimo-ridotto');
    return () => root.classList.remove('dimo-ridotto');
  }, [open, code?.code]);

  useEffect(() => {
    let alive = true;
    const tick = () =>
      void secondFactorCode().then((state) => {
        if (!alive) return;
        setCode(state.code);
        // Dopo l'accesso il riquadro si riduce da sé, una volta per sessione: resta il pulsante con
        // il codice. Se lo si è aperto a mano dopo l'accesso resta aperto: non si chiude mentre lo
        // si legge (D241).
        const next = autoReduce(state, decidedFor.current, openedByHand.current);
        decidedFor.current = next.decidedFor;
        if (next.reduce) setOpen(false);
      });
    tick();
    const timer = window.setInterval(tick, 1000);
    window.addEventListener(ACCESS_CHANGED, tick);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener(ACCESS_CHANGED, tick);
    };
  }, []);

  if (!open)
    return (
      <button
        ref={pill}
        type="button"
        className="dimo-apri"
        onClick={() => {
          openedByHand.current = Date.now();
          setOpen(true);
        }}
        aria-expanded="false"
      >
        Dimostrazione
        {/* Di chi è il codice, non solo il numero (suggerimento S5, D259). */}
        {code && (
          <span>
            codice per {code.username}:{' '}
            <span className="dimo-codice-breve">{group(code.code)}</span>
          </span>
        )}
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
                <td>
                  {u.roles.join(', ')}
                  {u.note && <span className="dimo-tenue"> ({u.note})</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p>
          Password di tutti: <code>{ready.password}</code>. Postazione: un nome qualsiasi, per
          esempio <code>Ambulatorio</code>.
        </p>
        <p>
          Per le ricette entra come <code>medico</code>: <strong>Pazienti</strong>, apri un
          paziente, <strong>Nuova ricetta</strong>. Farmaci d’esempio: amlodipina, atorvastatina,
          metformina. Per inviare una ricetta SSN serve prima l’accesso regionale: dal nome in alto,{' '}
          <strong>Credenziali</strong>, <strong>Entra con SPID o CIE</strong>, poi{' '}
          <strong>Entra con SPID (simulato)</strong>. L’amministratore dello studio non apre le
          cartelle.
        </p>
      </section>
      <section aria-labelledby="dimo-aura">
        <h3 id="dimo-aura">AURA simulata</h3>
        <p>All’avvio l’anagrafe regionale simulata ha mandato, da vedere in «Oggi»:</p>
        <ul>
          {ready.aura.exemption && <li>un’esenzione nuova per {ready.aura.exemption};</li>}
          {ready.aura.registry && <li>un’ASL diversa per {ready.aura.registry}, da confermare;</li>}
          {ready.aura.deceased && <li>il decesso di {ready.aura.deceased}, da confermare;</li>}
          {ready.aura.revoked && <li>la revoca di {ready.aura.revoked};</li>}
          {ready.aura.doctorChanges.length > 0 && (
            <li>
              la scelta di {ready.aura.doctorChanges.join(' e di ')} per la collega{' '}
              {ready.aura.colleague}: il cambio di medico, da decidere con «Sposta» o «Non
              spostare»;
            </li>
          )}
          <li>un nuovo assistito, {ready.aura.newPatient}, da registrare.</li>
        </ul>
      </section>
      <section aria-labelledby="dimo-aft">
        <h3 id="dimo-aft">AFT</h3>
        <p>
          La Dott.ssa Marchi è nell’{ready.aft.name} insieme a un medico di un altro studio,{' '}
          {ready.aft.colleague} ({ready.aft.studio}), che condivide i suoi pazienti.
        </p>
        <p>
          In <strong>Strumenti › AFT</strong> si consulta la scheda di {ready.aft.patient}, che ha
          dato il consenso: codice fiscale <code>{ready.aft.fiscalCode}</code>, con il motivo
          dell’accesso.
        </p>
      </section>
      <section aria-labelledby="dimo-invii">
        <h3 id="dimo-invii">Invii senza risposta</h3>
        <p>
          Una ricetta e un certificato di malattia di {ready.interrupted.patient}, firmati da{' '}
          {ready.interrupted.doctor}, sono rimasti «in invio»: come se il servizio si fosse fermato
          mentre aspettava il SAR e l’INPS.
        </p>
        <p>
          Il medico segna l’esito chiesto all’ente: la ricetta in{' '}
          <strong>Ricette › Invii senza risposta</strong>, il certificato nella cartella del
          paziente, in <strong>Certificati</strong>.
        </p>
      </section>
      <section aria-labelledby="dimo-presidi">
        <h3 id="dimo-presidi">Presidi</h3>
        <p>
          Nella cartella, in <strong>Presidi</strong>, si sceglie dal nomenclatore del DPCM LEA:
          allegato 2 (ausili monouso) e allegato 3 (diabete e malattie rare). Qui si vede prima che
          una persona abbia controllato la trascrizione; nel programma entra dopo il controllo.
        </p>
      </section>
      <section aria-labelledby="dimo-catalogo">
        <h3 id="dimo-catalogo">Specialistica</h3>
        <p>
          Nella cartella, in <strong>Specialistica</strong>, si sceglie dal catalogo regionale del
          Piemonte: la D.D. 590/2026 con le modifiche della D.D. 710/2026. Anche qui si vede prima
          che una persona abbia controllato la trascrizione; nel programma entra dopo il controllo.
        </p>
      </section>
      <section aria-labelledby="dimo-codice">
        <h3 id="dimo-codice">Secondo fattore</h3>
        {/* Si annuncia il codice quando cambia, non il conto alla rovescia di ogni secondo (D232). */}
        <p aria-live="polite" className={code ? undefined : 'dimo-tenue'}>
          {code ? (
            <>
              Codice per <code>{code.username}</code>:{' '}
              <strong className="dimo-codice">{group(code.code)}</strong>
            </>
          ) : (
            <>
              Dopo la password il programma chiede di collegare un’app di autenticazione: qui
              comparirà il codice che l’app mostrerebbe.
            </>
          )}
        </p>
        {code && <p className="dimo-tenue">Cambia fra {code.secondsLeft} s.</p>}
      </section>
      <p className="dimo-tenue">
        Si riparte da capo con «Ricomincia da capo». I PDF si aprono in un visore qui dentro; stampa
        e download non sono attivi nella dimostrazione.
      </p>
      <button
        type="button"
        className="dimo-ricomincia"
        // All'indirizzo d'avvio: da una pagina interna il Worker non si troverebbe (D232).
        onClick={() => location.replace(START_URL)}
      >
        Ricomincia da capo
      </button>
    </aside>
  );
}
