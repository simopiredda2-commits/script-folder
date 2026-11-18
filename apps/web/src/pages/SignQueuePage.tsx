import { useState } from 'react';
import { Link } from 'react-router';
import { ErrorMessage, Loading, Notice, PageHeader } from '../components/common';
import { SendPanel } from '../components/SendPanel';
import { dateTime, PRESCRIPTION_KIND } from '../lib/format';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';

interface QueueGroup {
  paziente: { id: string; nome: string; cognome: string; codiceFiscale: string };
  ricette: {
    id: string;
    tipo: string;
    preparataIl: string;
    preparataDa: string;
    righe: number;
    errore: string | null;
    tipoErrore: string | null;
  }[];
}

interface PatientPrescriptions {
  ricette: {
    id: string;
    righe: {
      id: string;
      drugName: string | null;
      serviceDescription: string | null;
      quantity: number;
    }[];
  }[];
}

/** Le righe di una ricetta in coda, lette dalla cartella del paziente (accesso registrato). */
function QueueItem({
  patientId,
  prescription,
  status,
  onChange,
}: {
  patientId: string;
  prescription: QueueGroup['ricette'][number];
  status: 'to_sign' | 'error';
  onChange: (status: string, nre?: string) => void;
}) {
  const list = useApi<PatientPrescriptions>(`/api/pazienti/${patientId}/ricette`);
  const lines = list.data?.ricette.find((r) => r.id === prescription.id)?.righe ?? [];
  return (
    <li className="ricetta-in-coda">
      <p>
        <strong>{PRESCRIPTION_KIND[prescription.tipo] ?? prescription.tipo}</strong>
        <span className="tenue">
          {' '}
          · preparata da {prescription.preparataDa}, {dateTime(prescription.preparataIl)}
        </span>
      </p>
      <ul className="elenco-semplice">
        {lines.map((l) => (
          <li key={l.id}>
            {l.drugName ?? l.serviceDescription} × {l.quantity}
          </li>
        ))}
      </ul>
      {prescription.errore && (
        <Notice kind="avviso">Ultimo invio non riuscito: {prescription.errore}</Notice>
      )}
      {list.data && (
        <SendPanel
          prescriptionId={prescription.id}
          status={status}
          lineNames={Object.fromEntries(
            lines.map((l) => [l.id, l.drugName ?? l.serviceDescription ?? '']),
          )}
          onChange={onChange}
        />
      )}
    </li>
  );
}

function Queue({
  path,
  status,
  empty,
}: {
  path: string;
  status: 'to_sign' | 'error';
  empty: string;
}) {
  const queue = useApi<{ pazienti: QueueGroup[] }>(path);
  // Le ricette inviate escono dalla coda: la conferma con l'NRE resta qui sopra.
  const [sent, setSent] = useState<{ who: string; nre: string }[]>([]);
  if (queue.loading && !queue.data) return <Loading what="ricette" />;
  if (!queue.data) return <ErrorMessage error={queue.error} />;
  const groups = queue.data.pazienti;
  const done = sent.length > 0 && (
    <ul className="elenco-semplice" aria-live="polite">
      {sent.map((x) => (
        <li key={x.nre}>
          <Notice kind="fatto">
            Ricetta inviata per {x.who}. NRE <span className="codice">{x.nre}</span>
          </Notice>
        </li>
      ))}
    </ul>
  );
  if (groups.length === 0)
    return (
      <>
        {done}
        <p className="tenue">{empty}</p>
      </>
    );
  return (
    <>
      {done}
      <ul className="coda-ricette">
        {groups.map((g) => (
          <li key={g.paziente.id} className="riquadro">
            <h3>
              <Link to={`/pazienti/${g.paziente.id}`}>
                {g.paziente.nome} {g.paziente.cognome}
              </Link>
            </h3>
            <ul>
              {g.ricette.map((r) => (
                <QueueItem
                  key={r.id}
                  patientId={g.paziente.id}
                  prescription={r}
                  status={status}
                  onChange={(newStatus, nre) => {
                    if (newStatus === 'sent' && nre) {
                      setSent((xs) => [
                        ...xs,
                        { who: `${g.paziente.nome} ${g.paziente.cognome}`, nre },
                      ]);
                    }
                    queue.reload();
                  }}
                />
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Coda «da firmare» del medico e invii non riusciti. */
export function SignQueuePage() {
  const { isDoctor } = useSession();
  return (
    <>
      <PageHeader title="Ricette" />
      {!isDoctor && (
        <Notice kind="info">
          La segreteria prepara le ricette; firma e invio sono del medico. Qui sotto le ricette in
          attesa.
        </Notice>
      )}
      <section aria-labelledby="titolo-da-firmare">
        <h2 id="titolo-da-firmare">Da firmare</h2>
        <p className="tenue">
          Ogni ricetta passa i controlli delle regole di prescrizione prima dell’invio.
        </p>
        {isDoctor ? (
          <Queue
            path="/api/ricette/da-firmare"
            status="to_sign"
            empty="Nessuna ricetta da firmare."
          />
        ) : (
          <p className="tenue">La coda è visibile al medico.</p>
        )}
      </section>
      <section aria-labelledby="non-inviate">
        <h2 id="non-inviate">Invii non riusciti</h2>
        {isDoctor ? (
          <Queue path="/api/ricette/non-inviate" status="error" empty="Nessun invio in sospeso." />
        ) : (
          <p className="tenue">La coda è visibile al medico.</p>
        )}
      </section>
    </>
  );
}
