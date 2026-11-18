import { useState, type FormEvent } from 'react';
import { ErrorMessage, Loading, Notice, PageHeader } from '../components/common';
import { Icon } from '../components/Icon';
import { api, ApiError } from '../lib/api';
import { useApi } from '../lib/useApi';

interface Option {
  codice: string;
  nome: string;
}
interface Settings {
  organizzazione: { codice: string; nome: string };
  radiceDocumenti: string | null;
  repository: string | null;
  radiceInvii: string | null;
  custode: {
    radice: string | null;
    codice: string | null;
    nome: string | null;
    via: string | null;
    comune: string | null;
    istat: string | null;
    provincia: string | null;
  };
  struttura: string | null;
  tipologiaStruttura: string;
  assettoOrganizzativo: string;
  attivitaClinica: string | null;
  regime: string | null;
}
interface FseSettings {
  impostazioni: Settings | null;
  daCompletare: string[];
  valori: { attivitaClinica: Option[]; regime: Option[] };
  puoModificare: boolean;
}

type FieldKey =
  | 'radiceDocumenti'
  | 'repository'
  | 'radiceInvii'
  | 'custodeRadice'
  | 'custodeCodice'
  | 'custodeNome'
  | 'custodeVia'
  | 'custodeComune'
  | 'custodeIstat'
  | 'custodeProvincia'
  | 'struttura'
  | 'attivitaClinica'
  | 'regime';

function initial(s: Settings | null): Record<FieldKey, string> {
  return {
    radiceDocumenti: s?.radiceDocumenti ?? '',
    repository: s?.repository ?? '',
    radiceInvii: s?.radiceInvii ?? '',
    custodeRadice: s?.custode.radice ?? '',
    custodeCodice: s?.custode.codice ?? '',
    custodeNome: s?.custode.nome ?? '',
    custodeVia: s?.custode.via ?? '',
    custodeComune: s?.custode.comune ?? '',
    custodeIstat: s?.custode.istat ?? '',
    custodeProvincia: s?.custode.provincia ?? '',
    struttura: s?.struttura ?? '',
    attivitaClinica: s?.attivitaClinica ?? '',
    regime: s?.regime ?? '',
  };
}

/**
 * Strumenti dello studio: per ora le impostazioni del Fascicolo Sanitario Elettronico (tappa 11).
 * Sono i valori che lo studio riceve con l'accreditamento presso il Gateway: li inserisce
 * l'amministratore; chi lavora nello studio li legge.
 */
export function StudioToolsPage() {
  const current = useApi<FseSettings>('/api/studio/fascicolo');
  if (current.loading && !current.data) return <Loading what="impostazioni dello studio" />;
  if (!current.data) return <ErrorMessage error={current.error} />;
  return (
    <>
      <PageHeader title="Strumenti dello studio" />
      <FseSettingsForm
        key={JSON.stringify(current.data.impostazioni)}
        data={current.data}
        onSaved={current.reload}
      />
    </>
  );
}

function FseSettingsForm({ data, onSaved }: { data: FseSettings; onSaved: () => void }) {
  const [f, setF] = useState(() => initial(data.impostazioni));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState(false);
  const s = data.impostazioni;
  const readOnly = !data.puoModificare;
  const set = (k: FieldKey, v: string) => setF((x) => ({ ...x, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      await api('/api/studio/fascicolo', {
        method: 'PUT',
        body: {
          radiceDocumenti: f.radiceDocumenti,
          repository: f.repository,
          radiceInvii: f.radiceInvii,
          custode: {
            radice: f.custodeRadice,
            codice: f.custodeCodice,
            nome: f.custodeNome,
            via: f.custodeVia,
            comune: f.custodeComune,
            istat: f.custodeIstat,
            ...(f.custodeProvincia ? { provincia: f.custodeProvincia } : {}),
          },
          struttura: f.struttura,
          attivitaClinica: f.attivitaClinica,
          regime: f.regime,
        },
      });
      setSaved(true);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'Servizio non raggiungibile'));
    } finally {
      setBusy(false);
    }
  }

  const input = (
    k: FieldKey,
    label: string,
    props: { help?: string; code?: boolean; maxLength?: number; pattern?: string } = {},
  ) => (
    <div className="campo">
      <label htmlFor={`fascicolo-${k}`}>{label}</label>
      <input
        id={`fascicolo-${k}`}
        className={props.code ? 'codice' : undefined}
        required={k !== 'custodeProvincia'}
        readOnly={readOnly}
        maxLength={props.maxLength ?? 200}
        pattern={props.pattern}
        aria-describedby={props.help ? `fascicolo-${k}-aiuto` : undefined}
        value={f[k]}
        onChange={(e) => set(k, e.target.value)}
      />
      {props.help && (
        <p className="aiuto" id={`fascicolo-${k}-aiuto`}>
          {props.help}
        </p>
      )}
    </div>
  );
  const select = (k: 'attivitaClinica' | 'regime', label: string, options: Option[]) => (
    <div className="campo">
      <label htmlFor={`fascicolo-${k}`}>{label}</label>
      <select
        id={`fascicolo-${k}`}
        required
        disabled={readOnly}
        value={f[k]}
        onChange={(e) => set(k, e.target.value)}
      >
        <option value="">Da scegliere</option>
        {options.map((o) => (
          <option key={o.codice} value={o.codice}>
            {o.codice} – {o.nome}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <form className="riquadro" onSubmit={(e) => void submit(e)} aria-labelledby="titolo-fascicolo">
      <h2 id="titolo-fascicolo">
        <Icon name="archivio" /> Fascicolo Sanitario Elettronico
      </h2>
      <p>
        I valori che lo studio riceve con l’accreditamento presso il Gateway del Fascicolo. Senza,
        il Profilo sanitario sintetico non si pubblica.
      </p>
      {data.daCompletare.length > 0 ? (
        <Notice kind="avviso">
          {data.daCompletare.map((m) => (
            <p key={m}>{m}.</p>
          ))}
        </Notice>
      ) : (
        <Notice kind="fatto">Impostazioni complete.</Notice>
      )}
      {readOnly && (
        <Notice kind="info">
          Le impostazioni del Fascicolo le cambia l’amministratore dello studio.
        </Notice>
      )}
      <dl className="dati-fissi">
        <div>
          <dt>Organizzazione</dt>
          <dd>
            <span className="codice">{s?.organizzazione.codice ?? '010'}</span>{' '}
            {s?.organizzazione.nome ?? 'Regione Piemonte'}
          </dd>
        </div>
        <div>
          <dt>Tipologia della struttura</dt>
          <dd>{s?.tipologiaStruttura ?? 'Territorio'}</dd>
        </div>
        <div>
          <dt>Assetto organizzativo</dt>
          <dd className="codice">{s?.assettoOrganizzativo ?? 'AD_PSC130'}</dd>
        </div>
      </dl>
      <fieldset disabled={busy}>
        <legend>Identificativi</legend>
        <div className="campi-in-riga">
          {input('radiceDocumenti', 'Radice OID dei documenti', {
            code: true,
            help: 'Numeri separati da punti, per esempio 2.16.840.1.113883.2.9.',
          })}
          {input('repository', 'Identificativo del repository', { code: true })}
          {input('radiceInvii', 'Radice OID degli invii', { code: true })}
        </div>
      </fieldset>
      <fieldset disabled={busy}>
        <legend>Custode dei documenti</legend>
        <div className="campi-in-riga">
          {input('custodeRadice', 'Radice OID', { code: true })}
          {input('custodeCodice', 'Codice', { code: true, maxLength: 100 })}
          {input('custodeNome', 'Nome')}
        </div>
        <div className="campi-in-riga">
          {input('custodeVia', 'Via')}
          {input('custodeComune', 'Comune', { maxLength: 100 })}
          {input('custodeIstat', 'Codice ISTAT del comune', {
            code: true,
            maxLength: 6,
            pattern: '[0-9]{6}',
          })}
          {input('custodeProvincia', 'Provincia', { code: true, maxLength: 2 })}
        </div>
      </fieldset>
      <fieldset disabled={busy}>
        <legend>Struttura e documento</legend>
        <div className="campi-in-riga">
          {input('struttura', 'Struttura nel formato XON', {
            code: true,
            help: 'NOME^^^^^&OID&ISO^^^^CODICE',
          })}
        </div>
        <div className="campi-in-riga">
          {select('attivitaClinica', 'Tipo di attività clinica', data.valori.attivitaClinica)}
          {select('regime', 'Regime', data.valori.regime)}
        </div>
        <p className="aiuto">
          Codici e nomi dalle tabelle 57 e 63 della specifica del Gateway (versione 2.26).
        </p>
      </fieldset>
      {!readOnly && (
        <div className="azioni">
          <button type="submit" className="pulsante pulsante-primario" disabled={busy}>
            <Icon name="fatto" /> <span>Salva le impostazioni</span>
          </button>
        </div>
      )}
      <ErrorMessage error={error} />
      {saved && <Notice kind="fatto">Impostazioni salvate.</Notice>}
    </form>
  );
}
