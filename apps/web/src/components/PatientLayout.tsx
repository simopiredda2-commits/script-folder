import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useParams } from 'react-router';
import { useSession } from '../lib/session';
import { useMoreBelow } from '../lib/useMoreBelow';
import type { Patient, Summary } from '../pages/RecordPage';
import { Icon, type IconName } from './Icon';
import { PatientFacts } from './PatientFacts';

/** I dati della testata, come li ha caricati la pagina aperta. */
export interface BandData {
  patient: Patient;
  summary?: Summary | null;
}

const BandContext = createContext<((band: BandData) => void) | null>(null);

/**
 * Dentro la cartella (D244) la pagina non mostra la testata: la passa alla fascia fissa del
 * contenitore. Fuori dalla cartella (le prove dei singoli componenti) non c'è chi la riceve.
 */
export function useBandPublisher() {
  return useContext(BandContext);
}

/**
 * Per le pagine della cartella che non mostrano la testata (certificati di malattia, schema
 * orario): passano alla fascia il paziente che hanno già caricato.
 */
export function useBand(patient: Patient | undefined, summary?: Summary | null) {
  const publish = useBandPublisher();
  useEffect(() => {
    if (patient) publish?.({ patient, summary });
  }, [publish, patient, summary]);
}

interface Section {
  to: string;
  label: string;
  icon: IconName;
  end?: boolean;
  doctorOnly?: boolean;
  /** Le scorciatoie per prescrivere, in testa al menu; la prima è il pulsante principale. */
  prescribe?: 'primary' | true;
  /** Altre pagine della cartella in cui la voce resta evidenziata. */
  also?: readonly string[];
}

/**
 * Il menu della cartella: prima le scorciatoie per prescrivere (erano nel riepilogo), poi il
 * riepilogo e le voci, nell'ordine di prima; «Risultati degli esami» (i referti) accanto ai
 * parametri. I nomi dicono che cosa si fa: i risultati da una parte, le visite e gli esami da
 * prescrivere dall'altra (D282).
 */
export const RECORD_SECTIONS: readonly Section[] = [
  // I farmaci prescritti stanno nella ricetta (D246): la loro pagina completa resta sotto questa voce.
  {
    to: 'ricetta',
    label: 'Nuova ricetta',
    icon: 'ricette',
    prescribe: 'primary',
    also: ['farmaci'],
  },
  {
    to: 'specialistica',
    label: 'Visite ed esami da prescrivere',
    icon: 'specialistica',
    prescribe: true,
  },
  { to: 'certificati', label: 'Certificati', icon: 'firma', prescribe: true, doctorOnly: true },
  { to: '', label: 'Riepilogo', icon: 'info', end: true },
  { to: 'amministrazione', label: 'Dati amministrativi', icon: 'pazienti' },
  { to: 'visite-ed-esami', label: 'Visite ed esami prescritti', icon: 'specialistica' },
  { to: 'voci', label: 'Voci cliniche', icon: 'storico' },
  { to: 'parametri', label: 'Parametri', icon: 'esami' },
  { to: 'esami', label: 'Risultati degli esami', icon: 'esami' },
  { to: 'piani', label: 'Piani terapeutici', icon: 'terapia' },
  { to: 'presidi', label: 'Presidi', icon: 'terapia' },
  { to: 'prestazioni-aggiuntive', label: 'Prestazioni aggiuntive', icon: 'firma' },
  { to: 'seguito', label: 'Seguito delle prestazioni', icon: 'specialistica' },
  { to: 'privacy', label: 'Privacy', icon: 'lucchetto' },
  { to: 'certificati-modelli', label: 'Altri certificati', icon: 'ricette' },
  { to: 'profilo-sanitario', label: 'Profilo sanitario sintetico', icon: 'archivio' },
  { to: 'fascicolo-regionale', label: 'Fascicolo regionale', icon: 'archivio', doctorOnly: true },
  // Lo legge il titolare dell'archivio (audit D259); agli altri la pagina lo dice.
  { to: 'registro', label: 'Registro degli accessi', icon: 'lucchetto', doctorOnly: true },
];

/**
 * La cartella del paziente (D244): una fascia fissa con nome e dati in una riga, allergie ed
 * esenzioni in corso; il menu sempre in vista, con le scorciatoie per prescrivere in testa e la voce aperta
 * evidenziata; accanto, la pagina scelta. Sul computer e sul tablet in orizzontale la cornice è alta
 * quanto lo schermo e scorre solo il contenuto.
 */
export function PatientLayout() {
  const { id } = useParams<{ id: string }>();
  const { isDoctor } = useSession();
  const [band, setBand] = useState<BandData | null>(null);
  // La testata resta quella dell'ultima pagina del paziente finché la nuova non è pronta: niente
  // fascia che sparisce e ricompare a ogni cambio di pagina (D244).
  const shown = band && band.patient.id === id ? band : null;
  const base = `/pazienti/${id}`;
  const content = useRef<HTMLDivElement>(null);
  const markContent = useMoreBelow();
  const contentRef = useCallback(
    (node: HTMLDivElement | null) => {
      content.current = node;
      markContent(node);
    },
    [markContent],
  );
  const { pathname, hash } = useLocation();

  // Il contenuto scorre nel suo riquadro, che resta lo stesso da una voce all'altra: a ogni voce
  // nuova, e a ogni sezione nuova dei dati amministrativi (#sezione), si riparte dall'alto.
  useEffect(() => {
    if (content.current) content.current.scrollTop = 0;
  }, [pathname, hash]);

  useEffect(() => {
    document.documentElement.classList.add('cartella-aperta');
    return () => document.documentElement.classList.remove('cartella-aperta');
  }, []);

  return (
    <BandContext.Provider value={setBand}>
      <div className="cartella">
        {/* Il nome apre la riga dei dati, piccolo come loro: nessun titolo grande che ripeta il
            nome della linguetta (richieste di Simone del 23/11/2026). */}
        <div
          className="cartella-fascia"
          role="region"
          aria-label={
            shown ? `Paziente: ${shown.patient.firstName} ${shown.patient.lastName}` : 'Paziente'
          }
        >
          {shown && <PatientFacts patient={shown.patient} summary={shown.summary} withName />}
        </div>
        <div className="cartella-corpo">
          <RecordMenu base={base} doctor={isDoctor} />
          {/* Il riquadro scorre da solo (D244): si raggiunge anche da tastiera, per scorrerlo con
              le frecce quando non ha collegamenti o campi (WCAG 2.1.1). */}
          <div
            className="cartella-contenuto ombre-scorrimento"
            ref={contentRef}
            role="region"
            aria-label="Contenuto della cartella"
            tabIndex={0}
          >
            <Outlet />
          </div>
        </div>
      </div>
    </BandContext.Provider>
  );
}

/** Il menu delle voci, sempre in vista; la voce aperta è evidenziata e, nella striscia, in vista. */
function RecordMenu({ base, doctor }: { base: string; doctor: boolean }) {
  const list = useRef<HTMLUListElement>(null);
  const markMenu = useMoreBelow();
  const { pathname } = useLocation();
  useEffect(() => {
    // Nella striscia orizzontale (schermi stretti) la voce aperta entra nel riquadro, senza
    // spostare la pagina in verticale.
    const ul = list.current;
    const current = ul?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!ul || !current || ul.scrollWidth <= ul.clientWidth) return;
    const left = current.offsetLeft - ul.offsetLeft;
    if (left < ul.scrollLeft || left + current.offsetWidth > ul.scrollLeft + ul.clientWidth)
      ul.scrollLeft = Math.max(0, left - 16);
  }, [pathname]);
  return (
    <nav
      className="menu-cartella ombre-scorrimento"
      aria-label="Sezioni della cartella"
      ref={markMenu}
    >
      <ul ref={list}>
        {RECORD_SECTIONS.filter((s) => doctor || !s.doctorOnly).map((s) => {
          const path = s.to ? `${base}/${s.to}` : base;
          // La voce aperta: la sua pagina (e quelle sotto, se non è «end»), o una di `also`.
          const here =
            pathname === path ||
            (!s.end && pathname.startsWith(`${path}/`)) ||
            (s.also ?? []).some(
              (x) => pathname === `${base}/${x}` || pathname.startsWith(`${base}/${x}/`),
            );
          return (
            <li key={s.label} className={s.prescribe ? 'menu-cartella-prescrivi' : undefined}>
              <Link
                to={path}
                aria-current={here ? 'page' : undefined}
                className={
                  s.prescribe === 'primary'
                    ? 'menu-cartella-voce menu-cartella-primaria'
                    : 'menu-cartella-voce'
                }
              >
                <Icon name={s.icon} />
                <span>{s.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
