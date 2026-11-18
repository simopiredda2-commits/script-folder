import { PRODUCT_NAME } from '@mmg/brand';
import type { ReactNode } from 'react';
import { NavLink, useLocation } from 'react-router';
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

/** Cornice: salto al contenuto, menu con simbolo e nome, utente, piede con «by SCRIPT». */
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
