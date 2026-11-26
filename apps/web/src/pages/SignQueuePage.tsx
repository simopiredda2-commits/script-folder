import { useEffect, useId, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { ConfirmQuestion, ErrorMessage, Loading, Notice, PageHeader } from '../components/common';
import { Icon } from '../components/Icon';
import { InterruptedSendPanel } from '../components/InterruptedSendPanel';
import { RedPrintedNotice, type RedPrinted } from '../components/RedFormPrint';
import { ReminderPanel } from '../components/ReminderPanel';
import { SendPanel } from '../components/SendPanel';
import { api, ApiError } from '../lib/api';
import { dateTime, PRESCRIPTION_KIND } from '../lib/format';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';
import { useRegionalService } from '../lib/regional-service';

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
    /**
     * Falso per chi vede la coda senza firmare, la segreteria (D242): la ricetta si vede, la firma
     * e l'esito restano del medico.
     */
    firmabile?: boolean;
    /** Solo negli invii senza risposta: quando era partito l'invio e chi l'aveva firmato. */
    firmataIl?: string;
    firmataDa?: string | null;
    /** Da quando l'esito si può segnare (D239). */
    esitoDal?: string | null;
    /** Il codice fiscale mandato con l'invio, per la forma dell'NRBE (D259). */
    codiceFiscaleInviato?: string | null;
    /** Solo fra le confermate (D254): inviata con l'NRE, o stampata su carta. */
    stato?: string;
    nre?: string | null;
    inviataIl?: string | null;
    cartaceaIl?: string | null;
    /** Solo fra le confermate: le consegne del promemoria riuscite (suggerimento S7, D259). */
    consegne?: number;
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
  status: 'draft' | 'to_sign' | 'error';
  onChange: (status: string, nre?: string, red?: RedPrinted) => void;
}) {
  const { list, lines } = useLines(patientId, prescription.id);
  const { isDoctor } = useSession();
  // La bozza è di chi l'ha preparata: il medico la firma, la segreteria la manda alla firma (D259).
  const signable = status === 'draft' || (isDoctor && prescription.firmabile !== false);
  const [error, setError] = useState<ApiError | null>(null);
  async function dropDraft() {
    setError(null);
    try {
      await api(`/api/ricette/${prescription.id}/annulla`, {
        method: 'POST',
        body: { motivo: 'Bozza annullata dalla pagina Ricette' },
      });
      onChange('cancelled');
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'Il servizio non ha risposto'));
    }
  }
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
      {!signable && (
        <p className="tenue">
          {status === 'error'
            ? 'La corregge e la reinvia il medico.'
            : 'In attesa della firma del medico.'}
        </p>
      )}
      {signable && list.data && (
        <SendPanel
          prescriptionId={prescription.id}
          status={status}
          lastErrorKind={prescription.tipoErrore}
          preview={prescription.tipo !== 'white'}
          redForm={prescription.tipo === 'pharma_ssn' || prescription.tipo === 'specialist_ssn'}
          lineNames={Object.fromEntries(
            lines.map((l) => [l.id, l.drugName ?? l.serviceDescription ?? '']),
          )}
          onChange={onChange}
        />
      )}
      {status === 'draft' && (
        <div className="azioni">
          <button type="button" className="pulsante" onClick={() => void dropDraft()}>
            <Icon name="annulla" /> <span>Annulla la bozza</span>
          </button>
        </div>
      )}
      <ErrorMessage error={error} />
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
  status: 'draft' | 'to_sign' | 'error';
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
  // Anche la ricetta rossa stampata esce dalla coda: il PDF da stampare resta qui sopra (D270).
  const [printed, setPrinted] = useState<{ who: string; id: string; red: RedPrinted }[]>([]);
  if (queue.loading && !queue.data) return <Loading what="ricette" />;
  if (!queue.data) return <ErrorMessage error={queue.error} />;
  const groups = queue.data.pazienti;
  const done = (sent.length > 0 || printed.length > 0) && (
    <ul className="elenco-semplice" aria-live="polite">
      {printed.map((x) => (
        <li key={x.id}>
          <RedPrintedNotice red={x.red} who={x.who} />
        </li>
      ))}
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
                  onChange={(newStatus, nre, red) => {
                    if (newStatus === 'paper' && red)
                      setPrinted((xs) => [
                        ...xs,
                        { who: `${g.paziente.nome} ${g.paziente.cognome}`, id: r.id, red },
                      ]);
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
  const { isDoctor } = useSession();
  const signable = isDoctor && r.firmabile !== false;
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
      {!signable && (
        <p className="tenue">
          Invio partito il {dateTime(r.firmataIl ?? r.preparataIl)}
          {r.firmataDa ? `, firmata da ${r.firmataDa}` : ''}: l’esito lo segna il medico.
        </p>
      )}
      {signable && (
        <InterruptedSendPanel
          prescriptionId={r.id}
          kind={r.tipo}
          signedAt={r.firmataIl ?? r.preparataIl}
          signedBy={r.firmataDa ?? null}
          settleFrom={r.esitoDal ?? null}
          fiscalCode={r.codiceFiscaleInviato ?? patient.codiceFiscale}
          redForm={r.tipo === 'pharma_ssn' || r.tipo === 'specialist_ssn'}
          onChange={(status) => {
            if (status === 'sent') setArrived(true);
            // «Non è arrivata»: la ricetta passa fra gli invii non riusciti, che si ricaricano.
            // Ricetta rossa: si ricaricano le confermate e le ricette rosse; questa coda no, così
            // il PDF resta qui, come il promemoria dopo «È arrivata» (D270).
            else onChanged();
          }}
        />
      )}
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

/** Una ricetta confermata: come è partita, e il menu di stampa e invio che si apre a richiesta. */
function ConfirmedItem({
  patient,
  prescription,
}: {
  patient: QueueGroup['paziente'];
  prescription: QueueGroup['ricette'][number];
}) {
  const [open, setOpen] = useState(false);
  const panel = useId();
  const who = `${patient.nome} ${patient.cognome}`;
  const sent = prescription.stato === 'sent';
  return (
    <li className="ricetta-in-coda">
      <p>
        <strong>{PRESCRIPTION_KIND[prescription.tipo] ?? prescription.tipo}</strong>
        {' · '}
        {sent ? (
          <>
            inviata il {dateTime(prescription.inviataIl ?? '')}
            {prescription.nre && (
              <>
                {' · NRE '}
                <span className="codice">{prescription.nre}</span>
              </>
            )}
          </>
        ) : (
          <>ricetta rossa stampata il {dateTime(prescription.cartaceaIl ?? '')}</>
        )}
        {prescription.firmataDa && <span className="tenue"> · {prescription.firmataDa}</span>}
      </p>
      {sent && (
        <>
          <button
            type="button"
            className="pulsante"
            aria-expanded={open}
            aria-controls={panel}
            onClick={() => setOpen((v) => !v)}
          >
            <Icon name={open ? 'comprimi' : 'stampa'} />{' '}
            <span>{open ? 'Chiudi stampa e invio' : 'Stampa e invio del promemoria'}</span>
          </button>
          <div id={panel} hidden={!open}>
            {open && (
              <ReminderPanel
                prescriptionId={prescription.id}
                patientId={patient.id}
                kind={prescription.tipo}
                title={`Promemoria della ricetta di ${who}`}
              />
            )}
          </div>
        </>
      )}
    </li>
  );
}

/**
 * Le ricette confermate (D254): inviate o stampate, non ancora archiviate. «Archivia ricette
 * confermate» le toglie dall'elenco, per tutto lo studio; restano nello storico del paziente.
 */
function ConfirmedQueue({ reloadKey }: { reloadKey: number }) {
  const queue = useApi<{ pazienti: QueueGroup[] }>('/api/ricette/confermate');
  const { reload } = queue;
  useEffect(() => {
    if (reloadKey) reload();
  }, [reloadKey, reload]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [archived, setArchived] = useState<number | null>(null);
  const [asking, setAsking] = useState(false);
  if (queue.loading && !queue.data) return <Loading what="ricette" />;
  if (!queue.data) return <ErrorMessage error={queue.error} />;
  const groups = queue.data.pazienti;
  const count = groups.reduce((n, g) => n + g.ricette.length, 0);
  // Le ricette senza nessuna consegna del promemoria: prima di archiviarle si chiede (S7, D259).
  const undelivered = groups.flatMap((g) =>
    g.ricette.filter((r) => r.consegne === 0).map(() => `${g.paziente.nome} ${g.paziente.cognome}`),
  );
  async function archive() {
    setAsking(false);
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ archiviate: number }>('/api/ricette/archivia-confermate', {
        method: 'POST',
        body: {},
      });
      setArchived(r.archiviate);
      reload();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'Archiviazione non riuscita'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <ErrorMessage error={error} />
      {archived !== null && (
        <Notice kind="fatto">
          {archived === 1 ? '1 ricetta archiviata' : `${archived} ricette archiviate`}: restano
          nello storico dei pazienti.
        </Notice>
      )}
      {groups.length === 0 ? (
        <p className="tenue">Nessuna ricetta confermata da archiviare.</p>
      ) : (
        <>
          <div className="azioni">
            <button
              type="button"
              className="pulsante"
              onClick={() => (undelivered.length > 0 ? setAsking(true) : void archive())}
              disabled={busy || asking}
            >
              <Icon name="archivio" />{' '}
              <span>
                Archivia ricette confermate <span className="tenue">({count})</span>
              </span>
            </button>
          </div>
          {asking && (
            <ConfirmQuestion
              label="Ricette senza consegna del promemoria"
              yes="Sì, archivia"
              busy={busy}
              onYes={() => void archive()}
              onBack={() => setAsking(false)}
            >
              {undelivered.length === 1
                ? '1 ricetta non ha nessuna consegna del promemoria'
                : `${undelivered.length} ricette non hanno nessuna consegna del promemoria`}
              : {[...new Set(undelivered)].join(', ')}. Archiviate escono da questa pagina; il
              promemoria resta nello storico delle prescrizioni del paziente. Le archivi lo stesso?
            </ConfirmQuestion>
          )}
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
                    <ConfirmedItem key={r.id} patient={g.paziente} prescription={r} />
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

/**
 * Coda «da firmare» del medico e invii non riusciti. La segreteria le vede in sola lettura (D242):
 * la pagina le promette, «Qui sotto le ricette in attesa»; firma ed esito restano del medico.
 */
/** Una ricetta rossa del medico, come la dà `GET /api/ricette-rosse` (D270). */
interface RedRow {
  id: string;
  ricetta: string;
  paziente?: string;
  nomePaziente: string;
  poligrafico: string;
  nre: string;
  stampataIl: string;
  inviareEntro: string;
  stato: 'to_send' | 'accepted' | 'ok' | 'warnings' | 'discarded';
  protocollo: string | null;
  accoltaIl: string | null;
  messaggi: { code: string; description: string }[];
  errore: string | null;
  annullamentoDematerializzata: {
    nre: string | null;
    stato: 'pending' | 'done' | 'failed';
    errore: string | null;
    annullataIl: string | null;
  } | null;
  pdf: string;
  daSeguire: boolean;
}

/** Simbolo e parola dello stato, come in tutta la cartella: mai il solo colore. */
function RedStatus({ r }: { r: RedRow }) {
  const service = useRegionalService();
  const [kind, word, text]: ['info' | 'avviso' | 'errore' | 'fatto', string, string] =
    r.stato === 'to_send'
      ? [
          r.daSeguire ? 'avviso' : 'info',
          'Da mandare',
          `${service.al} entro il ${dateTime(r.inviareEntro)}. ${r.errore ?? 'Parte da sola.'}`,
        ]
      : r.stato === 'accepted'
        ? [
            r.daSeguire ? 'avviso' : 'info',
            'Mandata',
            `il ${dateTime(r.accoltaIl ?? r.stampataIl)}, protocollo ${r.protocollo ?? '—'}: si aspetta l’esito.${r.errore ? ` ${r.errore}` : ''}`,
          ]
        : r.stato === 'ok'
          ? ['fatto', 'Accolta', `${service.dal}, protocollo ${r.protocollo ?? '—'}.`]
          : r.stato === 'warnings'
            ? ['avviso', 'Accolta con avvisi', `protocollo ${r.protocollo ?? '—'}.`]
            : [
                'errore',
                'Scartata',
                `${service.dal}: i messaggi qui sotto dicono perché. La correzione di una ricetta DPCM già mandata non è ancora nella cartella.`,
              ];
  return (
    <p>
      <span className={`esito-aggiornamento esito-${kind}`}>
        <Icon name={kind === 'errore' ? 'blocco' : kind} /> {word}
      </span>{' '}
      {text}
    </p>
  );
}

/** L'annullamento della ricetta dematerializzata che può essere arrivata (D270). */
function DmCancelStatus({ a }: { a: NonNullable<RedRow['annullamentoDematerializzata']> }) {
  const nre = a.nre ? (
    <>
      {' '}
      <span className="codice">{a.nre}</span>
    </>
  ) : null;
  if (a.stato === 'done')
    return (
      <p>
        <span className="esito-aggiornamento esito-fatto">
          <Icon name="fatto" /> Annullata
        </span>{' '}
        la ricetta dematerializzata{nre}
        {a.annullataIl ? `, il ${dateTime(a.annullataIl)}` : ''}.
      </p>
    );
  return (
    <p>
      <span className={`esito-aggiornamento esito-${a.stato === 'failed' ? 'errore' : 'info'}`}>
        <Icon name={a.stato === 'failed' ? 'blocco' : 'info'} />{' '}
        {a.stato === 'failed' ? 'Non annullata' : 'Da annullare'}
      </span>{' '}
      la ricetta dematerializzata{nre}. {a.errore ?? 'Si annulla da sola.'}
    </p>
  );
}

/**
 * Le ricette rosse del medico (D270): in corso, e per 30 giorni quelle chiuse. Partono da sole per
 * il servizio della regione; «Invia adesso» fa subito un giro della coda.
 */
function RedQueue({ reloadKey }: { reloadKey: number }) {
  const list = useApi<{ ricette: RedRow[] }>('/api/ricette-rosse');
  const { reload } = list;
  useEffect(() => {
    if (reloadKey) reload();
  }, [reloadKey, reload]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  if (list.loading && !list.data) return <Loading what="ricette rosse" />;
  if (!list.data) return <ErrorMessage error={list.error} />;
  const rows = list.data.ricette;
  if (rows.length === 0) return <p className="tenue">Nessuna ricetta rossa.</p>;
  const open = rows.some(
    (r) =>
      r.stato === 'to_send' ||
      r.stato === 'accepted' ||
      r.annullamentoDematerializzata?.stato === 'pending',
  );
  async function sendNow() {
    setBusy(true);
    setError(null);
    try {
      await api('/api/ricette-rosse/invia', { method: 'POST', body: {} });
      reload();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'Il servizio non ha risposto'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {open && (
        <div className="azioni azioni-sopra-elenco">
          <button type="button" className="pulsante" onClick={() => void sendNow()} disabled={busy}>
            <Icon name="ripeti" /> <span>Invia adesso</span>
          </button>
        </div>
      )}
      <ErrorMessage error={error} />
      <ul className="coda-ricette">
        {rows.map((r) => (
          <li key={r.id} className="riquadro ricetta-in-coda">
            <p>
              <strong>
                {r.paziente ? (
                  <Link to={`/pazienti/${r.paziente}`}>{r.nomePaziente}</Link>
                ) : (
                  r.nomePaziente
                )}
              </strong>
              <span className="tenue">
                {' '}
                · stampata il {dateTime(r.stampataIl)} · modulo{' '}
                <span className="codice">{r.poligrafico}</span> · NRE{' '}
                <span className="codice">{r.nre}</span>
              </span>
            </p>
            <RedStatus r={r} />
            {r.messaggi.length > 0 && (
              <ul className="elenco-semplice">
                {r.messaggi.map((m) => (
                  <li key={`${m.code}-${m.description}`}>
                    <span className="codice">{m.code}</span> {m.description}
                  </li>
                ))}
              </ul>
            )}
            {r.annullamentoDematerializzata && (
              <DmCancelStatus a={r.annullamentoDematerializzata} />
            )}
            <div className="azioni">
              <a className="pulsante" href={r.pdf} target="_blank" rel="noopener">
                <Icon name="stampa" /> <span>Stampa di nuovo sul modulo (PDF)</span>
              </a>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}

export function SignQueuePage() {
  const service = useRegionalService();
  const { isDoctor, isSecretary } = useSession();
  const sees = isDoctor || isSecretary;
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
    // Anche quando la sessione arriva dopo: prima di lei la pagina non ha le sezioni (D259).
  }, [hash, sees]);
  // Chi non ha un ruolo clinico (l'amministratore) legge una frase sola, non una per sezione (audit 17).
  if (!sees)
    return (
      <>
        <PageHeader title="Ricette" />
        <p className="tenue">Le ricette le vedono il medico e la segreteria.</p>
      </>
    );
  return (
    <>
      <PageHeader title="Ricette" />
      {!isDoctor && isSecretary && (
        <Notice kind="info">
          La segreteria prepara le ricette; firma e invio sono del medico. Qui sotto le ricette in
          attesa.
        </Notice>
      )}
      <section aria-labelledby="in-bozza">
        <h2 id="in-bozza" tabIndex={-1}>
          In bozza
        </h2>
        <p className="tenue">
          Le ricette che hai salvato e non hai ancora firmato o mandato alla firma.
        </p>
        <Queue
          path="/api/ricette/in-bozza"
          status="draft"
          empty="Nessuna ricetta in bozza."
          reloadKey={changes}
          onChanged={changed}
        />
      </section>
      <section aria-labelledby="titolo-da-firmare">
        <h2 id="titolo-da-firmare">Da firmare</h2>
        <p className="tenue">
          Ogni ricetta passa i controlli delle regole di prescrizione prima dell’invio.
        </p>
        <Queue
          path="/api/ricette/da-firmare"
          status="to_sign"
          empty="Nessuna ricetta da firmare."
          reloadKey={changes}
          onChanged={changed}
        />
      </section>
      <section aria-labelledby="confermate">
        <h2 id="confermate" tabIndex={-1}>
          Confermate
        </h2>
        <p className="tenue">
          Inviate o stampate. Da qui il promemoria si stampa o si manda; «Archivia ricette
          confermate» le toglie dall’elenco, e restano nello storico del paziente.
        </p>
        <ConfirmedQueue reloadKey={changes} />
      </section>
      <section aria-labelledby="non-inviate">
        <h2 id="non-inviate" tabIndex={-1}>
          Invii non riusciti
        </h2>
        <Queue
          path="/api/ricette/non-inviate"
          status="error"
          empty="Nessun invio non riuscito."
          reloadKey={changes}
          onChanged={changed}
        />
      </section>
      <section aria-labelledby="senza-risposta">
        <h2 id="senza-risposta" tabIndex={-1}>
          Invii senza risposta
        </h2>
        <>
          <p className="tenue">
            Ricette rimaste «in invio». Se la risposta non arriva entro 15 minuti, il servizio si è
            fermato mentre aspettava l’ente: si chiede all’ente se sono arrivate.
          </p>
          <InterruptedQueue onChanged={changed} />
        </>
      </section>
      {isDoctor && (
        <section aria-labelledby="ricette-rosse">
          <h2 id="ricette-rosse" tabIndex={-1}>
            Ricette rosse in DPCM
          </h2>
          <p className="tenue">
            Le ricette rosse stampate quando {service.il} non ha dato esito partono da sole per{' '}
            {service.il} entro 24 ore. Qui l’esito e l’annullamento della ricetta dematerializzata;
            quelle chiuse restano per 30 giorni.
          </p>
          <RedQueue reloadKey={changes} />
        </section>
      )}
    </>
  );
}
