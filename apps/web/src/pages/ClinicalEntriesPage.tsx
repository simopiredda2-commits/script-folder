import { useState, type FormEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { ErrorMessage, Loading, Notice, PageHeader } from '../components/common';
import { Icon } from '../components/Icon';
import { api, ApiError } from '../lib/api';
import {
  nameOf,
  useCatalog,
  type Catalog,
  type Entry,
  type EntryList,
  type EntryType,
} from '../lib/clinical';
import { date, studioToday } from '../lib/format';
import { useApi } from '../lib/useApi';
import { PatientBanner, type Patient, type Summary } from './RecordPage';

/** I tipi di questa pagina; i parametri hanno la loro, con l'andamento nel tempo. */
const TYPES: EntryType[] = [
  'problema',
  'allergia',
  'diario',
  'anamnesi',
  'stile_di_vita',
  'esame_obiettivo',
];

const PLURAL: Record<EntryType, string> = {
  problema: 'Problemi e diagnosi',
  allergia: 'Allergie e reazioni',
  diario: 'Diario clinico',
  misura: 'Parametri',
  anamnesi: 'Anamnesi',
  stile_di_vita: 'Stili di vita',
  esame_obiettivo: 'Esame obiettivo',
};

const text = (v: unknown) => (typeof v === 'string' ? v : '');

/** Che cosa dice una voce, in una riga, con le parole dei requisiti. */
export function entrySummary(e: Entry, catalog: Catalog | null): string {
  const d = e.dettaglio ?? {};
  switch (e.tipo) {
    case 'problema':
      return [
        text(d.descrizione),
        d.codice ? `(${text(d.codice)})` : '',
        d.dal ? `dal ${date(text(d.dal))}` : '',
        d.stato === 'risolto' ? `risolto il ${date(text(d.risoltoIl))}` : '',
      ]
        .filter(Boolean)
        .join(' ');
    case 'diario':
      return `${nameOf(catalog?.contatti, text(d.contatto))}: ${text(d.testo)}`;
    case 'anamnesi':
      return `${nameOf(catalog?.sezioniAnamnesi, text(d.sezione))}: ${text(d.testo)}`;
    case 'allergia':
      return `${text(d.sostanza)}${d.reazione ? ` — ${text(d.reazione)}` : ''}`;
    case 'stile_di_vita':
      return `${text(d.fattore)}: ${text(d.valore)}`;
    case 'esame_obiettivo':
      return [
        text(d.testo),
        d.scala ? `Scheda: ${text(d.scala)}` : '',
        d.punteggio ? `punteggio ${text(d.punteggio)}` : '',
      ]
        .filter(Boolean)
        .join(' · ');
    case 'misura':
      return `${text(d.parametro)}: ${text(d.valore)} ${text(d.unita)}`;
  }
}

/**
 * Voci cliniche della cartella (tappa 9): problemi e diagnosi, allergie e reazioni avverse,
 * diario, anamnesi, stili di vita, esame obiettivo. Le scrive il medico; non si cancellano, si
 * annullano con un motivo.
 */
export function ClinicalEntriesPage() {
  const { id } = useParams<{ id: string }>();
  const [params, setParams] = useSearchParams();
  const requested = params.get('tipo') as EntryType | null;
  const tipo: EntryType = requested && TYPES.includes(requested) ? requested : 'problema';
  const record = useApi<{ paziente: Patient; riepilogo: Summary | null }>(`/api/pazienti/${id}`);
  const catalog = useCatalog();
  const list = useApi<EntryList>(`/api/pazienti/${id}/voci?tipo=${tipo}`);
  if (record.loading && !record.data) return <Loading what="dati della cartella" />;
  if (!record.data) return <ErrorMessage error={record.error} />;
  const p = record.data.paziente;
  const refresh = () => {
    list.reload();
    record.reload();
  };

  return (
    <>
      <PageHeader
        title="Voci cliniche"
        trail={
          <>
            <Link to={`/pazienti/${id}`}>
              {p.firstName} {p.lastName}
            </Link>{' '}
            <span aria-hidden="true">/</span> <span>Voci cliniche</span>
          </>
        }
        actions={
          <>
            <Link className="pulsante" to={`/pazienti/${id}/parametri`}>
              <Icon name="esami" /> <span>Parametri</span>
            </Link>
            <Link className="pulsante" to={`/pazienti/${id}/privacy`}>
              <Icon name="lucchetto" /> <span>Privacy</span>
            </Link>
          </>
        }
      />
      <PatientBanner patient={p} summary={record.data.riepilogo} />
      <div className="schede" role="group" aria-label="Tipo di voce">
        {TYPES.map((t) => (
          <button
            key={t}
            type="button"
            className="scheda"
            aria-pressed={tipo === t}
            onClick={() => setParams({ tipo: t }, { replace: true })}
          >
            {PLURAL[t]}
          </button>
        ))}
      </div>
      {list.data?.puoScrivere && catalog.data && (
        <NewEntryForm
          key={tipo}
          patientId={id!}
          tipo={tipo}
          catalog={catalog.data}
          onSaved={refresh}
        />
      )}
      <section className="riquadro" aria-labelledby="titolo-voci">
        <h2 id="titolo-voci">{PLURAL[tipo]}</h2>
        {list.loading && !list.data && <Loading what="voci" />}
        {list.error?.status === 403 ? (
          <p className="tenue">Voci cliniche: non visibili con il tuo ruolo.</p>
        ) : (
          <ErrorMessage error={list.error} />
        )}
        {list.data && list.data.voci.length === 0 && <p className="tenue">Nessuna voce.</p>}
        {list.data && list.data.voci.length > 0 && (
          <ul className="voci">
            {list.data.voci.map((e) => (
              <EntryItem
                key={e.id}
                entry={e}
                patientId={id!}
                catalog={catalog.data}
                canWrite={list.data!.puoScrivere}
                onChanged={refresh}
              />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function NewEntryForm({
  patientId,
  tipo,
  catalog,
  onSaved,
}: {
  patientId: string;
  tipo: EntryType;
  catalog: Catalog;
  onSaved: () => void;
}) {
  const today = studioToday();
  const [f, setF] = useState<Record<string, string | boolean>>({
    data: today,
    stato: 'attivo',
    contatto: 'studio',
    sezione: 'familiare',
    fattore: catalog.fattori[0] ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState(false);
  const fid = (k: string) => `nuova-${k}`;
  const set = (k: string, v: string | boolean) => setF((x) => ({ ...x, [k]: v }));
  const str = (k: string) => {
    const v = f[k];
    return typeof v === 'string' ? v : '';
  };
  const value = (k: string) => str(k).trim() || undefined;

  function body() {
    const common = {
      tipo,
      data: str('data'),
      note: value('note'),
      riservata: f.riservata === true || undefined,
      oscurata: f.oscurata === true || undefined,
      promemoria: value('promemoria'),
    };
    switch (tipo) {
      case 'problema':
        return {
          ...common,
          descrizione: str('descrizione'),
          codice: value('codice'),
          stato: str('stato'),
          dal: value('dal'),
          risoltoIl: str('stato') === 'risolto' ? value('risoltoIl') : undefined,
          quesitoAperto: f.quesitoAperto === true || undefined,
        };
      case 'diario':
        return { ...common, contatto: str('contatto'), testo: str('testo') };
      case 'anamnesi':
        return { ...common, sezione: str('sezione'), testo: str('testo') };
      case 'allergia':
        return {
          ...common,
          sostanza: str('sostanza'),
          reazione: value('reazione'),
          daFarmaco: f.daFarmaco === true || undefined,
        };
      case 'stile_di_vita':
        return {
          ...common,
          fattore: str('fattore') === 'altro' ? str('altroFattore') : str('fattore'),
          valore: str('valore'),
        };
      case 'esame_obiettivo':
        return {
          ...common,
          testo: str('testo'),
          scala: value('scala'),
          punteggio: value('punteggio'),
        };
      default:
        return common;
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await api(`/api/pazienti/${patientId}/voci`, { method: 'POST', body: body() });
      setF((x) => ({
        data: today,
        stato: 'attivo',
        contatto: x.contatto ?? 'studio',
        sezione: x.sezione ?? 'familiare',
        fattore: x.fattore ?? '',
      }));
      setDone(true);
      onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'Servizio non raggiungibile'));
    } finally {
      setBusy(false);
    }
  }

  const input = (k: string, label: string, props: Record<string, unknown> = {}) => (
    <div className={`campo${props.stretto ? ' campo-stretto' : ''}`}>
      <label htmlFor={fid(k)}>{label}</label>
      <input
        id={fid(k)}
        value={str(k)}
        onChange={(e) => set(k, e.target.value)}
        {...Object.fromEntries(Object.entries(props).filter(([p]) => p !== 'stretto'))}
      />
    </div>
  );
  const area = (k: string, label: string, required = true) => (
    <div className="campo">
      <label htmlFor={fid(k)}>{label}</label>
      <textarea
        id={fid(k)}
        rows={4}
        required={required}
        value={str(k)}
        onChange={(e) => set(k, e.target.value)}
      />
    </div>
  );
  const check = (k: string, label: string) => (
    <div className="casella">
      <input
        id={fid(k)}
        type="checkbox"
        checked={f[k] === true}
        onChange={(e) => set(k, e.target.checked)}
      />
      <label htmlFor={fid(k)}>{label}</label>
    </div>
  );
  const select = (k: string, label: string, options: { chiave: string; nome: string }[]) => (
    <div className="campo">
      <label htmlFor={fid(k)}>{label}</label>
      <select id={fid(k)} value={str(k)} onChange={(e) => set(k, e.target.value)}>
        {options.map((o) => (
          <option key={o.chiave} value={o.chiave}>
            {o.nome}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <form className="riquadro" onSubmit={(e) => void submit(e)} aria-labelledby="titolo-nuova">
      <h2 id="titolo-nuova">
        <Icon name="aggiungi" /> {nameOf(catalog.tipi, tipo)}: nuova voce
      </h2>
      <fieldset disabled={busy}>
        <legend className="visivamente-nascosto">Dati della voce</legend>
        <div className="campi-in-riga">
          {input('data', 'Data', { type: 'date', required: true, max: today, stretto: true })}
          {tipo === 'diario' && select('contatto', 'Tipo di contatto', catalog.contatti)}
          {tipo === 'anamnesi' && select('sezione', 'Sezione', catalog.sezioniAnamnesi)}
        </div>
        {tipo === 'problema' && (
          <>
            <div className="campi-in-riga">
              {input('descrizione', 'Descrizione', { required: true, maxLength: 300 })}
              {input('codice', 'Codice ICD-9-CM', {
                className: 'codice',
                maxLength: 10,
                stretto: true,
                'aria-describedby': fid('codice-aiuto'),
              })}
            </div>
            <p className="aiuto" id={fid('codice-aiuto')}>
              Facoltativo; nel formato ICD-9-CM, per esempio 401.9 o V17.3.
            </p>
            <fieldset className="scelta-in-riga">
              <legend>Stato</legend>
              {(['attivo', 'risolto'] as const).map((s) => (
                <div className="casella" key={s}>
                  <input
                    id={fid(`stato-${s}`)}
                    type="radio"
                    name="stato"
                    checked={str('stato') === s}
                    onChange={() => set('stato', s)}
                  />
                  <label htmlFor={fid(`stato-${s}`)}>{s === 'attivo' ? 'Attivo' : 'Risolto'}</label>
                </div>
              ))}
            </fieldset>
            <div className="campi-in-riga">
              {input('dal', 'Inizio', { type: 'date', max: today, stretto: true })}
              {str('stato') === 'risolto' &&
                input('risoltoIl', 'Risolto il', {
                  type: 'date',
                  max: today,
                  required: true,
                  stretto: true,
                })}
            </div>
            {check('quesitoAperto', 'Quesito diagnostico aperto')}
          </>
        )}
        {(tipo === 'diario' || tipo === 'anamnesi') && area('testo', 'Testo')}
        {tipo === 'allergia' && (
          <>
            <div className="campi-in-riga">
              {input('sostanza', 'Sostanza o farmaco', { required: true, maxLength: 200 })}
              {input('reazione', 'Reazione', { maxLength: 500 })}
            </div>
            {check('daFarmaco', 'Reazione avversa a un farmaco')}
          </>
        )}
        {tipo === 'stile_di_vita' && (
          <div className="campi-in-riga">
            {select('fattore', 'Fattore', [
              ...catalog.fattori.map((x) => ({ chiave: x, nome: x })),
              { chiave: 'altro', nome: 'Altro fattore' },
            ])}
            {str('fattore') === 'altro' &&
              input('altroFattore', 'Quale fattore', { required: true, maxLength: 100 })}
            {input('valore', 'Com’è', { required: true, maxLength: 300 })}
          </div>
        )}
        {tipo === 'esame_obiettivo' && (
          <>
            {area('testo', 'Esame obiettivo o valutazione')}
            <div className="campi-in-riga">
              {input('scala', 'Scheda o scala di valutazione', { maxLength: 100 })}
              {input('punteggio', 'Punteggio', { maxLength: 50, stretto: true })}
            </div>
          </>
        )}
        <div className="campi-in-riga">
          {input('note', 'Note', { maxLength: 2000 })}
          {input('promemoria', 'Promemoria il', { type: 'date', min: str('data'), stretto: true })}
        </div>
        {check('riservata', 'Riservata: la vede solo il medico')}
        {check(
          'oscurata',
          'Oscurata su richiesta del paziente: non va nel Fascicolo né ai colleghi',
        )}
        <div className="azioni">
          <button type="submit" className="pulsante pulsante-primario">
            <Icon name="fatto" /> <span>Registra</span>
          </button>
        </div>
      </fieldset>
      <ErrorMessage error={error} />
      {done && <Notice kind="fatto">Voce registrata.</Notice>}
    </form>
  );
}

function EntryItem({
  entry: e,
  patientId,
  catalog,
  canWrite,
  onChanged,
}: {
  entry: Entry;
  patientId: string;
  catalog: Catalog | null;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const [mode, setMode] = useState<'none' | 'annul' | 'resolve'>('none');
  const [reason, setReason] = useState('');
  const [resolvedOn, setResolvedOn] = useState(studioToday());
  const [error, setError] = useState<ApiError | null>(null);
  const base = `/api/pazienti/${patientId}/voci/${e.id}`;
  const when = `del ${date(e.data)}`;
  const annulled = e.stato === 'annullata';
  const problem = e.tipo === 'problema';
  const resolved = problem && e.dettaglio?.stato === 'risolto';

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      setMode('none');
      setReason('');
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'Servizio non raggiungibile'));
    }
  }
  const patch = (body: object) => run(() => api(base, { method: 'PATCH', body }));

  return (
    <li className={`voce${annulled ? ' voce-annullata' : ''}`}>
      <p className="voce-testo">
        <span className="cronologia-data">{date(e.data)}</span>{' '}
        <span className={annulled ? 'testo-annullato' : undefined}>{entrySummary(e, catalog)}</span>
      </p>
      <p className="voce-dati">
        {annulled && <span className="etichetta">Annullata</span>}
        {resolved && <span className="etichetta">Risolto</span>}
        {problem && e.dettaglio?.quesitoAperto === true && (
          <span className="etichetta">Quesito aperto</span>
        )}
        {e.tipo === 'allergia' && e.dettaglio?.daFarmaco === true && (
          <span className="etichetta">Da farmaco</span>
        )}
        {e.riservata && <span className="etichetta">Riservata</span>}
        {e.oscurata && <span className="etichetta">Oscurata</span>}
        {e.promemoria && <span className="etichetta">Promemoria il {date(e.promemoria)}</span>}
        <span className="tenue">{e.autore}</span>
      </p>
      {e.note && <p className="tenue">Note: {e.note}</p>}
      {annulled && e.motivoAnnullamento && (
        <p className="tenue">Motivo dell’annullamento: {e.motivoAnnullamento}</p>
      )}
      {canWrite && !annulled && (
        <div className="azioni">
          {problem &&
            (resolved ? (
              <button
                type="button"
                className="pulsante pulsante-piatto"
                onClick={() => void patch({ stato: 'attivo' })}
              >
                <Icon name="ripeti" /> <span>Di nuovo attivo</span>
                <span className="visivamente-nascosto"> il problema {when}</span>
              </button>
            ) : (
              <button
                type="button"
                className="pulsante pulsante-piatto"
                aria-expanded={mode === 'resolve'}
                onClick={() => setMode(mode === 'resolve' ? 'none' : 'resolve')}
              >
                <Icon name="fatto" /> <span>Segna come risolto</span>
                <span className="visivamente-nascosto"> il problema {when}</span>
              </button>
            ))}
          <button
            type="button"
            className="pulsante pulsante-piatto"
            aria-pressed={e.riservata}
            onClick={() => void patch({ riservata: !e.riservata })}
          >
            <Icon name="lucchetto" /> <span>Riservata</span>
            <span className="visivamente-nascosto"> la voce {when}</span>
          </button>
          <button
            type="button"
            className="pulsante pulsante-piatto"
            aria-pressed={e.oscurata}
            onClick={() => void patch({ oscurata: !e.oscurata })}
          >
            <Icon name="lucchetto" /> <span>Oscurata</span>
            <span className="visivamente-nascosto"> la voce {when}</span>
          </button>
          <button
            type="button"
            className="pulsante pulsante-piatto"
            aria-expanded={mode === 'annul'}
            onClick={() => setMode(mode === 'annul' ? 'none' : 'annul')}
          >
            <Icon name="annulla" /> <span>Annulla la voce</span>
            <span className="visivamente-nascosto"> {when}</span>
          </button>
        </div>
      )}
      {mode === 'resolve' && (
        <form
          className="modulo-in-riga"
          onSubmit={(ev) => {
            ev.preventDefault();
            void patch({ stato: 'risolto', risoltoIl: resolvedOn });
          }}
        >
          <div className="campo">
            <label htmlFor={`risolto-${e.id}`}>Risolto il</label>
            <input
              id={`risolto-${e.id}`}
              type="date"
              required
              max={studioToday()}
              value={resolvedOn}
              onChange={(ev) => setResolvedOn(ev.target.value)}
            />
          </div>
          <button type="submit" className="pulsante pulsante-primario">
            <Icon name="fatto" /> <span>Conferma</span>
          </button>
        </form>
      )}
      {mode === 'annul' && (
        <form
          className="modulo-in-riga"
          onSubmit={(ev) => {
            ev.preventDefault();
            void run(() => api(`${base}/annulla`, { method: 'POST', body: { motivo: reason } }));
          }}
        >
          <div className="campo">
            <label htmlFor={`motivo-${e.id}`}>Motivo dell’annullamento</label>
            <input
              id={`motivo-${e.id}`}
              required
              maxLength={500}
              value={reason}
              onChange={(ev) => setReason(ev.target.value)}
            />
          </div>
          <button type="submit" className="pulsante pulsante-primario">
            <Icon name="annulla" /> <span>Conferma l’annullamento</span>
          </button>
        </form>
      )}
      <ErrorMessage error={error} />
    </li>
  );
}
