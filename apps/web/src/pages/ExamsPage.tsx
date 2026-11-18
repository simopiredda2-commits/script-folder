import { Link, useParams } from 'react-router';
import { ErrorMessage, Loading, Notice, PageHeader } from '../components/common';
import { date } from '../lib/format';
import { useApi } from '../lib/useApi';
import { PatientBanner, type Patient } from './RecordPage';

interface LabResult {
  id: string;
  data: string;
  esame: string;
  valore: string;
  unita: string | null;
  minimo: string | null;
  massimo: string | null;
  intervallo: string | null;
}

const COLUMNS = 3;

/**
 * Esami di laboratorio: gli ultimi tre referti affiancati, con l'intervallo stampato sul referto.
 * Nessun «sopra» o «sotto»: un confronto automatico è da validare con il consulente regolatorio
 * (regola 3, D68).
 */
export function ExamsPage() {
  const { id } = useParams<{ id: string }>();
  const record = useApi<{ paziente: Patient }>(`/api/pazienti/${id}`);
  const exams = useApi<{ esami: LabResult[] }>(`/api/pazienti/${id}/esami`);
  if (record.loading && !record.data) return <Loading what="dati della cartella" />;
  if (!record.data) return <ErrorMessage error={record.error} />;
  const p = record.data.paziente;
  const rows = exams.data?.esami ?? [];
  const dates = [...new Set(rows.map((r) => r.data))].sort().reverse().slice(0, COLUMNS);
  const analytes = [...new Set(rows.map((r) => r.esame))].sort((a, b) => a.localeCompare(b, 'it'));
  const cell = (analyte: string, d: string) =>
    rows.find((r) => r.esame === analyte && r.data === d);
  const range = (analyte: string) => {
    const r = rows.find((x) => x.esame === analyte);
    if (!r) return '';
    if (r.intervallo) return r.intervallo;
    if (r.minimo || r.massimo)
      return `${r.minimo ?? ''}–${r.massimo ?? ''} ${r.unita ?? ''}`.trim();
    return '';
  };

  return (
    <>
      <PageHeader
        title="Esami di laboratorio"
        trail={
          <>
            <Link to={`/pazienti/${id}`}>
              {p.firstName} {p.lastName}
            </Link>{' '}
            <span aria-hidden="true">/</span> <span>Esami di laboratorio</span>
          </>
        }
      />
      <PatientBanner patient={p} />
      <section className="riquadro" aria-labelledby="titolo-risultati">
        <h2 id="titolo-risultati">Risultati</h2>
        <ErrorMessage error={exams.error} />
        {exams.loading && !exams.data && <Loading what="esami" />}
        {exams.data && rows.length === 0 && <p className="tenue">Nessun risultato registrato.</p>}
        {dates.length > 0 && (
          <div className="tabella-scorrevole">
            <table className="tabella">
              <caption>
                Ultimi {dates.length === 1 ? 'referto' : `${dates.length} referti`}; l’ultimo è del{' '}
                {date(dates[0])}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Esame</th>
                  {dates.map((d) => (
                    <th scope="col" key={d}>
                      {date(d)}
                    </th>
                  ))}
                  <th scope="col">Intervallo del laboratorio</th>
                </tr>
              </thead>
              <tbody>
                {analytes.map((a) => (
                  <tr key={a}>
                    <th scope="row">{a}</th>
                    {dates.map((d) => {
                      const c = cell(a, d);
                      return (
                        <td key={d} className="numero">
                          {c ? `${c.valore}${c.unita ? ` ${c.unita}` : ''}` : '—'}
                        </td>
                      );
                    })}
                    <td>{range(a)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <Notice kind="info">
          I valori si leggono accanto all’intervallo stampato sul referto. Il confronto automatico
          con l’intervallo non c’è: va prima validato con il consulente regolatorio.
        </Notice>
      </section>
    </>
  );
}
