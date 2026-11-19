import { Link } from 'react-router';
import { query } from '../lib/api';
import { date } from '../lib/format';
import type { Loaded } from '../lib/useApi';
import { ErrorMessage, Loading } from './common';
import { Icon } from './Icon';
import type { TherapyKind, TherapyOrigin } from './DrugColours';

/** Le chiavi dello storico (D65, D66): le stesse della rotta dello storico. */
export type HistoryKey =
  | { terapia: string }
  | { aic: string }
  | { principio: string }
  | { farmaco: string }
  | { prestazione: string }
  | { descrizione: string };

interface Counts {
  /** Ricette che contengono la voce, in qualunque stato. */
  ricette: number;
  /** Inviate o stampate su carta. */
  prescritte: number;
  /** In bozza, da firmare, in invio o con l'invio non riuscito. */
  inPreparazione: number;
  annullate: number;
  ultimaIl: string | null;
  ultimoStato: string | null;
  /** Confezioni (o quantità) negli ultimi 12 mesi, ricette inviate o su carta. */
  ultimi12Mesi: number;
  /** Ricette della stessa voce fatte con un altro programma (tappa 15), contate a parte. */
  altroProgramma?: { ricette: number; ultimaIl: string | null };
}

/** Una ricetta fatta con un altro programma, come la restituisce il servizio (tappa 15). */
export interface PastPrescription {
  id: string;
  tipo: 'farmaco' | 'prestazione';
  data: string;
  aic: string | null;
  farmaco: string | null;
  principioAttivo: string | null;
  atc: string | null;
  codice: string | null;
  descrizione: string | null;
  quantita: number | null;
  posologia: string | null;
  nre: string | null;
  prescrittore: string | null;
  note: string | null;
  programma: string | null;
  importata: boolean;
  registrataDa: string | null;
  registrataIl: string;
  stato: 'attiva' | 'annullata';
  annullataIl: string | null;
  motivoAnnullamento: string | null;
}

/** Un farmaco prescritto, come lo restituisce il servizio (D152). */
export interface PrescribedDrug extends Counts {
  chiave: string;
  storico: HistoryKey;
  farmaco: string;
  principioAttivo: string | null;
  aic: string | null;
  notaAifa: string | null;
  /** La terapia in cartella; null se il farmaco è stato prescritto senza terapia. */
  terapia: {
    id: string;
    tipo: TherapyKind;
    stato: 'active' | 'suspended' | 'ended';
    tipologia: TherapyOrigin | null;
    riservata: boolean;
    fine: string | null;
    motivoSospensione: string | null;
  } | null;
}

/** Una prestazione prescritta, come la restituisce il servizio (D152). */
export interface PrescribedService extends Counts {
  chiave: string;
  storico: HistoryKey;
  codice: string | null;
  descrizione: string;
  gruppo: 'visita' | 'altro';
}

/** I gruppi delle prestazioni, nell'ordine della cartella (stesse parole di @mmg/domain). */
export const SERVICE_GROUPS: ['visita' | 'altro', string][] = [
  ['visita', 'Visite'],
  ['altro', 'Esami e altre prestazioni'],
];

/** Dove si apre lo storico di una voce. */
export function historyHref(patientId: string, key: HistoryKey): string {
  if ('terapia' in key) return `/pazienti/${patientId}/terapie/${key.terapia}`;
  if ('prestazione' in key || 'descrizione' in key) {
    return `/pazienti/${patientId}/prestazioni${query(key)}`;
  }
  return `/pazienti/${patientId}/farmaci/storico${query(key)}`;
}

/** «2 fatte con un altro programma, l'ultima il 10/03/2025»; vuoto se non ce ne sono. */
export function pastCountsText(c: Counts): string {
  const n = c.altroProgramma?.ricette ?? 0;
  if (n === 0) return '';
  const when = c.altroProgramma?.ultimaIl ? date(c.altroProgramma.ultimaIl) : null;
  return n === 1
    ? `1 ricetta fatta con un altro programma${when ? `, il ${when}` : ''}`
    : `${n} ricette fatte con un altro programma${when ? `, l’ultima il ${when}` : ''}`;
}

/** «3 ricette, ultima il 12/10/2026 · 1 in preparazione · 2 fatte con un altro programma». */
export function countsText(c: Counts): string {
  const past = pastCountsText(c);
  if (c.ricette === 0) return past || 'nessuna ricetta';
  const parts = [
    `${c.prescritte === 1 ? '1 ricetta' : `${c.prescritte} ricette`} inviate o su carta`,
  ];
  if (c.ultimaIl) parts[0] += `, ultima il ${date(c.ultimaIl)}`;
  if (c.inPreparazione > 0) parts.push(`${c.inPreparazione} in preparazione`);
  if (c.annullate > 0)
    parts.push(`${c.annullate} ${c.annullate === 1 ? 'annullata' : 'annullate'}`);
  if (past) parts.push(past);
  return parts.join(' · ');
}

/**
 * Visite ed esami prescritti nella cartella (D152): divisi in due gruppi, ognuno con il suo
 * storico (D66).
 */
export function ServicesSection({
  patientId,
  services,
}: {
  patientId: string;
  services: Loaded<{ prestazioni: PrescribedService[] }>;
}) {
  const list = services.data?.prestazioni ?? [];
  return (
    <section className="riquadro" aria-labelledby="titolo-visite-esami">
      <h2 id="titolo-visite-esami">
        <Icon name="specialistica" /> Visite ed esami prescritti
      </h2>
      {services.loading && !services.data && <Loading what="prestazioni" />}
      {services.error?.status === 403 ? (
        <p className="tenue">Visite ed esami: non visibili con il tuo ruolo.</p>
      ) : (
        <ErrorMessage error={services.error} />
      )}
      {services.data && list.length === 0 && (
        <p className="tenue">Nessuna ricetta specialistica.</p>
      )}
      {SERVICE_GROUPS.map(([group, label]) => {
        const items = list.filter((x) => x.gruppo === group);
        if (items.length === 0) return null;
        return (
          <div key={group}>
            <h3>{label}</h3>
            <ul className="elenco-semplice">
              {items.map((x) => (
                <li key={x.chiave}>
                  <Link to={historyHref(patientId, x.storico)}>{x.descrizione}</Link>
                  {x.codice && <span className="codice tenue"> {x.codice}</span>}
                  <span className="tenue"> · {countsText(x)}</span>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
      <p>
        <Link to={`/pazienti/${patientId}/visite-ed-esami`}>
          Tutte le visite e gli esami prescritti
        </Link>
      </p>
    </section>
  );
}
