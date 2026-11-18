import { Link } from 'react-router';
import { ErrorMessage, Loading, Notice, PageHeader } from '../components/common';
import { Icon } from '../components/Icon';
import { credentialAlerts, CREDENTIALS_PATH, type CredentialsStatus } from '../lib/credentials';
import { age, APPOINTMENT_KIND, date, longDate, plural, time } from '../lib/format';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';

interface Today {
  data: string;
  appuntamenti: {
    id: string;
    inizio: string;
    tipo: string;
    stato: string;
    note: string | null;
    pazienteId: string | null;
    nome: string | null;
    cognome: string | null;
    dataNascita: string | null;
  }[];
  code: {
    daFirmare: number | null;
    nonInviate: number | null;
    richiesteAperte: number | null;
    pianiInScadenza: {
      pazienteId: string;
      nome: string;
      cognome: string;
      farmaco: string;
      scadenza: string;
    }[];
    giorniAvvisoPiani: number | null;
  };
}

export function TodayPage() {
  const { data, error, loading } = useApi<Today>('/api/oggi');
  if (loading && !data) return <Loading what="dati di oggi" />;
  if (!data) return <ErrorMessage error={error} />;
  const { code } = data;
  return (
    <>
      <PageHeader title="Oggi" />
      <p className="sottotitolo">{longDate(data.data)}</p>
      <CredentialAlerts />
      <div className="griglia-oggi">
        <section aria-labelledby="titolo-agenda" className="riquadro">
          <h2 id="titolo-agenda">
            <Icon name="oggi" /> Appuntamenti
          </h2>
          {data.appuntamenti.length === 0 ? (
            <p>Nessun appuntamento oggi.</p>
          ) : (
            <ol className="agenda">
              {data.appuntamenti.map((a) => (
                <li key={a.id} className="agenda-voce">
                  <span className="agenda-ora">{time(a.inizio)}</span>
                  <span className="agenda-chi">
                    {a.pazienteId ? (
                      <Link to={`/pazienti/${a.pazienteId}`}>
                        {a.nome} {a.cognome}
                      </Link>
                    ) : (
                      <span>Senza paziente</span>
                    )}
                    {a.dataNascita && <span className="tenue"> · {age(a.dataNascita)} anni</span>}
                    {a.note && <span className="agenda-nota">{a.note}</span>}
                  </span>
                  <span className="etichetta">{APPOINTMENT_KIND[a.tipo] ?? a.tipo}</span>
                </li>
              ))}
            </ol>
          )}
        </section>
        <section aria-labelledby="titolo-da-fare" className="riquadro">
          <h2 id="titolo-da-fare">Da fare</h2>
          <ul className="code-lavoro">
            {code.daFirmare !== null && (
              <li>
                <Link to="/ricette" className="coda">
                  <Icon name="firma" />
                  <span>Ricette da firmare</span>
                  <strong>{code.daFirmare}</strong>
                </Link>
              </li>
            )}
            {code.nonInviate !== null && code.nonInviate > 0 && (
              <li>
                <Link to="/ricette#non-inviate" className="coda coda-avviso">
                  <Icon name="avviso" />
                  <span>Invii non riusciti</span>
                  <strong>{code.nonInviate}</strong>
                </Link>
              </li>
            )}
            {code.richiesteAperte !== null && (
              <li className="coda coda-statica">
                <Icon name="info" />
                <span>Richieste dei pazienti aperte</span>
                <strong>{code.richiesteAperte}</strong>
              </li>
            )}
          </ul>
          {code.pianiInScadenza.length > 0 && (
            <>
              <h3>Piani terapeutici in scadenza</h3>
              <p className="tenue">
                Entro {plural(code.giorniAvvisoPiani ?? 0, 'giorno', 'giorni')}, come dice R5.
              </p>
              <ul className="elenco-semplice">
                {code.pianiInScadenza.map((p) => (
                  <li key={`${p.pazienteId}-${p.farmaco}`}>
                    <Link to={`/pazienti/${p.pazienteId}`}>
                      {p.nome} {p.cognome}
                    </Link>
                    : {p.farmaco}, scade il {date(p.scadenza)}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>
    </>
  );
}

/** Credenziali mancanti, password in scadenza, codice di sessione da attivare (D100–D102). */
function CredentialAlerts() {
  const { isDoctor } = useSession();
  const st = useApi<CredentialsStatus>(isDoctor ? '/api/profilo/credenziali' : null);
  // Una risposta inattesa non deve far cadere la pagina Oggi: niente avvisi.
  const servizi = st.data?.servizi;
  const alerts = Array.isArray(servizi) ? credentialAlerts(servizi) : [];
  if (alerts.length === 0) return null;
  return (
    <section aria-labelledby="titolo-servizi" className="riquadro avvisi-servizi">
      <h2 id="titolo-servizi">
        <Icon name="lucchetto" /> Servizi
      </h2>
      {alerts.map((a) => (
        <Notice key={a.text} kind={a.kind}>
          {a.text}
        </Notice>
      ))}
      <p>
        <Link to={CREDENTIALS_PATH}>Apri «Credenziali dei servizi»</Link>
      </p>
    </section>
  );
}
