import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { api, ApiError } from '../lib/api';
import { CREDENTIALS_PATH } from '../lib/credentials';
import { useSession } from '../lib/session';
import { ErrorMessage, IssueList, Notice, type RuleIssue } from './common';
import { Icon } from './Icon';

interface CheckResult {
  versioneRegole: string | null;
  problemi: RuleIssue[];
  bloccanti: number;
}

type SendOutcome =
  | { esito: 'accepted'; nre: string; messaggio: null }
  | { esito: 'rejected' | 'unreachable' | 'timeout' | 'auth'; nre: null; messaggio: string };

export interface SendPanelProps {
  prescriptionId: string;
  status: string;
  /** Nomi delle righe, per le conferme delle note AIFA. */
  lineNames: Record<string, string>;
  /** Nuovo stato della ricetta dopo un'azione, con l'NRE se è stata inviata. */
  onChange?: (status: string, nre?: string) => void;
}

/**
 * Controlli prima dell'invio, conferme e motivi, poi firma e invio (medico) o passaggio alla
 * firma (segreteria). Le regole decidono; qui si raccoglie solo ciò che chiedono. Si firma, o si
 * manda alla firma, a controllo finito: chi firma vede sempre i controlli prima (D230). Se il
 * controllo non riesce si può andare avanti: il servizio controlla di nuovo all'invio.
 */
export function SendPanel({ prescriptionId, status, lineNames, onChange }: SendPanelProps) {
  const { isDoctor } = useSession();
  const [check, setCheck] = useState<CheckResult | null>(null);
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [error, setError] = useState<ApiError | null>(null);
  const [outcome, setOutcome] = useState<SendOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [paper, setPaper] = useState<string | null>(null);
  // Il controllo parte da sé per le ricette che si possono ancora firmare (effetto qui sotto).
  const checkable = status === 'draft' || status === 'to_sign' || status === 'error';
  const [checking, setChecking] = useState(checkable);

  const body = { confermeNote: [...confirmed], motivi: reasons };
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
    } catch (e) {
      setError(e instanceof ApiError ? e : null);
    } finally {
      setChecking(false);
    }
  }, [prescriptionId]);

  useEffect(() => {
    if (checkable) void runCheck();
  }, [checkable, runCheck]);

  const aifa = (check?.problemi ?? []).filter((p) => p.needs === 'aifa_confirmation' && p.lineId);
  const warns = [
    ...new Set((check?.problemi ?? []).filter((p) => p.severity === 'warn').map((p) => p.ruleId)),
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
      setError(e instanceof ApiError ? e : null);
    } finally {
      setBusy(false);
    }
  }

  async function toSign() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/ricette/${prescriptionId}/da-firmare`, { method: 'POST', body: {} });
      onChange?.('to_sign');
    } catch (e) {
      setError(e instanceof ApiError ? e : null);
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
      setError(e instanceof ApiError ? e : null);
    }
  }

  if (status === 'to_sign' && !isDoctor) {
    return <Notice kind="fatto">La ricetta è nella coda «da firmare» del medico.</Notice>;
  }
  if (outcome?.esito === 'accepted') {
    return (
      <Notice kind="fatto">
        Ricetta inviata. NRE <span className="codice">{outcome.nre}</span>
      </Notice>
    );
  }

  return (
    <div className="pannello-invio">
      <h3>Controlli prima dell’invio</h3>
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
      {outcome?.esito === 'unreachable' && (
        <Notice kind="avviso">
          Il servizio regionale non risponde. Si può riprovare l’invio, oppure stampare la ricetta
          rossa.
        </Notice>
      )}
      {outcome?.esito === 'timeout' && (
        <Notice kind="avviso">
          Esito incerto: la ricetta potrebbe essere arrivata. Riprova l’invio; la ricetta rossa non
          si stampa finché l’esito non è chiaro.
        </Notice>
      )}
      {outcome?.esito === 'rejected' && (
        <Notice kind="errore">Ricetta respinta dal servizio regionale.</Notice>
      )}
      {outcome?.esito === 'auth' && (
        <Notice kind="errore">
          <p>
            {outcome.messaggio} La ricetta non cambia: si rimanda così com’è.{' '}
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
        {isDoctor ? (
          <button
            type="button"
            className="pulsante pulsante-primario"
            onClick={() => void sign()}
            disabled={busy || checking}
          >
            <Icon name="firma" /> <span>Firma e invia</span>
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
        {isDoctor && outcome?.esito === 'unreachable' && (
          <button type="button" className="pulsante" onClick={() => void printPaper()}>
            <Icon name="stampa" /> <span>Stampa la ricetta rossa</span>
          </button>
        )}
      </div>
    </div>
  );
}
