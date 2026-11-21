import { useState } from 'react';
import { api, ApiError } from '../lib/api';
import { dateTime } from '../lib/format';
import { ErrorMessage, Notice } from './common';
import { Icon } from './Icon';

type Pending = { esito: 'non_arrivato' } | { esito: 'arrivato'; protocollo: string };

/**
 * Esito di un invio all'INPS rimasto senza risposta (D233): il servizio si è fermato mentre
 * aspettava l'INPS. Il medico chiede all'INPS se il certificato è arrivato e segna la risposta.
 * «Non è arrivato»: torna da inviare. «È arrivato»: con il protocollo dato dall'INPS. L'esito non
 * si cambia dopo, quindi si conferma prima di segnarlo (D239).
 */
export function InterruptedCertificatePanel({
  certificateId,
  signedAt,
  onChange,
}: {
  certificateId: string;
  signedAt: string | null;
  /** Dopo l'esito, con il messaggio da dire nella scheda del certificato. */
  onChange: (message: string) => void;
}) {
  const [protocol, setProtocol] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);

  async function settle(body: Pending) {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/certificati/${certificateId}/esito-invio`, { method: 'POST', body });
      onChange(
        body.esito === 'arrivato'
          ? `Certificato segnato come arrivato all’INPS, protocollo ${body.protocollo}.`
          : 'Certificato di nuovo da inviare: si può rimandare all’INPS.',
      );
    } catch (e) {
      setPending(null);
      setError(
        e instanceof ApiError
          ? e
          : new ApiError(
              0,
              'Il servizio non ha risposto: ricarica la pagina per vedere il certificato',
            ),
      );
    } finally {
      setBusy(false);
    }
  }

  const protocolId = `esito-protocollo-${certificateId}`;
  return (
    <div className="pannello-invio">
      <Notice kind="avviso">
        L’invio{signedAt ? ` del ${dateTime(signedAt)}` : ''} è rimasto senza risposta: il servizio
        si è fermato mentre aspettava l’INPS. Chiedi all’INPS se il certificato è arrivato, poi
        segna qui l’esito.
      </Notice>
      <ErrorMessage error={error} />
      {pending ? (
        // L'esito non si cambia dopo: si rilegge e si conferma (WCAG 3.3.4).
        <div className="conferma-esito" role="group" aria-label="Conferma dell’esito">
          <p>
            {pending.esito === 'non_arrivato' ? (
              <>
                Confermi che il certificato <strong>non è arrivato</strong> all’INPS? Torna da
                inviare: se in realtà fosse arrivato, rimandarlo farebbe un doppione.
              </>
            ) : (
              <>
                Confermi che il certificato è arrivato con il protocollo{' '}
                <strong className="codice">{pending.protocollo}</strong>? Un protocollo sbagliato
                non si corregge dopo.
              </>
            )}
          </p>
          <div className="azioni">
            <button
              type="button"
              className="pulsante pulsante-primario"
              disabled={busy}
              onClick={() => void settle(pending)}
            >
              <Icon name="fatto" /> <span>Sì, confermo</span>
            </button>
            <button
              type="button"
              className="pulsante"
              disabled={busy}
              onClick={() => setPending(null)}
            >
              <Icon name="annulla" /> <span>Torna indietro</span>
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="azioni">
            <button
              type="button"
              className="pulsante"
              disabled={busy}
              onClick={() => setPending({ esito: 'non_arrivato' })}
            >
              <Icon name="ripeti" /> <span>Non è arrivato: torna da inviare</span>
            </button>
          </div>
          <form
            aria-label="Il certificato è arrivato"
            onSubmit={(e) => {
              e.preventDefault();
              setError(null);
              setPending({ esito: 'arrivato', protocollo: protocol.trim() });
            }}
          >
            <div className="campo">
              <label htmlFor={protocolId}>Protocollo dato dall’INPS</label>
              <input
                id={protocolId}
                className="codice"
                value={protocol}
                onChange={(e) => setProtocol(e.target.value)}
                required
                autoComplete="off"
                aria-describedby={`${protocolId}-aiuto`}
              />
              <p className="aiuto" id={`${protocolId}-aiuto`}>
                Va sulla copia del lavoratore e sull’attestato; come data di ricezione vale l’ora
                dell’invio.
              </p>
            </div>
            <div className="azioni">
              <button type="submit" className="pulsante pulsante-primario" disabled={busy}>
                <Icon name="fatto" /> <span>È arrivato: segna come inviato</span>
              </button>
            </div>
          </form>
        </>
      )}
    </div>
  );
}
