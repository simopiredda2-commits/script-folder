import { useEffect, useRef, type ReactNode } from 'react';
import { Link } from 'react-router';
import type { ApiError } from '../lib/api';
import { CREDENTIALS_PATH, isCredentialError } from '../lib/credentials';
import { date, dateTime, sentence } from '../lib/format';
import { Icon } from './Icon';

/** Stato di caricamento, annunciato a chi usa un lettore di schermo. */
export function Loading({ what = 'dati' }: { what?: string }) {
  return (
    <p className="stato-caricamento" role="status">
      Caricamento dei {what}…
    </p>
  );
}

/**
 * I motivi di un rifiuto dei dati (400): i messaggi dei campi che il servizio non ha accettato, per
 * esempio il formato di un NRE, senza doppioni (D239).
 */
function fieldMessages(error: ApiError): string[] {
  if (error.status !== 400 || !Array.isArray(error.details)) return [];
  const messages = (error.details as { message?: unknown }[])
    .map((d) => d?.message)
    .filter((m): m is string => typeof m === 'string' && m.length > 0);
  return [...new Set(messages)].slice(0, 5);
}

export function ErrorMessage({
  error,
  focus = false,
}: {
  error: ApiError | null;
  /**
   * L'errore di un'azione che toglie o spegne il pulsante premuto prende il fuoco, che altrimenti
   * finirebbe sulla pagina (WCAG 2.4.3, audit D259).
   */
  focus?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focus && error) ref.current?.focus();
  }, [focus, error]);
  if (!error) return null;
  const fields = fieldMessages(error);
  return (
    <div
      ref={ref}
      tabIndex={focus ? -1 : undefined}
      className="messaggio messaggio-errore"
      role="alert"
    >
      <Icon name="avviso" />
      <span>
        {/* Seguito dal collegamento, il messaggio chiude la frase col punto (audit D259). */}
        {isCredentialError(error.details) && fields.length === 0
          ? sentence(error.message)
          : error.message}
        {fields.length > 0 && `: ${fields.join('; ')}`}
        {isCredentialError(error.details) && (
          <>
            {' '}
            <Link to={CREDENTIALS_PATH}>Apri «Credenziali dei servizi»</Link>
          </>
        )}
      </span>
    </div>
  );
}

export function Notice({
  kind,
  children,
}: {
  kind: 'info' | 'avviso' | 'errore' | 'fatto';
  children: ReactNode;
}) {
  const icon = kind === 'errore' ? 'blocco' : kind === 'fatto' ? 'fatto' : kind;
  return (
    <div className={`messaggio messaggio-${kind}`} role={kind === 'errore' ? 'alert' : 'status'}>
      <Icon name={icon} />
      <div>{children}</div>
    </div>
  );
}

/**
 * Domanda di conferma prima di un esito che poi non si cambia (WCAG 3.3.4, audit D259): la
 * domanda, «Sì» e «Torna indietro». Quando compare prende il fuoco, così la tastiera e il lettore
 * di schermo la trovano subito (WCAG 2.4.3).
 */
export function ConfirmQuestion({
  label,
  yes,
  busy = false,
  onYes,
  onBack,
  children,
}: {
  /** Nome del gruppo, per il lettore di schermo. */
  label: string;
  /** Il testo del «Sì», che dice che cosa si fa: «Sì, sposta». */
  yes: string;
  busy?: boolean;
  onYes: () => void;
  onBack: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div ref={ref} tabIndex={-1} className="conferma-esito" role="group" aria-label={label}>
      <p>{children}</p>
      <div className="azioni">
        <button
          type="button"
          className="pulsante pulsante-primario"
          disabled={busy}
          onClick={onYes}
        >
          <Icon name="fatto" /> <span>{yes}</span>
        </button>
        <button type="button" className="pulsante" disabled={busy} onClick={onBack}>
          <Icon name="annulla" /> <span>Torna indietro</span>
        </button>
      </div>
    </div>
  );
}

/**
 * L'esito di un'azione che toglie il pulsante premuto: prende il fuoco, che altrimenti finirebbe
 * sulla pagina (WCAG 2.4.3, audit D259).
 */
export function ResultNotice({
  kind = 'fatto',
  children,
}: {
  kind?: 'info' | 'avviso' | 'errore' | 'fatto';
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), [children]);
  return (
    <div ref={ref} tabIndex={-1} className="esito-segnato">
      <Notice kind={kind}>{children}</Notice>
    </div>
  );
}

export interface DatasetVersion {
  kind: string;
  kindLabel: string;
  series: string;
  title: string;
  validFrom: string;
  validFromBasis: string;
  downloadedAt: string | null;
  act: string | null;
  stale: boolean | null;
  /** Perché è più vecchia del previsto (D156). */
  staleReasons?: string[];
  /** Ultimo controllo riuscito della sua fonte (D156). */
  checkedAt?: string | null;
}

/** A6: ogni schermata che usa una banca dati mostra la data della versione in uso. */
export function DataVersions({
  versions,
  label,
  compact = false,
}: {
  versions: DatasetVersion[] | undefined;
  label: string;
  /**
   * Chiuse in una riga, che si apre col clic (D242): nella ricetta, perché la pagina stia in una
   * schermata. Una banca dati più vecchia del previsto si dice anche da chiuse.
   */
  compact?: boolean;
}) {
  if (!versions) return null;
  if (versions.length === 0) {
    return (
      <Notice kind="avviso">
        {label}: nessuna banca dati importata. I controlli che ne hanno bisogno dicono «non
        verificabile».
      </Notice>
    );
  }
  const stale = versions.some((v) => v.stale);
  const list = (
    <>
      <ul>
        {versions.map((v) => (
          <li key={v.series}>
            <span>{v.title}</span>{' '}
            <span className="versioni-data">
              {v.validFromBasis === 'atto'
                ? `in vigore dal ${date(v.validFrom)}${v.act ? ` (${v.act})` : ''}`
                : `scaricata il ${v.downloadedAt ? dateTime(v.downloadedAt) : date(v.validFrom)}`}
            </span>
            {v.checkedAt && (
              <span className="versioni-data"> · fonte controllata il {dateTime(v.checkedAt)}</span>
            )}
            {v.stale && (
              <>
                <strong className="versioni-vecchia">
                  {' '}
                  · <Icon name="avviso" /> più vecchia del previsto
                </strong>
                {v.staleReasons && v.staleReasons.length > 0 && (
                  <ul className="versioni-motivi">
                    {v.staleReasons.map((r) => (
                      <li key={r}>{r}</li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
      <Link className="versioni-aggiornamento" to="/strumenti?sezione=banche-dati">
        Aggiornamento delle banche dati
      </Link>
    </>
  );
  if (compact)
    return (
      <details className="versioni versioni-chiuse">
        <summary>
          <Icon name="apri" />
          {label} in uso
          {stale && (
            <strong className="versioni-vecchia">
              {' '}
              · <Icon name="avviso" /> più vecchia del previsto
            </strong>
          )}
        </summary>
        {list}
      </details>
    );
  return (
    <div className="versioni">
      <p className="versioni-titolo">{label} in uso</p>
      {list}
    </div>
  );
}

export interface RuleIssue {
  ruleId: string;
  severity: 'block' | 'warn' | 'info';
  message: string;
  lineId?: string;
  needs?: string;
  source?: string;
  remedy?: string;
}

const SEVERITY_LABEL = { block: 'Blocca', warn: 'Chiede un motivo', info: 'Informazione' } as const;

/** Problemi trovati dalle regole di prescrizione, con la fonte e che cosa fare. */
export function IssueList({ issues }: { issues: RuleIssue[] }) {
  if (!issues.length)
    return (
      <Notice kind="fatto">Nessun problema: le regole di prescrizione sono rispettate.</Notice>
    );
  return (
    <ul className="problemi">
      {issues.map((i, n) => (
        <li key={`${i.ruleId}-${n}`} className={`problema problema-${i.severity}`}>
          <Icon
            name={i.severity === 'block' ? 'blocco' : i.severity === 'warn' ? 'avviso' : 'info'}
          />
          <div>
            <p>
              <strong>
                {/* La proposta della segreteria chiede al medico una decisione (D283). */}
                {i.ruleId === 'PROPOSTA' ? 'Proposta della segreteria' : i.ruleId} ·{' '}
                {i.needs === 'therapy_decision'
                  ? 'Chiede la decisione del medico'
                  : SEVERITY_LABEL[i.severity]}
              </strong>
              : {i.message}
            </p>
            {i.remedy && <p className="problema-rimedio">Che cosa fare: {i.remedy}</p>}
            {i.source && <p className="problema-fonte">Fonte: {i.source}</p>}
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Intestazione di pagina con il percorso (briciole) e il titolo. */
export function PageHeader({
  title,
  trail,
  actions,
}: {
  title: string;
  trail?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="intestazione-pagina">
      {trail && (
        <nav aria-label="Percorso" className="briciole">
          {trail}
        </nav>
      )}
      <div className="intestazione-riga">
        <h1>{title}</h1>
        {actions && <div className="azioni">{actions}</div>}
      </div>
    </div>
  );
}
