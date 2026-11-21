import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { ErrorMessage, Loading, Notice, PageHeader } from '../components/common';
import { InterruptedSendPanel } from '../components/InterruptedSendPanel';
import { ReminderPanel } from '../components/ReminderPanel';
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
    /** Solo negli invii senza risposta: quando era partito l'invio e chi l'aveva firmato. */
    firmataIl?: string;
    firmataDa?: string | null;
    /** Da quando l'esito si può segnare (D239). */
    esitoDal?: string | null;
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

/** Le righe di una ricetta, lette dalla cartella del paziente (accesso registrato). */
function useLines(patientId: string, prescriptionId: string) {
  const list = useApi<PatientPrescriptions>(`/api/pazienti/${patientId}/ricette`);
  return { list, lines: list.data?.ricette.find((r) => r.id === prescriptionId)?.righe ?? [] };
}

function Lines({ lines }: { lines: PatientPrescriptions['ricette'][number]['righe'] }) {
  return (
    <ul className="elenco-semplice">
      {lines.map((l) => (
        <li key={l.id}>
          {l.drugName ?? l.serviceDescription} × {l.quantity}
        </li>
      ))}
    </ul>
  );
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
  const { list, lines } = useLines(patientId, prescription.id);
  return (
    <li className="ricetta-in-coda">
      <p>
        <strong>{PRESCRIPTION_KIND[prescription.tipo] ?? prescription.tipo}</strong>
        <span className="tenue">
          {' '}
          · preparata da {prescription.preparataDa}, {dateTime(prescription.preparataIl)}
        </span>
      </p>
      <Lines lines={lines} />
      {prescription.errore && (
        <Notice kind="avviso">Ultimo invio non riuscito: {prescription.errore}</Notice>
      )}
      {list.data && (
        <SendPanel
          prescriptionId={prescription.id}
          status={status}
          lastErrorKind={prescription.tipoErrore}
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
  reloadKey,
  onChanged,
}: {
  path: string;
  status: 'to_sign' | 'error';
  empty: string;
  /** Cambia quando un'altra coda della pagina ha spostato una ricetta: si ricarica (D239). */
  reloadKey?: number;
  onChanged?: () => void;
}) {
  const queue = useApi<{ pazienti: QueueGroup[] }>(path);
  const { reload } = queue;
  useEffect(() => {
    if (reloadKey) reload();
  }, [reloadKey, reload]);
  // Le ricette inviate escono dalla coda: la conferma con l'NRE resta qui sopra.
  const [sent, setSent] = useState<
    { who: string; nre: string; id: string; patientId: string; kind: string }[]
  >([]);
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
          <ReminderPanel
            prescriptionId={x.id}
            patientId={x.patientId}
            kind={x.kind}
            title={`Promemoria della ricetta di ${x.who}`}
          />
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
                        {
                          who: `${g.paziente.nome} ${g.paziente.cognome}`,
                          nre,
                          id: r.id,
                          patientId: g.paziente.id,
                          kind: r.tipo,
                        },
                      ]);
                    }
                    queue.reload();
                    onChanged?.();
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

/**
 * Una ricetta rimasta «in invio»: le sue righe, così il numero dato dall'ente si mette sulla
 * ricetta giusta; dopo «È arrivata» il promemoria resta qui, con il paziente (D239).
 */
function InterruptedItem({
  patient,
  prescription: r,
  onChanged,
}: {
  patient: QueueGroup['paziente'];
  prescription: QueueGroup['ricette'][number];
  onChanged: () => void;
}) {
  const { lines } = useLines(patient.id, r.id);
  const [arrived, setArrived] = useState(false);
  return (
    <li className="ricetta-in-coda">
      <p>
        <strong>{PRESCRIPTION_KIND[r.tipo] ?? r.tipo}</strong>
        <span className="tenue">
          {' '}
          · preparata da {r.preparataDa}, {dateTime(r.preparataIl)}
        </span>
      </p>
      <Lines lines={lines} />
      <InterruptedSendPanel
        prescriptionId={r.id}
        kind={r.tipo}
        signedAt={r.firmataIl ?? r.preparataIl}
        signedBy={r.firmataDa ?? null}
        settleFrom={r.esitoDal ?? null}
        onChange={(status) => {
          if (status === 'sent') setArrived(true);
          // «Non è arrivata»: la ricetta passa fra gli invii non riusciti, che si ricaricano.
          else onChanged();
        }}
      />
      {arrived && (
        <ReminderPanel
          prescriptionId={r.id}
          patientId={patient.id}
          kind={r.tipo}
          title={`Promemoria della ricetta di ${patient.nome} ${patient.cognome}`}
        />
      )}
    </li>
  );
}

/**
 * Invii rimasti senza risposta (D233): il servizio si è fermato mentre aspettava l'ente. Il medico
 * ne segna l'esito chiesto all'ente dopo 15 minuti; prima la ricetta si vede, con l'ora (D239).
 */
function InterruptedQueue({ onChanged }: { onChanged: () => void }) {
  const queue = useApi<{ pazienti: QueueGroup[] }>('/api/ricette/senza-risposta');
  if (queue.loading && !queue.data) return <Loading what="ricette" />;
  if (!queue.data) return <ErrorMessage error={queue.error} />;
  const groups = queue.data.pazienti;
  if (groups.length === 0) return <p className="tenue">Nessun invio rimasto senza risposta.</p>;
  return (
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
              <InterruptedItem
                key={r.id}
                patient={g.paziente}
                prescription={r}
                onChanged={onChanged}
              />
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}

/** Coda «da firmare» del medico e invii non riusciti. */
export function SignQueuePage() {
  const { isDoctor } = useSession();
  // Una ricetta che passa da una coda all'altra: gli invii non riusciti si ricaricano (D239).
  const [changes, setChanges] = useState(0);
  const changed = () => setChanges((n) => n + 1);
  // I collegamenti di Oggi portano alla loro sezione (#non-inviate, #senza-risposta), con il fuoco
  // sul titolo (D239): React Router non segue l'ancora da solo.
  const { hash } = useLocation();
  useEffect(() => {
    const target = hash ? document.getElementById(hash.slice(1)) : null;
    if (!target) return;
    target.scrollIntoView?.({ block: 'start' });
    target.focus({ preventScroll: true });
  }, [hash]);
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
            onChanged={changed}
          />
        ) : (
          <p className="tenue">La coda è visibile al medico.</p>
        )}
      </section>
      <section aria-labelledby="non-inviate">
        <h2 id="non-inviate" tabIndex={-1}>
          Invii non riusciti
        </h2>
        {isDoctor ? (
          <Queue
            path="/api/ricette/non-inviate"
            status="error"
            empty="Nessun invio in sospeso."
            reloadKey={changes}
          />
        ) : (
          <p className="tenue">La coda è visibile al medico.</p>
        )}
      </section>
      <section aria-labelledby="senza-risposta">
        <h2 id="senza-risposta" tabIndex={-1}>
          Invii senza risposta
        </h2>
        {isDoctor ? (
          <>
            <p className="tenue">
              Ricette rimaste «in invio». Se la risposta non arriva entro 15 minuti, il servizio si
              è fermato mentre aspettava l’ente: si chiede all’ente se sono arrivate.
            </p>
            <InterruptedQueue onChanged={changed} />
          </>
        ) : (
          <p className="tenue">La coda è visibile al medico.</p>
        )}
      </section>
    </>
  );
}
