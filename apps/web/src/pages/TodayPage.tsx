import { Link } from 'react-router';
import { ErrorMessage, Loading, Notice, PageHeader } from '../components/common';
import { Icon } from '../components/Icon';
import { AIFA_CHANGE_LABEL, type AifaChange } from '../components/Shortage';
import { credentialAlerts, CREDENTIALS_PATH, type CredentialsStatus } from '../lib/credentials';
import { age, APPOINTMENT_KIND, date, longDate, plural, time } from '../lib/format';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';
import { AuraChangesToday, AuraDoctorChangesToday, AuraNewPatientsToday } from './AuraSection';

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
    /** Ricette rimaste «in invio» da più di 15 minuti (D233). */
    senzaRisposta: number | null;
    richiesteAperte: number | null;
    pianiInScadenza: {
      pazienteId: string;
      nome: string;
      cognome: string;
      farmaco: string;
      scadenza: string;
    }[];
    giorniAvvisoPiani: number | null;
    /** Farmaci delle terapie in corso nell'elenco AIFA dei carenti, con i pazienti (A7, D202). */
    farmaciCarenti?: {
      aic: string;
      farmaco: string;
      testo: string;
      pazienti: { id: string; nome: string; cognome: string }[];
    }[];
    /** Le altre variazioni AIFA sui farmaci delle terapie in corso, con i pazienti (A7, D205). */
    variazioniAifa?: {
      aic: string;
      farmaco: string;
      tipo: AifaChange['kind'];
      testo: string;
      pazienti: { id: string; nome: string; cognome: string }[];
    }[];
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
            {code.senzaRisposta !== null && code.senzaRisposta > 0 && (
              <li>
                <Link to="/ricette#senza-risposta" className="coda coda-avviso">
                  <Icon name="avviso" />
                  <span>Invii senza risposta</span>
                  <strong>{code.senzaRisposta}</strong>
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
          {(code.farmaciCarenti ?? []).length > 0 && (
            <>
              <h3>Farmaci in terapia carenti</h3>
              <p className="tenue">
                Terapie in corso con un farmaco nell’elenco AIFA dei farmaci carenti in vigore oggi.
              </p>
              {code.farmaciCarenti!.map((d) => (
                <div key={d.aic} className="carenza-oggi">
                  <p className="carenza">
                    <Icon name="avviso" />
                    <span>
                      <strong>{d.farmaco}</strong>: {d.testo}.
                    </span>
                  </p>
                  <ul
                    className="elenco-semplice"
                    aria-label={`Pazienti con ${d.farmaco} in terapia`}
                  >
                    {d.pazienti.map((p) => (
                      <li key={p.id}>
                        <Link to={`/pazienti/${p.id}`}>
                          {p.nome} {p.cognome}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </>
          )}
          {(code.variazioniAifa ?? []).length > 0 && (
            <>
              <h3>Variazioni AIFA sui farmaci in terapia</h3>
              <p className="tenue">
                Terapie in corso con un farmaco che le banche dati AIFA in vigore oggi danno
                sospeso, fuori dall’anagrafica, o con la classe, la nota o il piano cambiati. La
                voce resta finché la terapia non è aggiornata o conclusa.
              </p>
              {code.variazioniAifa!.map((d) => (
                <div key={`${d.aic}-${d.tipo}-${d.testo}`} className="carenza-oggi">
                  <p className="carenza">
                    <Icon name="avviso" />
                    <span>
                      <strong>{d.farmaco}</strong>: {d.testo}.
                    </span>
                  </p>
                  <ul
                    className="elenco-semplice"
                    aria-label={`Pazienti con ${d.farmaco} in terapia: ${AIFA_CHANGE_LABEL[d.tipo]}`}
                  >
                    {d.pazienti.map((p) => (
                      <li key={p.id}>
                        <Link to={`/pazienti/${p.id}`}>
                          {p.nome} {p.cognome}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </>
          )}
        </section>
      </div>
      <AuraNewPatientsToday />
      <AuraDoctorChangesToday />
      <AuraChangesToday />
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
