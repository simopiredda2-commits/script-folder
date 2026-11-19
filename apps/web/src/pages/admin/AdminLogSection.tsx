import { useState } from 'react';
import { ErrorMessage, Loading } from '../../components/common';
import { Icon, type IconName } from '../../components/Icon';
import { query } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { useApi } from '../../lib/useApi';

interface Row {
  numero: number;
  quando: string;
  utente: string | null;
  postazione: string | null;
  area: string;
  azione: string;
  dettaglio: string | null;
  esito: string;
}
interface Page {
  righe: Row[];
  /** Da passare come `prima` per le righe più vecchie; null se non ce ne sono. */
  prossima: number | null;
}

/** L'esito sempre a parole, con il simbolo accanto (D69). */
const OUTCOMES: Record<string, { name: string; icon: IconName }> = {
  riuscito: { name: 'Riuscito', icon: 'fatto' },
  consentito: { name: 'Consentito', icon: 'fatto' },
  negato: { name: 'Negato', icon: 'blocco' },
  fallito: { name: 'Non riuscito', icon: 'avviso' },
};

const PAGE_SIZE = 50;

/**
 * Registro delle azioni di amministrazione (tappa 14): utenti, ruoli, impostazioni dello studio,
 * autorizzazioni sugli archivi, dati dell'AFT; chi, quando, da quale postazione. In sola lettura, a
 * pagine dalle più recenti. Lo leggono i titolari e l'amministratore (D163); non contiene dati dei
 * pazienti.
 */
export function AdminLogSection() {
  // Pagine lette, come pila: ognuna è il numero di riga da cui parte (null: la più recente).
  const [cursors, setCursors] = useState<(number | null)[]>([null]);
  const cursor = cursors[cursors.length - 1] ?? null;
  const page = useApi<Page>(
    `/api/studio/registro-amministrazione${query({
      limite: String(PAGE_SIZE),
      prima: cursor === null ? null : String(cursor),
    })}`,
  );
  const rows = page.data?.righe ?? [];
  const older = page.data?.prossima ?? null;

  return (
    <section className="riquadro" aria-labelledby="titolo-registro-amministrazione">
      <h2 id="titolo-registro-amministrazione">
        <Icon name="storico" /> Registro delle azioni di amministrazione
      </h2>
      <p>
        Chi ha cambiato utenti e ruoli, dati e impostazioni dello studio, autorizzazioni sugli
        archivi e dati dell’AFT, quando e da quale postazione, anche i tentativi negati. Il registro
        non si modifica e non si cancella; non contiene dati dei pazienti.
      </p>
      {page.loading && !page.data && <Loading what="dati del registro" />}
      <ErrorMessage error={page.error} />
      {page.data && rows.length === 0 && (
        <p className="tenue">Nessuna azione di amministrazione registrata.</p>
      )}
      {rows.length > 0 && (
        <div className="tabella-scorrevole">
          <table className="tabella">
            <caption>
              Azioni di amministrazione, dalle più recenti
              {cursors.length > 1 ? ` (pagina ${cursors.length})` : ''}
            </caption>
            <thead>
              <tr>
                <th scope="col">Quando</th>
                <th scope="col">Chi</th>
                <th scope="col">Postazione</th>
                <th scope="col">Area</th>
                <th scope="col">Azione</th>
                <th scope="col">Esito</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const outcome = OUTCOMES[r.esito] ?? { name: r.esito, icon: 'info' as const };
                return (
                  <tr key={r.numero}>
                    <td>{dateTime(r.quando)}</td>
                    <td>{r.utente ?? '—'}</td>
                    <td>{r.postazione ?? '—'}</td>
                    <td>{r.area}</td>
                    <td>
                      {r.azione}
                      {r.dettaglio && <div className="aiuto">{r.dettaglio}</div>}
                    </td>
                    <td>
                      <Icon name={outcome.icon} size={18} /> {outcome.name}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {(cursors.length > 1 || older !== null) && (
        <div className="azioni" role="group" aria-label="Pagine del registro">
          <button
            type="button"
            className="pulsante"
            disabled={cursors.length === 1 || page.loading}
            onClick={() => setCursors((c) => c.slice(0, -1))}
          >
            <Icon name="indietro" /> <span>Righe più recenti</span>
          </button>
          <button
            type="button"
            className="pulsante"
            disabled={older === null || page.loading}
            onClick={() => setCursors((c) => [...c, older])}
          >
            <span>Righe più vecchie</span> <Icon name="apri" />
          </button>
        </div>
      )}
    </section>
  );
}
