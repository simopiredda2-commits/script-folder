import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { ErrorMessage, Loading, Notice, PageHeader } from '../components/common';
import { Icon } from '../components/Icon';
import { api, ApiError } from '../lib/api';
import { dateTime } from '../lib/format';
import { useSession } from '../lib/session';
import { toolsSectionsFor } from '../lib/tools-sections';
import { useApi } from '../lib/useApi';
import { AdminLogSection } from './admin/AdminLogSection';
import { ConfirmUsersSection } from './admin/ConfirmUsersSection';
import { ImportSection } from './admin/ImportSection';
import { ListsSection } from './admin/ListsSection';
import { PrintSection } from './admin/PrintSection';
import { ServiceSection } from './admin/ServiceSection';
import { StudioSection } from './admin/StudioSection';
import { UsersSection } from './admin/UsersSection';
import { AftSection } from './AftSection';
import { DataUpdatesSection } from './DataUpdatesSection';
import { LayoutSection, TemplatesSection } from './TemplatesTools';

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
  /** Fissata dalla Regione per il PSS (V09): «ERP». */
  attivitaClinica: string | null;
  regime: string | null;
}
interface FseSettings {
  impostazioni: Settings | null;
  daCompletare: string[];
  valori: { regime: Option[] };
  /** Invii al Fascicolo regionale sospesi dall'amministratore (FSE-INT-SRS-01-V02, 3.4). */
  inviiSospesi: { dal: string | null; motivo: string | null } | null;
  puoModificare: boolean;
}

type FieldKey =
  | 'radiceDocumenti'
  | 'custodeRadice'
  | 'custodeCodice'
  | 'custodeNome'
  | 'custodeVia'
  | 'custodeComune'
  | 'custodeIstat'
  | 'custodeProvincia'
  | 'struttura'
  | 'regime';

function initial(s: Settings | null): Record<FieldKey, string> {
  return {
    radiceDocumenti: s?.radiceDocumenti ?? '',
    custodeRadice: s?.custode.radice ?? '',
    custodeCodice: s?.custode.codice ?? '',
    custodeNome: s?.custode.nome ?? '',
    custodeVia: s?.custode.via ?? '',
    custodeComune: s?.custode.comune ?? '',
    custodeIstat: s?.custode.istat ?? '',
    custodeProvincia: s?.custode.provincia ?? '',
    struttura: s?.struttura ?? '',
    regime: s?.regime ?? '',
  };
}

/**
 * Strumenti dello studio: modelli dei certificati e impaginazione del medico (tappa 13),
 * impostazioni del Fascicolo Sanitario Elettronico (tappa 11), aggiornamento delle banche dati
 * (D156). Le impostazioni del Fascicolo sono i
 * valori dell'accreditamento presso il Gateway: le inserisce l'amministratore, gli altri le leggono.
 */
export function StudioToolsPage() {
  const { state } = useSession();
  const [params, setParams] = useSearchParams();
  const roles = state.status === 'ready' ? state.me.ruoli.map((r) => r.codice) : [];
  const sections = toolsSectionsFor(roles);
  const current = sections.find((x) => x.key === params.get('sezione')) ?? sections[0];
  if (!current) return <PageHeader title="Strumenti dello studio" />;
  return (
    <>
      <PageHeader title="Strumenti dello studio" />
      <div className="schede" role="group" aria-label="Sezione degli strumenti">
        {sections.map((x) => (
          <button
            key={x.key}
            type="button"
            className="scheda"
            aria-pressed={current.key === x.key}
            onClick={() => setParams({ sezione: x.key }, { replace: true })}
          >
            {x.label}
          </button>
        ))}
      </div>
      {current.key === 'studio' && <StudioSection />}
      {current.key === 'utenti' && <UsersSection />}
      {current.key === 'conferme' && <ConfirmUsersSection />}
      {current.key === 'stampa' && <PrintSection />}
      {current.key === 'elenchi' && <ListsSection />}
      {current.key === 'registro' && <AdminLogSection />}
      {current.key === 'servizio' && <ServiceSection />}
      {current.key === 'importazione' && <ImportSection />}
      {current.key === 'modelli' && <TemplatesSection />}
      {current.key === 'aft' && <AftSection />}
      {current.key === 'impaginazione' && <LayoutSection />}
      {current.key === 'fascicolo' && <FseSection />}
      {current.key === 'banche-dati' && <DataUpdatesSection />}
    </>
  );
}

function FseSection() {
  const current = useApi<FseSettings>('/api/studio/fascicolo');
  // Il messaggio sta fuori dal modulo, che si rifà con i dati salvati.
  const [saved, setSaved] = useState(false);
  if (current.loading && !current.data) return <Loading what="impostazioni dello studio" />;
  if (!current.data) return <ErrorMessage error={current.error} />;
  return (
    <>
      <FseSettingsForm
        key={JSON.stringify(current.data.impostazioni)}
        data={current.data}
        onSaving={() => setSaved(false)}
        onSaved={() => {
          setSaved(true);
          current.reload();
        }}
      />
      {saved && <Notice kind="fatto">Impostazioni salvate.</Notice>}
      <FseSendingPanel data={current.data} onChanged={() => current.reload()} />
    </>
  );
}

/**
 * Sospendere gli invii al Fascicolo regionale, per esempio su richiesta del supporto del CSI: i
 * messaggi restano in coda e partono alla ripresa (FSE-INT-SRS-01-V02, 3.4 e 4.5). Solo
 * l'amministratore; ogni cambio resta nel registro delle azioni di amministrazione.
 */
function FseSendingPanel({ data, onChanged }: { data: FseSettings; onChanged: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const suspended = data.inviiSospesi;
  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      await api('/api/studio/fascicolo/invii', {
        method: 'PUT',
        body: suspended
          ? { sospesi: false }
          : { sospesi: true, ...(reason ? { motivo: reason } : {}) },
      });
      setReason('');
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'Servizio non raggiungibile'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="riquadro" aria-labelledby="titolo-invii-fascicolo">
      <h2 id="titolo-invii-fascicolo">Invii al Fascicolo regionale</h2>
      {suspended ? (
        <Notice kind="avviso">
          Invii sospesi{suspended.dal ? ` dal ${dateTime(suspended.dal)}` : ''}
          {suspended.motivo ? `: ${suspended.motivo}` : ''}. I Profili restano in coda e partono
          alla ripresa.
        </Notice>
      ) : (
        <p>
          Il programma manda i Profili al Fascicolo regionale, con le regole della Regione: niente
          invii dalle 00 alle 07, tre tentativi a 5 minuti e poi uno al giorno per dieci giorni.
        </p>
      )}
      {data.puoModificare && (
        <>
          {!suspended && (
            <div className="campo">
              <label htmlFor="fascicolo-motivo-sospensione">Motivo (facoltativo)</label>
              <input
                id="fascicolo-motivo-sospensione"
                maxLength={500}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <p className="aiuto">Per esempio: richiesta del supporto del Fascicolo del CSI.</p>
            </div>
          )}
          <div className="azioni">
            <button
              type="button"
              className="pulsante"
              disabled={busy}
              onClick={() => void toggle()}
            >
              <Icon name={suspended ? 'ripeti' : 'blocco'} />{' '}
              <span>{suspended ? 'Riprendi gli invii' : 'Sospendi gli invii'}</span>
            </button>
          </div>
        </>
      )}
      <ErrorMessage error={error} />
    </section>
  );
}

function FseSettingsForm({
  data,
  onSaving,
  onSaved,
}: {
  data: FseSettings;
  onSaving: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState(() => initial(data.impostazioni));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const s = data.impostazioni;
  const readOnly = !data.puoModificare;
  const set = (k: FieldKey, v: string) => setF((x) => ({ ...x, [k]: v }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    onSaving();
    try {
      await api('/api/studio/fascicolo', {
        method: 'PUT',
        body: {
          radiceDocumenti: f.radiceDocumenti,
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
          regime: f.regime,
        },
      });
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
  const select = (k: 'regime', label: string, options: Option[]) => (
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
        il Profilo sanitario sintetico non si pubblica. Il Profilo va al Fascicolo della Regione,
        che lo pubblica sul Gateway: repository, invii e tipo di attività li mette la Regione.
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
        <div>
          <dt>Tipo di attività clinica</dt>
          <dd>
            <span className="codice">ERP</span> Erogazione Prestazione Prenotata, come vuole la
            Regione per il Profilo
          </dd>
        </div>
      </dl>
      <fieldset disabled={busy}>
        <legend>Identificativi</legend>
        <div className="campi-in-riga">
          {input('radiceDocumenti', 'Radice OID dei documenti', {
            code: true,
            help: 'Numeri separati da punti, per esempio 2.16.840.1.113883.2.9.',
          })}
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
        <div className="campi-in-riga">{select('regime', 'Regime', data.valori.regime)}</div>
        <p className="aiuto">
          I regimi della Regione Piemonte (specifiche del Fascicolo regionale per le cartelle, V09).
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
    </form>
  );
}
