import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { ErrorMessage, Loading, Notice, PageHeader } from '../components/common';
import { Icon } from '../components/Icon';
import { PrintHint } from '../components/PrintHint';
import { api, ApiError, apiPdf, openPdf } from '../lib/api';
import { date, studioToday } from '../lib/format';
import { usePersistentState } from '../lib/storage';
import { useTemplates, type IssuedCertificate, type Template } from '../lib/templates';
import { useApi } from '../lib/useApi';
import { PatientBanner, type Patient, type Summary } from './RecordPage';
import { Problems, SourceLine } from './TemplatesTools';

interface Draft {
  modello: string;
  valori: Record<string, string>;
  luogo: string | null;
}

const failure = (e: unknown) =>
  e instanceof ApiError ? e : new ApiError(0, 'Servizio non raggiungibile');

/**
 * Altri certificati (tappa 13): dai modelli ufficiali, con il testo dell'atto, o da quelli dello
 * studio. Il programma mette i dati del paziente; il medico compila i campi del modello e rilascia.
 * Il certificato rilasciato resta nella cartella com'era; si annulla con un motivo.
 */
export function TemplateCertificatesPage() {
  const { id } = useParams<{ id: string }>();
  const record = useApi<{ paziente: Patient; riepilogo: Summary | null }>(`/api/pazienti/${id}`);
  const catalog = useTemplates();
  const overview = useApi<{ certificati: IssuedCertificate[]; luogo: string }>(
    `/api/pazienti/${id}/certificati-modelli`,
  );
  // Quello che si sta scrivendo resta ricordato per paziente, come negli altri moduli (D68, D129).
  const [draft, setDraft, resetDraft] = usePersistentState<Draft>(
    `certificato-modello-bozza-${id}`,
    {
      modello: '',
      valori: {},
      luogo: null,
    },
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);

  if (record.loading && !record.data) return <Loading what="dati della cartella" />;
  if (!record.data) return <ErrorMessage error={record.error} />;
  const p = record.data.paziente;
  const base = `/api/pazienti/${id}/certificati-modelli`;
  const all = [...(catalog.data?.ufficiali ?? []), ...(catalog.data?.studio ?? [])];
  const template = all.find((t) => t.chiave === draft.modello) ?? null;
  const place = draft.luogo ?? overview.data?.luogo ?? '';
  const body = () => ({ modello: draft.modello, valori: draft.valori, luogo: place });

  async function run(fn: () => Promise<unknown>, message: string | null) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await fn();
      if (message) setDone(message);
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  }

  function issue(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      await api(base, { method: 'POST', body: body() });
      resetDraft();
      overview.reload();
    }, 'Certificato rilasciato: è nella cartella, da stampare e firmare.');
  }

  const forbidden = overview.error?.status === 403;

  return (
    <>
      <PageHeader
        title="Altri certificati"
        trail={
          <>
            <Link to={`/pazienti/${id}`}>
              {p.firstName} {p.lastName}
            </Link>{' '}
            <span aria-hidden="true">/</span> <span>Altri certificati</span>
          </>
        }
        actions={
          <Link className="pulsante" to={`/pazienti/${id}/certificati`}>
            <Icon name="ricette" /> <span>Certificati di malattia</span>
          </Link>
        }
      />
      <PatientBanner patient={p} summary={record.data.riepilogo} />
      {forbidden ? (
        <Notice kind="info">I certificati li rilascia il medico.</Notice>
      ) : (
        <>
          <section className="riquadro" aria-labelledby="titolo-nuovo-certificato">
            <h2 id="titolo-nuovo-certificato">
              <Icon name="aggiungi" /> Nuovo certificato
            </h2>
            {catalog.loading && !catalog.data && <Loading what="modelli" />}
            <ErrorMessage error={catalog.error} />
            <div className="campo">
              <label htmlFor="certificato-modello">Modello</label>
              <select
                id="certificato-modello"
                value={draft.modello}
                onChange={(e) => setDraft({ ...draft, modello: e.target.value, valori: {} })}
              >
                <option value="">Scegli il modello</option>
                {catalog.data && catalog.data.ufficiali.length > 0 && (
                  <optgroup label="Modelli ufficiali e proposti">
                    {catalog.data.ufficiali.map((t) => (
                      <option key={t.chiave} value={t.chiave}>
                        {t.titolo}
                      </option>
                    ))}
                  </optgroup>
                )}
                {catalog.data && catalog.data.studio.length > 0 && (
                  <optgroup label="Modelli dello studio">
                    {catalog.data.studio.map((t) => (
                      <option key={t.chiave} value={t.chiave}>
                        {t.titolo}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
            </div>
            {catalog.data && all.length === 0 && (
              <p className="tenue">
                Non ci sono ancora modelli: si aggiungono in «Strumenti», sezione «Modelli dei
                certificati».
              </p>
            )}
            {template && (
              <IssueForm
                template={template}
                draft={draft}
                place={place}
                busy={busy}
                onChange={setDraft}
                onPreview={() =>
                  void run(async () => openPdf(await apiPdf(`${base}/anteprima`, body())), null)
                }
                onSubmit={issue}
              />
            )}
            <Problems error={error} />
            {done && <Notice kind="fatto">{done}</Notice>}
          </section>

          <section className="riquadro" aria-labelledby="titolo-certificati-rilasciati">
            <h2 id="titolo-certificati-rilasciati">
              <Icon name="storico" /> Certificati rilasciati
            </h2>
            <PrintHint kind="certificato_modello" />
            {overview.loading && !overview.data && <Loading what="certificati" />}
            <ErrorMessage error={overview.error} />
            {overview.data && overview.data.certificati.length === 0 && (
              <p className="tenue">Nessun certificato rilasciato da un modello.</p>
            )}
            {overview.data && overview.data.certificati.length > 0 && (
              <ul className="voci">
                {overview.data.certificati.map((c) => (
                  <IssuedItem key={c.id} c={c} base={base} onChanged={overview.reload} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </>
  );
}

function IssueForm({
  template: t,
  draft,
  place,
  busy,
  onChange,
  onPreview,
  onSubmit,
}: {
  template: Template;
  draft: Draft;
  place: string;
  busy: boolean;
  onChange: (d: Draft) => void;
  onPreview: () => void;
  onSubmit: (e: FormEvent) => void;
}) {
  const value = (k: string) => draft.valori[k] ?? '';
  const set = (k: string, v: string) => onChange({ ...draft, valori: { ...draft.valori, [k]: v } });
  const fid = (k: string) => `certificato-campo-${k}`;
  return (
    <form onSubmit={onSubmit} aria-label={`Rilascio: ${t.titolo}`}>
      <SourceLine t={t} />
      {t.perIlMedico.length > 0 && (
        <Notice kind="info">
          <p>Prima del rilascio (dall’atto):</p>
          <ul>
            {t.perIlMedico.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </Notice>
      )}
      <fieldset disabled={busy}>
        <legend>Campi del modello</legend>
        {t.campi.length === 0 && (
          <p className="tenue">Questo modello non ha campi: i dati li mette il programma.</p>
        )}
        {t.campi.map((f) =>
          f.type === 'scelta' && f.boxes ? (
            // Le caselle del modello cartaceo: una riga di pulsanti, uno per valore.
            <fieldset
              key={f.key}
              className="scelta scelta-in-riga"
              aria-describedby={f.help ? `${fid(f.key)}-aiuto` : undefined}
            >
              <legend>
                {f.label}
                {f.required ? '' : ' (facoltativo)'}
              </legend>
              {f.options?.map((o, i) => (
                <div key={o} className="casella">
                  <input
                    type="radio"
                    id={`${fid(f.key)}-${i}`}
                    name={fid(f.key)}
                    required={f.required}
                    checked={value(f.key) === o}
                    onChange={() => set(f.key, o)}
                  />
                  <label htmlFor={`${fid(f.key)}-${i}`}>{o}</label>
                </div>
              ))}
              {f.help && (
                <p className="aiuto" id={`${fid(f.key)}-aiuto`}>
                  {f.help}
                </p>
              )}
            </fieldset>
          ) : (
            <div key={f.key} className="campo">
              <label htmlFor={fid(f.key)}>
                {f.label}
                {f.required ? '' : ' (facoltativo)'}
              </label>
              {f.type === 'testo_lungo' ? (
                <textarea
                  id={fid(f.key)}
                  rows={4}
                  required={f.required}
                  maxLength={f.max}
                  aria-describedby={f.help ? `${fid(f.key)}-aiuto` : undefined}
                  value={value(f.key)}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              ) : f.type === 'scelta' ? (
                <select
                  id={fid(f.key)}
                  required={f.required}
                  aria-describedby={f.help ? `${fid(f.key)}-aiuto` : undefined}
                  value={value(f.key)}
                  onChange={(e) => set(f.key, e.target.value)}
                >
                  <option value="">Scegli</option>
                  {f.options?.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={fid(f.key)}
                  type={f.type === 'data' ? 'date' : 'text'}
                  inputMode={f.type === 'numero' ? 'decimal' : undefined}
                  max={f.type === 'data' ? studioToday() : undefined}
                  required={f.required}
                  maxLength={f.type === 'data' ? undefined : f.max}
                  aria-describedby={f.help ? `${fid(f.key)}-aiuto` : undefined}
                  value={value(f.key)}
                  onChange={(e) => set(f.key, e.target.value)}
                />
              )}
              {f.help && (
                <p className="aiuto" id={`${fid(f.key)}-aiuto`}>
                  {f.help}
                </p>
              )}
            </div>
          ),
        )}
        <div className="campo">
          <label htmlFor="certificato-luogo">Luogo del rilascio</label>
          <input
            id="certificato-luogo"
            required
            maxLength={100}
            value={place}
            onChange={(e) => onChange({ ...draft, luogo: e.target.value })}
          />
        </div>
        <p className="aiuto">
          La data è quella di oggi. I dati del paziente vengono dalla cartella: se manca qualcosa,
          il programma lo dice prima del rilascio.
        </p>
        <div className="azioni">
          <button type="submit" className="pulsante pulsante-primario">
            <Icon name="firma" /> <span>Rilascia il certificato</span>
          </button>
          <button type="button" className="pulsante" onClick={onPreview}>
            <Icon name="stampa" /> <span>Anteprima (PDF)</span>
          </button>
        </div>
        {/* La carta A5 della postazione vale già nell'anteprima (tappa 14). */}
        <PrintHint kind="certificato_modello" />
      </fieldset>
    </form>
  );
}

function IssuedItem({
  c,
  base,
  onChanged,
}: {
  c: IssuedCertificate;
  base: string;
  onChanged: () => void;
}) {
  const [annulling, setAnnulling] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const annulled = Boolean(c.annullatoIl);
  const when = `del ${date(c.rilasciatoIl)}`;

  async function annul(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api(`${base}/${c.id}/annulla`, { method: 'POST', body: { motivo: reason } });
      setAnnulling(false);
      onChanged();
    } catch (err) {
      setError(failure(err));
    }
  }

  return (
    <li className={`voce${annulled ? ' voce-annullata' : ''}`}>
      <p className="voce-testo">
        <span className="cronologia-data">{date(c.rilasciatoIl)}</span>{' '}
        <span className={annulled ? 'testo-annullato' : undefined}>{c.titolo}</span>
      </p>
      <p className="voce-dati">
        {annulled && <span className="etichetta">Annullato</span>}
        {c.validoFinoAl && !annulled && (
          <span className="etichetta">Valido fino al {date(c.validoFinoAl)}</span>
        )}
        <span className="tenue">
          {c.ufficiale
            ? 'Modello ufficiale'
            : c.fonte
              ? 'Modello proposto'
              : 'Modello dello studio'}
        </span>
      </p>
      {c.campi.filter((f) => f.value).length > 0 && (
        <p className="tenue">
          {c.campi
            .filter((f) => f.value)
            .map((f) => `${f.label}: ${f.value}`)
            .join(' · ')}
        </p>
      )}
      {annulled && c.motivoAnnullamento && (
        <p className="tenue">Motivo dell’annullamento: {c.motivoAnnullamento}</p>
      )}
      <div className="azioni">
        <a
          className="pulsante pulsante-piatto"
          href={`${base}/${c.id}/pdf`}
          target="_blank"
          rel="noreferrer"
        >
          <Icon name="stampa" /> <span>PDF</span>
          <span className="visivamente-nascosto">
            {' '}
            del certificato {c.titolo} {when}
          </span>
        </a>
        {!annulled && (
          <button
            type="button"
            className="pulsante pulsante-piatto"
            aria-expanded={annulling}
            onClick={() => setAnnulling(!annulling)}
          >
            <Icon name="annulla" /> <span>Annulla</span>
            <span className="visivamente-nascosto">
              {' '}
              il certificato {c.titolo} {when}
            </span>
          </button>
        )}
      </div>
      {annulling && (
        <form className="modulo-in-riga" onSubmit={(e) => void annul(e)}>
          <div className="campo">
            <label htmlFor={`annulla-${c.id}`}>Motivo dell’annullamento</label>
            <input
              id={`annulla-${c.id}`}
              required
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
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
