import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api, ApiError } from '../lib/api';
import { CREDENTIALS_PATH } from '../lib/credentials';
import { sentence } from '../lib/format';
import { useSession } from '../lib/session';
import { ErrorMessage, IssueList, Notice, ResultNotice, type RuleIssue } from './common';
import { Icon } from './Icon';
import { RedFormPrint, RedPrintedNotice, type RedPrinted } from './RedFormPrint';
import { capitalized, useRegionalService } from '../lib/regional-service';

interface CheckResult {
  versioneRegole: string | null;
  problemi: RuleIssue[];
  bloccanti: number;
}

type SendOutcome =
  /** Con il messaggio quando il promemoria non si è potuto fissare (D232). */
  (
    | { esito: 'accepted'; nre: string; messaggio: string | null }
    | { esito: 'rejected' | 'unreachable' | 'timeout' | 'auth'; nre: null; messaggio: string }
  ) & {
    /** Il lotto successivo di numeri di ricetta non è arrivato, ma ne restano (D269). */
    avviso?: string | null;
  };

export interface SendPanelProps {
  prescriptionId: string;
  status: string;
  /**
   * Il motivo dell'ultimo invio non riuscito: con l'ente che non risponde la ricetta rossa si può
   * stampare anche riaprendo la pagina, non solo subito dopo l'invio (D239).
   */
  lastErrorKind?: string | null;
  /** Nomi delle righe, per le conferme delle note AIFA. */
  lineNames: Record<string, string>;
  /** Ricetta SSN: prima della firma si vede l'anteprima del promemoria (D253). */
  preview?: boolean;
  /**
   * Ricetta SSN farmaceutica o specialistica, dove la regione vuole la ricetta rossa in DPCM:
   * senza esito non si rimanda, si stampa la ricetta rossa sul modulo del Poligrafico, che parte
   * poi in DPCM (D270, D300).
   */
  redForm?: boolean;
  /**
   * Ricetta del medico in un passo (D255): finito il controllo, se non ha nulla da dire, si firma e
   * si invia da sé; altrimenti ci si ferma sui controlli e si firma da qui.
   */
  autoSign?: boolean;
  /**
   * Nuovo stato della ricetta dopo un'azione, con l'NRE se è stata inviata e la ricetta rossa se è
   * stata stampata: la pagina che la toglie dalla coda tiene in vista il PDF (D270).
   */
  onChange?: (status: string, nre?: string, red?: RedPrinted) => void;
  /** Torna a modificare la ricetta, dove si può (l'editor): «Modifica la ricetta» (D259). */
  onEdit?: () => void;
  /**
   * Arrivato dopo un'azione nell'editor («Salva in bozza», «Firma e invia»): il pulsante premuto
   * non c'è più e il fuoco va ai controlli; se il passo unico si ferma, all'arresto (WCAG 2.4.3,
   * audit D259). Nella coda «da firmare» no: lì i pannelli sono tanti e nessuno ha premuto nulla.
   */
  focusOnArrival?: boolean;
}

/**
 * Controlli prima dell'invio, conferme e motivi, poi firma e invio (medico) o passaggio alla
 * firma (segreteria). Le regole decidono; qui si raccoglie solo ciò che chiedono. Si firma, o si
 * manda alla firma, a controllo finito: chi firma vede sempre i controlli prima (D230). Se il
 * controllo non riesce si può andare avanti: il servizio controlla di nuovo all'invio.
 */
/** Un errore senza risposta del servizio (rete, pagina d'errore del proxy), detto a parole (D239). */
const failure = (e: unknown, message: string) =>
  e instanceof ApiError ? e : new ApiError(0, message);

/**
 * L'informazione R1 sulla validità (30 giorni; per la specialistica 60 o 180 secondo il tipo di
 * accesso, D260) accompagna ogni ricetta SSN e non chiede nulla al medico: non ferma il passo unico
 * (D255). Ogni altro problema, anche solo informativo, lo ferma.
 */
const routine = (p: RuleIssue) => p.ruleId === 'R1' && p.severity === 'info';
const toLookAt = (c: CheckResult) => c.problemi.filter((p) => !routine(p));

/**
 * I blocchi che la firma non supera (audit, D259): una regola che blocca si corregge nella ricetta.
 * La nota AIFA (R7) no: si conferma qui, con la casella.
 */
export const hardBlocks = (c: CheckResult | null) =>
  (c?.problemi ?? []).filter((p) => p.severity === 'block' && p.needs !== 'aifa_confirmation');

export function SendPanel({
  prescriptionId,
  status,
  lastErrorKind,
  lineNames,
  preview,
  redForm,
  autoSign,
  onChange,
  onEdit,
  focusOnArrival,
}: SendPanelProps) {
  const service = useRegionalService();
  const { isDoctor } = useSession();
  const heading = useRef<HTMLHeadingElement>(null);
  const arrival = useRef(focusOnArrival);
  useEffect(() => {
    if (arrival.current) heading.current?.focus();
  }, []);
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [reasons, setReasons] = useState<Record<string, string>>({});
  /** Le decisioni del medico sulle proposte della segreteria, per riga (D283). */
  const [decisions, setDecisions] = useState<Record<string, 'conferma' | 'non_applicare'>>({});
  const [error, setError] = useState<ApiError | null>(null);
  const [outcome, setOutcome] = useState<SendOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [paper, setPaper] = useState<string | null>(null);
  /** Ricetta rossa in DPCM: modulo aperto ed esito della stampa (D270). */
  const [redOpen, setRedOpen] = useState(false);
  const [red, setRed] = useState<RedPrinted | null>(null);
  // Il controllo parte da sé per le ricette che si possono ancora firmare (effetto qui sotto).
  const checkable = status === 'draft' || status === 'to_sign' || status === 'error';
  const [checking, setChecking] = useState(checkable);

  const body = { confermeNote: [...confirmed], motivi: reasons, proposte: decisions };
  // Il controllo legge le conferme e i motivi del momento, senza ripartire a ogni tasto.
  const latest = useRef(body);
  latest.current = body;
  const runCheck = useCallback(async () => {
    setChecking(true);
    try {
      setCheck(
        await api<CheckResult>(`/api/ricette/${prescriptionId}/controlla`, {
          method: 'POST',
          body: latest.current,
        }),
      );
      // Il controllo è riuscito: l'errore di prima non vale più (D239).
      setError(null);
    } catch (e) {
      // Anche senza risposta del servizio (rete, pagina d'errore del proxy) lo si dice: chi firma
      // sa che i controlli non li ha visti (D230, D232).
      setError(
        failure(e, 'Controllo non riuscito: il servizio non ha risposto. Controlla di nuovo'),
      );
    } finally {
      setChecking(false);
    }
  }, [prescriptionId]);

  useEffect(() => {
    if (checkable) void runCheck();
  }, [checkable, runCheck]);

  // In un passo (D255): un tentativo solo, al primo controllo finito, riuscito o no. Si firma solo
  // se è riuscito senza problemi; «Controlla di nuovo» poi non firma da sé.
  // Chi firma vede sempre i controlli prima (D230): con un problema qualsiasi, anche solo
  // informativo, ci si ferma e si firma con il pulsante; tranne la validità della R1 (routine).
  const signNow = useRef<() => Promise<void>>(async () => {});
  const autoTried = useRef(false);
  useEffect(() => {
    if (!autoSign || !isDoctor || autoTried.current || checking || (!check && !error)) return;
    autoTried.current = true;
    if (check && toLookAt(check).length === 0 && !error) void signNow.current();
  }, [autoSign, isDoctor, checking, check, error]);
  const stopped = !!autoSign && isDoctor && !!check && toLookAt(check).length > 0;
  // Con un blocco non si firma: si dice che cosa correggere, e dove (D259).
  const blocked = [...new Set(hardBlocks(check).map((p) => p.ruleId))];
  // Fermato il passo unico, l'arresto prende il fuoco: il pulsante premuto non c'è più (D259).
  const Stop = autoSign ? ResultNotice : Notice;

  // L'ente non ha risposto: all'invio appena fatto, o all'ultimo invio della ricetta (D239).
  const unreachable = outcome
    ? outcome.esito === 'unreachable'
    : status === 'error' && lastErrorKind === 'unreachable';
  // Nessun esito, nemmeno incerto: dove la regione lo vuole si passa alla ricetta rossa (D270).
  const noOutcome = outcome
    ? outcome.esito === 'unreachable' || outcome.esito === 'timeout'
    : status === 'error' && (lastErrorKind === 'unreachable' || lastErrorKind === 'timeout');
  const toRedForm = !!redForm && noOutcome;
  const aifa = (check?.problemi ?? []).filter((p) => p.needs === 'aifa_confirmation' && p.lineId);
  // Le proposte della segreteria sul tipo di terapia: il medico le conferma o no (D283). Una
  // proposta decisa qui resta con la sua scelta anche dopo «Controlla di nuovo», che la dice già
  // decisa: il medico può cambiare idea fino alla firma.
  const proposals = (check?.problemi ?? []).filter(
    (p) =>
      p.ruleId === 'PROPOSTA' &&
      !!p.lineId &&
      (p.needs === 'therapy_decision' || decisions[p.lineId] !== undefined),
  );
  const undecided = proposals.filter((p) => !decisions[p.lineId!]).length;
  const warns = [
    ...new Set(
      (check?.problemi ?? [])
        .filter((p) => p.severity === 'warn' && p.needs !== 'therapy_decision')
        .map((p) => p.ruleId),
    ),
  ];

  async function sign() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<SendOutcome>(`/api/ricette/${prescriptionId}/firma-e-invia`, {
        method: 'POST',
        body,
      });
      setOutcome(r);
      if (r.esito === 'accepted') onChange?.('sent', r.nre);
      else onChange?.('error');
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) {
        const d = e.details as { problemi?: RuleIssue[]; versioneRegole?: string } | undefined;
        setCheck({
          versioneRegole: d?.versioneRegole ?? null,
          problemi: d?.problemi ?? [],
          bloccanti: 1,
        });
      }
      setError(
        failure(
          e,
          'Il servizio non ha risposto: non si sa se la ricetta è partita. Ricarica la pagina per vederne lo stato',
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  signNow.current = sign;

  async function toSign() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/ricette/${prescriptionId}/da-firmare`, { method: 'POST', body: {} });
      onChange?.('to_sign');
    } catch (e) {
      setError(
        failure(
          e,
          'Il servizio non ha risposto: ricarica la pagina per vedere se la ricetta è nella coda del medico',
        ),
      );
    } finally {
      setBusy(false);
    }
  }

  async function printPaper() {
    try {
      const r = await api<{ avviso: string }>(`/api/ricette/${prescriptionId}/ricetta-rossa`, {
        method: 'POST',
        body: {},
      });
      setPaper(r.avviso);
      onChange?.('paper');
    } catch (e) {
      setError(
        failure(
          e,
          'Il servizio non ha risposto: ricarica la pagina per vedere se la ricetta rossa è pronta',
        ),
      );
    }
  }

  if (red) return <RedPrintedNotice red={red} />;
  if (status === 'to_sign' && !isDoctor) {
    return <Notice kind="fatto">La ricetta è nella coda «da firmare» del medico.</Notice>;
  }
  if (outcome?.esito === 'accepted') {
    return (
      <>
        <Notice kind="fatto">
          Ricetta inviata. NRE <span className="codice">{outcome.nre}</span>
        </Notice>
        {outcome.messaggio && <Notice kind="avviso">{outcome.messaggio}</Notice>}
        {outcome.avviso && <Notice kind="avviso">{outcome.avviso}</Notice>}
      </>
    );
  }

  return (
    <div className="pannello-invio">
      <h3 ref={heading} tabIndex={-1}>
        Controlli prima dell’invio
      </h3>
      {blocked.length > 0 && !outcome && (
        <Stop kind="errore">
          <p>
            La ricetta non può partire: {blocked.join(', ')}{' '}
            {blocked.length === 1 ? 'blocca' : 'bloccano'}. Che cosa correggere, e dove, lo dice il
            controllo qui sotto.
          </p>
          {onEdit && (
            <button type="button" className="pulsante" onClick={onEdit}>
              <Icon name="ricette" /> <span>Modifica la ricetta</span>
            </button>
          )}
        </Stop>
      )}
      {stopped && blocked.length === 0 && !outcome && (
        <Stop kind="avviso">
          <p>
            La ricetta non è ancora partita. Guarda i controlli qui sotto e conferma con «Ho visto i
            controlli: firma e invia».
          </p>
          {onEdit && (
            <button type="button" className="pulsante" onClick={onEdit}>
              <Icon name="ricette" /> <span>Modifica la ricetta</span>
            </button>
          )}
        </Stop>
      )}
      {check && (
        <>
          <IssueList issues={check.problemi} />
          {check.versioneRegole && (
            <p className="tenue">Regole di prescrizione, versione {check.versioneRegole}</p>
          )}
        </>
      )}
      <p role="status" className={check ? 'stato-controllo tenue' : 'stato-controllo'}>
        {checking
          ? `Controllo in corso: si ${isDoctor ? 'firma' : 'manda alla firma'} quando è finito.`
          : busy && isDoctor
            ? 'Firma e invio in corso.'
            : isDoctor && undecided > 0
              ? 'Per firmare, decidi sulle proposte della segreteria.'
              : ''}
      </p>
      {isDoctor && aifa.length > 0 && (
        <fieldset className="conferme">
          <legend>Note AIFA (R7)</legend>
          {aifa.map((p) => (
            <div key={p.lineId} className="casella">
              <input
                type="checkbox"
                id={`nota-${p.lineId}`}
                checked={confirmed.has(p.lineId!)}
                onChange={(e) => {
                  const next = new Set(confirmed);
                  if (e.target.checked) next.add(p.lineId!);
                  else next.delete(p.lineId!);
                  setConfirmed(next);
                }}
              />
              <label htmlFor={`nota-${p.lineId}`}>
                {lineNames[p.lineId!] ?? 'Riga'}: confermo che il paziente rientra nelle condizioni
                della nota
              </label>
            </div>
          ))}
        </fieldset>
      )}
      {isDoctor && proposals.length > 0 && (
        <fieldset className="conferme">
          <legend>Proposte della segreteria sul tipo di terapia</legend>
          {proposals.map((p) => (
            <fieldset key={p.lineId} className="proposta">
              <legend>{lineNames[p.lineId!] ?? 'Riga'}</legend>
              {(['conferma', 'non_applicare'] as const).map((d) => (
                <div key={d} className="casella">
                  <input
                    type="radio"
                    id={`proposta-${d}-${p.lineId}`}
                    name={`proposta-${p.lineId}`}
                    checked={decisions[p.lineId!] === d}
                    onChange={() => setDecisions({ ...decisions, [p.lineId!]: d })}
                  />
                  <label htmlFor={`proposta-${d}-${p.lineId}`}>
                    {d === 'conferma'
                      ? 'Conferma la proposta: con la firma si aggiorna la terapia'
                      : 'Non applicarla: la ricetta parte con la terapia com’è'}
                  </label>
                </div>
              ))}
            </fieldset>
          ))}
        </fieldset>
      )}
      {isDoctor &&
        warns.map((rule) => (
          <div className="campo" key={rule}>
            <label htmlFor={`motivo-${rule}`}>
              Motivo per procedere nonostante l’avviso {rule}
            </label>
            <textarea
              id={`motivo-${rule}`}
              value={reasons[rule] ?? ''}
              onChange={(e) => setReasons({ ...reasons, [rule]: e.target.value })}
              rows={2}
            />
            <p className="aiuto">Il motivo resta registrato con il controllo.</p>
          </div>
        ))}
      <ErrorMessage error={error} />
      {unreachable && !toRedForm && (
        <Notice kind="avviso">
          Il servizio regionale non risponde. Si può riprovare l’invio, oppure stampare la ricetta
          rossa.
        </Notice>
      )}
      {isDoctor && toRedForm && redOpen && (
        <RedFormPrint
          prescriptionId={prescriptionId}
          onPrinted={(r) => {
            setRed(r);
            onChange?.('paper', undefined, r);
          }}
          onCancel={() => setRedOpen(false)}
        />
      )}
      {toRedForm ? (
        <Notice kind="avviso">
          {capitalized(service.il)} non ha dato esito: come vuole la regione, si stampa la ricetta
          rossa, che parte poi in DPCM. Se la ricetta dematerializzata era arrivata, si annulla da
          sola.
        </Notice>
      ) : (
        outcome?.esito === 'timeout' && (
          <Notice kind="avviso">
            Esito incerto: la ricetta potrebbe essere arrivata. Riprova l’invio; la ricetta rossa
            non si stampa finché l’esito non è chiaro.
          </Notice>
        )
      )}
      {outcome?.esito === 'rejected' && (
        <Notice kind="errore">Ricetta respinta dal servizio regionale.</Notice>
      )}
      {outcome?.avviso && <Notice kind="avviso">{outcome.avviso}</Notice>}
      {outcome?.esito === 'auth' && (
        <Notice kind="errore">
          <p>
            {sentence(outcome.messaggio)} La ricetta non cambia: si rimanda così com’è.{' '}
            <Link to={CREDENTIALS_PATH}>Apri «Credenziali dei servizi»</Link>
          </p>
        </Notice>
      )}
      {paper && <Notice kind="fatto">Ricetta rossa pronta per la stampa. {paper}.</Notice>}
      <div className="azioni">
        <button
          type="button"
          className="pulsante"
          onClick={() => void runCheck()}
          disabled={checking}
        >
          <Icon name="ripeti" /> <span>Controlla di nuovo</span>
        </button>
        {/* Il promemoria com'è prima della firma, con «BOZZA – NON VALIDA» al posto dell'NRE. */}
        {preview && checkable && (
          <a
            className="pulsante"
            href={`/api/ricette/${prescriptionId}/promemoria/anteprima`}
            target="_blank"
            rel="noopener"
          >
            <Icon name="stampa" /> <span>Anteprima del promemoria (PDF)</span>
          </a>
        )}
        {isDoctor && toRedForm ? (
          !redOpen && (
            <button
              type="button"
              className="pulsante pulsante-primario"
              onClick={() => setRedOpen(true)}
            >
              <Icon name="stampa" /> <span>Stampa la ricetta rossa</span>
            </button>
          )
        ) : isDoctor ? (
          <button
            type="button"
            className="pulsante pulsante-primario"
            onClick={() => void sign()}
            disabled={busy || checking || blocked.length > 0 || undecided > 0}
          >
            {/* Fermato il passo unico, il medico conferma di aver visto i controlli (D256). */}
            <Icon name="firma" />{' '}
            <span>
              {stopped && blocked.length === 0
                ? 'Ho visto i controlli: firma e invia'
                : 'Firma e invia'}
            </span>
          </button>
        ) : (
          status === 'draft' && (
            <button
              type="button"
              className="pulsante pulsante-primario"
              onClick={() => void toSign()}
              disabled={busy || checking}
            >
              <Icon name="firma" /> <span>Manda alla firma del medico</span>
            </button>
          )
        )}
        {isDoctor && unreachable && !paper && !redForm && (
          <button type="button" className="pulsante" onClick={() => void printPaper()}>
            <Icon name="stampa" /> <span>Stampa la ricetta rossa</span>
          </button>
        )}
      </div>
    </div>
  );
}
