import { useState, type FormEvent } from 'react';
import { ErrorMessage, Loading, Notice } from '../components/common';
import { Icon } from '../components/Icon';
import { api, ApiError, apiPdf, openPdf } from '../lib/api';
import { date } from '../lib/format';
import {
  FONT_LABELS,
  paragraphsOf,
  PLACEHOLDERS,
  useTemplates,
  type Layout,
  type Template,
} from '../lib/templates';
import { useApi } from '../lib/useApi';

const failure = (e: unknown) =>
  e instanceof ApiError ? e : new ApiError(0, 'Servizio non raggiungibile');

/** I problemi elencati dal servizio, uno per riga. */
export function Problems({ error }: { error: ApiError | null }) {
  const list = (error?.details as { problemi?: unknown } | undefined)?.problemi;
  if (!error) return null;
  if (!Array.isArray(list) || !list.every((p) => typeof p === 'string'))
    return <ErrorMessage error={error} />;
  return (
    <Notice kind="errore">
      <p>Da correggere:</p>
      <ul>
        {list.map((p) => (
          <li key={p}>{p}</li>
        ))}
      </ul>
    </Notice>
  );
}

/** Fonte di un modello ufficiale, con il collegamento all'atto; base di legge di un proposto. */
export function SourceLine({ t }: { t: Template }) {
  if (!t.fonte) return <p className="tenue">Modello dello studio.</p>;
  if (t.proposto)
    return (
      <>
        <p className="tenue">
          Base di legge:{' '}
          <a href={t.fonte.url} target="_blank" rel="noreferrer">
            {t.fonte.act}
          </a>
          {t.fonte.publication ? ` (${t.fonte.publication})` : ''}. Testo scritto dai requisiti di
          legge il {date(t.fonte.checkedOn)}.
          {t.validitaMesi ? ` Validità: ${t.validitaMesi} mesi dal rilascio.` : ''}
        </p>
        <p className="tenue">
          <strong>Modello proposto, da verificare:</strong> {t.proposto}
        </p>
      </>
    );
  return (
    <p className="tenue">
      Fonte:{' '}
      <a href={t.fonte.url} target="_blank" rel="noreferrer">
        {t.fonte.act}
      </a>
      {t.fonte.publication ? ` (${t.fonte.publication})` : ''}. Testo confrontato con l’atto il{' '}
      {date(t.fonte.checkedOn)}.
      {t.validitaMesi ? ` Validità: ${t.validitaMesi} mesi dal rilascio.` : ''}
    </p>
  );
}

/**
 * Modelli dei certificati (tappa 13): gli ufficiali, con il testo dell'atto, e quelli dello studio.
 */
export function TemplatesSection() {
  const catalog = useTemplates();
  const [editing, setEditing] = useState<Template | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  if (catalog.loading && !catalog.data) return <Loading what="modelli" />;
  if (!catalog.data) return <ErrorMessage error={catalog.error} />;
  const c = catalog.data;

  async function archive(t: Template) {
    setError(null);
    try {
      await api(`/api/modelli/studio/${t.id}/archivia`, { method: 'POST' });
      catalog.reload();
    } catch (e) {
      setError(failure(e));
    }
  }

  return (
    <>
      <section className="riquadro" aria-labelledby="titolo-modelli-ufficiali">
        <h2 id="titolo-modelli-ufficiali">
          <Icon name="archivio" /> Modelli ufficiali e proposti
        </h2>
        <p>
          Il testo viene dall’atto indicato e non si cambia. Dove un modello ufficiale non c’è, il
          programma propone un testo scritto dai requisiti di legge, da verificare. Al rilascio si
          compilano i dati del paziente e i campi che il modello prevede; carattere, intestazione e
          margini sono quelli dell’impaginazione del medico.
        </p>
        {c.ufficiali.length === 0 ? (
          <p className="tenue">
            Nessun modello ufficiale ancora: i testi si aggiungono dopo il confronto con gli atti.
          </p>
        ) : (
          <ul className="voci">
            {c.ufficiali.map((t) => (
              <li key={t.chiave} className="voce">
                <p>
                  <strong>{t.titolo}</strong>
                </p>
                <SourceLine t={t} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="riquadro" aria-labelledby="titolo-modelli-studio">
        <h2 id="titolo-modelli-studio">
          <Icon name="ricette" /> Modelli dello studio
        </h2>
        <p>
          Per i certificati che non hanno un modello ufficiale. Il testo lo scrive lo studio; i dati
          del paziente e del medico li mette il programma.
        </p>
        <Problems error={error} />
        {c.studio.length === 0 ? (
          <p className="tenue">Nessun modello dello studio.</p>
        ) : (
          <ul className="voci">
            {c.studio.map((t) => (
              <li key={t.chiave} className="voce">
                <p>
                  <strong>{t.titolo}</strong>{' '}
                  <span className="tenue">aggiornato il {date(t.versione)}</span>
                </p>
                {c.puoGestire && (
                  <div className="azioni">
                    <button
                      type="button"
                      className="pulsante pulsante-piatto"
                      onClick={() => setEditing(t)}
                    >
                      <Icon name="firma" /> <span>Modifica</span>
                      <span className="visivamente-nascosto"> il modello {t.titolo}</span>
                    </button>
                    <button
                      type="button"
                      className="pulsante pulsante-piatto"
                      onClick={() => void archive(t)}
                    >
                      <Icon name="archivio" /> <span>Archivia</span>
                      <span className="visivamente-nascosto"> il modello {t.titolo}</span>
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {c.puoGestire && (
          <StudioTemplateForm
            key={editing?.chiave ?? 'nuovo'}
            editing={editing}
            onDone={() => {
              setEditing(null);
              catalog.reload();
            }}
          />
        )}
      </section>
    </>
  );
}

function StudioTemplateForm({ editing, onDone }: { editing: Template | null; onDone: () => void }) {
  const [title, setTitle] = useState(editing?.titolo ?? '');
  const [text, setText] = useState(editing?.testo.join('\n\n') ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const body = { titolo: title, testo: paragraphsOf(text) };
      if (editing) await api(`/api/modelli/studio/${editing.id}`, { method: 'PUT', body });
      else await api('/api/modelli/studio', { method: 'POST', body });
      setDone(editing ? 'Modello aggiornato.' : 'Modello salvato.');
      if (!editing) {
        setTitle('');
        setText('');
      }
      onDone();
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} aria-labelledby="titolo-modello-studio">
      <h3 id="titolo-modello-studio">
        {editing ? `Modifica: ${editing.titolo}` : 'Nuovo modello dello studio'}
      </h3>
      <fieldset disabled={busy}>
        <legend className="visivamente-nascosto">Titolo e testo del modello</legend>
        <div className="campo">
          <label htmlFor="modello-titolo">Titolo</label>
          <input
            id="modello-titolo"
            required
            maxLength={200}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className="campo">
          <label htmlFor="modello-testo">Testo</label>
          <textarea
            id="modello-testo"
            required
            rows={8}
            value={text}
            aria-describedby="modello-testo-aiuto"
            onChange={(e) => setText(e.target.value)}
          />
          <p className="aiuto" id="modello-testo-aiuto">
            Una riga vuota tra un paragrafo e l’altro. I dati li mette il programma dove scrivi i
            segnaposto qui sotto.
          </p>
        </div>
        <details className="segnaposto">
          <summary>Segnaposto che si possono usare</summary>
          <dl>
            {PLACEHOLDERS.map((p) => (
              <div key={p.code}>
                <dt className="codice">{p.code}</dt>
                <dd>{p.label}</dd>
              </div>
            ))}
          </dl>
        </details>
        <div className="azioni">
          <button type="submit" className="pulsante pulsante-primario">
            <Icon name="fatto" /> <span>{editing ? 'Salva le modifiche' : 'Salva il modello'}</span>
          </button>
          {editing && (
            <button type="button" className="pulsante pulsante-piatto" onClick={onDone}>
              <Icon name="annulla" /> <span>Lascia com’è</span>
            </button>
          )}
        </div>
      </fieldset>
      <Problems error={error} />
      {done && <Notice kind="fatto">{done}</Notice>}
    </form>
  );
}

/** Impaginazione dei certificati, del medico che guarda (tappa 13). */
export function LayoutSection() {
  const current = useApi<Layout>('/api/profilo/impaginazione');
  // Il messaggio sta fuori dal modulo, che si rifà con i dati salvati.
  const [saved, setSaved] = useState(false);
  if (current.loading && !current.data) return <Loading what="impaginazione" />;
  if (!current.data) return <ErrorMessage error={current.error} />;
  return (
    <>
      <LayoutForm
        key={JSON.stringify(current.data)}
        initial={current.data}
        onSaving={() => setSaved(false)}
        onSaved={() => {
          setSaved(true);
          current.reload();
        }}
      />
      {saved && <Notice kind="fatto">Impaginazione salvata.</Notice>}
    </>
  );
}

function LayoutForm({
  initial,
  onSaving,
  onSaved,
}: {
  initial: Layout;
  onSaving: () => void;
  onSaved: () => void;
}) {
  const [l, setL] = useState(initial);
  const [header, setHeader] = useState(initial.intestazione.join('\n'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const body = (): Layout => ({
    ...l,
    intestazione: header
      .split('\n')
      .map((r) => r.trim())
      .filter(Boolean),
  });

  async function run(fn: () => Promise<unknown>, after?: () => void) {
    setBusy(true);
    setError(null);
    onSaving();
    try {
      await fn();
      after?.();
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      className="riquadro"
      aria-labelledby="titolo-impaginazione"
      onSubmit={(e) => {
        e.preventDefault();
        void run(() => api('/api/profilo/impaginazione', { method: 'PUT', body: body() }), onSaved);
      }}
    >
      <h2 id="titolo-impaginazione">
        <Icon name="stampa" /> Impaginazione dei certificati
      </h2>
      <p>
        Vale per i certificati che rilasci dai modelli. Il testo dei modelli non cambia: cambiano
        carattere, dimensione, intestazione, margini e timbro.
      </p>
      <fieldset disabled={busy}>
        <legend className="visivamente-nascosto">Impaginazione</legend>
        <fieldset className="scelta-in-riga">
          <legend>Carattere</legend>
          {(Object.keys(FONT_LABELS) as Layout['carattere'][]).map((k) => (
            <div key={k} className="casella">
              <input
                id={`carattere-${k}`}
                type="radio"
                name="carattere"
                checked={l.carattere === k}
                onChange={() => setL({ ...l, carattere: k })}
              />
              <label htmlFor={`carattere-${k}`}>{FONT_LABELS[k]}</label>
            </div>
          ))}
        </fieldset>
        <div className="campi-in-riga">
          <div className="campo campo-stretto">
            <label htmlFor="impaginazione-dimensione">Dimensione (punti)</label>
            <input
              id="impaginazione-dimensione"
              type="number"
              min={9}
              max={14}
              required
              value={l.dimensione}
              onChange={(e) => setL({ ...l, dimensione: Number(e.target.value) })}
            />
          </div>
          <div className="campo campo-stretto">
            <label htmlFor="impaginazione-margini">Margini (mm)</label>
            <input
              id="impaginazione-margini"
              type="number"
              min={10}
              max={40}
              required
              value={l.margini}
              onChange={(e) => setL({ ...l, margini: Number(e.target.value) })}
            />
          </div>
          <div className="campo">
            <label htmlFor="impaginazione-luogo">Luogo proposto per «luogo e data»</label>
            <input
              id="impaginazione-luogo"
              maxLength={100}
              value={l.luogo}
              onChange={(e) => setL({ ...l, luogo: e.target.value })}
            />
          </div>
        </div>
        <div className="campo">
          <label htmlFor="impaginazione-intestazione">Intestazione</label>
          <textarea
            id="impaginazione-intestazione"
            rows={4}
            value={header}
            aria-describedby="impaginazione-intestazione-aiuto"
            onChange={(e) => setHeader(e.target.value)}
          />
          <p className="aiuto" id="impaginazione-intestazione-aiuto">
            Al massimo sei righe; la prima si stampa in neretto.
          </p>
        </div>
        <fieldset className="scelta-in-riga">
          <legend>Intestazione</legend>
          {(
            [
              ['left', 'A sinistra'],
              ['center', 'Al centro'],
            ] as const
          ).map(([k, label]) => (
            <div key={k} className="casella">
              <input
                id={`allineamento-${k}`}
                type="radio"
                name="allineamento"
                checked={l.allineamento === k}
                onChange={() => setL({ ...l, allineamento: k })}
              />
              <label htmlFor={`allineamento-${k}`}>{label}</label>
            </div>
          ))}
        </fieldset>
        <div className="campo">
          <label htmlFor="impaginazione-timbro">Timbro</label>
          <textarea
            id="impaginazione-timbro"
            rows={3}
            maxLength={500}
            value={l.timbro}
            aria-describedby="impaginazione-timbro-aiuto"
            onChange={(e) => setL({ ...l, timbro: e.target.value })}
          />
          <p className="aiuto" id="impaginazione-timbro-aiuto">
            Si stampa sotto lo spazio della firma.
          </p>
        </div>
        <div className="azioni">
          <button type="submit" className="pulsante pulsante-primario">
            <Icon name="fatto" /> <span>Salva l’impaginazione</span>
          </button>
          <button
            type="button"
            className="pulsante"
            onClick={() =>
              void run(async () =>
                openPdf(await apiPdf('/api/profilo/impaginazione/anteprima', body())),
              )
            }
          >
            <Icon name="stampa" /> <span>Prova di stampa (PDF)</span>
          </button>
        </div>
      </fieldset>
      <Problems error={error} />
    </form>
  );
}
