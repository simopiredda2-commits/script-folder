import { PRODUCT_NAME } from '@mmg/brand';
import { useEffect, type ReactNode } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router';
import { age } from '../lib/format';
import { patientIdOf, recordLabel, useOpenRecords, MAX_OPEN_RECORDS } from '../lib/openRecords';
import { useApi } from '../lib/useApi';
import { useSession } from '../lib/session';
import { Icon, type IconName } from './Icon';
import { Logo } from './Logo';
import { Signature } from './Signature';

interface TodayCounts {
  code: { daFirmare: number | null };
}

const NAV: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: '/', label: 'Oggi', icon: 'oggi', end: true },
  { to: '/pazienti', label: 'Pazienti', icon: 'pazienti' },
  { to: '/ricette', label: 'Ricette', icon: 'ricette' },
  { to: '/banche-dati', label: 'Farmaci e prestazioni', icon: 'farmaci' },
];

/**
 * Cartelle aperte insieme (D68): una scheda per paziente, che riporta all'ultima pagina vista.
 * Il paziente attivo è evidenziato; nome e cognome per intero, per non scambiare i pazienti.
 */
function OpenRecordsBar() {
  const { records, closedForLimit, visit, close, closeAll } = useOpenRecords();
  const location = useLocation();
  const navigate = useNavigate();
  const current = patientIdOf(location.pathname);

  useEffect(() => {
    if (current) visit(current, location.pathname + location.search);
  }, [current, location.pathname, location.search, visit]);

  if (records.length === 0) return null;
  return (
    <div className="schede-aperte-contenitore">
      <nav aria-label="Cartelle aperte" className="schede-aperte">
        <ul>
          {records.map((r) => {
            const label = recordLabel(r, records);
            const active = r.id === current;
            return (
              <li key={r.id} className={active ? 'scheda-aperta attiva' : 'scheda-aperta'}>
                <Link to={r.lastPath} aria-current={active ? 'page' : undefined}>
                  <span>{label}</span>
                  <span className="tenue"> · {age(r.birthDate)} anni</span>
                </Link>
                <button
                  type="button"
                  className="pulsante pulsante-piatto"
                  aria-label={`Chiudi la cartella di ${label}`}
                  onClick={() => {
                    close(r.id);
                    if (active) void navigate('/pazienti');
                  }}
                >
                  <Icon name="annulla" />
                </button>
              </li>
            );
          })}
        </ul>
        {records.length > 1 && (
          <button
            type="button"
            className="pulsante pulsante-piatto"
            onClick={() => {
              closeAll();
              if (current) void navigate('/pazienti');
            }}
          >
            Chiudi tutte
          </button>
        )}
      </nav>
      <p role="status" className="tenue schede-avviso">
        {closedForLimit
          ? `Si tengono aperte al massimo ${MAX_OPEN_RECORDS} cartelle: chiusa quella di ${closedForLimit.lastName} ${closedForLimit.firstName}, usata meno di recente.`
          : ''}
      </p>
    </div>
  );
}

/** Cornice: salto al contenuto, menu con simbolo e nome, utente, cartelle aperte, piede con «by SCRIPT». */
export function Shell({ children }: { children: ReactNode }) {
  const { state, logout } = useSession();
  const location = useLocation();
  // Il numero accanto a «Ricette» si aggiorna a ogni cambio di pagina.
  const today = useApi<TodayCounts>(`/api/oggi?_=${encodeURIComponent(location.pathname)}`);
  const toSign = today.data?.code.daFirmare ?? null;
  const me = state.status === 'ready' ? state.me : null;

  return (
    <div className="app-shell">
      <a className="salta" href="#contenuto">
        Vai al contenuto
      </a>
      <header className="app-header">
        <NavLink to="/" className="marchio-link" aria-label={`${PRODUCT_NAME}: oggi`}>
          <Logo />
        </NavLink>
        <nav aria-label="Sezioni" className="menu">
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className="menu-voce">
              <Icon name={n.icon} />
              <span>{n.label}</span>
              {n.to === '/ricette' && toSign !== null && toSign > 0 && (
                <span className="contatore" aria-label={`${toSign} da firmare`}>
                  {toSign}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
        {me && (
          <div className="utente">
            <span className="utente-nome">
              {me.nome}
              <span className="utente-ruolo">
                {me.ruoli.map((r) => r.nome).join(', ')}
                {me.postazione ? ` · ${me.postazione}` : ''}
              </span>
            </span>
            <button
              type="button"
              className="pulsante pulsante-piatto"
              onClick={() => void logout()}
            >
              <Icon name="esci" />
              <span>Esci</span>
            </button>
          </div>
        )}
      </header>
      <OpenRecordsBar />
      <main className="app-main" id="contenuto" tabIndex={-1}>
        {children}
      </main>
      <footer className="app-footer">
        <span>
          {PRODUCT_NAME} <Signature />
        </span>
        <span>Solo pazienti inventati in questo ambiente</span>
      </footer>
    </div>
  );
}
