import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { ErrorMessage, Loading, Notice, PageHeader } from '../components/common';
import { Icon } from '../components/Icon';
import { api, ApiError } from '../lib/api';
import { date, studioToday } from '../lib/format';
import { usePersistentState } from '../lib/storage';
import { useApi } from '../lib/useApi';
import { PatientBanner, type Patient, type Summary } from './RecordPage';

interface Execution {
  id: string;
  data: string;
  struttura: string | null;
  esito: string | null;
  seduta: number | null;
  note: string | null;
  stato: 'attiva' | 'annullata';
  motivoAnnullamento: string | null;
  registrataDa: string;
  referto: { allegatoId: string; nome: string; tipo: string; dimensione: number } | null;
}

interface Service {
  rigaId: string;
  ricettaId: string;
  nre: string | null;
  prescrittaIl: string;
  codice: string | null;
  descrizione: string;
  quantita: number;
  eseguite: number;
  esecuzioni: Execution[];
}

const failure = (e: unknown) =>
  e instanceof ApiError ? e : new ApiError(0, 'Servizio non raggiungibile');

const MAX_BYTES = 5 * 1024 * 1024;
const TYPES = ['application/pdf', 'image/jpeg', 'image/png'];

/** Il file scelto, in base64 per il servizio; il servizio ricontrolla tipo e dimensione. */
function readFile(file: File): Promise<{ nome: string; tipo: string; contenuto: string }> {
  return new Promise((resolve, reject) => {
    if (!TYPES.includes(file.type)) {
      reject(new ApiError(400, 'Si allegano solo PDF, JPEG e PNG'));
      return;
    }
    if (file.size > MAX_BYTES) {
      reject(new ApiError(400, 'Il file supera 5 MB: va ridotto prima di allegarlo'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : '';
      resolve({ nome: file.name, tipo: file.type, contenuto: url.slice(url.indexOf(',') + 1) });
    };
    reader.onerror = () => reject(new ApiError(0, 'Il file non si legge'));
    reader.readAsDataURL(file);
  });
}

const kb = (n: number) =>
  n < 1024 * 1024
    ? `${Math.max(1, Math.round(n / 1024))} kB`
    : `${(n / 1024 / 1024).toFixed(1)} MB`;

/**
 * Seguito delle prestazioni prescritte (tappa 10): dopo la prescrizione, data di esecuzione,
 * struttura, esito e referto; per i cicli, le sedute fatte su quelle prescritte. Lo scrive il
 * medico; non si cancella, si annulla con un motivo.
 */
export function FollowUpPage() {
  const { id } = useParams<{ id: string }>();
  const record = useApi<{ paziente: Patient; riepilogo: Summary | null }>(`/api/pazienti/${id}`);
  const data = useApi<{ prestazioni: Service[]; puoScrivere: boolean }>(
    `/api/pazienti/${id}/seguito`,
  );
  if (record.loading && !record.data) return <Loading what="dati della cartella" />;
  if (!record.data) return <ErrorMessage error={record.error} />;
  const p = record.data.paziente;

  return (
    <>
      <PageHeader
        title="Seguito delle prestazioni"
        trail={
          <>
            <Link to={`/pazienti/${id}`}>
              {p.firstName} {p.lastName}
            </Link>{' '}
            <span aria-hidden="true">/</span> <span>Seguito delle prestazioni</span>
          </>
        }
      />
      <PatientBanner patient={p} summary={record.data.riepilogo} />
      {data.loading && !data.data && <Loading what="prestazioni" />}
      {data.error?.status === 403 ? (
        <Notice kind="info">Il seguito delle prestazioni non è visibile con il tuo ruolo.</Notice>
      ) : (
        <ErrorMessage error={data.error} />
      )}
      {data.data && data.data.prestazioni.length === 0 && (
        <p className="tenue">Nessuna prestazione prescritta con la ricetta specialistica.</p>
      )}
      {data.data?.prestazioni.map((s) => (
        <ServiceCard
          key={s.rigaId}
          service={s}
          patientId={id!}
          canWrite={data.data!.puoScrivere}
          onChanged={data.reload}
        />
      ))}
    </>
  );
}

function ServiceCard({
  service: s,
  patientId,
  canWrite,
  onChanged,
}: {
  service: Service;
  patientId: string;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const fid = (k: string) => `${s.rigaId}-${k}`;
  const today = studioToday();
  const cycle = s.quantita > 1;
  const nextSession = (() => {
    const used = new Set(
      s.esecuzioni.filter((e) => e.stato === 'attiva').map((e) => e.seduta ?? 0),
    );
    for (let n = 1; n <= s.quantita; n++) if (!used.has(n)) return n;
    return null;
  })();
  // Ricordato per paziente e prestazione finché non si registra (D68, D129); il file no: il browser
  // non lo conserva, si sceglie di nuovo.
  const key = `bozza-esecuzione-${patientId}-${s.rigaId}`;
  const [open, setOpen, resetOpen] = usePersistentState(`${key}-aperto`, false);
  const [day, setDay, resetDay] = usePersistentState(`${key}-data`, today);
  const [facility, setFacility, resetFacility] = usePersistentState(`${key}-struttura`, '');
  const [outcome, setOutcome, resetOutcome] = usePersistentState(`${key}-esito`, '');
  const [session, setSession, resetSession] = usePersistentState(
    `${key}-seduta`,
    String(nextSession ?? ''),
  );
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState(false);
  const done_ = s.eseguite >= s.quantita;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const referto = file ? await readFile(file) : undefined;
      await api(`/api/pazienti/${patientId}/seguito`, {
        method: 'POST',
        body: {
          rigaId: s.rigaId,
          data: day,
          ...(facility.trim() ? { struttura: facility.trim() } : {}),
          ...(outcome.trim() ? { esito: outcome.trim() } : {}),
          ...(cycle && session ? { seduta: Number(session) } : {}),
          ...(referto ? { referto } : {}),
        },
      });
      for (const reset of [resetDay, resetFacility, resetOutcome, resetSession, resetOpen]) reset();
      setFile(null);
      setDone(true);
      onChanged();
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="riquadro" aria-labelledby={fid('titolo')}>
      <h2 id={fid('titolo')}>{s.descrizione}</h2>
      <p className="voce-dati">
        {s.codice && <span className="codice">{s.codice}</span>}
        <span>prescritta il {date(s.prescrittaIl)}</span>
        {s.nre && <span className="codice">NRE {s.nre}</span>}
        <span className="etichetta">
          {cycle
            ? `${s.eseguite} di ${s.quantita} sedute`
            : s.eseguite > 0
              ? 'Eseguita'
              : 'Da eseguire'}
        </span>
      </p>
      {s.esecuzioni.length > 0 && (
        <ul className="voci">
          {s.esecuzioni.map((x) => (
            <ExecutionItem
              key={x.id}
              x={x}
              patientId={patientId}
              canWrite={canWrite}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
      {done && <Notice kind="fatto">Esecuzione registrata.</Notice>}
      {canWrite && !done_ && !open && (
        <div className="azioni">
          <button type="button" className="pulsante" onClick={() => setOpen(true)}>
            <Icon name="aggiungi" />{' '}
            <span>{cycle ? 'Registra una seduta' : 'Registra l’esecuzione'}</span>
            <span className="visivamente-nascosto"> di {s.descrizione}</span>
          </button>
        </div>
      )}
      {canWrite && open && (
        <form onSubmit={(e) => void submit(e)}>
          <fieldset disabled={busy}>
            <legend>{cycle ? 'Nuova seduta' : 'Esecuzione'}</legend>
            <div className="campi-in-riga">
              <div className="campo campo-stretto">
                <label htmlFor={fid('data')}>Eseguita il</label>
                <input
                  id={fid('data')}
                  type="date"
                  required
                  min={s.prescrittaIl}
                  max={today}
                  value={day}
                  onChange={(e) => setDay(e.target.value)}
                />
              </div>
              {cycle && (
                <div className="campo campo-stretto">
                  <label htmlFor={fid('seduta')}>Seduta</label>
                  <input
                    id={fid('seduta')}
                    inputMode="numeric"
                    pattern="[0-9]{1,3}"
                    required
                    value={session}
                    onChange={(e) => setSession(e.target.value)}
                  />
                </div>
              )}
              <div className="campo">
                <label htmlFor={fid('struttura')}>Struttura</label>
                <input
                  id={fid('struttura')}
                  maxLength={200}
                  value={facility}
                  onChange={(e) => setFacility(e.target.value)}
                />
              </div>
            </div>
            <div className="campo">
              <label htmlFor={fid('esito')}>Esito</label>
              <textarea
                id={fid('esito')}
                rows={3}
                maxLength={5000}
                value={outcome}
                onChange={(e) => setOutcome(e.target.value)}
              />
            </div>
            <div className="campo">
              <label htmlFor={fid('referto')}>Referto (PDF o immagine, al più 5 MB)</label>
              <input
                id={fid('referto')}
                type="file"
                accept="application/pdf,image/jpeg,image/png"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </div>
            <div className="azioni">
              <button type="submit" className="pulsante pulsante-primario">
                <Icon name="fatto" /> <span>Registra</span>
              </button>
              <button type="button" className="pulsante" onClick={() => setOpen(false)}>
                <Icon name="annulla" /> <span>Chiudi</span>
              </button>
            </div>
          </fieldset>
          <ErrorMessage error={error} />
        </form>
      )}
    </section>
  );
}

function ExecutionItem({
  x,
  patientId,
  canWrite,
  onChanged,
}: {
  x: Execution;
  patientId: string;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const [annulling, setAnnulling] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const annulled = x.stato === 'annullata';

  async function annul(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api(`/api/pazienti/${patientId}/seguito/${x.id}/annulla`, {
        method: 'POST',
        body: { motivo: reason },
      });
      onChanged();
    } catch (err) {
      setError(failure(err));
    }
  }

  return (
    <li className={`voce${annulled ? ' voce-annullata' : ''}`}>
      <p className="voce-testo">
        <span className="cronologia-data">{date(x.data)}</span>{' '}
        <span className={annulled ? 'testo-annullato' : undefined}>
          {x.seduta ? `Seduta ${x.seduta}` : 'Eseguita'}
          {x.struttura ? ` · ${x.struttura}` : ''}
        </span>
      </p>
      {x.esito && <p>Esito: {x.esito}</p>}
      <p className="voce-dati">
        {annulled && <span className="etichetta">Annullata</span>}
        <span className="tenue">{x.registrataDa}</span>
      </p>
      {annulled && x.motivoAnnullamento && (
        <p className="tenue">Motivo dell’annullamento: {x.motivoAnnullamento}</p>
      )}
      <div className="azioni">
        {x.referto && (
          <a
            className="pulsante pulsante-piatto"
            href={`/api/pazienti/${patientId}/allegati/${x.referto.allegatoId}`}
            target="_blank"
            rel="noopener"
          >
            <Icon name="apri" /> <span>Referto</span>
            <span className="tenue">
              {' '}
              ({x.referto.tipo === 'application/pdf' ? 'PDF' : 'immagine'},{' '}
              {kb(x.referto.dimensione)})
            </span>
          </a>
        )}
        {canWrite && !annulled && (
          <button
            type="button"
            className="pulsante pulsante-piatto"
            aria-expanded={annulling}
            onClick={() => setAnnulling((v) => !v)}
          >
            <Icon name="annulla" /> <span>Annulla</span>
            <span className="visivamente-nascosto"> l’esecuzione del {date(x.data)}</span>
          </button>
        )}
      </div>
      {annulling && (
        <form className="modulo-in-riga" onSubmit={(e) => void annul(e)}>
          <div className="campo">
            <label htmlFor={`motivo-${x.id}`}>Motivo dell’annullamento</label>
            <input
              id={`motivo-${x.id}`}
              required
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <button type="submit" className="pulsante pulsante-primario">
            <Icon name="annulla" /> <span>Conferma l’annullamento</span>
          </button>
        </form>
      )}
      <ErrorMessage error={error} />
    </li>
  );
}
