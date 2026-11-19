import { Fragment, useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { ErrorMessage, Loading, Notice, PageHeader } from '../components/common';
import { Icon, type IconName } from '../components/Icon';
import { api, query, type ApiError } from '../lib/api';
import { date, dateTime } from '../lib/format';
import { useApi } from '../lib/useApi';
import {
  failure,
  FormError,
  IDENTITY_LABELS,
  IdentityFields,
  identityBody,
  type IdentityValues,
  type Option,
} from './NewPatientPage';
import { PatientBanner, type Patient, type Summary } from './RecordPage';

type AdminKey =
  | 'telefono'
  | 'email'
  | 'residenzaVia'
  | 'residenzaCivico'
  | 'residenzaCap'
  | 'residenzaComune'
  | 'residenzaProvincia'
  | 'domicilio'
  | 'asl'
  | 'distretto'
  | 'tipoAssistenza'
  | 'stato'
  | 'decedutoIl'
  | 'causaDecesso'
  | 'tesseraTeam'
  | 'enteEstero'
  | 'professione'
  | 'condizioneProfessionale'
  | 'emailDatoreLavoro'
  | 'canalePromemoria'
  | 'recapitoPromemoria'
  | 'canaleSceltoIl';

interface Imported {
  il: string;
  programma: string | null;
}

interface Exemption {
  id: string;
  codice: string;
  dal: string;
  al: string | null;
  codiceRicetta: string | null;
  fonte: string;
  daAura: boolean;
  importata: Imported | null;
  stato: 'valida' | 'scaduta' | 'futura';
  nelCatalogo: boolean | null;
}

interface Choice {
  id: string;
  medicoId: string;
  medico: string;
  dal: string;
  scadenza: string | null;
  cessataIl: string | null;
  motivoCessazione: string | null;
  fonte: string;
  daAura: boolean;
  importata: Imported | null;
  stato: 'in_corso' | 'cessata' | 'scaduta' | 'futura';
}

interface AdminView {
  paziente: {
    id: string;
    archivio: { id: string; nome: string; titolare: string; titolareId: string | null };
    identita: {
      cognome: string;
      nome: string;
      sesso: 'M' | 'F';
      nascita: string;
      luogoNascitaCodice: string | null;
      luogoNascita: string | null;
      codiceFiscale: string;
    };
    dati: Record<AdminKey, string | null>;
    nucleo: {
      id: string;
      etichetta: string;
      componenti: { id: string; cognome: string; nome: string; nascita: string }[];
    } | null;
    importato: Imported | null;
    creatoIl: string;
    aggiornatoIl: string;
    /** La causa del decesso è un dato clinico: chi non legge il riepilogo clinico non la vede (D171). */
    causaDecessoRiservata?: boolean;
  };
  esenzioni: Exemption[];
  scelte: Choice[];
  correzioni: { quando: string; utente: string | null; campi: string[]; motivo: string }[];
  medici: { id: string; nome: string }[];
  stati: Option[];
  canali: Option[];
  sessi: Option[];
  catalogoEsenzioni: boolean;
  puoScrivere: boolean;
  oggi: string;
}

interface FieldDef {
  key: AdminKey;
  label: string;
  type?: 'text' | 'email' | 'tel' | 'date' | 'select';
  /** Valori di un elenco, dalle API. */
  options?: 'stati' | 'canali';
  /** Voce dell'elenco per «nessun valore». */
  emptyLabel?: string;
  maxLength?: number;
  narrow?: boolean;
  upper?: boolean;
  mono?: boolean;
  numeric?: boolean;
  help?: string;
  /** Il campo vale solo in certi casi: altrimenti non si vede e si svuota. */
  onlyIf?: (v: Partial<Record<AdminKey, string | null>>) => boolean;
  /** Quando il campo compare, propone la data di oggi. */
  today?: boolean;
}

interface Group {
  id: string;
  title: string;
  icon: IconName;
  help?: string;
  fields: FieldDef[];
}

const deceased = (v: Partial<Record<AdminKey, string | null>>) => v.stato === 'deceduto';

/** I gruppi dei dati amministrativi (requisiti, «Anagrafica e dati SSN», «Dati sociali e lavoro»). */
const GROUPS: Group[] = [
  {
    id: 'residenza',
    title: 'Residenza e recapiti',
    icon: 'pazienti',
    fields: [
      { key: 'residenzaVia', label: 'Via o piazza', maxLength: 200 },
      { key: 'residenzaCivico', label: 'Numero civico', maxLength: 20, narrow: true },
      { key: 'residenzaCap', label: 'CAP', maxLength: 5, narrow: true, numeric: true },
      { key: 'residenzaComune', label: 'Comune', maxLength: 100 },
      {
        key: 'residenzaProvincia',
        label: 'Provincia (sigla)',
        maxLength: 2,
        narrow: true,
        upper: true,
      },
      { key: 'domicilio', label: 'Domicilio, se diverso dalla residenza', maxLength: 300 },
      { key: 'telefono', label: 'Telefono', type: 'tel', maxLength: 40 },
      { key: 'email', label: 'Email', type: 'email', maxLength: 200 },
    ],
  },
  {
    id: 'ssn',
    title: 'Dati SSN',
    icon: 'archivio',
    fields: [
      { key: 'asl', label: 'ASL di assistenza', maxLength: 100 },
      { key: 'distretto', label: 'Distretto', maxLength: 100 },
      { key: 'tipoAssistenza', label: 'Tipo di assistenza', maxLength: 100 },
    ],
  },
  {
    id: 'stato',
    title: 'Stato e decesso',
    icon: 'storico',
    fields: [
      { key: 'stato', label: 'Stato del paziente', type: 'select', options: 'stati' },
      { key: 'decedutoIl', label: 'Data del decesso', type: 'date', onlyIf: deceased },
      {
        key: 'causaDecesso',
        label: 'Causa del decesso, in ICD-9-CM (se nota)',
        maxLength: 10,
        mono: true,
        upper: true,
        onlyIf: deceased,
        help: 'Il codice, per esempio 410.9 o V17.3.',
      },
    ],
  },
  {
    id: 'stranieri',
    title: 'Cittadini stranieri',
    icon: 'pazienti',
    help: 'Per chi è assistito con la tessera europea (TEAM) o per conto di un ente estero.',
    fields: [
      {
        key: 'tesseraTeam',
        label: 'Numero della tessera europea (TEAM)',
        maxLength: 40,
        mono: true,
      },
      { key: 'enteEstero', label: 'Ente estero', maxLength: 200 },
    ],
  },
  {
    id: 'lavoro',
    title: 'Lavoro',
    icon: 'firma',
    fields: [
      { key: 'professione', label: 'Professione', maxLength: 200 },
      { key: 'condizioneProfessionale', label: 'Condizione professionale', maxLength: 100 },
      {
        key: 'emailDatoreLavoro',
        label: 'Email del datore di lavoro (facoltativa)',
        type: 'email',
        maxLength: 200,
        help: 'Per i certificati INPS: al datore di lavoro va solo il numero di protocollo, nessun dato clinico (D88).',
      },
    ],
  },
  {
    id: 'promemoria',
    title: 'Canale del promemoria',
    icon: 'ricette',
    help: 'Un canale diverso dalla carta si usa solo su richiesta del paziente (R15): registra il canale, il recapito e la data della scelta.',
    fields: [
      {
        key: 'canalePromemoria',
        label: 'Canale scelto dal paziente',
        type: 'select',
        options: 'canali',
        emptyLabel: 'Nessuna scelta registrata',
      },
      {
        key: 'recapitoPromemoria',
        label: 'Recapito per il canale',
        maxLength: 200,
        onlyIf: (v) => !!v.canalePromemoria && v.canalePromemoria !== 'carta',
        help: 'Email, PEC o numero di telefono, secondo il canale.',
      },
      {
        key: 'canaleSceltoIl',
        label: 'Data della scelta',
        type: 'date',
        onlyIf: (v) => !!v.canalePromemoria,
        today: true,
      },
    ],
  },
];

const ADMIN_LABELS: Record<string, string> = Object.fromEntries(
  GROUPS.flatMap((g) => g.fields.map((f) => [f.key, f.label])),
);

const EXEMPTION_STATE = { valida: 'Valida oggi', scaduta: 'Scaduta', futura: 'Non ancora valida' };
const CHOICE_STATE = {
  in_corso: 'In corso',
  cessata: 'Cessata',
  scaduta: 'Scaduta',
  futura: 'Non ancora in vigore',
};

const importedText = (i: Imported | null) =>
  i ? ` · importata il ${dateTime(i.il)}${i.programma ? ` da ${i.programma}` : ''}` : '';

/** Una sezione di dati amministrativi: in lettura, oppure in modifica con i soli campi cambiati. */
function FieldsSection({
  group,
  view,
  onSaved,
}: {
  group: Group;
  view: AdminView;
  onSaved: () => void;
}) {
  const dati = view.paziente.dati;
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<Partial<Record<AdminKey, string>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const optionsOf = (f: FieldDef) =>
    f.options === 'stati' ? view.stati : f.options === 'canali' ? view.canali : [];
  const shown = (f: FieldDef, v: Partial<Record<AdminKey, string | null>>) =>
    !(f.key === 'causaDecesso' && view.paziente.causaDecessoRiservata) &&
    (!f.onlyIf || f.onlyIf(v));
  const display = (f: FieldDef) => {
    const v = dati[f.key];
    if (!v) return f.emptyLabel ?? '—';
    if (f.type === 'select') return optionsOf(f).find((o) => o.chiave === v)?.nome ?? v;
    if (f.type === 'date') return date(v);
    return v;
  };

  function start() {
    setValues(Object.fromEntries(group.fields.map((f) => [f.key, dati[f.key] ?? ''])));
    setError(null);
    setDone(null);
    setEditing(true);
  }

  function change(key: AdminKey, value: string) {
    setValues((prev) => {
      const next = { ...prev, [key]: value };
      for (const f of group.fields)
        if (f.today && shown(f, next) && !shown(f, prev) && !next[f.key]) next[f.key] = view.oggi;
      return next;
    });
  }

  async function save(e: FormEvent) {
    e.preventDefault();
    const patch: Partial<Record<AdminKey, string | null>> = {};
    for (const f of group.fields) {
      let v: string | null = shown(f, values) ? (values[f.key] ?? '').trim() : '';
      if (v && f.upper) v = v.toUpperCase();
      if (v === '') v = null;
      if (v !== (dati[f.key] ?? null)) patch[f.key] = v;
    }
    if (Object.keys(patch).length === 0) {
      setEditing(false);
      setDone('Nessun dato cambiato.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/api/pazienti/${view.paziente.id}/amministrazione`, {
        method: 'PATCH',
        body: patch,
      });
      setEditing(false);
      setDone(`${group.title}: dati salvati.`);
      onSaved();
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="riquadro" id={group.id} aria-labelledby={`titolo-${group.id}`}>
      <h2 id={`titolo-${group.id}`}>
        <Icon name={group.icon} /> {group.title}
      </h2>
      {group.help && <p className="aiuto">{group.help}</p>}
      {!editing ? (
        <>
          <dl className="dati">
            {group.fields
              .filter((f) => shown(f, dati))
              .map((f) => (
                <Fragment key={f.key}>
                  <dt>{f.label}</dt>
                  <dd className={f.mono ? 'codice' : undefined}>{display(f)}</dd>
                </Fragment>
              ))}
          </dl>
          {view.puoScrivere && (
            <button type="button" className="pulsante" onClick={start}>
              <Icon name="firma" /> <span>Modifica</span>
              <span className="visivamente-nascosto"> {group.title.toLowerCase()}</span>
            </button>
          )}
          {done && <Notice kind="fatto">{done}</Notice>}
        </>
      ) : (
        <form noValidate onSubmit={(e) => void save(e)}>
          <fieldset disabled={busy}>
            <legend className="visivamente-nascosto">{group.title}</legend>
            <div className="campi-in-riga">
              {group.fields
                .filter((f) => shown(f, values))
                .map((f) => {
                  const id = `${group.id}-${f.key}`;
                  const helpId = f.help ? `${id}-aiuto` : undefined;
                  return (
                    <div key={f.key} className={`campo${f.narrow ? ' campo-stretto' : ''}`}>
                      <label htmlFor={id}>{f.label}</label>
                      {f.type === 'select' ? (
                        <select
                          id={id}
                          value={values[f.key] ?? ''}
                          aria-describedby={helpId}
                          onChange={(e) => change(f.key, e.target.value)}
                        >
                          {f.emptyLabel && <option value="">{f.emptyLabel}</option>}
                          {optionsOf(f).map((o) => (
                            <option key={o.chiave} value={o.chiave}>
                              {o.nome}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          id={id}
                          type={f.type ?? 'text'}
                          className={f.mono ? 'codice' : undefined}
                          inputMode={f.numeric ? 'numeric' : undefined}
                          maxLength={f.maxLength}
                          max={f.type === 'date' ? view.oggi : undefined}
                          autoComplete="off"
                          aria-describedby={helpId}
                          value={values[f.key] ?? ''}
                          onChange={(e) => change(f.key, e.target.value)}
                        />
                      )}
                      {f.help && (
                        <p className="aiuto" id={helpId}>
                          {f.help}
                        </p>
                      )}
                    </div>
                  );
                })}
            </div>
            <FormError error={error} labels={ADMIN_LABELS} />
            <div className="azioni">
              <button type="submit" className="pulsante pulsante-primario">
                <Icon name="fatto" /> <span>Salva</span>
                <span className="visivamente-nascosto"> {group.title.toLowerCase()}</span>
              </button>
              <button type="button" className="pulsante" onClick={() => setEditing(false)}>
                <Icon name="annulla" /> <span>Annulla</span>
              </button>
            </div>
          </fieldset>
        </form>
      )}
    </section>
  );
}

const toValues = (i: AdminView['paziente']['identita']): IdentityValues => ({
  cognome: i.cognome,
  nome: i.nome,
  sesso: i.sesso,
  nascita: i.nascita,
  luogoNascita: i.luogoNascita ?? '',
  luogoNascitaCodice: i.luogoNascitaCodice ?? '',
  codiceFiscale: i.codiceFiscale,
});

/**
 * Identità. D86 la lasciava fuori dalla cartella, da allineare con AURA; finché AURA non c'è si
 * corregge qui con un motivo, che resta nel registro con i campi corretti e chi li ha corretti.
 */
function IdentitySection({ view, onSaved }: { view: AdminView; onSaved: () => void }) {
  const i = view.paziente.identita;
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<IdentityValues>(() => toValues(i));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<{ campi: string[]; avvisi: string[] } | null>(null);
  const sex = view.sessi.find((s) => s.chiave === i.sesso)?.nome ?? i.sesso;

  async function save(e: FormEvent) {
    e.preventDefault();
    const before = identityBody(toValues(i));
    const after = identityBody(values);
    const changed = Object.fromEntries(
      Object.entries(after).filter(([k, v]) => v !== before[k as keyof typeof before]),
    );
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ campi: string[]; avvisi: string[] }>(
        `/api/pazienti/${view.paziente.id}/identita`,
        { method: 'POST', body: { ...changed, motivo: reason.trim() } },
      );
      setEditing(false);
      setReason('');
      setDone(r);
      onSaved();
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="riquadro" id="identita" aria-labelledby="titolo-identita">
      <h2 id="titolo-identita">
        <Icon name="pazienti" /> Identità
      </h2>
      {!editing ? (
        <>
          <dl className="dati">
            <dt>{IDENTITY_LABELS.cognome}</dt>
            <dd>{i.cognome}</dd>
            <dt>{IDENTITY_LABELS.nome}</dt>
            <dd>{i.nome}</dd>
            <dt>{IDENTITY_LABELS.sesso}</dt>
            <dd>{sex}</dd>
            <dt>{IDENTITY_LABELS.nascita}</dt>
            <dd>{date(i.nascita)}</dd>
            <dt>Luogo di nascita</dt>
            <dd>
              {i.luogoNascita ?? '—'}
              {i.luogoNascitaCodice && <span className="codice"> ({i.luogoNascitaCodice})</span>}
            </dd>
            <dt>{IDENTITY_LABELS.codiceFiscale}</dt>
            <dd className="codice">{i.codiceFiscale}</dd>
            <dt>Archivio</dt>
            <dd>
              {view.paziente.archivio.nome} ({view.paziente.archivio.titolare})
            </dd>
          </dl>
          {view.paziente.importato && (
            <p className="tenue">
              Paziente importato il {dateTime(view.paziente.importato.il)}
              {view.paziente.importato.programma ? ` da ${view.paziente.importato.programma}` : ''}.
            </p>
          )}
          {view.puoScrivere && (
            <button
              type="button"
              className="pulsante"
              onClick={() => {
                setValues(toValues(i));
                setError(null);
                setDone(null);
                setEditing(true);
              }}
            >
              <Icon name="firma" /> <span>Correggi l’identità</span>
            </button>
          )}
          {done && (
            <>
              <Notice kind="fatto">
                Identità corretta:{' '}
                {done.campi
                  .map((c) => IDENTITY_LABELS[c as keyof IdentityValues] ?? c)
                  .join(', ')
                  .toLowerCase()}
                .
              </Notice>
              {done.avvisi.length > 0 && (
                <Notice kind="avviso">
                  <p>
                    <strong>Da controllare:</strong> il codice fiscale non torna con i dati.
                  </p>
                  <ul>
                    {done.avvisi.map((a) => (
                      <li key={a}>{a}</li>
                    ))}
                  </ul>
                </Notice>
              )}
            </>
          )}
        </>
      ) : (
        <form noValidate onSubmit={(e) => void save(e)}>
          <fieldset disabled={busy}>
            <legend className="visivamente-nascosto">Correzione dell’identità</legend>
            <IdentityFields
              prefix="correzione"
              values={values}
              sexes={view.sessi}
              onChange={setValues}
            />
            <div className="campo">
              <label htmlFor="correzione-motivo">Motivo della correzione</label>
              <textarea
                id="correzione-motivo"
                required
                minLength={10}
                maxLength={500}
                rows={2}
                aria-describedby="correzione-motivo-aiuto"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <p className="aiuto" id="correzione-motivo-aiuto">
                Una frase: per esempio da quale documento viene il dato giusto. Il motivo resta nel
                registro con i campi corretti e chi li ha corretti; i valori di prima restano nello
                storico delle modifiche. Quando ci sarà il collegamento con AURA, l’identità
                arriverà dall’anagrafe regionale.
              </p>
            </div>
            <FormError
              error={error}
              labels={{ ...IDENTITY_LABELS, motivo: 'Motivo della correzione' }}
            />
            <div className="azioni">
              <button type="submit" className="pulsante pulsante-primario">
                <Icon name="fatto" /> <span>Salva la correzione</span>
              </button>
              <button type="button" className="pulsante" onClick={() => setEditing(false)}>
                <Icon name="annulla" /> <span>Annulla</span>
              </button>
            </div>
          </fieldset>
        </form>
      )}
      {view.correzioni.length > 0 && (
        <details className="storia">
          <summary>Correzioni dell’identità ({view.correzioni.length})</summary>
          <ul className="elenco-semplice">
            {view.correzioni.map((c) => (
              <li key={c.quando}>
                <span className="cronologia-data">{dateTime(c.quando)}</span>{' '}
                {c.campi.map((k) => IDENTITY_LABELS[k as keyof IdentityValues] ?? k).join(', ')}
                {c.utente && <span className="tenue"> · {c.utente}</span>} — «{c.motivo}»
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

const SEARCH_DELAY_MS = 250;
/** Pazienti trovati mostrati per l'unione al nucleo: scelta d'interfaccia, si affina la ricerca. */
const FAMILY_SEARCH_SHOWN = 10;

/** Nucleo familiare: nuovo con un'etichetta, quello di un altro paziente visibile, o nessuno. */
function FamilySection({ view, onSaved }: { view: AdminView; onSaved: () => void }) {
  const p = view.paziente;
  const [label, setLabel] = useState('');
  const [rename, setRename] = useState(p.nucleo?.etichetta ?? '');
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => setRename(p.nucleo?.etichetta ?? ''), [p.nucleo?.etichetta]);
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(t);
  }, [text]);
  const results = useApi<{
    pazienti: { id: string; nome: string; cognome: string; dataNascita: string }[];
  }>(q.length >= 2 ? `/api/pazienti${query({ q })}` : null);

  async function run(method: 'PUT' | 'PATCH', body: object, ok: string) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await api(`/api/pazienti/${p.id}/nucleo`, { method, body });
      setDone(ok);
      setLabel('');
      setText('');
      onSaved();
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="riquadro" id="nucleo" aria-labelledby="titolo-nucleo">
      <h2 id="titolo-nucleo">
        <Icon name="pazienti" /> Nucleo familiare
      </h2>
      {p.nucleo ? (
        <>
          <p>
            Nucleo «{p.nucleo.etichetta}».{' '}
            {p.nucleo.componenti.length === 0 && 'Nessun altro componente tra i pazienti che vedi.'}
          </p>
          {p.nucleo.componenti.length > 0 && (
            <ul className="elenco-semplice" aria-label="Altri componenti del nucleo">
              {p.nucleo.componenti.map((m) => (
                <li key={m.id}>
                  <Link to={`/pazienti/${m.id}`}>
                    {m.cognome} {m.nome}
                  </Link>{' '}
                  <span className="tenue">· nascita {date(m.nascita)}</span>
                </li>
              ))}
            </ul>
          )}
          {view.puoScrivere && (
            <>
              <form
                className="modulo-in-riga"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run('PATCH', { etichetta: rename.trim() }, 'Etichetta del nucleo cambiata.');
                }}
              >
                <div className="campo">
                  <label htmlFor="nucleo-etichetta-nuova">Etichetta del nucleo</label>
                  <input
                    id="nucleo-etichetta-nuova"
                    required
                    maxLength={100}
                    value={rename}
                    onChange={(e) => setRename(e.target.value)}
                  />
                </div>
                <button type="submit" className="pulsante" disabled={busy}>
                  <Icon name="firma" /> <span>Cambia l’etichetta</span>
                </button>
              </form>
              <button
                type="button"
                className="pulsante"
                disabled={busy}
                onClick={() =>
                  void run('PUT', { nessuno: true }, 'Paziente tolto dal nucleo familiare.')
                }
              >
                <Icon name="annulla" /> <span>Togli il paziente dal nucleo</span>
              </button>
            </>
          )}
        </>
      ) : (
        <p className="tenue">Il paziente non è in un nucleo familiare.</p>
      )}
      {view.puoScrivere && !p.nucleo && (
        <>
          <form
            className="modulo-in-riga"
            onSubmit={(e) => {
              e.preventDefault();
              void run('PUT', { etichetta: label.trim() }, 'Nucleo familiare creato.');
            }}
          >
            <div className="campo">
              <label htmlFor="nucleo-etichetta">Etichetta del nucleo nuovo</label>
              <input
                id="nucleo-etichetta"
                required
                maxLength={100}
                aria-describedby="nucleo-etichetta-aiuto"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
              />
              <p className="aiuto" id="nucleo-etichetta-aiuto">
                Il nome con cui lo studio riconosce la famiglia; si cerca anche così.
              </p>
            </div>
            <button type="submit" className="pulsante" disabled={busy}>
              <Icon name="aggiungi" /> <span>Crea il nucleo</span>
            </button>
          </form>
          <div className="campo">
            <label htmlFor="nucleo-cerca">Oppure unisci al nucleo di un altro paziente</label>
            <input
              id="nucleo-cerca"
              type="search"
              autoComplete="off"
              aria-describedby="nucleo-cerca-aiuto"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
            <p className="aiuto" id="nucleo-cerca-aiuto">
              Cognome, nome o codice fiscale di un paziente che è già in un nucleo.
            </p>
          </div>
          {results.data && (
            <ul className="elenco-semplice" aria-label="Pazienti trovati">
              {results.data.pazienti
                .filter((r) => r.id !== p.id)
                .slice(0, FAMILY_SEARCH_SHOWN)
                .map((r) => (
                  <li key={r.id}>
                    <button
                      type="button"
                      className="pulsante pulsante-piatto"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          'PUT',
                          { conPaziente: r.id },
                          `Paziente unito al nucleo di ${r.cognome} ${r.nome}.`,
                        )
                      }
                    >
                      <Icon name="aggiungi" />
                      <span>
                        Unisci al nucleo di {r.cognome} {r.nome}
                      </span>
                    </button>{' '}
                    <span className="tenue">nascita {date(r.dataNascita)}</span>
                  </li>
                ))}
            </ul>
          )}
        </>
      )}
      <FormError error={error} labels={{ etichetta: 'Etichetta' }} />
      {done && <Notice kind="fatto">{done}</Notice>}
    </section>
  );
}

/** Esenzioni: codice, validità, codice da riportare in ricetta. Non si cancellano. */
function ExemptionsSection({ view, onSaved }: { view: AdminView; onSaved: () => void }) {
  const empty = { codice: '', dal: view.oggi, al: '', codiceRicetta: '' };
  const [form, setForm] = useState(empty);
  const [editing, setEditing] = useState<Exemption | null>(null);
  const [edit, setEdit] = useState({ al: '', codiceRicetta: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<{ text: string; avvisi: string[] } | null>(null);
  const labels = {
    codice: 'Codice',
    dal: 'Valida dal',
    al: 'Valida fino al',
    codiceRicetta: 'Codice da riportare in ricetta',
  };

  async function run(fn: () => Promise<{ avvisi?: string[] }>, text: string) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const r = await fn();
      setDone({ text, avvisi: r.avvisi ?? [] });
      onSaved();
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="riquadro" id="esenzioni" aria-labelledby="titolo-esenzioni">
      <h2 id="titolo-esenzioni">
        <Icon name="ricette" /> Esenzioni
      </h2>
      <p className="aiuto">
        {view.catalogoEsenzioni
          ? 'Il codice si confronta con il catalogo delle esenzioni importato tra le banche dati.'
          : 'Il catalogo delle esenzioni non è tra le banche dati importate: il codice non si confronta con il catalogo.'}{' '}
        Un’esenzione non si cancella: se non vale più, si chiude la sua validità.
      </p>
      {view.esenzioni.length === 0 ? (
        <p className="tenue">Nessuna esenzione registrata.</p>
      ) : (
        <div className="tabella-scorrevole">
          <table className="tabella">
            <caption>Esenzioni registrate</caption>
            <thead>
              <tr>
                <th scope="col">Codice</th>
                <th scope="col">Validità</th>
                <th scope="col">In ricetta</th>
                <th scope="col">Stato</th>
                <th scope="col">Fonte</th>
                {view.puoScrivere && <th scope="col">Azioni</th>}
              </tr>
            </thead>
            <tbody>
              {view.esenzioni.map((e) => (
                <tr key={e.id}>
                  <th scope="row" className="codice">
                    {e.codice}
                  </th>
                  <td>
                    dal {date(e.dal)}
                    {e.al ? ` al ${date(e.al)}` : ', senza fine'}
                  </td>
                  <td className="codice">{e.codiceRicetta ?? '—'}</td>
                  <td>
                    {EXEMPTION_STATE[e.stato]}
                    {e.nelCatalogo === false && (
                      <span className="etichetta">
                        <Icon name="avviso" size={16} /> Non nel catalogo di oggi
                      </span>
                    )}
                  </td>
                  <td>
                    {e.fonte}
                    {importedText(e.importata)}
                  </td>
                  {view.puoScrivere && (
                    <td>
                      {!e.daAura && (
                        <button
                          type="button"
                          className="pulsante pulsante-piatto"
                          disabled={busy}
                          onClick={() => {
                            setEditing(e);
                            setEdit({ al: e.al ?? '', codiceRicetta: e.codiceRicetta ?? '' });
                            setError(null);
                            setDone(null);
                          }}
                        >
                          <Icon name="firma" /> <span>Modifica</span>
                          <span className="visivamente-nascosto"> l’esenzione {e.codice}</span>
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {view.puoScrivere && editing && (
        <form
          noValidate
          onSubmit={(ev) => {
            ev.preventDefault();
            const body: Record<string, string | null> = {};
            if ((edit.al || null) !== editing.al) body.al = edit.al || null;
            const code = edit.codiceRicetta.trim().toUpperCase() || null;
            if (code !== editing.codiceRicetta) body.codiceRicetta = code;
            if (!Object.keys(body).length) {
              setEditing(null);
              return;
            }
            void run(async () => {
              const r = await api<{ avvisi: string[] }>(
                `/api/pazienti/${view.paziente.id}/esenzioni/${editing.id}`,
                { method: 'PATCH', body },
              );
              setEditing(null);
              return r;
            }, `Esenzione ${editing.codice} aggiornata.`);
          }}
        >
          <fieldset disabled={busy}>
            <legend>Modifica dell’esenzione {editing.codice}</legend>
            <div className="campi-in-riga">
              <div className="campo campo-stretto">
                <label htmlFor="esenzione-modifica-al">Valida fino al</label>
                <input
                  id="esenzione-modifica-al"
                  type="date"
                  min={editing.dal}
                  aria-describedby="esenzione-modifica-al-aiuto"
                  value={edit.al}
                  onChange={(e) => setEdit({ ...edit, al: e.target.value })}
                />
                <p className="aiuto" id="esenzione-modifica-al-aiuto">
                  Vuoto: senza fine.
                </p>
              </div>
              <div className="campo">
                <label htmlFor="esenzione-modifica-ricetta">Codice da riportare in ricetta</label>
                <input
                  id="esenzione-modifica-ricetta"
                  className="codice"
                  maxLength={20}
                  value={edit.codiceRicetta}
                  onChange={(e) => setEdit({ ...edit, codiceRicetta: e.target.value })}
                />
              </div>
            </div>
            <div className="azioni">
              <button type="submit" className="pulsante pulsante-primario">
                <Icon name="fatto" /> <span>Salva l’esenzione</span>
              </button>
              <button type="button" className="pulsante" onClick={() => setEditing(null)}>
                <Icon name="annulla" /> <span>Annulla</span>
              </button>
            </div>
          </fieldset>
        </form>
      )}
      {view.puoScrivere && (
        <form
          noValidate
          onSubmit={(ev) => {
            ev.preventDefault();
            void run(async () => {
              const r = await api<{ avvisi: string[] }>(
                `/api/pazienti/${view.paziente.id}/esenzioni`,
                {
                  method: 'POST',
                  body: {
                    codice: form.codice.trim(),
                    dal: form.dal,
                    ...(form.al ? { al: form.al } : {}),
                    ...(form.codiceRicetta.trim()
                      ? { codiceRicetta: form.codiceRicetta.trim() }
                      : {}),
                  },
                },
              );
              setForm(empty);
              return r;
            }, 'Esenzione registrata.');
          }}
        >
          <fieldset disabled={busy}>
            <legend>Nuova esenzione</legend>
            <div className="campi-in-riga">
              <div className="campo campo-stretto">
                <label htmlFor="esenzione-codice">{labels.codice}</label>
                <input
                  id="esenzione-codice"
                  className="codice"
                  required
                  maxLength={20}
                  autoComplete="off"
                  value={form.codice}
                  onChange={(e) => setForm({ ...form, codice: e.target.value.toUpperCase() })}
                />
              </div>
              <div className="campo campo-stretto">
                <label htmlFor="esenzione-dal">{labels.dal}</label>
                <input
                  id="esenzione-dal"
                  type="date"
                  required
                  value={form.dal}
                  onChange={(e) => setForm({ ...form, dal: e.target.value })}
                />
              </div>
              <div className="campo campo-stretto">
                <label htmlFor="esenzione-al">{labels.al} (facoltativo)</label>
                <input
                  id="esenzione-al"
                  type="date"
                  min={form.dal}
                  value={form.al}
                  onChange={(e) => setForm({ ...form, al: e.target.value })}
                />
              </div>
              <div className="campo">
                <label htmlFor="esenzione-ricetta">{labels.codiceRicetta}</label>
                <input
                  id="esenzione-ricetta"
                  className="codice"
                  maxLength={20}
                  autoComplete="off"
                  aria-describedby="esenzione-ricetta-aiuto"
                  value={form.codiceRicetta}
                  onChange={(e) =>
                    setForm({ ...form, codiceRicetta: e.target.value.toUpperCase() })
                  }
                />
                <p className="aiuto" id="esenzione-ricetta-aiuto">
                  Solo se è diverso dal codice dell’esenzione.
                </p>
              </div>
            </div>
            <div className="azioni">
              <button type="submit" className="pulsante pulsante-primario">
                <Icon name="aggiungi" /> <span>Registra l’esenzione</span>
              </button>
            </div>
          </fieldset>
        </form>
      )}
      <FormError error={error} labels={labels} />
      {done && <Notice kind="fatto">{done.text}</Notice>}
      {done && done.avvisi.length > 0 && (
        <Notice kind="avviso">
          <p>
            <strong>Da controllare:</strong>
          </p>
          <ul>
            {done.avvisi.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </Notice>
      )}
    </section>
  );
}

/** Scelta del medico: registrata a mano finché non c'è AURA; si cessa con data e motivo. */
function ChoicesSection({ view, onSaved }: { view: AdminView; onSaved: () => void }) {
  // Il medico proposto è il titolare dell'archivio del paziente, se è tra i medici dello studio.
  const owner = view.medici.find((m) => m.id === view.paziente.archivio.titolareId);
  const empty = { medicoId: owner?.id ?? '', dal: view.oggi, scadenza: '' };
  const [form, setForm] = useState(empty);
  const [ending, setEnding] = useState<Choice | null>(null);
  const [end, setEnd] = useState({ cessataIl: view.oggi, motivoCessazione: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<{ text: string; avvisi: string[] } | null>(null);
  const labels = {
    medicoId: 'Medico',
    dal: 'Scelto dal',
    scadenza: 'Scadenza',
    cessataIl: 'Data della cessazione',
    motivoCessazione: 'Motivo della cessazione',
  };

  async function run(fn: () => Promise<{ avvisi?: string[] }>, text: string) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const r = await fn();
      setDone({ text, avvisi: r.avvisi ?? [] });
      onSaved();
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="riquadro" id="scelta" aria-labelledby="titolo-scelta">
      <h2 id="titolo-scelta">
        <Icon name="firma" /> Scelta del medico
      </h2>
      <p className="aiuto">
        Scelte e revoche arriveranno dall’anagrafe regionale (AURA); finché il collegamento non c’è
        si registrano qui. Una scelta non si cancella: si registra la sua cessazione.
      </p>
      {view.scelte.length === 0 ? (
        <p className="tenue">Nessuna scelta registrata.</p>
      ) : (
        <div className="tabella-scorrevole">
          <table className="tabella">
            <caption>Scelte del medico registrate</caption>
            <thead>
              <tr>
                <th scope="col">Medico</th>
                <th scope="col">Dal</th>
                <th scope="col">Scadenza</th>
                <th scope="col">Cessazione</th>
                <th scope="col">Stato</th>
                <th scope="col">Fonte</th>
                {view.puoScrivere && <th scope="col">Azioni</th>}
              </tr>
            </thead>
            <tbody>
              {view.scelte.map((c) => (
                <tr key={c.id}>
                  <th scope="row">{c.medico}</th>
                  <td>{date(c.dal)}</td>
                  <td>{c.scadenza ? date(c.scadenza) : '—'}</td>
                  <td>
                    {c.cessataIl
                      ? `${date(c.cessataIl)}${c.motivoCessazione ? `: ${c.motivoCessazione}` : ''}`
                      : '—'}
                  </td>
                  <td>{CHOICE_STATE[c.stato]}</td>
                  <td>
                    {c.fonte}
                    {importedText(c.importata)}
                  </td>
                  {view.puoScrivere && (
                    <td>
                      {!c.cessataIl && !c.daAura && (
                        <button
                          type="button"
                          className="pulsante pulsante-piatto"
                          disabled={busy}
                          onClick={() => {
                            setEnding(c);
                            setEnd({ cessataIl: view.oggi, motivoCessazione: '' });
                            setError(null);
                            setDone(null);
                          }}
                        >
                          <Icon name="annulla" /> <span>Registra la cessazione</span>
                          <span className="visivamente-nascosto"> della scelta di {c.medico}</span>
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {view.puoScrivere && ending && (
        <form
          noValidate
          onSubmit={(ev) => {
            ev.preventDefault();
            void run(async () => {
              await api(`/api/pazienti/${view.paziente.id}/scelte/${ending.id}`, {
                method: 'PATCH',
                body: { cessataIl: end.cessataIl, motivoCessazione: end.motivoCessazione.trim() },
              });
              setEnding(null);
              return {};
            }, `Cessazione della scelta di ${ending.medico} registrata.`);
          }}
        >
          <fieldset disabled={busy}>
            <legend>Cessazione della scelta di {ending.medico}</legend>
            <div className="campi-in-riga">
              <div className="campo campo-stretto">
                <label htmlFor="scelta-cessata">{labels.cessataIl}</label>
                <input
                  id="scelta-cessata"
                  type="date"
                  required
                  min={ending.dal}
                  max={view.oggi}
                  value={end.cessataIl}
                  onChange={(e) => setEnd({ ...end, cessataIl: e.target.value })}
                />
              </div>
              <div className="campo">
                <label htmlFor="scelta-motivo">{labels.motivoCessazione}</label>
                <input
                  id="scelta-motivo"
                  required
                  maxLength={300}
                  value={end.motivoCessazione}
                  onChange={(e) => setEnd({ ...end, motivoCessazione: e.target.value })}
                />
              </div>
            </div>
            <div className="azioni">
              <button type="submit" className="pulsante pulsante-primario">
                <Icon name="fatto" /> <span>Registra la cessazione</span>
              </button>
              <button type="button" className="pulsante" onClick={() => setEnding(null)}>
                <Icon name="annulla" /> <span>Annulla</span>
              </button>
            </div>
          </fieldset>
        </form>
      )}
      {view.puoScrivere && (
        <form
          noValidate
          onSubmit={(ev) => {
            ev.preventDefault();
            void run(async () => {
              const r = await api<{ avvisi: string[] }>(
                `/api/pazienti/${view.paziente.id}/scelte`,
                {
                  method: 'POST',
                  body: {
                    medicoId: form.medicoId,
                    dal: form.dal,
                    ...(form.scadenza ? { scadenza: form.scadenza } : {}),
                  },
                },
              );
              setForm(empty);
              return r;
            }, 'Scelta del medico registrata.');
          }}
        >
          <fieldset disabled={busy}>
            <legend>Nuova scelta</legend>
            <div className="campi-in-riga">
              <div className="campo">
                <label htmlFor="scelta-medico">{labels.medicoId}</label>
                <select
                  id="scelta-medico"
                  required
                  value={form.medicoId}
                  onChange={(e) => setForm({ ...form, medicoId: e.target.value })}
                >
                  <option value="">Scegli il medico</option>
                  {view.medici.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.nome}
                    </option>
                  ))}
                </select>
              </div>
              <div className="campo campo-stretto">
                <label htmlFor="scelta-dal">{labels.dal}</label>
                <input
                  id="scelta-dal"
                  type="date"
                  required
                  value={form.dal}
                  onChange={(e) => setForm({ ...form, dal: e.target.value })}
                />
              </div>
              <div className="campo campo-stretto">
                <label htmlFor="scelta-scadenza">{labels.scadenza} (facoltativa)</label>
                <input
                  id="scelta-scadenza"
                  type="date"
                  min={form.dal}
                  aria-describedby="scelta-scadenza-aiuto"
                  value={form.scadenza}
                  onChange={(e) => setForm({ ...form, scadenza: e.target.value })}
                />
                <p className="aiuto" id="scelta-scadenza-aiuto">
                  Per le scelte a tempo determinato.
                </p>
              </div>
            </div>
            <div className="azioni">
              <button type="submit" className="pulsante pulsante-primario">
                <Icon name="aggiungi" /> <span>Registra la scelta</span>
              </button>
            </div>
          </fieldset>
        </form>
      )}
      <FormError error={error} labels={labels} />
      {done && <Notice kind="fatto">{done.text}</Notice>}
      {done && done.avvisi.length > 0 && (
        <Notice kind="avviso">
          <p>
            <strong>Da controllare:</strong>
          </p>
          <ul>
            {done.avvisi.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </ul>
        </Notice>
      )}
    </section>
  );
}

/** Gruppi che cambiano la testata della cartella (lo stato del paziente). */
const BANNER_GROUPS = new Set(['stato']);

const SECTIONS: { id: string; title: string }[] = [
  { id: 'identita', title: 'Identità' },
  ...GROUPS.map((g) => ({ id: g.id, title: g.title })),
  { id: 'nucleo', title: 'Nucleo familiare' },
  { id: 'esenzioni', title: 'Esenzioni' },
  { id: 'scelta', title: 'Scelta del medico' },
];

/**
 * Dati amministrativi del paziente (tappa 15): identità, residenza e recapiti, dati SSN, stato e
 * decesso, cittadini stranieri, lavoro, canale del promemoria, nucleo familiare, esenzioni,
 * scelta del medico. Medico e segreteria li scrivono allo stesso modo (registry.write).
 */
export function PatientAdminPage() {
  const { id } = useParams<{ id: string }>();
  const record = useApi<{ paziente: Patient; riepilogo: Summary | null }>(`/api/pazienti/${id}`);
  const admin = useApi<AdminView>(`/api/pazienti/${id}/amministrazione`);
  if (record.loading && !record.data) return <Loading what="dati della cartella" />;
  if (!record.data) return <ErrorMessage error={record.error} />;
  const p = record.data.paziente;
  // La testata (nome, nascita, codice fiscale, stato, esenzioni) si ricarica solo quando cambia:
  // ogni apertura della cartella resta nel registro.
  const reload = () => {
    admin.reload();
    record.reload();
  };

  return (
    <>
      <PageHeader
        title="Dati amministrativi"
        trail={
          <>
            <Link to="/pazienti">Pazienti</Link> <span aria-hidden="true">/</span>{' '}
            <Link to={`/pazienti/${id}`}>
              {p.firstName} {p.lastName}
            </Link>{' '}
            <span aria-hidden="true">/</span> <span>Dati amministrativi</span>
          </>
        }
      />
      <PatientBanner patient={p} summary={record.data.riepilogo} />
      {admin.loading && !admin.data && <Loading what="dati amministrativi" />}
      <ErrorMessage error={admin.error} />
      {admin.data && (
        <>
          <nav className="collegamenti-cartella" aria-label="Gruppi dei dati amministrativi">
            {SECTIONS.map((s) => (
              <a key={s.id} className="pulsante pulsante-piatto" href={`#${s.id}`}>
                {s.title}
              </a>
            ))}
          </nav>
          <IdentitySection view={admin.data} onSaved={reload} />
          {GROUPS.map((g) => (
            <FieldsSection
              key={g.id}
              group={g}
              view={admin.data!}
              onSaved={BANNER_GROUPS.has(g.id) ? reload : admin.reload}
            />
          ))}
          <FamilySection view={admin.data} onSaved={admin.reload} />
          <ExemptionsSection view={admin.data} onSaved={reload} />
          <ChoicesSection view={admin.data} onSaved={admin.reload} />
        </>
      )}
    </>
  );
}
