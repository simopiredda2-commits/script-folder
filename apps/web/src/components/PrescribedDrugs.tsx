import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { query } from '../lib/api';
import { date, PRESCRIPTION_STATUS, THERAPY_KIND } from '../lib/format';
import { useApi } from '../lib/useApi';
import { ErrorMessage, Loading } from './common';
import { drugRowClass, type TherapyOrigin } from './DrugColours';
import { Icon } from './Icon';
import { countsText, historyHref, type PrescribedDrug } from './Prescribed';

const THERAPY_STATUS: Record<string, string> = {
  suspended: 'Sospesa',
  ended: 'Conclusa',
};

/** S e H in breve sulla riga chiusa: la legenda e i dettagli le dicono per intero. */
const ORIGIN_SHORT: Record<TherapyOrigin, { text: string; label: string }> = {
  S: { text: 'S', label: 'Suggerita dallo specialista' },
  H: { text: 'H', label: 'Da ricovero' },
};

/** «1 confezione», «2 confezioni»; una ricetta passata può non dirlo. */
export const packages = (n: number | null) =>
  n === null ? 'confezioni non indicate' : n === 1 ? '1 confezione' : `${n} confezioni`;

/**
 * I gruppi della pagina dei farmaci prescritti (D152): 0 le terapie in corso, 1 quelle sospese o
 * concluse, 2 i farmaci prescritti senza terapia.
 */
export const drugGroup = (d: PrescribedDrug): 0 | 1 | 2 =>
  !d.terapia ? 2 : d.terapia.stato === 'active' ? 0 : 1;

/**
 * I gruppi uno dopo l'altro, come nella pagina, anche nella ricetta (D246): una terapia sospesa
 * con una ricetta recente non passa davanti a quelle in corso. Dentro ogni gruppo resta l'ordine
 * del servizio, dall'ultima ricetta più recente (D245).
 */
export const byGroup = (drugs: readonly PrescribedDrug[]) =>
  [...drugs].sort((a, b) => drugGroup(a) - drugGroup(b));

/** Le ricette di una voce, dentro la voce aperta (D246): le ultime, con lo stato e l'NRE. */
interface HistoryEntry {
  ricetta: {
    id: string;
    stato: string;
    nre: string | null;
    preparataIl: string;
    inviataIl: string | null;
    cartaceaIl: string | null;
    annullataIl: string | null;
  };
  riga: { farmaco: string | null; quantita: number };
}

interface History {
  ultimi12Mesi: number;
  voci: HistoryEntry[];
  ricettePassate?: {
    id: string;
    data: string;
    quantita: number | null;
    annullataIl?: string | null;
  }[];
}

/** Quante ricette si vedono dentro la voce; le altre nella scheda. */
const SHOWN = 5;

function InlineHistory({ patientId, d }: { patientId: string; d: PrescribedDrug }) {
  const history = useApi<History>(
    `/api/pazienti/${patientId}/storico-prescrizioni${query(d.storico)}`,
  );
  if (history.loading && !history.data) return <Loading what="storico" />;
  if (!history.data) return <ErrorMessage error={history.error} />;
  const voci = history.data.voci;
  const past = history.data.ricettePassate ?? [];
  if (voci.length === 0 && past.length === 0)
    return <p className="tenue">Nessuna ricetta di questo farmaco.</p>;
  const lines = [
    ...voci.slice(0, SHOWN).map((v) => ({
      key: `${v.ricetta.id}-${v.riga.farmaco ?? ''}`,
      day: v.ricetta.inviataIl ?? v.ricetta.cartaceaIl ?? v.ricetta.preparataIl,
      quantity: v.riga.quantita,
      status: PRESCRIPTION_STATUS[v.ricetta.stato] ?? v.ricetta.stato,
      nre: v.ricetta.nre,
    })),
    ...past.slice(0, Math.max(0, SHOWN - voci.length)).map((r) => ({
      key: r.id,
      day: r.data,
      quantity: r.quantita,
      status: r.annullataIl ? 'Annullata' : 'Con un altro programma',
      nre: null,
    })),
  ];
  // Una riga per ricetta, che va a capo fra un dato e l'altro e mai dentro un dato: nella colonna
  // stretta della ricetta una tabella a quattro colonne usciva dal riquadro (D249). La tabella
  // intera è nello storico completo.
  return (
    <ul className="ricette-in-riga" aria-label={`Ultime ricette di ${d.farmaco}`}>
      {lines.map((l) => (
        <li key={l.key}>
          <span className="farmaco-ultima-data">{date(l.day)}</span> ·{' '}
          <span>{packages(l.quantity)}</span> · <span>{l.status}</span>
          {l.nre && (
            <>
              {' '}
              · <span className="codice">NRE {l.nre}</span>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Un farmaco prescritto in una riga sola (D246): in vista il nome, come si prende (cronica,
 * ciclo, al bisogno; S o H; sospesa o conclusa) e l'ultima ricetta con le confezioni; il resto,
 * con lo storico, si apre col «+» del nome. `action` è il pulsante della riga, per esempio
 * «Aggiungi» nella ricetta.
 */
export function PrescribedDrugItem({
  d,
  patientId,
  action,
}: {
  d: PrescribedDrug;
  patientId: string;
  action?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const details = useId();
  const t = d.terapia;
  const last = d.ultimaPrescrizione;
  const origin = t?.tipologia ? ORIGIN_SHORT[t.tipologia] : null;
  return (
    <li className={`${drugRowClass(t)} farmaco-voce`}>
      <button
        type="button"
        className="farmaco-apri"
        aria-expanded={open}
        aria-controls={details}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon name={open ? 'comprimi' : 'espandi'} />
        <span className="farmaco-nome">{d.farmaco}</span>
      </button>
      <span className="farmaco-tipo">
        {/* Come si prende lo dicono sfondo e tratto della barra, spiegati dalla legenda: la
            parola solo per chi usa un lettore di schermo (D248). Senza terapia, la parola si vede. */}
        {t ? (
          <span className="visivamente-nascosto">{THERAPY_KIND[t.tipo]}</span>
        ) : (
          <span className="etichetta">Senza terapia</span>
        )}
        {origin && (
          <span className="etichetta etichetta-tipologia" title={origin.label}>
            <span aria-hidden="true">{origin.text}</span>
            <span className="visivamente-nascosto">{origin.label}</span>
          </span>
        )}
        {t && THERAPY_STATUS[t.stato] && (
          <span className="etichetta">{THERAPY_STATUS[t.stato]}</span>
        )}
        {t?.riservata && <span className="etichetta">Riservata</span>}
      </span>
      {action && <span className="farmaco-azione">{action}</span>}
      <p className="farmaco-ultima">
        <span className="farmaco-ultima-titolo">Ultima ricetta</span>
        {last ? (
          <span>
            <span className="farmaco-ultima-data">{date(last.il)}</span> · {packages(last.quantita)}
          </span>
        ) : (
          <span className="tenue">nessuna</span>
        )}
        {last?.altroProgramma && <span className="tenue">con un altro programma</span>}
      </p>
      <div id={details} className="farmaco-dettagli" hidden={!open}>
        {open && (
          <>
            <p className="farmaco-conti">
              {d.principioAttivo && d.principioAttivo.toLowerCase() !== d.farmaco.toLowerCase() && (
                <span>Principio attivo: {d.principioAttivo}</span>
              )}
              {d.aic && <span className="codice">AIC {d.aic}</span>}
              {d.notaAifa && <span>Nota AIFA {d.notaAifa}</span>}
              <span>
                {countsText({ ...d, ultimaIl: null })}
                {d.ultimi12Mesi > 0 && ` · ${packages(d.ultimi12Mesi)} negli ultimi 12 mesi`}
              </span>
              {t?.stato === 'active' && t.tipo === 'cycle' && t.fine && (
                <span>Ciclo fino al {date(t.fine)}</span>
              )}
              {t?.stato === 'ended' && t.fine && <span>Conclusa il {date(t.fine)}</span>}
              {t?.motivoSospensione && <span>Sospesa: {t.motivoSospensione}</span>}
            </p>
            <InlineHistory patientId={patientId} d={d} />
            <Link to={historyHref(patientId, d.storico)} className="pulsante pulsante-piatto">
              <Icon name="storico" />{' '}
              <span>{t ? 'Scheda e storico completo' : 'Storico completo'}</span>
            </Link>
          </>
        )}
      </div>
    </li>
  );
}

/**
 * «Aggiungi» di un farmaco prescritto (D249): c'è su ogni farmaco, scritto più piccolo, con il
 * bersaglio sempre di 44 px. Il nome del farmaco è per chi usa un lettore di schermo.
 */
export function AddDrugButton({
  name,
  disabled,
  onClick,
}: {
  name: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="pulsante pulsante-piccolo"
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name="aggiungi" size={16} /> <span>Aggiungi</span>
      <span className="visivamente-nascosto"> {name}</span>
    </button>
  );
}

/** Confezioni di una riga: da 1 a 99, come il campo della riga in ricetta. */
export const MAX_PACKS = 99;

/**
 * Le confezioni di un farmaco già in ricetta (D250): «−» e «+» al posto di «Aggiungi», così una
 * riga non si ripete e il numero cambia dove si sceglie il farmaco. Almeno una confezione; la
 * riga si toglie dalla ricetta.
 */
export function PackStepper({
  name,
  quantity,
  disabled,
  autoFocus,
  onChange,
}: {
  name: string;
  quantity: number;
  disabled?: boolean;
  /** Appena aggiunto il farmaco: il fuoco viene qui, al posto di «Aggiungi» (audit 14, D259). */
  autoFocus?: boolean;
  onChange: (quantity: number) => void;
}) {
  const more = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (autoFocus) more.current?.focus();
    // Solo alla comparsa: poi il fuoco lo decide chi usa la pagina.
  }, []);
  return (
    <span className="confezioni-passo" role="group" aria-label={`Confezioni di ${name} in ricetta`}>
      <button
        type="button"
        className="pulsante pulsante-piccolo"
        disabled={disabled || quantity <= 1}
        onClick={() => onChange(quantity - 1)}
        aria-label={`Una confezione in meno di ${name}`}
      >
        <span aria-hidden="true">−</span>
      </button>
      <span className="confezioni-numero" aria-live="polite">
        <span aria-hidden="true">{quantity} conf.</span>
        <span className="visivamente-nascosto">{packages(quantity)} in ricetta</span>
      </span>
      <button
        type="button"
        className="pulsante pulsante-piccolo"
        ref={more}
        disabled={disabled || quantity >= MAX_PACKS}
        onClick={() => onChange(quantity + 1)}
        aria-label={`Una confezione in più di ${name}`}
      >
        <span aria-hidden="true">+</span>
      </button>
    </span>
  );
}

/** I farmaci prescritti, una riga ciascuno, nell'ordine del servizio (D245). */
export function PrescribedDrugList({
  drugs,
  patientId,
  label,
  action,
}: {
  drugs: PrescribedDrug[];
  patientId: string;
  /** L'id del titolo che dà il nome all'elenco. */
  label: string;
  action?: (d: PrescribedDrug) => ReactNode;
}) {
  return (
    <ul className="elenco-farmaci" aria-labelledby={label}>
      {drugs.map((d) => (
        <PrescribedDrugItem key={d.chiave} d={d} patientId={patientId} action={action?.(d)} />
      ))}
    </ul>
  );
}
