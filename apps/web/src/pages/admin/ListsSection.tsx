import { useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { useSearchParams } from 'react-router';
import { ErrorMessage, Loading, Notice } from '../../components/common';
import { Icon } from '../../components/Icon';
import { ServiceResultText, type ServiceResultData } from '../../components/ServiceResult';
import { api, ApiError, query } from '../../lib/api';
import { useCatalog } from '../../lib/clinical';
import { date } from '../../lib/format';
import {
  count,
  useStudioList,
  type ListItem,
  type PackageService,
  type Posology,
  type StudioListKind,
  type StudioLists,
  type Suggestor,
  type UsefulContact,
} from '../../lib/studio-lists';
import { DOSE_UNITS, FREQUENCIES, patientReading, ROUTES, TIMES_OF_DAY } from '../../lib/therapy';
import { useApi } from '../../lib/useApi';
import { useDebounced } from '../PrescriptionEditor';

interface KindInfo {
  key: StudioListKind;
  label: string;
  /** Il nome di una voce, all'inizio dei messaggi. */
  item: string;
  feminine: boolean;
  newTitle: string;
  intro: string;
}

/** I quattro elenchi, con a che cosa servono e dove si usano. */
const KINDS: KindInfo[] = [
  {
    key: 'suggeritore',
    label: 'Medici suggeritori',
    item: 'Medico suggeritore',
    feminine: false,
    newTitle: 'Nuovo medico suggeritore',
    intro:
      'Gli specialisti e i reparti da cui arrivano le terapie. Nella scheda della terapia, scegliendone uno si riempiono medico e struttura, che servono alla ricetta «Suggerita (S)».',
  },
  {
    key: 'posologia',
    label: 'Posologie',
    item: 'Posologia',
    feminine: true,
    newTitle: 'Nuova posologia',
    intro:
      'Le posologie che lo studio usa spesso. Con le parti (dose, unità, frequenza, momento, via), nella scheda della terapia riempiono i campi di «Come si prende», che alimentano il contatore delle confezioni (R11). Il testo si propone anche nella posologia delle righe della ricetta.',
  },
  {
    key: 'pacchetto',
    label: 'Pacchetti di prestazioni',
    item: 'Pacchetto',
    feminine: false,
    newTitle: 'Nuovo pacchetto di prestazioni',
    intro:
      'Gruppi di prestazioni del catalogo regionale, per esempio il controllo del diabete: nella ricetta specialistica, «Aggiungi un pacchetto» le mette in ricetta tutte insieme. Si compongono cercando le prestazioni nel catalogo in vigore.',
  },
  {
    key: 'contatto',
    label: 'Contatti utili',
    item: 'Contatto',
    feminine: false,
    newTitle: 'Nuovo contatto',
    intro: 'Strutture, specialisti, laboratori e altri recapiti che lo studio usa.',
  },
];

const failure = (e: unknown) =>
  e instanceof ApiError ? e : new ApiError(0, 'Servizio non raggiungibile');

const dash = (v: string | null | undefined) => v || '—';
const code = (c: string) => c.trim().toUpperCase();

/** Le voci dell'elenco, più il valore già salvato se non è tra queste (non si perde). */
function choices(list: readonly string[], current: string): string[] {
  return current && !list.includes(current) ? [...list, current] : [...list];
}

/**
 * Elenchi dello studio (tappa 14): medici suggeritori, posologie, pacchetti di prestazioni,
 * contatti utili. Li vedono tutti; li aggiungono, li modificano e li archiviano i medici e
 * l'amministratore. Non si cancellano: archiviata, una voce resta nello storico e non si propone
 * più nelle schede e nelle ricette.
 */
export function ListsSection() {
  const [params, setParams] = useSearchParams();
  const current = KINDS.find((k) => k.key === params.get('elenco')) ?? KINDS[0]!;
  const choose = (kind: StudioListKind) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        next.set('elenco', kind);
        return next;
      },
      { replace: true },
    );
  return (
    <section className="riquadro" aria-labelledby="titolo-elenchi">
      <h2 id="titolo-elenchi">
        <Icon name="terapia" /> Elenchi dello studio
      </h2>
      <p>
        Gli elenchi che lo studio usa nelle schede e nelle ricette. Li consultano tutti; li
        aggiornano i medici e l’amministratore. Una voce non si cancella: si archivia, e non si
        propone più.
      </p>
      <div className="schede" role="group" aria-label="Elenco dello studio">
        {KINDS.map((k) => (
          <button
            key={k.key}
            type="button"
            className="scheda"
            aria-pressed={current.key === k.key}
            onClick={() => choose(k.key)}
          >
            {k.label}
          </button>
        ))}
      </div>
      <KindPanel key={current.key} kind={current} />
    </section>
  );
}

function KindPanel({ kind }: { kind: KindInfo }) {
  const list = useStudioList(kind.key);
  const [editing, setEditing] = useState<ListItem | null>(null);
  // Dopo un salvataggio il modulo riparte vuoto.
  const [formKey, setFormKey] = useState(0);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const firstField = useRef<HTMLInputElement>(null);

  async function run(fn: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await fn();
      setDone(message);
      setEditing(null);
      setFormKey((k) => k + 1);
      list.reload();
      return true;
    } catch (e) {
      setError(failure(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function edit(item: ListItem) {
    setEditing(item);
    setDone(null);
    setError(null);
    // Il modulo cambia sotto la tabella: il cursore va sul primo campo, da lì si continua.
    setTimeout(() => firstField.current?.focus(), 0);
  }

  function archive(item: ListItem) {
    if (
      !window.confirm(
        `Archiviare «${item.etichetta}»? Non si propone più nelle schede e nelle ricette; resta nello storico.`,
      )
    )
      return;
    void run(
      () => api(`/api/studio/elenchi/${item.id}/archivia`, { method: 'POST', body: {} }),
      `${kind.item} «${item.etichetta}» ${kind.feminine ? 'archiviata' : 'archiviato'}.`,
    );
  }

  if (list.loading && !list.data) return <Loading what="dati dell’elenco" />;
  if (!list.data) return <ErrorMessage error={list.error} />;
  const data = list.data;

  return (
    <div>
      <h3>{kind.label}</h3>
      <p>{kind.intro}</p>
      {kind.key === 'pacchetto' && data.catalogo === false && (
        <Notice kind="avviso">
          Nessun catalogo delle prestazioni in uso: i pacchetti si compongono dal catalogo, che si
          importa con le banche dati (Strumenti › Banche dati).
        </Notice>
      )}
      <ItemsTable kind={kind} data={data} busy={busy} onEdit={edit} onArchive={archive} />
      {done && <Notice kind="fatto">{done}</Notice>}
      {data.puoModificare ? (
        <ItemForm
          key={editing?.id ?? `nuova-${formKey}`}
          kind={kind}
          data={data}
          editing={editing}
          busy={busy}
          firstField={firstField}
          onCancel={() => setEditing(null)}
          onSubmit={(dati, label) =>
            run(
              () =>
                editing
                  ? api(`/api/studio/elenchi/${editing.id}`, { method: 'PATCH', body: { dati } })
                  : api('/api/studio/elenchi', { method: 'POST', body: { tipo: kind.key, dati } }),
              `${kind.item} «${label}» ${
                editing
                  ? kind.feminine
                    ? 'salvata'
                    : 'salvato'
                  : kind.feminine
                    ? 'aggiunta'
                    : 'aggiunto'
              }.`,
            )
          }
        />
      ) : (
        <Notice kind="info">
          Gli elenchi dello studio li aggiornano i medici e l’amministratore: qui si consultano.
        </Notice>
      )}
      <ErrorMessage error={error} />
      {data.archiviate.length > 0 && (
        <details className="storia">
          <summary>Voci archiviate ({data.archiviate.length})</summary>
          <ul>
            {data.archiviate.map((v) => (
              <li key={v.id}>
                {v.etichetta} <span className="tenue">archiviata il {date(v.archiviataIl)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** Le colonne di ogni elenco: la prima nomina la voce. */
function columns(
  kind: StudioListKind,
  data: StudioLists,
): { heads: string[]; cells: (item: ListItem) => ReactNode[] } {
  switch (kind) {
    case 'suggeritore':
      return {
        heads: ['Medico', 'Specialità', 'Struttura', 'Telefono'],
        cells: (item) => {
          const d = item.dati as Suggestor;
          return [d.nome, dash(d.specialita), dash(d.struttura), dash(d.telefono)];
        },
      };
    case 'posologia':
      return {
        heads: ['Posologia', 'Parti per la scheda della terapia'],
        cells: (item) => {
          const d = item.dati as Posology;
          const parts = [d.dose && `dose ${d.dose}`, d.unita, d.frequenza, d.momento, d.via]
            .filter(Boolean)
            .join(' · ');
          return [d.testo, parts || 'Solo testo: si propone nelle righe della ricetta'];
        },
      };
    case 'pacchetto':
      return {
        heads: ['Pacchetto', 'Prestazioni'],
        cells: (item) => [
          item.etichetta,
          <PackageServices key="prestazioni" item={item as ListItem<'pacchetto'>} />,
        ],
      };
    case 'contatto':
      return {
        heads: ['Nome', 'Tipo', 'Telefono', 'Email', 'Indirizzo', 'Note'],
        cells: (item) => {
          const d = item.dati as UsefulContact;
          const tipo = data.tipiContatto.find((k) => k.codice === d.tipo)?.nome ?? d.tipo;
          return [d.nome, tipo, dash(d.telefono), dash(d.email), dash(d.indirizzo), dash(d.note)];
        },
      };
  }
}

function ItemsTable({
  kind,
  data,
  busy,
  onEdit,
  onArchive,
}: {
  kind: KindInfo;
  data: StudioLists;
  busy: boolean;
  onEdit: (item: ListItem) => void;
  onArchive: (item: ListItem) => void;
}) {
  if (data.voci.length === 0) return <p className="tenue">Nessuna voce nell’elenco.</p>;
  const { heads, cells } = columns(kind.key, data);
  return (
    <div className="tabella-scorrevole">
      <table className="tabella">
        <caption>{kind.label} in uso</caption>
        <thead>
          <tr>
            {heads.map((h) => (
              <th key={h} scope="col">
                {h}
              </th>
            ))}
            {data.puoModificare && <th scope="col">Azioni</th>}
          </tr>
        </thead>
        <tbody>
          {data.voci.map((item) => {
            const [first, ...rest] = cells(item);
            return (
              <tr key={item.id}>
                <th scope="row">{first}</th>
                {rest.map((c, i) => (
                  <td key={heads[i + 1]}>{c}</td>
                ))}
                {data.puoModificare && (
                  <td>
                    <div className="azioni">
                      <button
                        type="button"
                        className="pulsante"
                        disabled={busy}
                        aria-label={`Modifica «${item.etichetta}»`}
                        onClick={() => onEdit(item)}
                      >
                        Modifica
                      </button>
                      <button
                        type="button"
                        className="pulsante pulsante-piatto"
                        disabled={busy}
                        aria-label={`Archivia «${item.etichetta}»`}
                        onClick={() => onArchive(item)}
                      >
                        <Icon name="archivio" /> <span>Archivia</span>
                      </button>
                    </div>
                  </td>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Le prestazioni di un pacchetto, con quelle che il catalogo in vigore non ha più. */
function PackageServices({ item }: { item: ListItem<'pacchetto'> }) {
  const checks = item.catalogo?.prestazioni ?? null;
  return (
    <>
      <ul>
        {item.dati.prestazioni.map((s) => {
          const out =
            checks !== null && !checks.find((c) => code(c.codice) === code(s.codice))?.voce;
          return (
            <li key={s.codice}>
              <span className="codice">{s.codice}</span> {s.descrizione}
              {out && (
                <strong>
                  {' '}
                  · <Icon name="avviso" size={18} /> non è nel catalogo in vigore: in ricetta non si
                  aggiunge
                </strong>
              )}
            </li>
          );
        })}
      </ul>
      {item.catalogo === null && (
        <p className="aiuto">Nessun catalogo in uso: le prestazioni non si possono controllare.</p>
      )}
    </>
  );
}

interface FormProps {
  kind: KindInfo;
  data: StudioLists;
  editing: ListItem | null;
  busy: boolean;
  firstField: RefObject<HTMLInputElement | null>;
  onCancel: () => void;
  onSubmit: (dati: object, label: string) => Promise<boolean>;
}

function ItemForm(props: FormProps) {
  switch (props.kind.key) {
    case 'suggeritore':
      return <SuggestorForm {...props} />;
    case 'posologia':
      return <PosologyForm {...props} />;
    case 'pacchetto':
      return <PackageForm {...props} />;
    case 'contatto':
      return <ContactForm {...props} />;
  }
}

/** Il modulo di una voce: titolo, campi, salva o annulla la modifica. */
function FormFrame({
  kind,
  editing,
  busy,
  onCancel,
  onSubmit,
  children,
}: Pick<FormProps, 'kind' | 'editing' | 'busy' | 'onCancel'> & {
  onSubmit: (e: FormEvent) => void;
  children: ReactNode;
}) {
  const titleId = `titolo-modulo-${kind.key}`;
  return (
    <form className="modulo" onSubmit={onSubmit} aria-labelledby={titleId}>
      <h4 id={titleId}>{editing ? `Modifica «${editing.etichetta}»` : kind.newTitle}</h4>
      <fieldset disabled={busy}>
        <legend className="visivamente-nascosto">Dati della voce</legend>
        {children}
        <div className="azioni">
          <button type="submit" className="pulsante pulsante-primario">
            <Icon name={editing ? 'fatto' : 'aggiungi'} />{' '}
            <span>{editing ? 'Salva le modifiche' : 'Aggiungi all’elenco'}</span>
          </button>
          {editing && (
            <button type="button" className="pulsante pulsante-piatto" onClick={onCancel}>
              <Icon name="annulla" /> <span>Annulla la modifica</span>
            </button>
          )}
        </div>
      </fieldset>
    </form>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  max,
  required,
  help,
  type = 'text',
  inputRef,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  max: number;
  required?: boolean;
  help?: string;
  type?: 'text' | 'tel' | 'email';
  inputRef?: RefObject<HTMLInputElement | null>;
}) {
  return (
    <div className="campo">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        ref={inputRef}
        type={type}
        required={required}
        maxLength={max}
        autoComplete="off"
        aria-describedby={help ? `${id}-aiuto` : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      {help && (
        <p className="aiuto" id={`${id}-aiuto`}>
          {help}
        </p>
      )}
    </div>
  );
}

function SuggestorForm(props: FormProps) {
  const e = props.editing?.dati as Suggestor | undefined;
  const L = props.data.limiti;
  const [f, setF] = useState({
    nome: e?.nome ?? '',
    specialita: e?.specialita ?? '',
    struttura: e?.struttura ?? '',
    telefono: e?.telefono ?? '',
  });
  const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    void props.onSubmit(f, f.nome.trim());
  };
  return (
    <FormFrame {...props} onSubmit={submit}>
      <TextField
        id="suggeritore-nome"
        label="Nome del medico"
        required
        max={L.name}
        value={f.nome}
        onChange={set('nome')}
        inputRef={props.firstField}
        help="Come va sulla ricetta: titolo, nome e cognome."
      />
      <div className="campi-in-riga">
        <TextField
          id="suggeritore-specialita"
          label="Specialità (facoltativa)"
          max={L.specialty}
          value={f.specialita}
          onChange={set('specialita')}
        />
        <TextField
          id="suggeritore-struttura"
          label="Struttura (facoltativa)"
          max={L.facility}
          value={f.struttura}
          onChange={set('struttura')}
          help="Ospedale, reparto o ambulatorio."
        />
        <TextField
          id="suggeritore-telefono"
          label="Telefono (facoltativo)"
          type="tel"
          max={L.phone}
          value={f.telefono}
          onChange={set('telefono')}
        />
      </div>
    </FormFrame>
  );
}

type PartKey = 'dose' | 'unita' | 'frequenza' | 'momento' | 'via';

function PosologyForm(props: FormProps) {
  // Le vie con il codice del dizionario ufficiale, come nella scheda della terapia (tappa 11).
  const routes = useCatalog().data?.vieSomministrazione ?? ROUTES;
  const e = props.editing?.dati as Posology | undefined;
  const L = props.data.limiti;
  const [testo, setTesto] = useState(e?.testo ?? '');
  const [parts, setParts] = useState<Record<PartKey, string>>({
    dose: e?.dose ?? '',
    unita: e?.unita ?? '',
    frequenza: e?.frequenza ?? '',
    momento: e?.momento ?? '',
    via: e?.via ?? '',
  });
  const set = (k: PartKey, v: string) => setParts((x) => ({ ...x, [k]: v }));
  const reading = patientReading({
    dose: parts.dose,
    doseUnit: parts.unita,
    frequency: parts.frequenza,
    timeOfDay: parts.momento,
    route: parts.via,
  });
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    void props.onSubmit({ testo, ...parts }, testo.trim());
  };
  const select = (k: Exclude<PartKey, 'dose'>, label: string, list: readonly string[]) => (
    <div className="campo">
      <label htmlFor={`posologia-${k}`}>{label}</label>
      <select
        id={`posologia-${k}`}
        aria-describedby="posologia-parti-aiuto"
        value={parts[k]}
        onChange={(ev) => set(k, ev.target.value)}
      >
        <option value="">Non indicato</option>
        {choices(list, parts[k]).map((v) => (
          <option key={v}>{v}</option>
        ))}
      </select>
    </div>
  );
  return (
    <FormFrame {...props} onSubmit={submit}>
      <TextField
        id="posologia-testo"
        label="Testo della posologia"
        required
        max={L.posologyText}
        value={testo}
        onChange={setTesto}
        inputRef={props.firstField}
        help="Come la legge il paziente, per esempio «1 compressa la sera, dopo cena»."
      />
      <fieldset>
        <legend>Parti per la scheda della terapia (facoltative)</legend>
        <p className="aiuto" id="posologia-parti-aiuto">
          Se le indichi, nella scheda della terapia questa posologia riempie dose, unità, frequenza,
          momento e via, che servono al contatore delle confezioni (R11).
        </p>
        <div className="campi-in-riga">
          <div className="campo campo-stretto">
            <label htmlFor="posologia-dose">Dose</label>
            <input
              id="posologia-dose"
              inputMode="decimal"
              maxLength={L.dose}
              autoComplete="off"
              aria-describedby="posologia-parti-aiuto"
              value={parts.dose}
              onChange={(ev) => set('dose', ev.target.value)}
            />
          </div>
          {select('unita', 'Unità', DOSE_UNITS)}
          {select('frequenza', 'Frequenza', FREQUENCIES)}
          {select('momento', 'Momento', TIMES_OF_DAY)}
          {select('via', 'Via', routes)}
        </div>
        {reading && (
          <div className="anteprima">
            <p className="anteprima-titolo">Come si legge dalle parti</p>
            <p>{reading}</p>
            {reading !== testo.trim() && (
              <button
                type="button"
                className="pulsante pulsante-piatto"
                onClick={() => setTesto(reading)}
              >
                <Icon name="ripeti" /> <span>Usalo come testo</span>
              </button>
            )}
          </div>
        )}
      </fieldset>
    </FormFrame>
  );
}

function PackageForm(props: FormProps) {
  const e = props.editing as ListItem<'pacchetto'> | null;
  const L = props.data.limiti;
  const [nome, setNome] = useState(e?.dati.nome ?? '');
  const [services, setServices] = useState<PackageService[]>(e?.dati.prestazioni ?? []);
  const [text, setText] = useState('');
  const q = useDebounced(text).trim();
  // La stessa ricerca della ricetta specialistica, nel catalogo in vigore oggi (D153).
  const search = useApi<{ prestazioni: ServiceResultData[] }>(
    q ? `/api/prestazioni${query({ q })}` : null,
  );
  const inPackage = (c: string) => services.some((s) => code(s.codice) === code(c));
  const outOfCatalog = new Set(
    (e?.catalogo?.prestazioni ?? []).filter((c) => !c.voce).map((c) => code(c.codice)),
  );
  const full = services.length >= L.packageServices;
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    void props.onSubmit({ nome, prestazioni: services }, nome.trim());
  };
  return (
    <FormFrame {...props} onSubmit={submit}>
      <TextField
        id="pacchetto-nome"
        label="Nome del pacchetto"
        required
        max={L.name}
        value={nome}
        onChange={setNome}
        inputRef={props.firstField}
        help="Per esempio «Controllo del diabete»."
      />
      <div role="search" className="ricerca">
        <label htmlFor="pacchetto-cerca">
          Cerca nel catalogo regionale: prestazione, branca o codice
        </label>
        <div className="ricerca-campo">
          <Icon name="cerca" />
          <input
            id="pacchetto-cerca"
            type="search"
            autoComplete="off"
            value={text}
            onChange={(ev) => setText(ev.target.value)}
            // Invio nella ricerca non salva il pacchetto.
            onKeyDown={(ev) => {
              if (ev.key === 'Enter') ev.preventDefault();
            }}
          />
        </div>
      </div>
      <ErrorMessage error={search.error} />
      <ul className="risultati" aria-live="polite">
        {search.data?.prestazioni.map((s) => (
          <li key={s.regionalCode} className="risultato">
            <ServiceResultText s={s} />
            <button
              type="button"
              className="pulsante"
              disabled={inPackage(s.regionalCode) || full}
              onClick={() =>
                setServices((x) => [...x, { codice: s.regionalCode, descrizione: s.description }])
              }
            >
              <Icon name="aggiungi" />{' '}
              <span>
                {inPackage(s.regionalCode) ? 'Già nel pacchetto' : 'Aggiungi al pacchetto'}
              </span>
            </button>
          </li>
        ))}
        {q && search.data && search.data.prestazioni.length === 0 && (
          <li className="tenue">Nessun risultato per «{q}».</li>
        )}
      </ul>
      <fieldset>
        <legend>
          Prestazioni del pacchetto: {services.length} (al massimo {L.packageServices})
        </legend>
        {services.length === 0 ? (
          <p className="tenue">
            Nessuna prestazione: cercale nel catalogo e aggiungile. Un pacchetto ne ha almeno una.
          </p>
        ) : (
          <ol className="risultati">
            {services.map((s) => (
              <li key={s.codice} className="risultato">
                <div>
                  <span className="codice">{s.codice}</span> {s.descrizione}
                  {outOfCatalog.has(code(s.codice)) && (
                    <Notice kind="avviso">
                      Non è nel catalogo in vigore: in ricetta non si aggiunge. Toglila o cerca la
                      voce nuova.
                    </Notice>
                  )}
                </div>
                <button
                  type="button"
                  className="pulsante pulsante-piatto"
                  aria-label={`Togli «${s.descrizione}» dal pacchetto`}
                  onClick={() => setServices((x) => x.filter((y) => y.codice !== s.codice))}
                >
                  <Icon name="annulla" /> <span>Togli</span>
                </button>
              </li>
            ))}
          </ol>
        )}
        {full && (
          <p className="aiuto">
            Il pacchetto ha già {count(L.packageServices, 'prestazione', 'prestazioni')}, il
            massimo.
          </p>
        )}
      </fieldset>
    </FormFrame>
  );
}

function ContactForm(props: FormProps) {
  const e = props.editing?.dati as UsefulContact | undefined;
  const L = props.data.limiti;
  const [f, setF] = useState({
    nome: e?.nome ?? '',
    tipo: e?.tipo ?? '',
    telefono: e?.telefono ?? '',
    email: e?.email ?? '',
    indirizzo: e?.indirizzo ?? '',
    note: e?.note ?? '',
  });
  const set = (k: keyof typeof f) => (v: string) => setF((x) => ({ ...x, [k]: v }));
  const submit = (ev: FormEvent) => {
    ev.preventDefault();
    void props.onSubmit(f, f.nome.trim());
  };
  return (
    <FormFrame {...props} onSubmit={submit}>
      <div className="campi-in-riga">
        <TextField
          id="contatto-nome"
          label="Nome"
          required
          max={L.name}
          value={f.nome}
          onChange={set('nome')}
          inputRef={props.firstField}
        />
        <div className="campo">
          <label htmlFor="contatto-tipo">Tipo</label>
          <select
            id="contatto-tipo"
            required
            value={f.tipo}
            onChange={(ev) => set('tipo')(ev.target.value)}
          >
            <option value="">Da scegliere</option>
            {props.data.tipiContatto.map((k) => (
              <option key={k.codice} value={k.codice}>
                {k.nome}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="campi-in-riga">
        <TextField
          id="contatto-telefono"
          label="Telefono (facoltativo)"
          type="tel"
          max={L.phone}
          value={f.telefono}
          onChange={set('telefono')}
        />
        <TextField
          id="contatto-email"
          label="Email (facoltativa)"
          type="email"
          max={L.email}
          value={f.email}
          onChange={set('email')}
        />
      </div>
      <TextField
        id="contatto-indirizzo"
        label="Indirizzo (facoltativo)"
        max={L.address}
        value={f.indirizzo}
        onChange={set('indirizzo')}
      />
      <div className="campo">
        <label htmlFor="contatto-note">Note (facoltative)</label>
        <textarea
          id="contatto-note"
          rows={2}
          maxLength={L.notes}
          value={f.note}
          onChange={(ev) => set('note')(ev.target.value)}
        />
      </div>
    </FormFrame>
  );
}
