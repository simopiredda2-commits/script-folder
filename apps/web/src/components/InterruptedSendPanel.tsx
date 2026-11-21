import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { dateTime } from '../lib/format';
import { ErrorMessage, Notice } from './common';
import { Icon } from './Icon';

interface SettleOutcome {
  stato: 'sent' | 'error';
  nre: string | null;
  messaggio: string | null;
}

export interface InterruptedSendPanelProps {
  prescriptionId: string;
  /** Quando era partito l'invio rimasto senza risposta, e chi l'aveva firmato. */
  signedAt: string;
  signedBy: string | null;
  /** Dopo l'esito: la coda si ricarica. */
  onChange?: (status: 'sent' | 'error', nre: string | null) => void;
}

/**
 * Esito di un invio rimasto senza risposta (D233): il servizio si è fermato mentre aspettava il
 * SAR. Il medico chiede all'ente se la ricetta è arrivata e segna la risposta. «Non è arrivata»:
 * la ricetta torna da inviare. «È arrivata»: con l'NRE e, se l'ente lo dà, il codice di
 * autenticazione, che serve al promemoria.
 */
export function InterruptedSendPanel({
  prescriptionId,
  signedAt,
  signedBy,
  onChange,
}: InterruptedSendPanelProps) {
  const [nre, setNre] = useState('');
  const [authCode, setAuthCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<SettleOutcome | null>(null);

  async function settle(body: object) {
    setBusy(true);
    setError(null);
    try {
      const r = await api<SettleOutcome>(`/api/ricette/${prescriptionId}/esito-invio`, {
        method: 'POST',
        body,
      });
      setDone(r);
      onChange?.(r.stato, r.nre);
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e
          : new ApiError(
              0,
              'Il servizio non ha risposto: ricarica la pagina per vedere la ricetta',
            ),
      );
    } finally {
      setBusy(false);
    }
  }

  if (done)
    return done.stato === 'sent' ? (
      <>
        <Notice kind="fatto">
          Ricetta segnata come arrivata. NRE <span className="codice">{done.nre}</span>
        </Notice>
        {done.messaggio && <Notice kind="avviso">{done.messaggio}</Notice>}
      </>
    ) : (
      <Notice kind="fatto">Ricetta di nuovo da inviare: è fra gli invii non riusciti.</Notice>
    );

  const nreId = `esito-nre-${prescriptionId}`;
  const codeId = `esito-codice-${prescriptionId}`;
  return (
    <div className="pannello-invio">
      <Notice kind="avviso">
        L’invio del {dateTime(signedAt)}
        {signedBy ? `, firmato da ${signedBy},` : ''} è rimasto senza risposta: il servizio si è
        fermato mentre aspettava il SAR. Chiedi all’ente se la ricetta è arrivata, poi segna qui
        l’esito.
      </Notice>
      <ErrorMessage error={error} />
      <div className="azioni">
        <button
          type="button"
          className="pulsante"
          disabled={busy}
          onClick={() => void settle({ esito: 'non_arrivata' })}
        >
          <Icon name="ripeti" /> <span>Non è arrivata: torna da inviare</span>
        </button>
      </div>
      <form
        className="esito-arrivata"
        aria-label="La ricetta è arrivata"
        onSubmit={(e) => {
          e.preventDefault();
          void settle({
            esito: 'arrivata',
            nre: nre.trim(),
            ...(authCode.trim() ? { codiceAutenticazione: authCode.trim() } : {}),
          });
        }}
      >
        <div className="campo">
          <label htmlFor={nreId}>Numero di ricetta (NRE) dato dall’ente</label>
          <input
            id={nreId}
            className="codice"
            value={nre}
            onChange={(e) => setNre(e.target.value)}
            required
            autoComplete="off"
          />
        </div>
        <div className="campo">
          <label htmlFor={codeId}>Codice di autenticazione (facoltativo)</label>
          <input
            id={codeId}
            className="codice"
            value={authCode}
            onChange={(e) => setAuthCode(e.target.value)}
            aria-describedby={`${codeId}-aiuto`}
            autoComplete="off"
          />
          <p className="aiuto" id={`${codeId}-aiuto`}>
            Serve per stampare il promemoria; senza, il promemoria non si stampa e al paziente
            bastano il numero di ricetta e il codice fiscale.
          </p>
        </div>
        <div className="azioni">
          <button type="submit" className="pulsante pulsante-primario" disabled={busy}>
            <Icon name="fatto" /> <span>È arrivata: segna come inviata</span>
          </button>
        </div>
      </form>
    </div>
  );
}
