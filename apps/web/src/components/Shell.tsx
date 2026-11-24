import { PRODUCT_NAME } from '@mmg/brand';
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router';
import { age } from '../lib/format';
import { patientIdOf, recordLabel, useOpenRecords, MAX_OPEN_RECORDS } from '../lib/openRecords';
import { useApi } from '../lib/useApi';
import { useSession } from '../lib/session';
import { toolsSectionsFor } from '../lib/tools-sections';
import { Notice } from './common';
import { Icon, type IconName } from './Icon';
import { Logo } from './Logo';
import { Signature } from './Signature';

interface TodayCounts {
  code: { daFirmare: number | null; inBozza?: number | null };
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

  // Con molte cartelle la barra scorre: la scheda attiva deve restare in vista (D68), anche se
  // cambia la larghezza dello schermo. Si scorre solo la barra, mai la pagina.
  const navRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const showActive = () => {
      const nav = navRef.current;
      const li = nav?.querySelector('a[aria-current="page"]')?.closest('li');
      if (!nav || !li) return;
      const n = nav.getBoundingClientRect();
      const r = li.getBoundingClientRect();
      if (r.left < n.left) nav.scrollLeft -= n.left - r.left + 8;
      else if (r.right > n.right) nav.scrollLeft += r.right - n.right + 8;
    };
    showActive();
    window.addEventListener('resize', showActive);
    return () => window.removeEventListener('resize', showActive);
  }, [current, records]);

  if (records.length === 0) return null;
  return (
    <div className="schede-aperte-contenitore">
      <nav aria-label="Cartelle aperte" className="schede-aperte" ref={navRef}>
        <ul>
          {records.map((r) => {
            const label = recordLabel(r, records);
            const active = r.id === current;
            return (
              <li key={r.id} className={active ? 'scheda-aperta attiva' : 'scheda-aperta'}>
                <Link to={r.lastPath} aria-current={active ? 'page' : undefined}>
                  <span>{label}</span>
                  <span className="tenue">· {age(r.birthDate)} anni</span>
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

/**
 * Chi è entrato, in alto a destra sulla riga del marchio (richiesta di Simone del 23/11/2026): nome,
 * ruoli e postazione. Credenziali, password e uscita stanno nel menu che si apre col clic sul nome:
 * la cornice resta su una riga e lascia spazio alla pagina. Il menu si chiude con Esc, con un clic
 * fuori o cambiando pagina.
 */
function UserMenu() {
  const { state, logout, isDoctor } = useSession();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const { pathname } = useLocation();
  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);
  if (state.status !== 'ready') return null;
  const me = state.me;
  const roles = me.ruoli.map((r) => r.nome).join(', ');
  return (
    <div className="utente" ref={box}>
      {/* In vista il nome e la postazione, dove vanno le stampe (D180); i ruoli nel menu, per
          tenere la testata in una riga (D244). */}
      <button
        type="button"
        className="utente-apri"
        aria-expanded={open}
        aria-controls="menu-utente"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="utente-nome">
          <span className="utente-chi">{me.nome}</span>
          <span className="utente-ruolo">{me.postazione ?? roles}</span>
        </span>
        <Icon name="apri" />
      </button>
      {open && (
        <div id="menu-utente" className="utente-menu">
          <p className="utente-dettagli">
            <span>{roles}</span>
            {me.postazione && <span>Postazione: {me.postazione}</span>}
          </p>
          {isDoctor && (
            <NavLink to="/profilo/credenziali" className="pulsante pulsante-piatto">
              <Icon name="lucchetto" />
              <span>Credenziali</span>
            </NavLink>
          )}
          {/* La propria password del programma, per tutti (tappa 14). */}
          <NavLink to="/profilo/password" className="pulsante pulsante-piatto">
            <Icon name="lucchetto" />
            <span>Password</span>
          </NavLink>
          <button type="button" className="pulsante pulsante-piatto" onClick={() => void logout()}>
            <Icon name="esci" />
            <span>Esci</span>
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * La testata sta in una riga quando marchio, menu e utente ci stanno; altrimenti marchio e utente
 * restano in alto e il menu va sulla riga sotto, intero (D244). Si misura invece di fissare una
 * larghezza: il nome di chi entra, il contatore e i caratteri cambiano lo spazio che serve.
 * `content` cambia quando cambia ciò che sta nella testata, per misurare di nuovo.
 */
function useHeaderRows(header: RefObject<HTMLElement | null>, content: string) {
  const [twoRows, setTwoRows] = useState(false);
  useLayoutEffect(() => {
    const h = header.current;
    // Senza ResizeObserver (le prove dei componenti) niente misure: una riga.
    if (!h || typeof ResizeObserver === 'undefined') return;
    const width = (e: Element | null) => (e ? e.getBoundingClientRect().width : 0);
    const measure = () => {
      const menu = h.querySelector('.menu');
      const user = h.querySelector('.utente');
      if (!menu) return;
      const css = getComputedStyle(h);
      const gap = parseFloat(css.columnGap) || 0;
      const items = [...menu.children];
      const menuGap = parseFloat(getComputedStyle(menu).columnGap) || 0;
      const need =
        (parseFloat(css.paddingLeft) || 0) +
        (parseFloat(css.paddingRight) || 0) +
        width(h.querySelector('.marchio-link')) +
        gap +
        items.reduce((sum, item) => sum + width(item), 0) +
        menuGap * Math.max(0, items.length - 1) +
        (user ? gap + width(user) : 0);
      // Un pixel di margine per gli arrotondamenti.
      setTwoRows(need > width(h) - 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(h);
    for (const e of h.querySelectorAll('.menu > *, .utente')) observer.observe(e);
    // I caratteri arrivano dopo la prima disegnata e cambiano le larghezze.
    void document.fonts?.ready.then(measure);
    return () => observer.disconnect();
  }, [header, content]);
  return twoRows;
}

/** Cornice: salto al contenuto, menu con simbolo e nome, utente, cartelle aperte, piede con «by SCRIPT». */
export function Shell({ children }: { children: ReactNode }) {
  const { state } = useSession();
  const location = useLocation();
  // Il numero accanto a «Ricette» si aggiorna a ogni cambio di pagina.
  const today = useApi<TodayCounts>(`/api/oggi?_=${encodeURIComponent(location.pathname)}`);
  // Da firmare, e le bozze di chi guarda: una ricetta salvata non si dimentica (audit, D259).
  const counts = today.data?.code;
  const toSign =
    counts && (counts.daFirmare !== null || counts.inBozza != null)
      ? (counts.daFirmare ?? 0) + (counts.inBozza ?? 0)
      : null;
  const me = state.status === 'ready' ? state.me : null;
  const header = useRef<HTMLElement>(null);
  const items = [
    ...NAV,
    ...(me?.archivio
      ? [{ to: '/archivio', label: 'Archivio', icon: 'archivio' as const, end: false }]
      : []),
    // La segreteria non ha un archivio suo: i riepiloghi degli archivi che l'hanno
    // confermata (D204) li apre dal menu.
    ...(me && !me.archivio && me.ruoli.some((r) => r.codice === 'secretary')
      ? [{ to: '/archivio/riepiloghi', label: 'Riepiloghi', icon: 'storico' as const, end: false }]
      : []),
    // Strumenti, se c'è almeno una sezione per i ruoli di chi entra (D175).
    ...(me && toolsSectionsFor(me.ruoli.map((r) => r.codice)).length > 0
      ? [{ to: '/strumenti', label: 'Strumenti', icon: 'strumenti' as const, end: false }]
      : []),
  ];
  const twoRows = useHeaderRows(
    header,
    [items.map((n) => n.to).join(' '), toSign, me?.nome, me?.postazione].join('|'),
  );

  return (
    <div className="app-shell">
      <a className="salta" href="#contenuto">
        Vai al contenuto
      </a>
      <header className={twoRows ? 'app-header testata-due-righe' : 'app-header'} ref={header}>
        <NavLink to="/" className="marchio-link" aria-label={`${PRODUCT_NAME}: oggi`}>
          <Logo />
        </NavLink>
        <nav aria-label="Sezioni" className="menu">
          {items.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className="menu-voce">
              <Icon name={n.icon} />
              <span>{n.label}</span>
              {n.to === '/ricette' && toSign !== null && toSign > 0 && (
                <span className="contatore" aria-label={`${toSign} da firmare o in bozza`}>
                  {toSign}
                </span>
              )}
            </NavLink>
          ))}
        </nav>
        {me && <UserMenu />}
      </header>
      <OpenRecordsBar />
      <main className="app-main" id="contenuto" tabIndex={-1}>
        {!!me?.blocchiDaVedere && location.pathname !== '/profilo/blocchi' && (
          <Notice kind="avviso">
            <p>
              {me.blocchiDaVedere === 1
                ? 'Un blocco del conto dopo troppi tentativi sbagliati, da vedere.'
                : `${me.blocchiDaVedere} blocchi del conto dopo troppi tentativi sbagliati, da vedere.`}{' '}
              <Link to="/profilo/blocchi">Vedi i blocchi</Link>
            </p>
          </Notice>
        )}
        {me?.codiceFiscaleDaConfermare && location.pathname !== '/profilo/recapiti' && (
          <Notice kind="avviso">
            <p>
              L’amministratore ha corretto il tuo codice fiscale: finché non lo confermi vale quello
              di prima. <Link to="/profilo/recapiti">Controlla e conferma</Link>
            </p>
          </Notice>
        )}
        {children}
      </main>
      <footer className="app-footer">
        <span className="firma-piede">
          <span>{PRODUCT_NAME}</span>
          <Signature />
        </span>
        <span>Solo pazienti inventati in questo ambiente</span>
      </footer>
    </div>
  );
}
