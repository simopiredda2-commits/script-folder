import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { api, ApiError } from '../lib/api';
import { date, studioToday } from '../lib/format';
import { usePersistentState } from '../lib/storage';
import { ErrorMessage, Notice } from './common';
import { Icon } from './Icon';
import type { PastPrescription } from './Prescribed';

/**
 * Ricette fatte con un altro programma (tappa 15): stanno nei farmaci e nelle prestazioni
 * prescritti, nel loro storico e nella cronologia, sempre con il segno «fatta con un altro
 * programma». Non sono ricette di questo programma: non si firmano, non si inviano e non si
 * ripetono. Un farmaco con un codice AIC valido oggi si può usare come base per una terapia nuova.
 */

type Kind = PastPrescription['tipo'];

/** Che cosa è stato prescritto, in una riga. */
export function pastWhat(p: PastPrescription): string {
  const what =
    p.tipo === 'prestazione'
      ? (p.descrizione ?? p.codice ?? '')
      : (p.farmaco ?? p.principioAttivo ?? (p.aic ? `AIC ${p.aic}` : ''));
  return p.quantita ? `${what} × ${p.quantita}` : what;
}

/** I codici e chi l'ha prescritta, in una riga. */
function pastDetails(p: PastPrescription): string {
  return [
    p.tipo === 'farmaco' && p.principioAttivo && p.principioAttivo !== p.farmaco
      ? `principio attivo ${p.principioAttivo}`
      : null,
    p.aic && `AIC ${p.aic}`,
    p.atc && `ATC ${p.atc}`,
    p.tipo === 'prestazione' && p.codice && p.descrizione ? `codice ${p.codice}` : null,
    p.nre && `NRE ${p.nre}`,
    p.prescrittore && `prescritta da ${p.prescrittore}`,
    p.programma && `con ${p.programma}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Usa un farmaco come base per una terapia nuova, solo se il codice AIC è nella banca dati in
 * vigore oggi: lo si controlla quando il medico lo chiede, poi la scheda nuova parte da quel
 * farmaco (con i dati di oggi, non con quelli della ricetta di prima).
 */
function TherapyFromPast({ patientId, p }: { patientId: string; p: PastPrescription }) {
  const navigate = useNavigate();
  const [problem, setProblem] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  if (p.tipo !== 'farmaco' || !p.aic || p.stato !== 'attiva') return null;
  const aic = p.aic;

  async function start() {
    setBusy(true);
    setProblem(null);
    setError(null);
    try {
      const r = await api<{ farmaco: unknown }>(`/api/farmaci/${aic}`);
      if (!r.farmaco) {
        setProblem(
          `Il codice AIC ${aic} non è nella banca dati dei farmaci in vigore oggi: non si può usare come base. Per una terapia nuova scegli il farmaco dalla banca dati.`,
        );
        return;
      }
      void navigate(
        `/pazienti/${patientId}/terapie/nuova?aic=${encodeURIComponent(aic)}&da=altro-programma`,
      );
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'Servizio non raggiungibile'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        type="button"
        className="pulsante pulsante-piatto"
        disabled={busy}
        onClick={() => void start()}
      >
        <Icon name="aggiungi" /> <span>Nuova terapia da questo farmaco</span>
        <span className="visivamente-nascosto"> (ricetta del {date(p.data)})</span>
      </button>
      {problem && <Notice kind="avviso">{problem}</Notice>}
      <ErrorMessage error={error} />
    </>
  );
}

function PastItem({
  p,
  patientId,
  canWrite,
  onChanged,
}: {
  p: PastPrescription;
  patientId: string;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const [annulling, setAnnulling] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const annulled = p.stato === 'annullata';
  const when = `del ${date(p.data)}`;

  async function annul(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api(`/api/pazienti/${patientId}/ricette-passate/${p.id}/annulla`, {
        method: 'POST',
        body: { motivo: reason.trim() },
      });
      setAnnulling(false);
      setReason('');
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'Servizio non raggiungibile'));
    }
  }

  const details = pastDetails(p);
  return (
    <li className={`voce${annulled ? ' voce-annullata' : ''}`}>
      <p className="voce-testo">
        <span className="cronologia-data">{date(p.data)}</span>{' '}
        <span className={annulled ? 'testo-annullato' : undefined}>{pastWhat(p)}</span>
        {p.posologia && <span className="tenue"> · {p.posologia}</span>}
      </p>
      <p className="voce-dati">
        <span className="etichetta">
          <Icon name="archivio" size={16} /> Fatta con un altro programma
        </span>
        {p.importata && <span className="etichetta">Importata</span>}
        {annulled && <span className="etichetta">Annullata</span>}
        {details && <span className="tenue">{details}</span>}
      </p>
      {p.note && <p className="tenue">Note: {p.note}</p>}
      {p.registrataDa && (
        <p className="tenue">
          Registrata da {p.registrataDa} il {date(p.registrataIl)}
        </p>
      )}
      {annulled && p.motivoAnnullamento && (
        <p className="tenue">Motivo dell’annullamento: {p.motivoAnnullamento}</p>
      )}
      {canWrite && !annulled && (
        <div className="azioni">
          <TherapyFromPast patientId={patientId} p={p} />
          <button
            type="button"
            className="pulsante pulsante-piatto"
            aria-expanded={annulling}
            onClick={() => setAnnulling(!annulling)}
          >
            <Icon name="annulla" /> <span>Annulla la ricetta</span>
            <span className="visivamente-nascosto"> {when}</span>
          </button>
        </div>
      )}
      {annulling && (
        <form className="modulo-in-riga" onSubmit={(ev) => void annul(ev)}>
          <div className="campo">
            <label htmlFor={`motivo-passata-${p.id}`}>Motivo dell’annullamento</label>
            <input
              id={`motivo-passata-${p.id}`}
              required
              maxLength={500}
              value={reason}
              onChange={(ev) => setReason(ev.target.value)}
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

/** L'elenco delle ricette fatte con un altro programma, dalla più recente. */
export function PastPrescriptionsList({
  items,
  patientId,
  canWrite,
  onChanged,
  label,
}: {
  items: PastPrescription[];
  patientId: string;
  canWrite: boolean;
  onChanged: () => void;
  /** Nome dell'elenco per chi usa un lettore di schermo. */
  label: string;
}) {
  if (items.length === 0) return null;
  return (
    <ul className="voci" aria-label={label}>
      {items.map((p) => (
        <PastItem
          key={p.id}
          p={p}
          patientId={patientId}
          canWrite={canWrite}
          onChanged={onChanged}
        />
      ))}
    </ul>
  );
}

const EMPTY: Record<string, string> = {};

/** Registrazione a mano di una ricetta fatta con un altro programma. */
function PastPrescriptionForm({
  patientId,
  kind,
  onSaved,
}: {
  patientId: string;
  kind: Kind;
  onSaved: () => void;
}) {
  const today = studioToday();
  // Quello che si sta scrivendo resta ricordato per paziente e tipo, come le voci (D68, D129).
  const [f, setF, resetF] = usePersistentState<Record<string, string>>(
    `bozza-ricetta-passata-${patientId}-${kind}`,
    { ...EMPTY, data: today },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState(false);
  const fid = (k: string) => `passata-${kind}-${k}`;
  const value = (k: string) => (f[k] ?? '').trim() || undefined;
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));

  function body() {
    const quantity = value('quantita');
    const common = {
      tipo: kind,
      data: f.data ?? '',
      quantita: quantity === undefined ? undefined : Number(quantity),
      nre: value('nre'),
      prescrittore: value('prescrittore'),
      programma: value('programma'),
      note: value('note'),
    };
    return kind === 'farmaco'
      ? {
          ...common,
          farmaco: value('farmaco'),
          principioAttivo: value('principioAttivo'),
          aic: value('aic'),
          atc: value('atc'),
          posologia: value('posologia'),
        }
      : { ...common, codice: value('codice'), descrizione: value('descrizione') };
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await api(`/api/pazienti/${patientId}/ricette-passate`, { method: 'POST', body: body() });
      resetF();
      setDone(true);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'Servizio non raggiungibile'));
    } finally {
      setBusy(false);
    }
  }

  const input = (k: string, label: string, props: Record<string, unknown> = {}) => (
    <div className={`campo${props.stretto ? ' campo-stretto' : ''}`}>
      <label htmlFor={fid(k)}>{label}</label>
      <input
        id={fid(k)}
        value={f[k] ?? ''}
        onChange={(e) => set(k, e.target.value)}
        {...Object.fromEntries(Object.entries(props).filter(([p]) => p !== 'stretto'))}
      />
    </div>
  );

  return (
    <form onSubmit={(e) => void submit(e)} aria-labelledby={fid('titolo')}>
      <h3 id={fid('titolo')}>
        {kind === 'farmaco'
          ? 'Nuova ricetta di un farmaco fatta con un altro programma'
          : 'Nuova ricetta di una prestazione fatta con un altro programma'}
      </h3>
      <fieldset disabled={busy}>
        <legend className="visivamente-nascosto">Dati della ricetta</legend>
        <div className="campi-in-riga">
          {input('data', 'Data della ricetta', {
            type: 'date',
            required: true,
            max: today,
            stretto: true,
          })}
          {input('quantita', kind === 'farmaco' ? 'Confezioni' : 'Quantità', {
            type: 'number',
            min: 1,
            max: 99,
            step: 1,
            stretto: true,
          })}
        </div>
        {kind === 'farmaco' ? (
          <>
            <div className="campi-in-riga">
              {input('farmaco', 'Nome del farmaco', { maxLength: 300 })}
              {input('principioAttivo', 'Principio attivo', { maxLength: 300 })}
            </div>
            <div className="campi-in-riga">
              {input('aic', 'Codice AIC', {
                className: 'codice',
                inputMode: 'numeric',
                maxLength: 9,
                stretto: true,
                'aria-describedby': fid('aic-aiuto'),
              })}
              {input('atc', 'Codice ATC', { className: 'codice', maxLength: 10, stretto: true })}
              {input('posologia', 'Posologia', { maxLength: 500 })}
            </div>
            <p className="aiuto" id={fid('aic-aiuto')}>
              Serve almeno il nome, il principio attivo o il codice AIC (9 cifre). Con l’AIC valido
              oggi il farmaco si può usare come base per una terapia nuova.
            </p>
          </>
        ) : (
          <>
            <div className="campi-in-riga">
              {input('codice', 'Codice della prestazione', {
                className: 'codice',
                maxLength: 40,
                stretto: true,
              })}
              {input('descrizione', 'Descrizione', { maxLength: 500 })}
            </div>
            <p className="aiuto">Serve il codice o la descrizione.</p>
          </>
        )}
        <div className="campi-in-riga">
          {input('nre', 'NRE, se c’è', { className: 'codice', maxLength: 20, stretto: true })}
          {input('prescrittore', 'Prescritta da', { maxLength: 200 })}
          {input('programma', 'Programma con cui è stata fatta', { maxLength: 100 })}
        </div>
        <div className="campi-in-riga">{input('note', 'Note', { maxLength: 2000 })}</div>
        <div className="azioni">
          <button type="submit" className="pulsante pulsante-primario">
            <Icon name="fatto" /> <span>Registra la ricetta</span>
          </button>
        </div>
      </fieldset>
      <ErrorMessage error={error} />
      {done && (
        <Notice kind="fatto">
          Ricetta registrata, con il segno «fatta con un altro programma».
        </Notice>
      )}
    </form>
  );
}

/**
 * Riquadro delle ricette fatte con un altro programma, nei farmaci o nelle prestazioni
 * prescritti: l'elenco e, per il medico, la registrazione a mano. L'importazione le scrive nello
 * stesso posto.
 */
export function PastPrescriptionsSection({
  patientId,
  kind,
  items,
  canWrite,
  onChanged,
}: {
  patientId: string;
  kind: Kind;
  items: PastPrescription[];
  canWrite: boolean;
  onChanged: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const titleId = `titolo-ricette-passate-${kind}`;
  return (
    <section className="riquadro" aria-labelledby={titleId}>
      <h2 id={titleId}>
        <Icon name="archivio" />{' '}
        {kind === 'farmaco'
          ? 'Farmaci prescritti con un altro programma'
          : 'Visite ed esami prescritti con un altro programma'}
      </h2>
      <p className="aiuto">
        Ricette fatte prima, con un altro programma: restano nella cartella con il loro storico, ma
        non si firmano, non si inviano e non si ripetono. Se una è stata registrata per errore, si
        annulla con il motivo.
      </p>
      {canWrite && (
        <div className="azioni">
          <button
            type="button"
            className="pulsante"
            aria-expanded={adding}
            onClick={() => setAdding(!adding)}
          >
            <Icon name="aggiungi" /> <span>Registra una ricetta fatta con un altro programma</span>
          </button>
        </div>
      )}
      {canWrite && adding && (
        <PastPrescriptionForm patientId={patientId} kind={kind} onSaved={onChanged} />
      )}
      {items.length === 0 ? (
        <p className="tenue">Nessuna ricetta fatta con un altro programma.</p>
      ) : (
        <PastPrescriptionsList
          items={items}
          patientId={patientId}
          canWrite={canWrite}
          onChanged={onChanged}
          label={
            kind === 'farmaco'
              ? 'Ricette di farmaci fatte con un altro programma'
              : 'Ricette di visite ed esami fatte con un altro programma'
          }
        />
      )}
    </section>
  );
}
