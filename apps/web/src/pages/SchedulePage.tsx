import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { ErrorMessage, Loading, PageHeader } from '../components/common';
import { Icon } from '../components/Icon';
import { useBand } from '../components/PatientLayout';
import { PrintHint } from '../components/PrintHint';
import { date, studioToday } from '../lib/format';
import { useSession } from '../lib/session';
import { patientReading, scheduleMoment, SCHEDULE_MOMENTS } from '../lib/therapy';
import { useApi } from '../lib/useApi';
import type { Patient, Summary, TherapyFull } from './RecordPage';

/** Fino a quando: il ciclo e le terapie con una fine hanno la data; le altre continuano. */
function until(t: TherapyFull): string {
  if (t.endOn) return `fino al ${date(t.endOn)}`;
  if (t.kind === 'as_needed') return 'quando serve';
  return 'senza una data di fine';
}

/**
 * Schema orario per il paziente (requisiti, «Scheda della terapia»): cosa prendere, quando, fino a
 * quando. Solo le terapie in corso; le riservate solo se il medico sceglie di includerle (D83).
 */
export function SchedulePage() {
  const { id } = useParams<{ id: string }>();
  const { state } = useSession();
  const record = useApi<{ paziente: Patient; riepilogo?: Summary | null }>(`/api/pazienti/${id}`);
  useBand(record.data?.paziente, record.data?.riepilogo);
  const therapies = useApi<{ terapie: TherapyFull[] }>(`/api/pazienti/${id}/terapie`);
  const [withReserved, setWithReserved] = useState(false);

  if ((record.loading || therapies.loading) && !(record.data && therapies.data))
    return <Loading what="dati dello schema" />;
  if (!record.data || !therapies.data)
    return <ErrorMessage error={record.error ?? therapies.error} />;
  const p = record.data.paziente;
  const active = therapies.data.terapie.filter((t) => t.status === 'active');
  const reservedCount = active.filter((t) => t.reserved).length;
  const shown = active.filter((t) => withReserved || !t.reserved);
  const doctor = state.status === 'ready' ? state.me.nome : null;

  return (
    <>
      <div className="no-stampa">
        <PageHeader
          title="Schema orario"
          trail={
            <>
              <Link to={`/pazienti/${id}`}>
                {p.firstName} {p.lastName}
              </Link>{' '}
              <span aria-hidden="true">/</span> <span>Schema orario</span>
            </>
          }
          actions={
            <button
              type="button"
              className="pulsante pulsante-primario"
              onClick={() => window.print()}
            >
              <Icon name="stampa" /> <span>Stampa</span>
            </button>
          }
        />
        {/* Preferenze di stampa della postazione (tappa 14): la carta si sceglie nella finestra. */}
        <PrintHint kind="schema_orario" />
        {reservedCount > 0 && (
          <div className="casella">
            <input
              type="checkbox"
              id="includi-riservate"
              checked={withReserved}
              onChange={(e) => setWithReserved(e.target.checked)}
            />
            <label htmlFor="includi-riservate">
              <strong>Includi le terapie riservate</strong>{' '}
              <span className="tenue">
                ({reservedCount === 1 ? '1 terapia' : `${reservedCount} terapie`}): per difetto
                restano fuori dal foglio.
              </span>
            </label>
          </div>
        )}
      </div>

      <article className="foglio-schema" aria-labelledby="titolo-schema">
        <header className="foglio-intestazione">
          <h2 id="titolo-schema">Schema orario della terapia</h2>
          <p>
            <strong>
              {p.firstName} {p.lastName}
            </strong>
            , {p.sex === 'F' ? 'nata' : 'nato'} il {date(p.birthDate)}
          </p>
          <p className="tenue">
            Aggiornato al {date(studioToday())}
            {doctor ? ` · ${doctor}` : ''}
          </p>
        </header>
        {shown.length === 0 && <p>Nessuna terapia in corso.</p>}
        {SCHEDULE_MOMENTS.map((moment) => {
          const items = shown.filter((t) => scheduleMoment(t) === moment);
          if (items.length === 0) return null;
          return (
            <section key={moment} className="schema-momento" aria-label={moment}>
              <h3>{moment}</h3>
              <table className="tabella">
                <thead>
                  <tr>
                    <th scope="col">Farmaco</th>
                    <th scope="col">Come si prende</th>
                    <th scope="col">Fino a quando</th>
                    <th scope="col">Istruzioni</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((t) => (
                    <tr key={t.id}>
                      <th scope="row">{t.drugName}</th>
                      <td>{patientReading(t) || '—'}</td>
                      <td>{until(t)}</td>
                      <td>{t.patientInstructions ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          );
        })}
        <footer className="foglio-piede tenue">
          Trascrizione della terapia registrata in cartella: per qualsiasi dubbio chiedi al medico.
        </footer>
      </article>
    </>
  );
}
