import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { ErrorMessage, Loading, PageHeader } from '../components/common';
import { Icon } from '../components/Icon';
import { api, ApiError } from '../lib/api';
import { studioToday } from '../lib/format';
import { usePersistentState } from '../lib/storage';
import { useApi } from '../lib/useApi';

export const failure = (e: unknown) =>
  e instanceof ApiError ? e : new ApiError(0, 'Servizio non raggiungibile');

export interface Option {
  chiave: string;
  nome: string;
}

/** L'identità come la scrive chi compila: il vuoto è «non scritto». */
export interface IdentityValues {
  cognome: string;
  nome: string;
  sesso: string;
  nascita: string;
  luogoNascita: string;
  luogoNascitaCodice: string;
  codiceFiscale: string;
}

export const EMPTY_IDENTITY: IdentityValues = {
  cognome: '',
  nome: '',
  sesso: '',
  nascita: '',
  luogoNascita: '',
  luogoNascitaCodice: '',
  codiceFiscale: '',
};

export const IDENTITY_LABELS: Record<keyof IdentityValues, string> = {
  cognome: 'Cognome',
  nome: 'Nome',
  sesso: 'Sesso',
  nascita: 'Data di nascita',
  luogoNascita: 'Comune o Stato estero di nascita',
  luogoNascitaCodice: 'Codice catastale del luogo di nascita',
  codiceFiscale: 'Codice fiscale',
};

/** I problemi di un salvataggio rifiutato, uno per riga, con il nome del campo quando c'è. */
export function problemLines(error: ApiError | null, labels: Record<string, string>): string[] {
  if (!error) return [];
  const d = error.details;
  if (Array.isArray(d))
    return (d as { message?: unknown; path?: unknown[] }[]).map((i) => {
      const key = [...(i.path ?? [])]
        .reverse()
        .find((p): p is string => typeof p === 'string' && p in labels);
      const message = typeof i.message === 'string' ? i.message : 'valore non valido';
      return key ? `${labels[key]}: ${message}` : message;
    });
  const problems = (d as { problemi?: unknown } | undefined)?.problemi;
  return Array.isArray(problems) ? problems.filter((x): x is string => typeof x === 'string') : [];
}

/** Errore di un modulo: che cosa non va, campo per campo, con simbolo e parola. */
export function FormError({
  error,
  labels,
  children,
}: {
  error: ApiError | null;
  labels: Record<string, string>;
  children?: ReactNode;
}) {
  if (!error) return null;
  const lines = problemLines(error, labels);
  const byRule = !Array.isArray(error.details) && lines.length > 0;
  return (
    <div className="messaggio messaggio-errore" role="alert">
      <Icon name="blocco" />
      <div>
        <p>
          <strong>Non salvato.</strong> {byRule ? 'Dati da correggere:' : error.message}
        </p>
        {lines.length > 0 && (
          <ul>
            {lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
        )}
        {children}
      </div>
    </div>
  );
}

const CHECK_DELAY_MS = 400;
const FISCAL_CODE_LENGTH = 16;

/**
 * Controllo del codice fiscale mentre si scrive: il problema formale (lunghezza, struttura, giorno,
 * carattere di controllo) e la coerenza con i dati scritti. Le incoerenze sono avvisi: si registra
 * lo stesso, perché l'unico codice valido è quello attribuito dall'Agenzia delle Entrate.
 */
export function FiscalCodeCheck({
  id,
  identity,
  touched,
}: {
  id: string;
  identity: IdentityValues;
  touched: boolean;
}) {
  const code = identity.codiceFiscale.trim();
  const ready = code.length >= FISCAL_CODE_LENGTH || (touched && code.length > 0);
  const body = ready
    ? {
        codiceFiscale: code,
        cognome: identity.cognome.trim() || null,
        nome: identity.nome.trim() || null,
        sesso: identity.sesso === 'M' || identity.sesso === 'F' ? identity.sesso : null,
        nascita: /^\d{4}-\d{2}-\d{2}$/.test(identity.nascita) ? identity.nascita : null,
        luogoNascitaCodice: /^[A-Za-z]\d{3}$/.test(identity.luogoNascitaCodice.trim())
          ? identity.luogoNascitaCodice.trim()
          : null,
      }
    : null;
  const key = body ? JSON.stringify(body) : '';
  const [result, setResult] = useState<{ problema: string | null; avvisi: string[] } | null>(null);
  useEffect(() => {
    if (!key) {
      setResult(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      api<{ problema: string | null; avvisi: string[] }>('/api/pazienti/verifica', {
        method: 'POST',
        body: JSON.parse(key) as unknown,
      })
        .then((r) => alive && setResult(r))
        .catch(() => alive && setResult(null));
    }, CHECK_DELAY_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [key]);

  return (
    <div id={id} role="status" aria-live="polite">
      {result?.problema && (
        <p className="errore-campo">
          <Icon name="blocco" /> Codice fiscale da correggere: {result.problema}.
        </p>
      )}
      {result && !result.problema && result.avvisi.length > 0 && (
        <div className="messaggio messaggio-avviso">
          <Icon name="avviso" />
          <div>
            <p>
              <strong>Da controllare:</strong> il codice fiscale non torna con i dati scritti.
            </p>
            <ul>
              {result.avvisi.map((a) => (
                <li key={a}>{a}</li>
              ))}
            </ul>
            <p>
              Controlla la trascrizione. Se il codice è quello della tessera sanitaria, si registra
              lo stesso: l’unico codice valido è quello attribuito dall’Agenzia delle Entrate, anche
              quando non torna con i dati. I casi di omocodia sono già riconosciuti.
            </p>
          </div>
        </div>
      )}
      {result && !result.problema && result.avvisi.length === 0 && (
        <p className="aiuto">
          <Icon name="fatto" /> Codice fiscale formalmente corretto e coerente con i dati scritti.
        </p>
      )}
    </div>
  );
}

/** Campi dell'identità, per il paziente nuovo e per la correzione. */
export function IdentityFields({
  prefix,
  values,
  sexes,
  onChange,
}: {
  prefix: string;
  values: IdentityValues;
  sexes: Option[];
  onChange: (next: IdentityValues) => void;
}) {
  const [touched, setTouched] = useState(false);
  const set = (k: keyof IdentityValues) => (e: { target: { value: string } }) =>
    onChange({ ...values, [k]: e.target.value });
  const today = studioToday();
  return (
    <>
      <div className="campi-in-riga">
        <div className="campo">
          <label htmlFor={`${prefix}-cognome`}>{IDENTITY_LABELS.cognome}</label>
          <input
            id={`${prefix}-cognome`}
            required
            maxLength={100}
            autoComplete="off"
            value={values.cognome}
            onChange={set('cognome')}
          />
        </div>
        <div className="campo">
          <label htmlFor={`${prefix}-nome`}>{IDENTITY_LABELS.nome}</label>
          <input
            id={`${prefix}-nome`}
            required
            maxLength={100}
            autoComplete="off"
            value={values.nome}
            onChange={set('nome')}
          />
        </div>
      </div>
      <fieldset className="scelta-in-riga">
        <legend>{IDENTITY_LABELS.sesso}</legend>
        {sexes.map((s) => (
          <div className="casella" key={s.chiave}>
            <input
              id={`${prefix}-sesso-${s.chiave}`}
              type="radio"
              name={`${prefix}-sesso`}
              required
              checked={values.sesso === s.chiave}
              onChange={() => onChange({ ...values, sesso: s.chiave })}
            />
            <label htmlFor={`${prefix}-sesso-${s.chiave}`}>{s.nome}</label>
          </div>
        ))}
      </fieldset>
      <div className="campi-in-riga">
        <div className="campo campo-stretto">
          <label htmlFor={`${prefix}-nascita`}>{IDENTITY_LABELS.nascita}</label>
          <input
            id={`${prefix}-nascita`}
            type="date"
            required
            max={today}
            value={values.nascita}
            onChange={set('nascita')}
          />
        </div>
        <div className="campo">
          <label htmlFor={`${prefix}-luogo`}>{IDENTITY_LABELS.luogoNascita}</label>
          <input
            id={`${prefix}-luogo`}
            maxLength={100}
            autoComplete="off"
            value={values.luogoNascita}
            onChange={set('luogoNascita')}
          />
        </div>
        <div className="campo campo-stretto">
          <label htmlFor={`${prefix}-luogo-codice`}>{IDENTITY_LABELS.luogoNascitaCodice}</label>
          <input
            id={`${prefix}-luogo-codice`}
            className="codice"
            maxLength={4}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={`${prefix}-luogo-codice-aiuto`}
            value={values.luogoNascitaCodice}
            onChange={(e) =>
              onChange({ ...values, luogoNascitaCodice: e.target.value.toUpperCase() })
            }
          />
          <p className="aiuto" id={`${prefix}-luogo-codice-aiuto`}>
            Una lettera e tre cifre, come i caratteri dal 12° al 15° del codice fiscale.
          </p>
        </div>
      </div>
      <div className="campo">
        <label htmlFor={`${prefix}-cf`}>{IDENTITY_LABELS.codiceFiscale}</label>
        <input
          id={`${prefix}-cf`}
          className="codice"
          required
          maxLength={FISCAL_CODE_LENGTH}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={`${prefix}-cf-controllo`}
          value={values.codiceFiscale}
          onChange={(e) => onChange({ ...values, codiceFiscale: e.target.value.toUpperCase() })}
          onBlur={() => setTouched(true)}
        />
        <FiscalCodeCheck id={`${prefix}-cf-controllo`} identity={values} touched={touched} />
      </div>
    </>
  );
}

/** Corpo dell'identità per il servizio: il vuoto dei campi facoltativi diventa null. */
export function identityBody(v: IdentityValues) {
  return {
    cognome: v.cognome.trim(),
    nome: v.nome.trim(),
    sesso: v.sesso,
    nascita: v.nascita,
    luogoNascita: v.luogoNascita.trim() || null,
    luogoNascitaCodice: v.luogoNascitaCodice.trim() || null,
    codiceFiscale: v.codiceFiscale.trim(),
  };
}

interface NewPatientOptions {
  archivi: { id: string; nome: string; titolare: string; proprio: boolean }[];
  archivioProposto: string | null;
  sessi: Option[];
}

/** Residenza e recapiti del paziente nuovo, con i nomi delle API. */
const CONTACTS = [
  { key: 'residenzaVia', label: 'Via o piazza della residenza', maxLength: 200 },
  { key: 'residenzaCivico', label: 'Numero civico', maxLength: 20, narrow: true },
  { key: 'residenzaCap', label: 'CAP', maxLength: 5, narrow: true, numeric: true },
  { key: 'residenzaComune', label: 'Comune di residenza', maxLength: 100 },
  { key: 'residenzaProvincia', label: 'Provincia (sigla)', maxLength: 2, narrow: true },
  { key: 'domicilio', label: 'Domicilio, se diverso dalla residenza', maxLength: 300 },
  { key: 'telefono', label: 'Telefono', maxLength: 40, type: 'tel' },
  { key: 'email', label: 'Email', maxLength: 200, type: 'email' },
] as const;
type ContactKey = (typeof CONTACTS)[number]['key'];
const EMPTY_CONTACTS = Object.fromEntries(CONTACTS.map((c) => [c.key, ''])) as Record<
  ContactKey,
  string
>;

const LABELS: Record<string, string> = {
  ...IDENTITY_LABELS,
  ...Object.fromEntries(CONTACTS.map((c) => [c.key, c.label])),
  archivioId: 'Archivio',
};

/**
 * Nuovo paziente (tappa 15): identità con il controllo del codice fiscale, archivio se c'è da
 * sceglierlo, residenza e recapiti. Quello che si sta scrivendo resta finché non si registra
 * (D68); dopo il salvataggio si apre la cartella.
 */
export function NewPatientPage() {
  const navigate = useNavigate();
  const options = useApi<NewPatientOptions>('/api/pazienti/nuovo');
  const [identity, setIdentity, resetIdentity] = usePersistentState(
    'bozza-nuovo-paziente-identita',
    EMPTY_IDENTITY,
  );
  const [contacts, setContacts, resetContacts] = usePersistentState(
    'bozza-nuovo-paziente-recapiti',
    EMPTY_CONTACTS,
  );
  const [archiveId, setArchiveId, resetArchive] = usePersistentState(
    'bozza-nuovo-paziente-archivio',
    '',
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const trail = (
    <>
      <Link to="/pazienti">Pazienti</Link> <span aria-hidden="true">/</span>{' '}
      <span>Nuovo paziente</span>
    </>
  );
  if (options.loading && !options.data) return <Loading what="dati del modulo" />;
  if (!options.data) return <ErrorMessage error={options.error} />;
  const { archivi, archivioProposto, sessi } = options.data;
  if (archivi.length === 0)
    return (
      <>
        <PageHeader title="Nuovo paziente" trail={trail} />
        <div className="messaggio messaggio-info" role="status">
          <Icon name="info" />
          <p>
            Non puoi registrare pazienti: serve il permesso di modificare l’anagrafica di un
            archivio (medico titolare, sostituto autorizzato o segreteria).
          </p>
        </div>
      </>
    );
  const chosen = archivi.some((a) => a.id === archiveId) ? archiveId : (archivioProposto ?? '');
  const duplicate = (error?.details as { paziente?: { id: string } | null } | undefined)?.paziente;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const dati: Record<string, string> = {};
    for (const c of CONTACTS) {
      const v = contacts[c.key].trim();
      if (v) dati[c.key] = c.key === 'residenzaProvincia' ? v.toUpperCase() : v;
    }
    try {
      const created = await api<{ id: string }>('/api/pazienti', {
        method: 'POST',
        body: {
          ...(chosen ? { archivioId: chosen } : {}),
          identita: identityBody(identity),
          dati,
        },
      });
      resetIdentity();
      resetContacts();
      resetArchive();
      void navigate(`/pazienti/${created.id}`);
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Nuovo paziente" trail={trail} />
      <form noValidate onSubmit={(e) => void submit(e)}>
        <fieldset disabled={busy} className="riquadro">
          <legend>Identità</legend>
          <IdentityFields prefix="nuovo" values={identity} sexes={sessi} onChange={setIdentity} />
        </fieldset>
        {archivi.length > 1 ? (
          <div className="riquadro">
            <div className="campo">
              <label htmlFor="nuovo-archivio">Archivio del paziente</label>
              <select
                id="nuovo-archivio"
                required
                value={chosen}
                aria-describedby="nuovo-archivio-aiuto"
                onChange={(e) => setArchiveId(e.target.value)}
              >
                <option value="">Scegli l’archivio</option>
                {archivi.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.nome} ({a.titolare})
                  </option>
                ))}
              </select>
              <p className="aiuto" id="nuovo-archivio-aiuto">
                L’archivio è quello del medico titolare che segue il paziente.
              </p>
            </div>
          </div>
        ) : (
          <p className="tenue">
            Archivio: {archivi[0]!.nome} ({archivi[0]!.titolare})
          </p>
        )}
        <fieldset disabled={busy} className="riquadro">
          <legend>Residenza e recapiti</legend>
          <div className="campi-in-riga">
            {CONTACTS.map((c) => (
              <div key={c.key} className={`campo${'narrow' in c ? ' campo-stretto' : ''}`}>
                <label htmlFor={`nuovo-${c.key}`}>{c.label}</label>
                <input
                  id={`nuovo-${c.key}`}
                  type={'type' in c ? c.type : 'text'}
                  inputMode={'numeric' in c ? 'numeric' : undefined}
                  maxLength={c.maxLength}
                  autoComplete="off"
                  value={contacts[c.key]}
                  onChange={(e) => setContacts({ ...contacts, [c.key]: e.target.value })}
                />
              </div>
            ))}
          </div>
          <p className="aiuto">
            Dati SSN, stato, esenzioni, scelta del medico, canale del promemoria e nucleo familiare
            si completano dopo, nei «Dati amministrativi» della cartella.
          </p>
        </fieldset>
        <FormError error={error} labels={LABELS}>
          {duplicate && (
            <p>
              <Link to={`/pazienti/${duplicate.id}`}>
                Apri la cartella del paziente già registrato
              </Link>
            </p>
          )}
        </FormError>
        <div className="azioni">
          <button type="submit" className="pulsante pulsante-primario" disabled={busy}>
            <Icon name="fatto" /> <span>Registra il paziente</span>
          </button>
          <button
            type="button"
            className="pulsante"
            disabled={busy}
            onClick={() => {
              resetIdentity();
              resetContacts();
              resetArchive();
              setError(null);
            }}
          >
            <Icon name="annulla" /> <span>Svuota il modulo</span>
          </button>
        </div>
      </form>
    </>
  );
}
