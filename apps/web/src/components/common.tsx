import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { ApiError } from '../lib/api';
import { CREDENTIALS_PATH, isCredentialError } from '../lib/credentials';
import { date, dateTime } from '../lib/format';
import { Icon } from './Icon';

/** Stato di caricamento, annunciato a chi usa un lettore di schermo. */
export function Loading({ what = 'dati' }: { what?: string }) {
  return (
    <p className="stato-caricamento" role="status">
      Caricamento dei {what}…
    </p>
  );
}

export function ErrorMessage({ error }: { error: ApiError | null }) {
  if (!error) return null;
  return (
    <div className="messaggio messaggio-errore" role="alert">
      <Icon name="avviso" />
      <span>
        {error.message}
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
}: {
  versions: DatasetVersion[] | undefined;
  label: string;
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
  return (
    <div className="versioni">
      <p className="versioni-titolo">{label} in uso</p>
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
                {i.ruleId} · {SEVERITY_LABEL[i.severity]}
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
