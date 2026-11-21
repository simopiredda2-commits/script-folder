import { useState } from 'react';
import { Link } from 'react-router';
import { Notice } from '../components/common';
import { Icon } from '../components/Icon';
import { api, ApiError } from '../lib/api';
import type { Patient } from './RecordPage';

/** I campi dell'anagrafica che si correggono dalla cartella (rotta PATCH, permesso registry.write). */
const FIELDS = [
  { key: 'phone', label: 'Telefono', type: 'tel' },
  { key: 'email', label: 'Email', type: 'email' },
  { key: 'residenceStreet', label: 'Via della residenza', type: 'text' },
  { key: 'residenceNumber', label: 'Numero civico', type: 'text' },
  { key: 'residenceTown', label: 'Comune di residenza', type: 'text' },
  { key: 'residenceProvince', label: 'Provincia (sigla)', type: 'text' },
  {
    key: 'domicile',
    label: 'Domicilio, se diverso dalla residenza',
    type: 'text',
  },
  { key: 'occupation', label: 'Professione', type: 'text' },
  {
    key: 'employerEmail',
    label: 'Email del datore di lavoro (facoltativa)',
    type: 'email',
  },
] as const;

/** Spiegazioni sotto il campo, dove servono. */
const HELP: Partial<Record<(typeof FIELDS)[number]['key'], string>> = {
  employerEmail:
    'Per i certificati INPS: al datore di lavoro va solo il numero di protocollo, nessun dato clinico.',
};

type Key = (typeof FIELDS)[number]['key'];
export type Registry = Record<Key, string | null>;

const residence = (p: Patient & Registry) =>
  [
    [p.residenceStreet, p.residenceNumber].filter(Boolean).join(' '),
    [p.residenceTown, p.residenceProvince && `(${p.residenceProvince})`].filter(Boolean).join(' '),
  ]
    .filter(Boolean)
    .join(', ');

/** Il corpo della modifica: solo i campi cambiati, il vuoto come «non scritto». */
export function registryPatch(
  before: Partial<Registry>,
  values: Record<Key, string>,
): Partial<Registry> {
  const patch: Partial<Registry> = {};
  for (const f of FIELDS) {
    let v: string | null = values[f.key].trim();
    if (f.key === 'residenceProvince' && v) v = v.toUpperCase();
    if (v === '') v = null;
    if (v !== (before[f.key] ?? null)) patch[f.key] = v;
  }
  return patch;
}

/**
 * Anagrafica e recapiti nella cartella. Medico e segreteria li correggono (registry.write); ogni
 * modifica passa dalla guardia del paziente ed entra nel registro degli accessi e nello storico.
 */
export function RegistrySection({
  patient,
  onSaved,
}: {
  patient: Patient & Partial<Registry>;
  onSaved: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [values, setValues] = useState<Record<Key, string>>(
    () => Object.fromEntries(FIELDS.map((f) => [f.key, ''])) as Record<Key, string>,
  );
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const p = patient as Patient & Registry;

  function start() {
    setValues(
      Object.fromEntries(FIELDS.map((f) => [f.key, p[f.key] ?? ''])) as Record<Key, string>,
    );
    setError(null);
    setSaved(false);
    setEditing(true);
  }

  async function save() {
    const patch = registryPatch(p, values);
    if (Object.keys(patch).length === 0) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/api/pazienti/${p.id}/anagrafica`, { method: 'PATCH', body: patch });
      setEditing(false);
      setSaved(true);
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e : null);
    } finally {
      setBusy(false);
    }
  }

  const issues =
    error && Array.isArray(error.details)
      ? (error.details as { message?: unknown; path?: unknown[] }[]).map((i) => {
          const field = FIELDS.find((f) => f.key === i.path?.[0]);
          return `${field ? `${field.label}: ` : ''}${typeof i.message === 'string' ? i.message : 'valore non valido'}`;
        })
      : [];

  return (
    <section className="riquadro" aria-labelledby="titolo-anagrafica">
      <h2 id="titolo-anagrafica">
        <Icon name="pazienti" /> Anagrafica e recapiti
      </h2>
      {!editing && (
        <>
          <dl className="dati">
            <dt>Luogo di nascita</dt>
            <dd>{p.birthPlaceName ?? '—'}</dd>
            <dt>Residenza</dt>
            <dd>{residence(p) || '—'}</dd>
            <dt>Domicilio</dt>
            <dd>{p.domicile ?? 'Come la residenza'}</dd>
            <dt>Telefono</dt>
            <dd>{p.phone ?? '—'}</dd>
            <dt>Email</dt>
            <dd>{p.email ?? '—'}</dd>
            <dt>ASL</dt>
            <dd>{p.asl ?? '—'}</dd>
            <dt>Professione</dt>
            <dd>{p.occupation ?? '—'}</dd>
            <dt>Email del datore di lavoro</dt>
            <dd>{p.employerEmail ?? '—'}</dd>
          </dl>
          <div className="azioni">
            <button type="button" className="pulsante" onClick={start}>
              <Icon name="firma" /> <span>Modifica i recapiti</span>
            </button>
            <Link className="pulsante pulsante-piatto" to={`/pazienti/${p.id}/amministrazione`}>
              <Icon name="apri" /> <span>Tutti i dati amministrativi</span>
            </Link>
          </div>
          <p className="aiuto">
            Nei dati amministrativi: CAP, dati SSN, stato, cittadini stranieri, canale del
            promemoria, nucleo familiare, esenzioni, scelta del medico e la correzione
            dell’identità.
          </p>
          {saved && <Notice kind="fatto">Recapiti salvati.</Notice>}
        </>
      )}
      {editing && (
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="campi-riga">
            {FIELDS.map((f) => (
              <div key={f.key} className="campo">
                <label htmlFor={`anagrafica-${f.key}`}>{f.label}</label>
                <input
                  id={`anagrafica-${f.key}`}
                  type={f.type}
                  autoComplete="off"
                  maxLength={f.key === 'residenceProvince' ? 2 : undefined}
                  value={values[f.key]}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                  aria-describedby={HELP[f.key] ? `anagrafica-${f.key}-aiuto` : undefined}
                />
                {HELP[f.key] && (
                  <p className="aiuto" id={`anagrafica-${f.key}-aiuto`}>
                    {HELP[f.key]}
                  </p>
                )}
              </div>
            ))}
          </div>
          {error && (
            <div className="messaggio messaggio-errore" role="alert">
              <Icon name="avviso" />
              <div>
                <p>{error.message}</p>
                {issues.length > 0 && (
                  <ul>
                    {issues.map((m) => (
                      <li key={m}>{m}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
          <div className="azioni">
            <button type="submit" className="pulsante pulsante-primario" disabled={busy}>
              <Icon name="fatto" /> <span>Salva i recapiti</span>
            </button>
            <button type="button" className="pulsante" onClick={() => setEditing(false)}>
              <Icon name="annulla" /> <span>Annulla</span>
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
