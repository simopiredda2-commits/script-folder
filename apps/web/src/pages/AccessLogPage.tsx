import { Link, useParams } from 'react-router';
import { ErrorMessage, Loading, Notice, PageHeader } from '../components/common';
import { dateTime } from '../lib/format';
import { useApi } from '../lib/useApi';
import { PatientBanner, type Patient, type Summary } from './RecordPage';

/** Una riga del registro degli accessi, come la dà il servizio. */
export interface AccessRow {
  quando: string;
  nome: string | null;
  azione: string;
  esito: string;
  postazione: string | null;
  motivo: string | null;
  /** Solo nel registro dell'archivio. */
  pazienteId?: string;
  paziente?: string;
}

const OUTCOMES: Record<string, string> = {
  consentito: 'Consentito',
  negato: 'Negato',
  riuscito: 'Riuscito',
  fallito: 'Non riuscito',
};

/** L'azione scritta nel registro, in parole: «apertura_cartella» → «Apertura cartella». */
export const actionText = (code: string) => {
  const words = code.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/**
 * Il registro degli accessi come tabella (audit D259): quando, chi, che cosa, con quale esito,
 * da quale postazione e perché; nel registro dell'archivio anche il paziente.
 */
export function AccessLogTable({
  rows,
  more,
  labelledBy,
  withPatient = false,
}: {
  rows: AccessRow[];
  more: boolean;
  labelledBy: string;
  withPatient?: boolean;
}) {
  if (!rows.length) return <p className="tenue">Nessun accesso registrato.</p>;
  return (
    <>
      <p className="tenue">
        {more
          ? `Gli ultimi ${rows.length} accessi, dal più recente. I precedenti sono nell’esportazione completa dell’archivio.`
          : `${rows.length === 1 ? '1 accesso' : `${rows.length} accessi`}, dal più recente.`}
      </p>
      <div className="tabella-scorrevole">
        <table className="tabella" aria-labelledby={labelledBy}>
          <thead>
            <tr>
              <th scope="col">Quando</th>
              {withPatient && <th scope="col">Paziente</th>}
              <th scope="col">Chi</th>
              <th scope="col">Azione</th>
              <th scope="col">Esito</th>
              <th scope="col">Postazione</th>
              <th scope="col">Motivo</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>{dateTime(r.quando)}</td>
                {withPatient && (
                  <td>
                    {r.pazienteId ? (
                      <Link to={`/pazienti/${r.pazienteId}/registro`}>{r.paziente}</Link>
                    ) : (
                      r.paziente
                    )}
                  </td>
                )}
                <td>{r.nome ?? '—'}</td>
                <td>{actionText(r.azione)}</td>
                <td>{OUTCOMES[r.esito] ?? r.esito}</td>
                <td>{r.postazione ?? '—'}</td>
                <td>{r.motivo ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/**
 * Registro degli accessi alla cartella (audit D259): ogni accesso, consentito o negato, con chi,
 * quando, da dove e perché. Lo legge il medico titolare dell'archivio (ruoli-permessi.md); il
 * registro non si modifica.
 */
export function AccessLogPage() {
  const { id } = useParams<{ id: string }>();
  const record = useApi<{ paziente: Patient; riepilogo: Summary | null }>(`/api/pazienti/${id}`);
  const log = useApi<{ registro: AccessRow[]; altri: boolean }>(`/api/pazienti/${id}/registro`);
  if (record.loading && !record.data) return <Loading what="dati della cartella" />;
  if (!record.data) return <ErrorMessage error={record.error} />;
  const p = record.data.paziente;
  return (
    <>
      <PageHeader
        title="Registro degli accessi"
        trail={
          <>
            <Link to={`/pazienti/${id}`}>
              {p.firstName} {p.lastName}
            </Link>{' '}
            <span aria-hidden="true">/</span> <span>Registro degli accessi</span>
          </>
        }
      />
      <PatientBanner patient={p} summary={record.data.riepilogo} />
      {log.loading && !log.data && <Loading what="registro degli accessi" />}
      {log.error?.status === 403 ? (
        <Notice kind="info">
          Il registro degli accessi lo legge il medico titolare dell’archivio del paziente.
        </Notice>
      ) : (
        <ErrorMessage error={log.error} />
      )}
      {log.data && (
        <section className="riquadro" aria-labelledby="titolo-registro">
          <h2 id="titolo-registro">Accessi alla cartella</h2>
          <AccessLogTable
            rows={log.data.registro}
            more={log.data.altri}
            labelledBy="titolo-registro"
          />
        </section>
      )}
    </>
  );
}
