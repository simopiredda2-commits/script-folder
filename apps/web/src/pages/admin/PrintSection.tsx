import { useRef, useState, type FormEvent, type RefObject } from 'react';
import { ErrorMessage, Loading, Notice } from '../../components/common';
import { Icon } from '../../components/Icon';
import {
  forgetPrintPreferences,
  type EffectivePrint,
  type PrintKind,
  type PrintPreferences,
  type PrintSource,
} from '../../components/PrintHint';
import { api, ApiError } from '../../lib/api';
import { useSession } from '../../lib/session';
import { useApi, type Loaded } from '../../lib/useApi';
import { WorkstationsPanel } from './WorkstationsPanel';

interface Kind {
  codice: PrintKind;
  nome: string;
  descrizione: string;
  uscita: 'pdf' | 'pagina';
  /** Formati che si possono scegliere: vuoto se il formato è fissato. */
  carte: string[];
  /** Il formato di oggi; null se non lo decide il programma. */
  cartaPredefinita: string | null;
  fonteCarta: string;
  variante: boolean;
}
interface Values {
  stampante: string | null;
  carta: string | null;
  copie: number | null;
  variante: string | null;
}
interface Settings {
  tipi: Kind[];
  carte: { codice: string; nome: string }[];
  varianti: { codice: string; nome: string }[];
  limiti: { copies: { min: number; max: number }; printerName: number };
  predefinite: { copie: number; variante: string };
  studio: Record<PrintKind, Values>;
  postazioni: { id: string; nome: string; preferenze: Record<PrintKind, Values> }[];
  puoModificare: boolean;
}

/** Che cosa vale se un livello lascia vuoto: lo studio per una postazione, il predefinito per lo studio. */
interface Below {
  label: string;
  printer: string | null;
  copies: number;
  paper: string | null;
  variant: string | null;
}

const failure = (e: unknown) =>
  e instanceof ApiError ? e : new ApiError(0, 'Servizio non raggiungibile');

const SOURCE: Record<PrintSource, string> = {
  postazione: 'della postazione',
  studio: 'dello studio',
  predefinito: 'predefinita',
};
const VARIANT: Record<string, string> = {
  completo: 'Promemoria completo',
  solo_nre: 'Solo NRE e codice fiscale',
};
const copiesText = (n: number) => `${n} ${n === 1 ? 'copia' : 'copie'}`;
const capitalized = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
/** Stampante o carta che il programma non decide: la propone la finestra di stampa. */
const DIALOG_CHOICE = 'quella proposta dalla finestra di stampa';

/**
 * Postazioni dello studio e preferenze di stampa per tipo di documento (tappa 14). Ognuno vede che
 * cosa vale alla sua postazione e che cosa il programma può fare con le stampanti; l'amministratore
 * imposta le preferenze dello studio e quelle di ogni postazione. Valgono, campo per campo, la
 * postazione, poi lo studio, poi le predefinite.
 */
export function PrintSection() {
  const { isAdmin } = useSession();
  const mine = useApi<PrintPreferences>('/api/stampa/preferenze');
  return (
    <>
      <WorkstationsPanel />
      <section className="riquadro" aria-labelledby="titolo-stampa">
        <h2 id="titolo-stampa">
          <Icon name="stampa" /> Preferenze di stampa
        </h2>
        <p>
          Per ogni documento: la stampante consigliata, le copie, la carta dove il formato si può
          scegliere e, per il promemoria, che cosa proporre per primo. Vale la preferenza della
          postazione, se c’è; altrimenti quella dello studio; altrimenti la predefinita.
        </p>
        <PrinterLimits />
        <ThisWorkstation prefs={mine} />
        {isAdmin ? (
          <SettingsEditor
            onSaved={() => {
              forgetPrintPreferences();
              mine.reload();
            }}
          />
        ) : (
          <Notice kind="info">
            Le preferenze di stampa le cambia l’amministratore dello studio.
          </Notice>
        )}
      </section>
    </>
  );
}

/** Che cosa il programma può e non può fare con le stampanti, detto in modo semplice. */
function PrinterLimits() {
  return (
    <>
      <h3>Che cosa può fare il programma con le stampanti</h3>
      <Notice kind="info">
        <p>
          Prepara i documenti in PDF con le misure esatte del modello: escono uguali su ogni
          stampante.
        </p>
        <p>
          Ricorda, per ogni postazione e per ogni documento, la stampante consigliata, le copie, la
          carta dove il formato non è fissato e, per il promemoria, che cosa proporre per primo. Li
          mostra accanto ai pulsanti di stampa.
        </p>
        <p>
          Non vede le stampanti del computer, non ne sceglie una e non stampa senza la finestra di
          stampa: un programma che si usa dal browser non può farlo. Stampante, copie e carta si
          confermano nella finestra di stampa, ogni volta. Per questo il nome della stampante va
          scritto come compare in quella finestra.
        </p>
      </Notice>
    </>
  );
}

/** Le preferenze che valgono alla postazione di chi guarda, con da dove viene ogni valore. */
function ThisWorkstation({ prefs }: { prefs: Loaded<PrintPreferences> }) {
  if (prefs.loading && !prefs.data) return <Loading what="preferenze di questa postazione" />;
  if (!prefs.data) return <ErrorMessage error={prefs.error} />;
  const { postazione, preferenze } = prefs.data;
  return (
    <>
      <h3 id="titolo-stampa-postazione">Questa postazione</h3>
      <p>
        {postazione.riconosciuta ? (
          <>
            All’accesso è stata scritta «{postazione.scritta}»: è la postazione «
            {postazione.riconosciuta.nome}» dello studio.
          </>
        ) : (
          <>
            All’accesso è stata scritta «{postazione.scritta}», che non è tra le postazioni dello
            studio: valgono le preferenze dello studio.
          </>
        )}
      </p>
      <div className="tabella-scorrevole">
        <table className="tabella" aria-labelledby="titolo-stampa-postazione">
          <thead>
            <tr>
              <th scope="col">Documento</th>
              <th scope="col">Stampante</th>
              <th scope="col">Copie</th>
              <th scope="col">Carta</th>
              <th scope="col">Variante del promemoria</th>
            </tr>
          </thead>
          <tbody>
            {preferenze.map((p) => (
              <EffectiveRow key={p.tipo} p={p} />
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function EffectiveRow({ p }: { p: EffectivePrint }) {
  const from = (s: PrintSource) => <span className="tenue">({SOURCE[s]})</span>;
  return (
    <tr>
      <th scope="row">{p.nome}</th>
      <td>
        {p.stampante ?? capitalized(DIALOG_CHOICE)} {from(p.da.stampante)}
      </td>
      <td>
        {copiesText(p.copie)} {from(p.da.copie)}
      </td>
      <td>
        {p.carta && (
          <>
            {p.carta} {p.cartaScelta ? from(p.da.carta) : <span className="tenue">(fissata)</span>}
          </>
        )}
        {!p.carta && (p.cartaScelta ? capitalized(DIALOG_CHOICE) : 'Quella del documento')}
      </td>
      <td>
        {p.variante ? (
          <>
            {VARIANT[p.variante] ?? p.variante} {from(p.da.variante)}
          </>
        ) : (
          '—'
        )}
      </td>
    </tr>
  );
}

/**
 * Le preferenze dello studio e di ogni postazione, per l'amministratore: si sceglie di chi, poi
 * si modifica un documento alla volta. Un valore vuoto vuol dire «come il livello sotto».
 */
function SettingsEditor({ onSaved }: { onSaved: () => void }) {
  const settings = useApi<Settings>('/api/stampa/impostazioni');
  const [scope, setScope] = useState('');
  const [editing, setEditing] = useState<PrintKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const firstField = useRef<HTMLInputElement>(null);

  if (settings.loading && !settings.data) return <Loading what="preferenze di stampa" />;
  if (!settings.data) return <ErrorMessage error={settings.error} />;
  const data = settings.data;
  // Una postazione archiviata nel frattempo sparisce dall'elenco: si torna allo studio.
  const station = data.postazioni.find((p) => p.id === scope) ?? null;
  const own = station ? station.preferenze : data.studio;
  const where = station ? `della postazione «${station.nome}»` : 'dello studio';
  const kind = data.tipi.find((k) => k.codice === editing) ?? null;
  const paperName = (code: string) => data.carte.find((p) => p.codice === code)?.nome ?? code;

  const below = (k: Kind): Below => {
    const st = data.studio[k.codice];
    const from = <T,>(studioValue: T | null, fallback: T): T =>
      station && studioValue !== null ? studioValue : fallback;
    return {
      label: station ? 'come lo studio' : 'predefinita',
      printer: from(st.stampante, null as string | null),
      copies: from(st.copie, data.predefinite.copie),
      paper: from(k.carte.length ? st.carta : null, k.cartaPredefinita),
      variant: from(k.variante ? st.variante : null, k.variante ? data.predefinite.variante : null),
    };
  };

  function edit(k: PrintKind) {
    setEditing(k);
    setDone(null);
    setError(null);
    // Il modulo compare sotto la tabella: il cursore va sulla stampante, da lì si continua.
    setTimeout(() => firstField.current?.focus(), 0);
  }

  async function save(k: Kind, body: Values) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await api('/api/stampa/impostazioni', {
        method: 'PUT',
        body: { postazione: station?.id ?? null, tipo: k.codice, ...body },
      });
      setDone(`Preferenze ${where} per «${k.nome}» salvate.`);
      setEditing(null);
      settings.reload();
      onSaved();
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  }

  const inherited = (b: Below, text: string) => (
    <span className="tenue">
      {capitalized(b.label)}: {text}
    </span>
  );

  return (
    <>
      <h3>Preferenze dello studio e delle postazioni</h3>
      <div className="campo">
        <label htmlFor="stampa-ambito">Preferenze di</label>
        <select
          id="stampa-ambito"
          value={station?.id ?? ''}
          aria-describedby="stampa-ambito-aiuto"
          onChange={(e) => {
            setScope(e.target.value);
            setEditing(null);
            setDone(null);
            setError(null);
          }}
        >
          <option value="">Tutto lo studio</option>
          {data.postazioni.map((p) => (
            <option key={p.id} value={p.id}>
              Postazione «{p.nome}»
            </option>
          ))}
        </select>
        <p className="aiuto" id="stampa-ambito-aiuto">
          Le preferenze dello studio valgono su ogni postazione che non ha le sue; quello che una
          postazione lascia vuoto lo prende dallo studio.
        </p>
      </div>
      <div className="tabella-scorrevole">
        <table className="tabella">
          <caption>Preferenze {where}</caption>
          <thead>
            <tr>
              <th scope="col">Documento</th>
              <th scope="col">Carta</th>
              <th scope="col">Stampante</th>
              <th scope="col">Copie</th>
              <th scope="col">Variante del promemoria</th>
              <th scope="col">Azioni</th>
            </tr>
          </thead>
          <tbody>
            {data.tipi.map((k) => {
              const v = own[k.codice];
              const b = below(k);
              return (
                <tr key={k.codice}>
                  <th scope="row">{k.nome}</th>
                  <td>
                    {k.carte.length === 0
                      ? `${k.cartaPredefinita ?? 'Quella del documento'}, fissata`
                      : (v.carta ?? inherited(b, b.paper ?? DIALOG_CHOICE))}
                  </td>
                  <td>{v.stampante ?? inherited(b, b.printer ?? 'nessuna')}</td>
                  <td>
                    {v.copie !== null ? copiesText(v.copie) : inherited(b, copiesText(b.copies))}
                  </td>
                  <td>
                    {!k.variante
                      ? '—'
                      : v.variante
                        ? (VARIANT[v.variante] ?? v.variante)
                        : inherited(b, VARIANT[b.variant ?? ''] ?? '—')}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="pulsante"
                      disabled={busy}
                      aria-label={`Modifica le preferenze ${where} per «${k.nome}»`}
                      onClick={() => edit(k.codice)}
                    >
                      Modifica
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {done && <Notice kind="fatto">{done}</Notice>}
      {kind && (
        <SettingForm
          key={`${station?.id ?? 'studio'}-${kind.codice}`}
          kind={kind}
          values={own[kind.codice]}
          below={below(kind)}
          where={where}
          limits={data.limiti}
          paperName={paperName}
          busy={busy}
          firstField={firstField}
          onCancel={() => setEditing(null)}
          onSubmit={(body) => void save(kind, body)}
        />
      )}
      <ErrorMessage error={error} />
    </>
  );
}

function SettingForm({
  kind,
  values,
  below,
  where,
  limits,
  paperName,
  busy,
  firstField,
  onCancel,
  onSubmit,
}: {
  kind: Kind;
  values: Values;
  below: Below;
  where: string;
  limits: Settings['limiti'];
  paperName: (code: string) => string;
  busy: boolean;
  firstField: RefObject<HTMLInputElement | null>;
  onCancel: () => void;
  onSubmit: (body: Values) => void;
}) {
  const [printer, setPrinter] = useState(values.stampante ?? '');
  const [copies, setCopies] = useState(values.copie === null ? '' : String(values.copie));
  const [paper, setPaper] = useState(values.carta ?? '');
  const [variant, setVariant] = useState(values.variante ?? '');
  const copyChoices = Array.from(
    { length: limits.copies.max - limits.copies.min + 1 },
    (_, i) => limits.copies.min + i,
  );
  const empty = capitalized(below.label);

  function submit(e: FormEvent) {
    e.preventDefault();
    onSubmit({
      stampante: printer.trim() || null,
      copie: copies ? Number(copies) : null,
      carta: kind.carte.length > 0 && paper ? paper : null,
      variante: kind.variante && variant ? variant : null,
    });
  }

  const variants: [string, string][] = [
    ['', `${empty}: ${VARIANT[below.variant ?? ''] ?? '—'}`],
    ['completo', 'Promemoria completo'],
    ['solo_nre', 'Solo NRE e codice fiscale'],
  ];

  return (
    <form className="modulo" onSubmit={submit} aria-labelledby="titolo-stampa-documento">
      <h3 id="titolo-stampa-documento">
        {kind.nome}: preferenze {where}
      </h3>
      <p className="aiuto">{kind.descrizione}</p>
      <fieldset disabled={busy}>
        <legend className="visivamente-nascosto">Preferenze del documento</legend>
        <div className="campo">
          <label htmlFor="stampa-stampante">Stampante consigliata</label>
          <input
            id="stampa-stampante"
            ref={firstField}
            maxLength={limits.printerName}
            autoComplete="off"
            aria-describedby="stampa-stampante-aiuto"
            value={printer}
            onChange={(e) => setPrinter(e.target.value)}
          />
          <p className="aiuto" id="stampa-stampante-aiuto">
            Il nome come compare nella finestra di stampa del computer. Vuoto: {below.label},{' '}
            {below.printer ? `«${below.printer}»` : 'nessuna stampante consigliata'}.
          </p>
        </div>
        <div className="campi-in-riga">
          <div className="campo campo-stretto">
            <label htmlFor="stampa-copie">Copie</label>
            <select id="stampa-copie" value={copies} onChange={(e) => setCopies(e.target.value)}>
              <option value="">
                {empty}: {copiesText(below.copies)}
              </option>
              {copyChoices.map((n) => (
                <option key={n} value={String(n)}>
                  {copiesText(n)}
                </option>
              ))}
            </select>
          </div>
          {kind.carte.length > 0 && (
            <div className="campo">
              <label htmlFor="stampa-carta">Carta</label>
              <select
                id="stampa-carta"
                value={paper}
                aria-describedby="stampa-carta-aiuto"
                onChange={(e) => setPaper(e.target.value)}
              >
                <option value="">
                  {empty}: {below.paper ? paperName(below.paper) : DIALOG_CHOICE}
                </option>
                {kind.carte.map((c) => (
                  <option key={c} value={c}>
                    {paperName(c)}
                  </option>
                ))}
              </select>
              <p className="aiuto" id="stampa-carta-aiuto">
                {kind.fonteCarta}
              </p>
            </div>
          )}
        </div>
        {kind.carte.length === 0 && (
          <p>
            <strong>Carta:</strong>{' '}
            {kind.cartaPredefinita ? paperName(kind.cartaPredefinita) : 'quella del documento'}, non
            si sceglie. <span className="tenue">{kind.fonteCarta}</span>
          </p>
        )}
        {kind.variante && (
          <fieldset className="scelta-in-riga">
            <legend>Che cosa proporre per primo</legend>
            {variants.map(([code, label]) => (
              <div className="casella" key={code || 'vuoto'}>
                <input
                  id={`stampa-variante-${code || 'vuoto'}`}
                  type="radio"
                  name="stampa-variante"
                  checked={variant === code}
                  onChange={() => setVariant(code)}
                />
                <label htmlFor={`stampa-variante-${code || 'vuoto'}`}>{label}</label>
              </div>
            ))}
          </fieldset>
        )}
        <div className="azioni">
          <button type="submit" className="pulsante pulsante-primario">
            <Icon name="fatto" /> <span>Salva le preferenze</span>
          </button>
          <button type="button" className="pulsante pulsante-piatto" onClick={onCancel}>
            <Icon name="annulla" /> <span>Annulla la modifica</span>
          </button>
        </div>
      </fieldset>
    </form>
  );
}
