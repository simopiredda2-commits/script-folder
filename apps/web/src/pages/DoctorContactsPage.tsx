import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { ErrorMessage, Loading, Notice, PageHeader } from '../components/common';
import { Icon } from '../components/Icon';
import { api, ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';

interface Contacts {
  nome: string;
  cognome: string;
  telefono: string;
  email: string;
  pec: string;
  mancaPerIlProfilo: string[];
}

const FIELDS: {
  key: keyof Omit<Contacts, 'mancaPerIlProfilo'>;
  label: string;
  type: string;
  autoComplete: string;
  required?: boolean;
}[] = [
  { key: 'nome', label: 'Nome', type: 'text', autoComplete: 'given-name', required: true },
  { key: 'cognome', label: 'Cognome', type: 'text', autoComplete: 'family-name', required: true },
  { key: 'telefono', label: 'Telefono dello studio', type: 'tel', autoComplete: 'tel' },
  { key: 'email', label: 'Email dello studio', type: 'email', autoComplete: 'email' },
  { key: 'pec', label: 'PEC', type: 'email', autoComplete: 'off' },
];

/**
 * Nome, cognome e recapiti di studio del medico (tappa 11): vanno nel Profilo Sanitario
 * Sintetico, che vuole nome e cognome separati e almeno un recapito. Li cambia solo il medico.
 */
export function DoctorContactsPage() {
  const { isDoctor } = useSession();
  const current = useApi<Contacts>(isDoctor ? '/api/profilo/recapiti' : null);
  const [draft, setDraft] = useState<Partial<Contacts>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);

  if (!isDoctor)
    return (
      <>
        <PageHeader title="Recapiti di studio" />
        <Notice kind="info">I recapiti di studio li inserisce e li cambia il medico.</Notice>
      </>
    );
  if (current.loading && !current.data) return <Loading what="recapiti di studio" />;
  if (!current.data) return <ErrorMessage error={current.error} />;
  const value = (k: keyof Contacts) => (draft[k] as string | undefined) ?? current.data![k];

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api('/api/profilo/recapiti', {
        method: 'PUT',
        body: Object.fromEntries(FIELDS.map((f) => [f.key, value(f.key)])),
      });
      setDraft({});
      setSaved(true);
      current.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'Servizio non raggiungibile'));
    } finally {
      setBusy(false);
    }
  }

  const missing = current.data.mancaPerIlProfilo;
  return (
    <>
      <PageHeader
        title="Recapiti di studio"
        actions={
          <Link className="pulsante" to="/profilo/credenziali">
            <Icon name="lucchetto" /> <span>Credenziali dei servizi</span>
          </Link>
        }
      />
      <p className="sottotitolo">
        Compaiono come autore nei documenti che firmi, come il Profilo sanitario sintetico.
      </p>
      {missing.length > 0 ? (
        <Notice kind="avviso">
          <p>Per firmare il Profilo sanitario sintetico manca:</p>
          <ul>
            {missing.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </Notice>
      ) : (
        <Notice kind="fatto">Ci sono i dati che il Profilo sanitario sintetico richiede.</Notice>
      )}
      <form className="riquadro" onSubmit={(e) => void submit(e)} aria-labelledby="titolo-recapiti">
        <h2 id="titolo-recapiti">
          <Icon name="pazienti" /> Nome e recapiti
        </h2>
        <fieldset disabled={busy}>
          <legend className="visivamente-nascosto">Nome e recapiti di studio</legend>
          <p className="aiuto">
            Nome e cognome come nel codice fiscale. Serve almeno un recapito: telefono, email o PEC.
          </p>
          <div className="campi-in-riga">
            {FIELDS.map((f) => (
              <div className="campo" key={f.key}>
                <label htmlFor={`recapito-${f.key}`}>{f.label}</label>
                <input
                  id={`recapito-${f.key}`}
                  type={f.type}
                  autoComplete={f.autoComplete}
                  required={f.required}
                  maxLength={
                    f.key === 'telefono' ? 30 : f.key === 'email' || f.key === 'pec' ? 200 : 100
                  }
                  value={value(f.key)}
                  onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.target.value }))}
                />
              </div>
            ))}
          </div>
          <div className="azioni">
            <button type="submit" className="pulsante pulsante-primario">
              <Icon name="fatto" /> <span>Salva i recapiti</span>
            </button>
          </div>
        </fieldset>
        <ErrorMessage error={error} />
        {saved && <Notice kind="fatto">Recapiti salvati.</Notice>}
      </form>
    </>
  );
}
