import { useState } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router';
import { ErrorMessage, Loading, Notice, PageHeader, type RuleIssue } from '../components/common';
import { Icon } from '../components/Icon';
import { AifaChangeNote, ShortageNote } from '../components/Shortage';
import { PastPrescriptionsList } from '../components/PastPrescriptions';
import type { PastPrescription } from '../components/Prescribed';
import { ReminderPanel } from '../components/ReminderPanel';
import { api, ApiError, query } from '../lib/api';
import { useSession } from '../lib/session';
import {
  ACCESS_TYPE,
  date,
  dateTime,
  PRESCRIPTION_KIND,
  PRESCRIPTION_STATUS,
  PRIORITY,
  THERAPY_KIND,
} from '../lib/format';
import { LINKS } from '../lib/links';
import { patientReading } from '../lib/therapy';
import { useApi } from '../lib/useApi';
import {
  PatientBanner,
  posology,
  type Patient,
  type Summary,
  type TherapyFull,
} from './RecordPage';
import { ConcludeTherapyPanel } from './TherapyForm';

interface HistoryEntry {
  ricetta: {
    id: string;
    tipo: string;
    stato: string;
    nre: string | null;
    preparataIl: string;
    preparataDa: string | null;
    firmataIl: string | null;
    firmataDa: string | null;
    inviataIl: string | null;
    cartaceaIl: string | null;
    esenzione: string | null;
    priorita: string | null;
    accesso: string | null;
    quesito: string | null;
    annullataIl: string | null;
    annullataDa: string | null;
    motivoAnnullamento: string | null;
    errore: string | null;
    statoErogazione: string | null;
    etichettaErogazione: string | null;
    statoVerificatoIl: string | null;
  };
  riga: {
    farmaco: string | null;
    principioAttivo: string | null;
    aic: string | null;
    prestazione: string | null;
    codicePrestazione: string | null;
    quantita: number;
    posologia: string | null;
    notaAifa: string | null;
    perPrincipioAttivo: boolean;
    nonSostituibile: boolean;
    motivoNonSostituibile: string | null;
  };
  controlli: {
    il: string;
    esito: string;
    versioneRegole: string;
    problemi: RuleIssue[];
    motivi: Record<string, string>;
  }[];
  /** Passaggi con l'ente: invio, verifica dello stato, annullamento. */
  enti: { il: string; ente: string; operazione: string; esito: string; messaggio: string | null }[];
}

interface History {
  ultimi12Mesi: number;
  annullateUltimi12Mesi: number;
  voci: HistoryEntry[];
  /** Ricette della stessa voce fatte con un altro programma (tappa 15), anche le annullate. */
  ricettePassate?: PastPrescription[];
}

/**
 * Le ricette fatte con un altro programma nello storico di una voce: si leggono, con il loro
 * segno; si registrano e si annullano dai farmaci e dalle prestazioni prescritti.
 */
function PastInHistory({ history, patientId }: { history: History; patientId: string }) {
  const items = history.ricettePassate ?? [];
  if (items.length === 0) return null;
  return (
    <>
      <h3>Ricette fatte con un altro programma</h3>
      <PastPrescriptionsList
        items={items}
        patientId={patientId}
        canWrite={false}
        onChanged={() => undefined}
        label="Ricette fatte con un altro programma"
      />
    </>
  );
}

const OPERATION: Record<string, string> = {
  invio: 'Invio',
  stato: 'Verifica dello stato',
  annullamento: 'Annullamento',
};
const EXCHANGE_OUTCOME: Record<string, string> = {
  accepted: 'accettato',
  ok: 'fatta',
  rejected: 'rifiutato',
  unreachable: 'ente non raggiungibile',
  timeout: 'nessuna risposta',
};

interface DispensingInfo {
  inviata: boolean;
  stato: string | null;
  etichetta: string | null;
  annullabile: boolean | null;
  motivo: string | null;
}

/**
 * Stato presso l'ente e annullamento (D70): si verifica lo stato e si propone l'annullamento
 * solo se l'ente non ha ancora lavorato la ricetta. Annullata, la ricetta resta nello storico.
 */
function DispensingControl({
  prescriptionId,
  onChange,
}: {
  prescriptionId: string;
  onChange: () => void;
}) {
  const { isDoctor } = useSession();
  const [info, setInfo] = useState<DispensingInfo | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  async function verify() {
    setError(null);
    try {
      setInfo(await api<DispensingInfo>(`/api/ricette/${prescriptionId}/stato-erogazione`));
      onChange();
    } catch (e) {
      setError(e instanceof ApiError ? e : null);
    }
  }

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/ricette/${prescriptionId}/annulla`, {
        method: 'POST',
        body: { motivo: reason.trim() },
      });
      onChange();
    } catch (e) {
      setError(e instanceof ApiError ? e : null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="controllo-erogazione">
      <button type="button" className="pulsante pulsante-piatto" onClick={() => void verify()}>
        <Icon name="ripeti" /> <span>Verifica lo stato presso l’ente</span>
      </button>
      {info && (
        <p role="status">
          {info.etichetta ? `Presso l’ente: ${info.etichetta}.` : info.motivo}
          {info.annullabile === false && info.etichetta && <> {info.motivo}</>}
        </p>
      )}
      {info && info.annullabile !== false && isDoctor && (
        <div className="campo">
          <label htmlFor={`motivo-annullamento-${prescriptionId}`}>Motivo dell’annullamento</label>
          <input
            id={`motivo-annullamento-${prescriptionId}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <p className="aiuto">La ricetta resta nello storico, come prescritta e annullata.</p>
          <button
            type="button"
            className="pulsante"
            disabled={busy || !reason.trim()}
            onClick={() => void cancel()}
          >
            <Icon name="annulla" /> <span>Annulla la ricetta</span>
          </button>
        </div>
      )}
      <ErrorMessage error={error} />
    </div>
  );
}

const OUTCOME: Record<string, string> = { superato: 'superato', bloccato: 'bloccato' };

/** Tabella dello storico: una riga per ogni ricetta che contiene il farmaco o la prestazione. */
/** Il pannello del promemoria si apre a richiesta: aperto per ogni riga leggerebbe troppo. */
function ReminderToggle({
  prescriptionId,
  patientId,
  kind,
}: {
  prescriptionId: string;
  patientId: string;
  kind: string;
}) {
  const [open, setOpen] = useState(false);
  return open ? (
    <ReminderPanel prescriptionId={prescriptionId} patientId={patientId} kind={kind} />
  ) : (
    <button type="button" className="pulsante" onClick={() => setOpen(true)}>
      <Icon name="stampa" /> <span>Promemoria…</span>
    </button>
  );
}

function HistoryTable({
  history,
  kind,
  onChange,
  patientId,
}: {
  history: History;
  kind: 'farmaco' | 'prestazione';
  onChange: () => void;
  patientId: string;
}) {
  if (history.voci.length === 0)
    return <p className="tenue">Nessuna ricetta fatta con questo programma.</p>;
  return (
    <div className="tabella-scorrevole">
      <table className="tabella">
        <caption className="visivamente-nascosto">Storico delle prescrizioni</caption>
        <thead>
          <tr>
            <th scope="col">Data</th>
            <th scope="col">Ricetta</th>
            <th scope="col">{kind === 'farmaco' ? 'Confezioni' : 'Quantità'}</th>
            <th scope="col">Dettagli</th>
            <th scope="col">Chi</th>
            <th scope="col">Ente</th>
            <th scope="col">Controlli</th>
          </tr>
        </thead>
        <tbody>
          {history.voci.map(({ ricetta: r, riga: l, controlli, enti }) => (
            <tr
              key={`${r.id}-${l.farmaco ?? l.prestazione}`}
              className={r.stato === 'cancelled' ? 'riga-annullata' : undefined}
            >
              <td>{date(r.inviataIl ?? r.cartaceaIl ?? r.preparataIl)}</td>
              <td>
                <span className="etichetta">{PRESCRIPTION_STATUS[r.stato] ?? r.stato}</span>
                <div>{PRESCRIPTION_KIND[r.tipo] ?? r.tipo}</div>
                {r.nre && <div className="codice">NRE {r.nre}</div>}
                {r.annullataIl && (
                  <div>
                    <strong>
                      Annullata il {date(r.annullataIl)}
                      {r.annullataDa ? ` da ${r.annullataDa}` : ''}
                    </strong>
                    {r.motivoAnnullamento && <> · {r.motivoAnnullamento}</>}
                  </div>
                )}
                {r.etichettaErogazione && (
                  <div>
                    Presso l’ente: {r.etichettaErogazione}
                    {r.statoVerificatoIl && (
                      <span className="tenue">
                        {' '}
                        (verificato il {dateTime(r.statoVerificatoIl)})
                      </span>
                    )}
                  </div>
                )}
                {r.stato === 'sent' && (
                  <>
                    <DispensingControl prescriptionId={r.id} onChange={onChange} />
                    <ReminderToggle prescriptionId={r.id} patientId={patientId} kind={r.tipo} />
                  </>
                )}
                {r.errore && <div>Errore: {r.errore}</div>}
              </td>
              <td className="numero">{l.quantita}</td>
              <td>
                <div>{l.farmaco ?? l.prestazione}</div>
                {l.codicePrestazione && <div className="codice">{l.codicePrestazione}</div>}
                {l.aic && <div className="codice">AIC {l.aic}</div>}
                {l.posologia && <div>{l.posologia}</div>}
                {l.notaAifa && <div>Nota AIFA {l.notaAifa}</div>}
                {l.perPrincipioAttivo && <div>Per principio attivo</div>}
                {l.nonSostituibile && <div>Non sostituibile: {l.motivoNonSostituibile}</div>}
                {r.esenzione && <div>Esenzione {r.esenzione}</div>}
                {r.accesso && <div>{ACCESS_TYPE[r.accesso]}</div>}
                {r.priorita && <div>Priorità {PRIORITY[r.priorita]}</div>}
                {r.quesito && <div>Quesito: {r.quesito}</div>}
              </td>
              <td>
                <div>Preparata da {r.preparataDa}</div>
                {r.firmataDa && (
                  <div>
                    Firmata da {r.firmataDa}
                    {r.firmataIl && `, ${dateTime(r.firmataIl)}`}
                  </div>
                )}
              </td>
              <td>
                {enti.length === 0 && <span className="tenue">nessuno</span>}
                {enti.map((e) => (
                  <div key={`${e.il}-${e.operazione}`}>
                    {dateTime(e.il)}: {OPERATION[e.operazione] ?? e.operazione}{' '}
                    {EXCHANGE_OUTCOME[e.esito] ?? e.esito}
                    {e.messaggio && <div className="tenue">{e.messaggio}</div>}
                  </div>
                ))}
              </td>
              <td>
                {controlli.length === 0 && <span className="tenue">nessuno</span>}
                {controlli.map((c) => (
                  <div key={c.il}>
                    {dateTime(c.il)}: {OUTCOME[c.esito] ?? c.esito}
                    {Object.entries(c.motivi).map(([rule, why]) => (
                      <div key={rule} className="tenue">
                        {rule}: {why}
                      </div>
                    ))}
                    {c.problemi
                      .filter((p) => p.severity !== 'info')
                      .map((p, i) => (
                        <div key={i} className="tenue">
                          {p.ruleId}: {p.message}
                        </div>
                      ))}
                  </div>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Interruttore della scheda in sola lettura: nome e una riga di spiegazione, non un'icona. */
function Option({ on, name, explanation }: { on: boolean; name: string; explanation: string }) {
  return (
    <li className="opzione">
      <span className={`opzione-stato ${on ? 'acceso' : 'spento'}`}>{on ? 'Sì' : 'No'}</span>
      <span>
        <strong>{name}</strong>
        <span className="tenue"> · {explanation}</span>
      </span>
    </li>
  );
}

/** Sospensione con motivo; per una reazione avversa la reazione entra tra le allergie (D81). */
function SuspendPanel({
  patientId,
  therapy,
  onDone,
  onCancel,
}: {
  patientId: string;
  therapy: TherapyFull;
  /** Con `adverse`, la sospensione era per una reazione avversa: si offre la segnalazione. */
  onDone: (message: string, adverse: boolean) => void;
  onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const [adverse, setAdverse] = useState(false);
  const [reaction, setReaction] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const substance = therapy.activeIngredient ?? therapy.drugName;
  return (
    <form
      className="riquadro pannello-sospensione"
      aria-labelledby="titolo-sospensione"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (!reason.trim()) {
          setError(new ApiError(400, 'Scrivi il motivo della sospensione.'));
          return;
        }
        setBusy(true);
        setError(null);
        api<{ reazioneRegistrata: boolean }>(
          `/api/pazienti/${patientId}/terapie/${therapy.id}/sospendi`,
          {
            method: 'POST',
            body: {
              motivo: reason.trim(),
              ...(adverse ? { reazioneAvversa: true, reazione: reaction.trim() || undefined } : {}),
            },
          },
        )
          .then((r) =>
            onDone(
              r.reazioneRegistrata
                ? `Terapia sospesa. La reazione a ${substance} è ora tra le allergie e reazioni da farmaci, in testata.`
                : 'Terapia sospesa.',
              adverse,
            ),
          )
          .catch((err: unknown) => setError(err instanceof ApiError ? err : null))
          .finally(() => setBusy(false));
      }}
    >
      <h2 id="titolo-sospensione">Sospendi la terapia</h2>
      <div className="campo">
        <label htmlFor="motivo-sospensione">Motivo della sospensione</label>
        <textarea
          id="motivo-sospensione"
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          aria-invalid={error?.status === 400 && !reason.trim() ? true : undefined}
        />
      </div>
      <div className="casella">
        <input
          type="checkbox"
          id="reazione-avversa"
          checked={adverse}
          onChange={(e) => setAdverse(e.target.checked)}
        />
        <label htmlFor="reazione-avversa">
          <strong>È una reazione avversa</strong>{' '}
          <span className="tenue">
            Si registra tra le allergie e reazioni da farmaci ({substance}), sempre in testata.
          </span>
        </label>
      </div>
      {adverse && (
        <>
          <div className="campo">
            <label htmlFor="reazione-osservata">Reazione osservata (facoltativa)</label>
            <textarea
              id="reazione-osservata"
              rows={2}
              value={reaction}
              onChange={(e) => setReaction(e.target.value)}
              aria-describedby="reazione-aiuto"
            />
            <p className="aiuto" id="reazione-aiuto">
              Se resta vuota si registra il motivo della sospensione.
            </p>
          </div>
          <PharmacovigilanceLinks />
        </>
      )}
      <ErrorMessage error={error} />
      <div className="azioni">
        <button type="submit" className="pulsante pulsante-primario" disabled={busy}>
          <Icon name="blocco" /> <span>Sospendi la terapia</span>
        </button>
        <button type="button" className="pulsante" onClick={onCancel}>
          <Icon name="annulla" /> <span>Non sospendere</span>
        </button>
      </div>
    </form>
  );
}

/** Scheda della terapia in tre parti, con le azioni e lo storico delle prescrizioni (D65). */
/**
 * Segnalazione di una sospetta reazione avversa (requisiti, «Scheda della terapia»; D82, D202):
 * le pagine AIFA si aprono in una scheda nuova, senza l'indirizzo della cartella (noreferrer).
 */
export function PharmacovigilanceLinks() {
  const { pharmacovigilanceReport: howTo, pharmacovigilanceOnline: online } = LINKS;
  if (!howTo && !online)
    return (
      <p className="aiuto">
        Collegamento alla segnalazione di farmacovigilanza: da completare (indirizzo ufficiale non
        ancora verificato).
      </p>
    );
  return (
    <p className="aiuto">
      Segnalazione di farmacovigilanza:{' '}
      {howTo && (
        <a href={howTo} target="_blank" rel="noreferrer">
          come segnalare una sospetta reazione avversa (AIFA)
        </a>
      )}
      {howTo && online && ' oppure '}
      {online && (
        <a href={online} target="_blank" rel="noreferrer">
          segnala online (AIFA)
        </a>
      )}
      . Le pagine si aprono in una scheda nuova.
    </p>
  );
}

export function TherapyPage() {
  const { id, therapyId } = useParams<{ id: string; therapyId: string }>();
  const location = useLocation();
  const { isDoctor } = useSession();
  const record = useApi<{ paziente: Patient; riepilogo: Summary | null }>(`/api/pazienti/${id}`);
  const therapies = useApi<{ terapie: TherapyFull[] }>(`/api/pazienti/${id}/terapie`);
  const history = useApi<History>(
    `/api/pazienti/${id}/storico-prescrizioni${query({ terapia: therapyId })}`,
  );
  const [suspending, setSuspending] = useState(false);
  const [concluding, setConcluding] = useState(false);
  const [done, setDone] = useState<string | null>(
    (location.state as { avviso?: string } | null)?.avviso ?? null,
  );
  const [actionError, setActionError] = useState<ApiError | null>(null);
  // Dopo una sospensione per reazione avversa si offre la segnalazione (D82, D202).
  const [offerReport, setOfferReport] = useState(false);
  const t = therapies.data?.terapie.find((x) => x.id === therapyId);

  if ((record.loading || therapies.loading) && !t) return <Loading what="dati della terapia" />;
  if (!record.data || !t)
    return (
      <ErrorMessage
        error={record.error ?? therapies.error ?? new ApiError(404, 'Terapia non trovata')}
      />
    );
  const p = record.data.paziente;
  const summary = record.data.riepilogo;
  const indication = summary?.problemiAttivi.find((x) => x.id === t.indicationEntryId);
  const suspended = t.status === 'suspended';
  // Conclusa (tappa 15): finita, con la data di fine vera; non si sospende e non si riprende.
  const ended = t.status === 'ended';

  // Classe, nota e DPC dalle banche dati in vigore: chiude le variazioni di classe e nota (D208).
  async function refreshDrugData() {
    setActionError(null);
    try {
      await api(`/api/pazienti/${id}/terapie/${therapyId}/aggiorna-dati-farmaco`, {
        method: 'POST',
        body: {},
      });
      setDone('Classe, nota e DPC della scheda aggiornati dalle banche dati in vigore oggi.');
      therapies.reload();
    } catch (e) {
      setActionError(e instanceof ApiError ? e : null);
    }
  }

  async function resume() {
    setActionError(null);
    try {
      await api(`/api/pazienti/${id}/terapie/${therapyId}/riprendi`, { method: 'POST', body: {} });
      setDone('Terapia ripresa: è di nuovo tra quelle in corso.');
      therapies.reload();
    } catch (e) {
      setActionError(e instanceof ApiError ? e : null);
    }
  }

  return (
    <>
      <PageHeader
        title={t.drugName}
        trail={
          <>
            <Link to={`/pazienti/${id}`}>
              {p.firstName} {p.lastName}
            </Link>{' '}
            <span aria-hidden="true">/</span> <span>Scheda della terapia</span>
          </>
        }
        actions={
          <>
            {isDoctor && (
              <Link
                className="pulsante pulsante-primario"
                to={`/pazienti/${id}/terapie/${t.id}/modifica`}
              >
                <Icon name="firma" /> <span>Modifica</span>
              </Link>
            )}
            <Link className="pulsante" to={`/pazienti/${id}/schema-orario`}>
              <Icon name="stampa" /> <span>Stampa lo schema orario</span>
            </Link>
            {isDoctor && !suspended && !ended && !suspending && !concluding && (
              <button type="button" className="pulsante" onClick={() => setSuspending(true)}>
                <Icon name="blocco" /> <span>Sospendi…</span>
              </button>
            )}
            {isDoctor && suspended && (
              <button type="button" className="pulsante" onClick={() => void resume()}>
                <Icon name="ripeti" /> <span>Riprendi</span>
              </button>
            )}
            {isDoctor && !ended && !suspending && !concluding && (
              <button type="button" className="pulsante" onClick={() => setConcluding(true)}>
                <Icon name="fatto" /> <span>Concludi…</span>
              </button>
            )}
          </>
        }
      />
      <PatientBanner patient={p} summary={summary} />
      {done && <Notice kind="fatto">{done}</Notice>}
      {offerReport && suspended && <PharmacovigilanceLinks />}
      <ErrorMessage error={actionError} />
      {suspended && (
        <Notice kind="avviso">
          <strong>Terapia sospesa.</strong>
          {t.suspendedReason ? ` Motivo: ${t.suspendedReason}` : ''} Non si ripete e non entra nello
          schema orario finché non la riprendi.
        </Notice>
      )}
      {t.shortage && (
        <div className="riquadro">
          <ShortageNote shortage={t.shortage} details />
        </div>
      )}
      {(t.aifaChanges ?? []).length > 0 && (
        <div className="riquadro variazioni-aifa">
          {t.aifaChanges!.map((c) => (
            <AifaChangeNote key={`${c.kind}-${c.text}`} change={c} details />
          ))}
          {isDoctor &&
            !ended &&
            t.aifaChanges!.some((c) => c.kind === 'classe' || c.kind === 'nota') && (
              <p>
                <button type="button" className="pulsante" onClick={() => void refreshDrugData()}>
                  <Icon name="ripeti" /> <span>Aggiorna dalla banca dati</span>
                </button>
              </p>
            )}
        </div>
      )}
      {ended && (
        <Notice kind="info">
          <strong>Terapia conclusa{t.endOn ? ` il ${date(t.endOn)}` : ''}.</strong> Non si ripete e
          non entra nello schema orario; resta tra i farmaci prescritti con il suo storico. Per lo
          stesso farmaco serve una terapia nuova.
        </Notice>
      )}
      {concluding && (
        <ConcludeTherapyPanel
          patientId={id!}
          therapy={t}
          onCancel={() => setConcluding(false)}
          onDone={(message) => {
            setConcluding(false);
            setDone(message);
            therapies.reload();
            record.reload();
          }}
        />
      )}
      {suspending && (
        <SuspendPanel
          patientId={id!}
          therapy={t}
          onCancel={() => setSuspending(false)}
          onDone={(message, adverse) => {
            setSuspending(false);
            setDone(message);
            setOfferReport(adverse);
            therapies.reload();
            record.reload();
          }}
        />
      )}
      <div className="griglia-cartella">
        <section className="riquadro" aria-labelledby="titolo-farmaco">
          <h2 id="titolo-farmaco">Il farmaco</h2>
          <dl className="dati">
            <dt>Principio attivo</dt>
            <dd>{t.activeIngredient ?? '—'}</dd>
            <dt>AIC</dt>
            <dd className="codice">{t.drugAic ?? '—'}</dd>
            <dt>ATC</dt>
            <dd className="codice">{t.atc ?? '—'}</dd>
            <dt>Classe</dt>
            <dd>{t.drugClass ?? '—'}</dd>
            <dt>Distribuzione per conto</dt>
            <dd>{t.dpc ? 'Sì' : 'No'}</dd>
          </dl>
          <h2>Come si prende</h2>
          <dl className="dati">
            <dt>Posologia</dt>
            <dd>{posology(t) || '—'}</dd>
            <dt>Come la legge il paziente</dt>
            <dd>{patientReading(t) || '—'}</dd>
            <dt>Tipo di terapia</dt>
            <dd>{THERAPY_KIND[t.kind]}</dd>
            <dt>Dal</dt>
            <dd>
              {date(t.startOn)}
              {t.endOn ? ` al ${date(t.endOn)}` : ''}
            </dd>
            <dt>Unità al giorno (R11)</dt>
            <dd>
              {t.unitsPerDay
                ? t.unitsPerDay.replace('.', ',')
                : 'Non indicate: il contatore non conta'}
            </dd>
            <dt>Indicazione</dt>
            <dd>
              {indication
                ? `${indication.descrizione}${indication.codice ? ` · ${indication.codice}` : ''}`
                : t.indicationEntryId
                  ? 'Problema non più tra gli attivi'
                  : '—'}
            </dd>
            <dt>Istruzioni per il paziente</dt>
            <dd>{t.patientInstructions ?? '—'}</dd>
          </dl>
        </section>
        <section className="riquadro" aria-labelledby="titolo-in-ricetta">
          <h2 id="titolo-in-ricetta">Come va in ricetta</h2>
          <dl className="dati">
            <dt>Confezioni per ricetta</dt>
            <dd>{t.packsPerPrescription}</dd>
            <dt>Esenzione abituale</dt>
            <dd>{t.habitualExemptionCode ?? 'Nessuna'}</dd>
            <dt>Nota AIFA</dt>
            <dd>{t.aifaNote ? `${t.aifaNote}: da confermare a ogni ricetta (R7)` : 'Nessuna'}</dd>
            <dt>Medico suggeritore</dt>
            <dd>
              {[t.suggestedByName, t.suggestedByFacility, t.suggestedOn && date(t.suggestedOn)]
                .filter(Boolean)
                .join(', ') || '—'}
            </dd>
          </dl>
          <ul className="opzioni">
            <Option
              on={t.important}
              name="Importante"
              explanation="sempre visibile nella testata della cartella"
            />
            <Option on={t.reserved} name="Riservata" explanation="visibile solo al medico" />
            <Option
              on={t.kind === 'chronic'}
              name="Cronica"
              explanation="attiva il contatore e la ripetizione rapida (R11)"
            />
            <Option
              on={t.notReimbursable}
              name="Non rimborsabile SSN"
              explanation="solo su ricetta bianca (R8)"
            />
            <Option
              on={t.byActiveIngredient}
              name="Per principio attivo"
              explanation="in ricetta va il principio attivo: il farmacista può dare un equivalente"
            />
            <Option
              on={t.notSubstitutable}
              name="Non sostituibile"
              explanation={
                t.notSubstitutable && t.notSubstitutableReason
                  ? `motivo: ${t.notSubstitutableReason}`
                  : 'vincola il farmacista; serve una sintetica motivazione (R13)'
              }
            />
            <Option
              on={t.multiPrescription}
              name="Multiprescrizione"
              explanation="fino a 6 confezioni, solo con le condizioni di R3 o R4"
            />
            <Option
              on={t.suggestedS}
              name="Suggerita (S)"
              explanation="tipologia S: servono i dati del medico suggeritore"
            />
            <Option on={t.hospitalH} name="Ricovero (H)" explanation="tipologia H sulla ricetta" />
          </ul>
        </section>
      </div>
      <section className="riquadro" aria-labelledby="titolo-storico">
        <h2 id="titolo-storico">
          <Icon name="storico" /> Storico delle prescrizioni
        </h2>
        <ErrorMessage error={history.error} />
        {history.loading && !history.data && <Loading what="prescrizioni" />}
        {history.data && (
          <>
            <p>
              Confezioni prescritte negli ultimi 12 mesi:{' '}
              <strong>{history.data.ultimi12Mesi}</strong>
              {history.data.annullateUltimi12Mesi > 0 && (
                <> · inviate e poi annullate: {history.data.annullateUltimi12Mesi}</>
              )}
            </p>
            <HistoryTable
              history={history.data}
              kind="farmaco"
              onChange={history.reload}
              patientId={id!}
            />
            <PastInHistory history={history.data} patientId={id!} />
          </>
        )}
      </section>
    </>
  );
}

/** Storico di una prestazione (D66), per codice regionale o per descrizione. */
export function ServiceHistoryPage() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const code = params.get('prestazione');
  const description = params.get('descrizione');
  const record = useApi<{ paziente: Patient }>(`/api/pazienti/${id}`);
  const history = useApi<History>(
    `/api/pazienti/${id}/storico-prescrizioni${query({ prestazione: code, descrizione: description })}`,
  );
  const title =
    history.data?.voci[0]?.riga.prestazione ??
    history.data?.ricettePassate?.[0]?.descrizione ??
    description ??
    code ??
    'Prestazione';
  if (record.loading && !record.data) return <Loading what="dati della cartella" />;
  if (!record.data) return <ErrorMessage error={record.error} />;
  const p = record.data.paziente;
  return (
    <>
      <PageHeader
        title={title}
        trail={
          <>
            <Link to={`/pazienti/${id}`}>
              {p.firstName} {p.lastName}
            </Link>{' '}
            <span aria-hidden="true">/</span> <span>Storico della prestazione</span>
          </>
        }
      />
      <PatientBanner patient={p} />
      <section className="riquadro" aria-labelledby="titolo-storico-prestazione">
        <h2 id="titolo-storico-prestazione">
          <Icon name="storico" /> Storico delle prescrizioni
        </h2>
        {code && <p className="codice">Codice {code}</p>}
        <ErrorMessage error={history.error} />
        {history.data && (
          <>
            <p>
              Prescritta negli ultimi 12 mesi: <strong>{history.data.ultimi12Mesi}</strong>
              {history.data.annullateUltimi12Mesi > 0 && (
                <> · inviata e poi annullata: {history.data.annullateUltimi12Mesi}</>
              )}
            </p>
            <HistoryTable
              history={history.data}
              kind="prestazione"
              onChange={history.reload}
              patientId={id!}
            />
            <PastInHistory history={history.data} patientId={id!} />
          </>
        )}
      </section>
    </>
  );
}

/**
 * Storico di un farmaco prescritto senza terapia in cartella (D152): per AIC, per principio
 * attivo o, se la riga è scritta a mano, per nome. Con le stesse regole dello storico (D65).
 */
export function DrugHistoryPage() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const aic = params.get('aic');
  const ingredient = params.get('principio');
  const name = params.get('farmaco');
  const record = useApi<{ paziente: Patient }>(`/api/pazienti/${id}`);
  const history = useApi<History>(
    `/api/pazienti/${id}/storico-prescrizioni${query({ aic, principio: ingredient, farmaco: name })}`,
  );
  const first = history.data?.voci[0]?.riga;
  const past = history.data?.ricettePassate?.[0];
  const title =
    first?.farmaco ?? past?.farmaco ?? ingredient ?? name ?? (aic ? `AIC ${aic}` : 'Farmaco');
  if (record.loading && !record.data) return <Loading what="dati della cartella" />;
  if (!record.data) return <ErrorMessage error={record.error} />;
  const p = record.data.paziente;
  return (
    <>
      <PageHeader
        title={title}
        trail={
          <>
            <Link to={`/pazienti/${id}`}>
              {p.firstName} {p.lastName}
            </Link>{' '}
            <span aria-hidden="true">/</span>{' '}
            <Link to={`/pazienti/${id}/farmaci`}>Farmaci prescritti</Link>{' '}
            <span aria-hidden="true">/</span> <span>Storico del farmaco</span>
          </>
        }
      />
      <PatientBanner patient={p} />
      <section className="riquadro" aria-labelledby="titolo-storico-farmaco">
        <h2 id="titolo-storico-farmaco">
          <Icon name="storico" /> Storico delle prescrizioni
        </h2>
        <p className="tenue">
          Prescritto senza una terapia in cartella.{' '}
          {aic
            ? `Ricette con l’AIC ${aic}.`
            : ingredient
              ? `Ricette con il principio attivo ${ingredient}.`
              : 'Ricette con questo nome, scritto a mano.'}
        </p>
        <ErrorMessage error={history.error} />
        {history.data && (
          <>
            <p>
              Confezioni prescritte negli ultimi 12 mesi:{' '}
              <strong>{history.data.ultimi12Mesi}</strong>
              {history.data.annullateUltimi12Mesi > 0 && (
                <> · inviate e poi annullate: {history.data.annullateUltimi12Mesi}</>
              )}
            </p>
            <HistoryTable
              history={history.data}
              kind="farmaco"
              onChange={history.reload}
              patientId={id!}
            />
            <PastInHistory history={history.data} patientId={id!} />
          </>
        )}
      </section>
    </>
  );
}
