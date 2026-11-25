import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { dateTime } from '../lib/format';
import { normalizePrescriptionNumber, nrbeProblem, nreProblem } from '../lib/prescription-numbers';
import { ConfirmQuestion, ErrorMessage, Notice } from './common';
import { Icon } from './Icon';
import { RedFormPrint, RedPrintedNotice, type RedPrinted } from './RedFormPrint';

interface SettleOutcome {
  stato: 'sent' | 'error';
  nre: string | null;
  messaggio: string | null;
}

export interface InterruptedSendPanelProps {
  prescriptionId: string;
  /**
   * Tipo di ricetta: la bianca va al Sistema TS, con NRBE e PIN (D239); la SSN vuole anche il
   * codice di autenticazione (D240).
   */
  kind?: string;
  /** Quando era partito l'invio rimasto senza risposta, e chi l'aveva firmato. */
  signedAt: string;
  signedBy: string | null;
  /** Da quando l'esito si può segnare: prima l'invio potrebbe essere ancora in corso (D239). */
  settleFrom?: string | null;
  /**
   * Il codice fiscale mandato con la ricetta: per la bianca l'NRBE comincia con la sua lettera di
   * controllo (D259).
   */
  fiscalCode?: string | null;
  /**
   * Ricetta SSN farmaceutica o specialistica al SAR: come vuole la Regione, senza esito si stampa
   * la ricetta rossa, che parte poi in DPCM; la dematerializzata si annulla da sé (V06, 4.3.1;
   * D270).
   */
  redForm?: boolean;
  /** Dopo l'esito: le code si ricaricano. Con la ricetta rossa resta in vista il PDF (D270). */
  onChange?: (status: 'sent' | 'error' | 'paper', nre: string | null) => void;
}

type Pending =
  | { esito: 'non_arrivata' }
  | { esito: 'arrivata'; nre: string; codiceAutenticazione?: string; pin?: string };

/**
 * Esito di un invio rimasto senza risposta (D233): il servizio si è fermato mentre aspettava
 * l'ente. Il medico chiede all'ente se la ricetta è arrivata e segna la risposta. «Non è arrivata»:
 * la ricetta torna da inviare. «È arrivata»: con il numero e, per la SSN, il codice di
 * autenticazione, senza il quale la ricetta non è valida (D240); per la bianca NRBE e PIN. L'esito
 * non si cambia dopo, quindi si conferma prima di segnarlo (D239).
 */
export function InterruptedSendPanel({
  prescriptionId,
  kind,
  signedAt,
  signedBy,
  settleFrom,
  fiscalCode,
  redForm,
  onChange,
}: InterruptedSendPanelProps) {
  const white = kind === 'white';
  // Farmaceutica e specialistica SSN: senza il codice di autenticazione la ricetta non è valida,
  // come nell'invio (D240). Per i presidi il codice resta facoltativo, come nell'invio.
  const ssn = kind === 'pharma_ssn' || kind === 'specialist_ssn';
  const [nre, setNre] = useState('');
  const [authCode, setAuthCode] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<SettleOutcome | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  /** Ricetta rossa in DPCM: modulo aperto ed esito della stampa (D270). */
  const [redOpen, setRedOpen] = useState(false);
  const [red, setRed] = useState<RedPrinted | null>(null);
  const result = useRef<HTMLDivElement>(null);
  // Nei primi 15 minuti l'esito non si segna: il pannello lo dice e si apre da solo all'ora giusta.
  const from = settleFrom ? Date.parse(settleFrom) : null;
  const [waiting, setWaiting] = useState(from !== null && Date.now() < from);
  useEffect(() => {
    if (!waiting || from === null) return;
    const timer = setTimeout(() => setWaiting(false), Math.max(0, from - Date.now()) + 500);
    return () => clearTimeout(timer);
  }, [waiting, from]);
  // Dopo l'esito il fuoco va al risultato: il pulsante premuto non c'è più (WCAG 2.4.3).
  useEffect(() => {
    if (done || red) result.current?.focus();
  }, [done, red]);

  async function settle(body: Pending) {
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
      setPending(null);
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

  if (red)
    return (
      <div ref={result} tabIndex={-1} className="esito-segnato">
        <RedPrintedNotice red={red} />
      </div>
    );
  if (done)
    return (
      <div ref={result} tabIndex={-1} className="esito-segnato">
        {done.stato === 'sent' ? (
          <>
            <Notice kind="fatto">
              Ricetta segnata come arrivata. {white ? 'NRBE' : 'NRE'}{' '}
              <span className="codice">{done.nre}</span>
            </Notice>
            {done.messaggio && <Notice kind="avviso">{done.messaggio}</Notice>}
          </>
        ) : (
          <Notice kind="fatto">Ricetta di nuovo da inviare: è fra gli invii non riusciti.</Notice>
        )}
      </div>
    );

  const ente = white ? 'il Sistema TS' : 'il SAR';
  if (waiting && from !== null)
    return (
      <div className="pannello-invio">
        <Notice kind="info">
          Invio del {dateTime(signedAt)}
          {signedBy ? `, firmato da ${signedBy},` : ''} in corso: si aspetta la risposta di {ente}.
          Se non arriva, l’esito si segna qui dalle {dateTime(new Date(from).toISOString())}.
          Intanto la ricetta non va rifatta.
        </Notice>
      </div>
    );

  const nreId = `esito-nre-${prescriptionId}`;
  const codeId = `esito-codice-${prescriptionId}`;
  const pinId = `esito-pin-${prescriptionId}`;
  const number = white ? 'NRBE' : 'NRE';
  return (
    <div className="pannello-invio">
      {redForm ? (
        <Notice kind="avviso">
          L’invio del {dateTime(signedAt)}
          {signedBy ? `, firmato da ${signedBy},` : ''} è rimasto senza risposta: il servizio si è
          fermato mentre aspettava {ente}. Come vuole la Regione, si stampa la ricetta rossa, che
          parte poi in DPCM; la ricetta dematerializzata, se era arrivata, si annulla da sola (V06,
          4.3.1). Se l’ente ti ha già dato numero e codice di autenticazione, segna invece che è
          arrivata.
        </Notice>
      ) : (
        <Notice kind="avviso">
          L’invio del {dateTime(signedAt)}
          {signedBy ? `, firmato da ${signedBy},` : ''} è rimasto senza risposta: il servizio si è
          fermato mentre aspettava {ente}. Chiedi all’ente se la ricetta è arrivata, poi segna qui
          l’esito.
        </Notice>
      )}
      <ErrorMessage error={error} focus />
      {redOpen ? (
        <RedFormPrint
          prescriptionId={prescriptionId}
          onPrinted={(r) => {
            setRed(r);
            onChange?.('paper', null);
          }}
          onCancel={() => setRedOpen(false)}
        />
      ) : pending ? (
        // L'esito non si cambia dopo: si rilegge e si conferma (WCAG 3.3.4).
        <ConfirmQuestion
          label="Conferma dell’esito"
          yes="Sì, confermo"
          busy={busy}
          onYes={() => void settle(pending)}
          onBack={() => setPending(null)}
        >
          {pending.esito === 'non_arrivata' ? (
            <>
              Confermi che la ricetta <strong>non è arrivata</strong>? Torna da inviare: se in
              realtà fosse arrivata, rimandarla farebbe un doppione.
            </>
          ) : (
            <>
              Confermi che la ricetta è arrivata con {number}{' '}
              <strong className="codice">{pending.nre}</strong>
              {pending.pin ? (
                <>
                  {' '}
                  e PIN <strong className="codice">{pending.pin}</strong>
                </>
              ) : pending.codiceAutenticazione ? (
                <>
                  {' '}
                  e codice di autenticazione{' '}
                  <strong className="codice">{pending.codiceAutenticazione}</strong>
                </>
              ) : (
                ', senza il codice di autenticazione'
              )}
              ? Un numero sbagliato non si corregge dopo.
            </>
          )}
        </ConfirmQuestion>
      ) : (
        <>
          <div className="azioni">
            {redForm ? (
              // Senza esito la dematerializzata non si rimanda: «Non è arrivata» non serve (D270).
              <button
                type="button"
                className="pulsante pulsante-primario"
                disabled={busy}
                onClick={() => setRedOpen(true)}
              >
                <Icon name="stampa" /> <span>Stampa la ricetta rossa</span>
              </button>
            ) : (
              <button
                type="button"
                className="pulsante"
                disabled={busy}
                onClick={() => setPending({ esito: 'non_arrivata' })}
              >
                <Icon name="ripeti" /> <span>Non è arrivata: torna da inviare</span>
              </button>
            )}
          </div>
          <form
            className="esito-arrivata"
            aria-label="La ricetta è arrivata"
            onSubmit={(e) => {
              e.preventDefault();
              // La forma del numero, prima della conferma (audit D259): NRE di 15 caratteri, NRBE
              // di 12, come nelle specifiche del Sistema TS. Il servizio la controlla di nuovo.
              const number = normalizePrescriptionNumber(nre);
              const shape = white ? nrbeProblem(number, fiscalCode) : nreProblem(number);
              if (shape) {
                setError(new ApiError(400, shape));
                return;
              }
              // Un codice di soli spazi non è un codice: lo si dice qui, prima della conferma.
              if (ssn && !authCode.trim()) {
                setError(
                  new ApiError(
                    400,
                    `Senza il codice di autenticazione la ricetta SSN non è valida: chiedi all’ente il numero e il codice. Se l’ente non li dà, ${redForm ? 'stampa la ricetta rossa' : 'segna «Non è arrivata»'}.`,
                  ),
                );
                return;
              }
              setError(null);
              setPending({
                esito: 'arrivata',
                nre: number,
                ...(white
                  ? { pin: pin.trim() }
                  : authCode.trim()
                    ? { codiceAutenticazione: authCode.trim() }
                    : {}),
              });
            }}
          >
            <div className="campo">
              <label htmlFor={nreId}>
                {white
                  ? 'Numero di ricetta bianca (NRBE) dato dal Sistema TS'
                  : 'Numero di ricetta (NRE) dato dall’ente'}
              </label>
              <input
                id={nreId}
                className="codice"
                value={nre}
                // In maiuscolo, come lo vuole il codice a barre del promemoria (D239).
                onChange={(e) => setNre(e.target.value.toUpperCase())}
                required
                aria-describedby={`${nreId}-aiuto`}
                autoComplete="off"
                spellCheck={false}
              />
              <p className="aiuto" id={`${nreId}-aiuto`}>
                {white
                  ? '12 caratteri: una lettera, una lettera o una cifra, poi 10 cifre.'
                  : '15 caratteri: 5 lettere o cifre, una cifra da 0 a 7, poi 9 cifre.'}
              </p>
            </div>
            {white ? (
              <div className="campo">
                <label htmlFor={pinId}>PIN della ricetta bianca</label>
                <input
                  id={pinId}
                  className="codice"
                  value={pin}
                  onChange={(e) => setPin(e.target.value)}
                  required
                  aria-describedby={`${pinId}-aiuto`}
                  autoComplete="off"
                />
                <p className="aiuto" id={`${pinId}-aiuto`}>
                  Con NRBE e PIN il paziente ritira il farmaco: si dettano o si mandano per SMS.
                </p>
              </div>
            ) : (
              <div className="campo">
                <label htmlFor={codeId}>
                  {ssn
                    ? 'Codice di autenticazione dato dall’ente'
                    : 'Codice di autenticazione (facoltativo)'}
                </label>
                <input
                  id={codeId}
                  className="codice"
                  value={authCode}
                  onChange={(e) => setAuthCode(e.target.value)}
                  required={ssn}
                  aria-describedby={`${codeId}-aiuto`}
                  autoComplete="off"
                />
                <p className="aiuto" id={`${codeId}-aiuto`}>
                  {ssn
                    ? `Senza il codice la ricetta SSN non è valida e il promemoria non si stampa. Se l’ente non dà il codice, ${redForm ? 'stampa la ricetta rossa' : 'segna «Non è arrivata»'}.`
                    : 'Se l’ente lo dà, resta con la ricetta.'}
                </p>
              </div>
            )}
            <div className="azioni">
              <button
                type="submit"
                className={redForm ? 'pulsante' : 'pulsante pulsante-primario'}
                disabled={busy}
              >
                <Icon name="fatto" /> <span>È arrivata: segna come inviata</span>
              </button>
            </div>
          </form>
        </>
      )}
    </div>
  );
}
