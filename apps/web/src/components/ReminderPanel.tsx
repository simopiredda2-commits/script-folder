import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { dateTime } from '../lib/format';
import { useApi } from '../lib/useApi';
import { ErrorMessage, Notice } from './common';
import { Icon } from './Icon';
import { PrintHint, usePrintPreference } from './PrintHint';

interface Contacts {
  paziente: { email: string | null; telefono: string | null };
  deleghe: {
    id: string;
    nome: string;
    email: string | null;
    telefono: string | null;
    valida: boolean;
  }[];
}

interface Delivery {
  il: string;
  canale: string;
  destinatario: string | null;
  recapito: string | null;
  esito: string;
  errore: string | null;
  da: string;
}

const CHANNEL: Record<string, string> = {
  stampa_promemoria: 'Promemoria stampato',
  stampa_nre: 'Foglio con l’NRE stampato',
  email: 'Email',
  sms: 'SMS',
};

const OUTCOME: Record<string, string> = {
  stampato: 'stampato',
  consegnato: 'consegnato',
  rifiutato: 'rifiutato',
  non_raggiungibile: 'servizio non raggiungibile',
};

/**
 * Promemoria di una ricetta inviata (tappa 7). Ricetta SSN: promemoria completo o solo NRE, dai
 * dati fissati all'invio; per primo quello delle preferenze di stampa della postazione (tappa 14),
 * con il suggerimento di stampante e copie. Ricetta bianca: solo il PDF prodotto dal SAC. Email e
 * SMS solo a un recapito del paziente o di un delegato con delega valida (R16); ogni consegna è
 * registrata.
 */
export function ReminderPanel({
  prescriptionId,
  patientId,
  kind,
}: {
  prescriptionId: string;
  patientId: string;
  kind: string;
}) {
  const contacts = useApi<Contacts>(`/api/pazienti/${patientId}/recapiti-promemoria`);
  const deliveries = useApi<{ consegne: Delivery[] }>(
    `/api/ricette/${prescriptionId}/promemoria/consegne`,
  );
  const [channel, setChannel] = useState<'email' | 'sms'>('email');
  const [target, setTarget] = useState('paziente');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const white = kind === 'white';
  const base = `/api/ricette/${prescriptionId}/promemoria`;
  const field = channel === 'email' ? 'email' : 'telefono';
  // Preferenze di stampa (tappa 14): la variante preferita va per prima, in evidenza se è stata
  // scelta; senza preferenza i pulsanti restano come sempre.
  const printing = usePrintPreference(white ? 'promemoria_bianca' : 'promemoria');
  const nreFirst = !white && printing?.variante === 'solo_nre';
  const chosenVariant = !white && printing !== null && printing.da.variante !== 'predefinito';
  const hintId = `stampa-promemoria-${prescriptionId}`;
  const describedBy = printing?.suggerimento ? hintId : undefined;

  // Le scelte possibili: il paziente e le deleghe valide oggi, con il recapito del canale.
  const options = contacts.data
    ? [
        ...(contacts.data.paziente[field]
          ? [{ value: 'paziente', label: `Il paziente – ${contacts.data.paziente[field]}` }]
          : []),
        ...contacts.data.deleghe
          .filter((d) => d.valida && d[field])
          .map((d) => ({ value: d.id, label: `Delegato: ${d.nome} – ${d[field]}` })),
      ]
    : [];
  const chosen = options.some((o) => o.value === target) ? target : (options[0]?.value ?? '');

  async function send() {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const r = await api<{ recapito: string }>(`${base}/invio`, {
        method: 'POST',
        body: {
          canale: channel,
          destinatario: chosen === 'paziente' ? 'paziente' : 'delegato',
          ...(chosen === 'paziente' ? {} : { delega: chosen }),
        },
      });
      setDone(
        channel === 'email'
          ? `Promemoria inviato per email a ${r.recapito}.`
          : `SMS con il numero di ricetta inviato a ${r.recapito}.`,
      );
      deliveries.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e : null);
      deliveries.reload();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="pannello-promemoria" aria-label="Promemoria della ricetta">
      <h4>Promemoria</h4>
      <div className="azioni">
        {nreFirst && (
          <a
            className={`pulsante${chosenVariant ? ' pulsante-primario' : ''}`}
            href={`${base}?formato=nre`}
            target="_blank"
            rel="noopener"
            aria-describedby={describedBy}
            onClick={() => setTimeout(deliveries.reload, 800)}
          >
            <Icon name="stampa" /> <span>Solo NRE (PDF)</span>
          </a>
        )}
        <a
          className={`pulsante${chosenVariant && !nreFirst ? ' pulsante-primario' : ''}`}
          href={base}
          target="_blank"
          rel="noopener"
          aria-describedby={describedBy}
          onClick={() => setTimeout(deliveries.reload, 800)}
        >
          <Icon name="stampa" />{' '}
          <span>{white ? 'Promemoria del SAC (PDF)' : 'Promemoria (PDF)'}</span>
        </a>
        {!white && !nreFirst && (
          <a
            className="pulsante"
            href={`${base}?formato=nre`}
            target="_blank"
            rel="noopener"
            aria-describedby={describedBy}
            onClick={() => setTimeout(deliveries.reload, 800)}
          >
            <Icon name="stampa" /> <span>Solo NRE (PDF)</span>
          </a>
        )}
      </div>
      <PrintHint kind={white ? 'promemoria_bianca' : 'promemoria'} id={hintId} />
      {white && (
        <p className="aiuto">
          Per la ricetta bianca vale solo il promemoria prodotto dal SAC: il programma lo consegna
          così com’è.
        </p>
      )}

      <fieldset className="invio-promemoria" disabled={busy}>
        <legend>Invia al paziente o a un delegato</legend>
        <div className="scelta-in-riga">
          {(
            [
              ['email', 'Email con il promemoria'],
              ['sms', 'SMS con il numero'],
            ] as const
          ).map(([v, label]) => (
            <div key={v} className="casella">
              <input
                type="radio"
                id={`canale-${prescriptionId}-${v}`}
                name={`canale-${prescriptionId}`}
                checked={channel === v}
                onChange={() => setChannel(v)}
              />
              <label htmlFor={`canale-${prescriptionId}-${v}`}>{label}</label>
            </div>
          ))}
        </div>
        {contacts.data && options.length === 0 ? (
          <p className="tenue">
            Nessun recapito {channel === 'email' ? 'email' : 'telefonico'} del paziente o di un
            delegato con delega valida.
          </p>
        ) : (
          <div className="campo">
            <label htmlFor={`destinatario-${prescriptionId}`}>Destinatario</label>
            <select
              id={`destinatario-${prescriptionId}`}
              value={chosen}
              onChange={(e) => setTarget(e.target.value)}
            >
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        )}
        <button
          type="button"
          className="pulsante pulsante-primario"
          disabled={!chosen}
          onClick={() => void send()}
        >
          <Icon name="apri" /> <span>Invia</span>
        </button>
      </fieldset>
      <ErrorMessage error={error ?? contacts.error} />
      {done && <Notice kind="fatto">{done}</Notice>}

      {deliveries.data && deliveries.data.consegne.length > 0 && (
        <details className="consegne">
          <summary>Consegne ({deliveries.data.consegne.length})</summary>
          <ul className="elenco-semplice">
            {deliveries.data.consegne.map((d, i) => (
              <li key={`${d.il}-${i}`}>
                {dateTime(d.il)} · {CHANNEL[d.canale] ?? d.canale}
                {d.recapito ? ` a ${d.recapito}` : ''} · {OUTCOME[d.esito] ?? d.esito}
                <span className="tenue"> · {d.da}</span>
                {d.errore && <span className="tenue"> · {d.errore}</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
