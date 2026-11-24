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

interface Available {
  promemoria: boolean;
  soloNre: boolean;
  email: boolean;
  sms: boolean;
  motivo: string | null;
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
  stampa_promemoria: 'Promemoria su carta',
  stampa_nre: 'Foglio con l’NRE su carta',
  email: 'Email',
  sms: 'SMS',
};

const OUTCOME: Record<string, string> = {
  // Le stampe registrate all'apertura del PDF, prima dell'audit (D259).
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
 * registrata. Aprire il PDF non è una consegna (audit D259): quella su carta la segna chi ha dato
 * il foglio, con «Consegnato su carta».
 */
export function ReminderPanel({
  prescriptionId,
  patientId,
  kind,
  title,
}: {
  prescriptionId: string;
  patientId: string;
  kind: string;
  /** Il titolo del riquadro: in un elenco di ricette, con il paziente (D239). */
  title?: string;
}) {
  const contacts = useApi<Contacts>(`/api/pazienti/${patientId}/recapiti-promemoria`);
  const deliveries = useApi<{
    consegne: Delivery[];
    carta: 'A4' | 'A5' | null;
    /** Che cosa si può consegnare, con il motivo se manca qualcosa (D239). */
    disponibile?: Available;
  }>(`/api/ricette/${prescriptionId}/promemoria/consegne`);
  const [picked, setChannel] = useState<'email' | 'sms'>('email');
  // Finché il servizio non ha detto che cosa si può consegnare, niente pulsanti che falliscono.
  const can = deliveries.data?.disponibile ?? null;
  const channel: 'email' | 'sms' = can && !can.email ? 'sms' : picked;
  const [target, setTarget] = useState('paziente');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);
  // Il PDF aperto in questo riquadro: la sua consegna su carta si segna dopo averlo dato.
  const [opened, setOpened] = useState<'completo' | 'nre' | null>(null);
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

  async function markPaper(formato: 'completo' | 'nre') {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await api(`${base}/consegna-carta`, { method: 'POST', body: { formato } });
      setOpened(null);
      setDone(
        formato === 'nre'
          ? 'Consegna del foglio con l’NRE registrata.'
          : 'Consegna del promemoria su carta registrata.',
      );
      deliveries.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e : null);
    } finally {
      setBusy(false);
    }
  }

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
    <section className="pannello-promemoria" aria-label={title ?? 'Promemoria della ricetta'}>
      <h4>{title ?? 'Promemoria'}</h4>
      {can?.motivo && <Notice kind="avviso">{can.motivo}</Notice>}
      <div className="azioni">
        {can?.soloNre && nreFirst && (
          <a
            className={`pulsante${chosenVariant ? ' pulsante-primario' : ''}`}
            href={`${base}?formato=nre`}
            target="_blank"
            rel="noopener"
            aria-describedby={describedBy}
            onClick={() => setOpened('nre')}
          >
            <Icon name="stampa" /> <span>Solo NRE (PDF)</span>
          </a>
        )}
        {can?.promemoria && (
          <a
            className={`pulsante${chosenVariant && !nreFirst ? ' pulsante-primario' : ''}`}
            href={base}
            target="_blank"
            rel="noopener"
            aria-describedby={describedBy}
            onClick={() => setOpened('completo')}
          >
            <Icon name="stampa" />{' '}
            <span>{white ? 'Promemoria del SAC (PDF)' : 'Promemoria (PDF)'}</span>
          </a>
        )}
        {can?.soloNre && !white && !nreFirst && (
          <a
            className="pulsante"
            href={`${base}?formato=nre`}
            target="_blank"
            rel="noopener"
            aria-describedby={describedBy}
            onClick={() => setOpened('nre')}
          >
            <Icon name="stampa" /> <span>Solo NRE (PDF)</span>
          </a>
        )}
      </div>
      {opened && (
        <div className="consegna-carta" role="group" aria-label="Consegna su carta">
          <p>
            Aprire il PDF non è una consegna. Quando hai stampato{' '}
            {opened === 'nre' ? 'il foglio con l’NRE' : 'il promemoria'} e l’hai dato al paziente o
            al delegato, segnalo qui.
          </p>
          <button
            type="button"
            className="pulsante"
            disabled={busy}
            onClick={() => void markPaper(opened)}
          >
            <Icon name="fatto" /> <span>Consegnato su carta</span>
          </button>
        </div>
      )}
      <PrintHint kind={white ? 'promemoria_bianca' : 'promemoria'} id={hintId} />
      {!white && (
        // Mezzo foglio A4 (D217): A5 per difetto, A4 se scelto in Strumenti › Stampa (D222). La
        // carta la dice il servizio: un promemoria del modello di prima esce sempre su A4 (D232).
        <p className="aiuto">
          {deliveries.data?.carta === 'A4'
            ? 'Carta A4, con il promemoria nella metà alta. '
            : deliveries.data?.carta === 'A5'
              ? 'Carta A5 orizzontale. '
              : ''}
          Stampa al 100% («dimensioni effettive»), senza adattare alla pagina: i codici a barre
          restano delle misure delle specifiche.
        </p>
      )}
      {white && (
        <p className="aiuto">
          Per la ricetta bianca vale solo il promemoria prodotto dal SAC: il programma lo consegna
          così com’è.
        </p>
      )}

      {(can?.email || can?.sms) && (
        <fieldset className="invio-promemoria" disabled={busy}>
          <legend>Invia al paziente o a un delegato</legend>
          <div className="scelta-in-riga">
            {(
              [
                ['email', 'Email con il promemoria'],
                ['sms', 'SMS con il numero'],
              ] as const
            )
              .filter(([v]) => can[v])
              .map(([v, label]) => (
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
      )}
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
