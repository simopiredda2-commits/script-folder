import { Link } from 'react-router';
import { ErrorMessage, Loading, Notice } from '../../components/common';
import { Icon } from '../../components/Icon';
import { dateTime } from '../../lib/format';
import { useApi } from '../../lib/useApi';

interface ServiceStatus {
  collegamenti: {
    codice: string;
    nome: string;
    uso: string;
    ambiente: string;
    ultimoUso: { quando: string; ambiente: string; operazione: string; esito: string } | null;
  }[];
  sessione: { durataMassimaOre: number; minutiInattivita: number | null };
  bancheDati: { configurato: boolean; ora: string | null; prossimoGiro: string | null };
  salvataggi: { nelProgramma: boolean };
}

/** La prima lettera in maiuscolo: «simulatore» in tabella diventa «Simulatore». */
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Stato del servizio (tappa 14), in sola lettura: collegamenti con i servizi esterni (oggi solo
 * simulatori, regola 7), durata della sessione, aggiornamento delle banche dati, salvataggi. Queste
 * cose le decide chi gestisce il server: qui l'amministratore dello studio le vede.
 */
export function ServiceSection() {
  const status = useApi<ServiceStatus>('/api/studio/servizio');
  if (status.loading && !status.data) return <Loading what="stato del servizio" />;
  if (!status.data) return <ErrorMessage error={status.error} />;
  const s = status.data;
  const updates = s.bancheDati;

  return (
    <section className="riquadro" aria-labelledby="titolo-servizio">
      <h2 id="titolo-servizio">
        <Icon name="info" /> Stato del servizio
      </h2>
      <p>
        In sola lettura: queste impostazioni le decide chi gestisce il server del programma, non si
        cambiano da qui.
      </p>

      <h3 id="titolo-collegamenti">Collegamenti con i servizi esterni</h3>
      <Notice kind="info">
        Oggi tutti i collegamenti sono simulatori: il programma non chiama nessun servizio reale.
        Quelli veri arriveranno con le specifiche e le credenziali di collaudo della Regione e del
        Sistema TS.
      </Notice>
      <div className="tabella-scorrevole">
        <table className="tabella" aria-labelledby="titolo-collegamenti">
          <thead>
            <tr>
              <th scope="col">Servizio</th>
              <th scope="col">A che cosa serve</th>
              <th scope="col">Collegamento</th>
              <th scope="col">Ultima chiamata registrata</th>
            </tr>
          </thead>
          <tbody>
            {s.collegamenti.map((c) => (
              <tr key={c.codice}>
                <td>{c.nome}</td>
                <td>{c.uso}</td>
                <td>{capital(c.ambiente)}</td>
                <td>
                  {c.ultimoUso
                    ? `${dateTime(c.ultimoUso.quando)}: ${c.ultimoUso.operazione}, ${c.ultimoUso.esito} (${c.ultimoUso.ambiente})`
                    : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="aiuto">
        L’ultima chiamata si vede per SAR, Sistema TS e INPS: ogni chiamata resta negli invii della
        ricetta o del certificato, con l’ambiente.
      </p>

      <h3>Sessione</h3>
      <dl className="dati-fissi">
        <div>
          <dt>Durata massima di una sessione</dt>
          <dd>{s.sessione.durataMassimaOre} ore, poi si accede di nuovo</dd>
        </div>
        <div>
          <dt>Blocco per inattività</dt>
          <dd>
            {s.sessione.minutiInattivita == null
              ? 'non attivo'
              : `dopo ${s.sessione.minutiInattivita} minuti`}{' '}
            (in «Dati dello studio»)
          </dd>
        </div>
      </dl>

      <h3>Banche dati</h3>
      {!updates.configurato ? (
        <Notice kind="info">
          In questa installazione le banche dati non si aggiornano dal programma: le aggiorna chi
          gestisce il server.
        </Notice>
      ) : updates.ora ? (
        <p>
          <strong>Aggiornamento automatico: ogni notte alle {updates.ora}.</strong>
          {updates.prossimoGiro && <> Prossimo: {dateTime(updates.prossimoGiro)}.</>}
        </p>
      ) : (
        <p>
          <strong>Aggiornamento automatico non attivo</strong>: le banche dati si aggiornano con il
          comando sul server o con il pulsante.
        </p>
      )}
      <p>
        <Link to="/strumenti?sezione=banche-dati">Versioni in uso e ultimi giri</Link>
      </p>

      <h3>Salvataggi</h3>
      {!s.salvataggi.nelProgramma && (
        <Notice kind="avviso">
          Il programma non fa salvataggi dei dati e qui non ce n’è nessuno da configurare: il backup
          lo fa chi gestisce il server. I requisiti chiedono backup cifrati ogni giorno, con la
          prova di ripristino.
        </Notice>
      )}
    </section>
  );
}
