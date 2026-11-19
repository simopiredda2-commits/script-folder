import { useEffect, useId, useRef, useState } from 'react';
import { ErrorMessage, Loading, Notice } from '../../components/common';
import { Icon } from '../../components/Icon';
import { api, ApiError, query } from '../../lib/api';
import { useApi } from '../../lib/useApi';
import {
  draftFor,
  emptyField,
  fromMapping,
  missingRequired,
  tableKey,
  toMapping,
} from '../import/drafts';
import { FieldsStep } from '../import/FieldsStep';
import { FileStep } from '../import/FileStep';
import { ImportHistory, ImportProfiles } from '../import/History';
import { CountsView, PreviewView, ReportView } from '../import/Results';
import { SheetsStep } from '../import/SheetsStep';
import '../import/import.css';
import type {
  Catalog,
  FieldDraft,
  PartDraft,
  PreviewResult,
  Profile,
  RunResult,
  TableInfo,
  Upload,
} from '../import/types';

const STEPS = [
  'Scegli il file',
  'Dove vanno i dati',
  'Colonne e campi',
  'Anteprima',
  'Prova senza scrivere',
  'Importa',
  'Esito',
] as const;

const asError = (e: unknown) =>
  e instanceof ApiError ? e : new ApiError(0, 'Servizio non raggiungibile');

/**
 * Importazione da altri programmi (tappa 15), in Strumenti, per il medico titolare: il file, dove
 * vanno i dati (destinazione per foglio), colonne e campi, anteprima, prova senza scrivere,
 * importazione, esito scaricabile; poi la storia delle importazioni e i profili. Il programma
 * d'origine non si nomina e non si analizza: la mappatura la costruisce il medico sul suo file.
 */
export function ImportSection() {
  const catalog = useApi<Catalog>('/api/importazioni/catalogo');
  if (catalog.loading && !catalog.data) return <Loading what="menu dell’importazione" />;
  if (!catalog.data) return <ErrorMessage error={catalog.error} />;
  return <ImportWizard catalog={catalog.data} />;
}

function ImportWizard({ catalog }: { catalog: Catalog }) {
  const id = useId();
  const [step, setStep] = useState(0);
  const [upload, setUpload] = useState<Upload | null>(null);
  const [tables, setTables] = useState<Record<string, TableInfo>>({});
  const [parts, setParts] = useState<PartDraft[]>([]);
  const [programma, setProgramma] = useState('');
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [trial, setTrial] = useState<{ key: string; result: RunResult } | null>(null);
  const [result, setResult] = useState<RunResult | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [profileName, setProfileName] = useState('');
  const [profileSaved, setProfileSaved] = useState<string | null>(null);
  const headings = useRef<(HTMLHeadingElement | null)[]>([]);
  const firstRender = useRef(true);

  // A ogni passo il fuoco va sul suo titolo: chi usa un lettore di schermo sa dove si trova.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headings.current[step]?.focus();
  }, [step]);

  const mapping = toMapping(parts, tables, catalog.destinazioni, programma);
  const mappingKey = JSON.stringify(mapping);
  const missing = missingRequired(parts, catalog.destinazioni);
  const trialCurrent = trial?.key === mappingKey ? trial.result : null;

  function reset() {
    setUpload(null);
    setTables({});
    setParts([]);
    setPreview(null);
    setTrial(null);
    setResult(null);
    setConfirmed(false);
    setError(null);
    setProfileSaved(null);
    setStep(0);
  }

  function onUploaded(u: Upload) {
    setUpload(u);
    setTables(Object.fromEntries(u.tabelle.map((t) => [tableKey(t.nome, t.intestazione), t])));
    setParts(
      u.mappaturaProposta
        ? fromMapping(u.mappaturaProposta, u.tabelle, catalog.destinazioni)
        : u.tabelle.flatMap((t) =>
            t.suggerimento
              ? [
                  draftFor(
                    t,
                    catalog.destinazioni.find((d) => d.key === t.suggerimento!.destinazione),
                    t.suggerimento.campi,
                  ),
                ]
              : [],
          ),
    );
    setPreview(null);
    setTrial(null);
    setResult(null);
    setError(null);
  }

  /** Colonne di un foglio con un'altra intestazione (e i suggerimenti per una destinazione). */
  async function loadColumns(tabella: string, intestazione: number, destinazione?: string) {
    if (!upload) return null;
    const info = await api<TableInfo>(
      `/api/importazioni/${upload.id}/colonne${query({
        tabella,
        intestazione: String(intestazione),
        destinazione: destinazione ?? null,
      })}`,
    );
    setTables((x) => ({ ...x, [tableKey(tabella, intestazione)]: info }));
    return info;
  }

  async function onHeader(tabella: string, intestazione: number) {
    setError(null);
    try {
      const info = await loadColumns(tabella, intestazione);
      setParts((list) =>
        list.map((p) =>
          p.tabella !== tabella
            ? p
            : {
                ...draftFor(
                  info!,
                  catalog.destinazioni.find((d) => d.key === p.destinazione),
                  p.destinazione === info!.suggerimento?.destinazione
                    ? info!.suggerimento.campi
                    : null,
                ),
                key: p.key,
              },
        ),
      );
    } catch (e) {
      setError(asError(e));
    }
  }

  async function onPartChange(key: string, patch: Partial<PartDraft>) {
    const current = parts.find((p) => p.key === key);
    if (!current) return;
    if (patch.destinazione !== undefined && patch.destinazione !== current.destinazione) {
      // Destinazione nuova: i campi ripartono, con le colonne suggerite per quella destinazione.
      setError(null);
      try {
        const info = patch.destinazione
          ? await loadColumns(current.tabella, current.intestazione, patch.destinazione)
          : null;
        const dest = catalog.destinazioni.find((d) => d.key === patch.destinazione);
        const fresh = draftFor(
          info ?? tables[tableKey(current.tabella, current.intestazione)]!,
          dest,
          info?.campi,
        );
        setParts((list) =>
          list.map((p) =>
            p.key === key ? { ...p, destinazione: patch.destinazione!, campi: fresh.campi } : p,
          ),
        );
      } catch (e) {
        setError(asError(e));
      }
      return;
    }
    setParts((list) => list.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  }

  function onAdd(tabella: string) {
    const t = upload?.tabelle.find((x) => x.nome === tabella);
    if (!t) return;
    const header = parts.find((p) => p.tabella === tabella)?.intestazione ?? t.intestazione;
    const info = tables[tableKey(tabella, header)] ?? t;
    setParts((list) => [...list, { ...draftFor(info, undefined, null), intestazione: header }]);
  }

  function onField(partKey: string, field: string, patch: Partial<FieldDraft>) {
    setParts((list) =>
      list.map((p) =>
        p.key === partKey
          ? {
              ...p,
              campi: { ...p.campi, [field]: { ...(p.campi[field] ?? emptyField()), ...patch } },
            }
          : p,
      ),
    );
  }

  async function run<T>(fn: () => Promise<T>): Promise<T | null> {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(asError(e));
      return null;
    } finally {
      setBusy(false);
    }
  }

  const doPreview = () =>
    run(async () => {
      const r = await api<PreviewResult>(`/api/importazioni/${upload!.id}/anteprima`, {
        method: 'POST',
        body: { mappatura: mapping },
      });
      setPreview(r);
      setStep(3);
    });
  const doTrial = () =>
    run(async () => {
      const r = await api<RunResult>(`/api/importazioni/${upload!.id}/prova`, {
        method: 'POST',
        body: { mappatura: mapping },
      });
      setTrial({ key: mappingKey, result: r });
      setConfirmed(false);
      setRefresh((n) => n + 1);
    });
  const doImport = () =>
    run(async () => {
      const r = await api<RunResult>(`/api/importazioni/${upload!.id}/importa`, {
        method: 'POST',
        body: { mappatura: mapping },
      });
      setResult(r);
      setRefresh((n) => n + 1);
      setStep(6);
    });
  const saveProfile = () =>
    run(async () => {
      const p = await api<Profile>('/api/importazioni/profili', {
        method: 'POST',
        body: {
          nome: profileName,
          programma: programma.trim() || null,
          formato: upload!.formato,
          mappatura: mapping,
        },
      });
      setProfileSaved(p.nome);
      setProfileName('');
      setRefresh((n) => n + 1);
    });

  function applyProfile(p: Profile) {
    if (!upload) return;
    const drafts = fromMapping(p.mappatura, Object.values(tables), catalog.destinazioni);
    setParts(drafts);
    setProgramma(p.programma ?? '');
    setPreview(null);
    setStep(2);
  }

  const reachable = (n: number) =>
    n === 0 ||
    (n <= 2 && !!upload) ||
    (n === 3 && !!preview) ||
    (n === 4 && !!upload && missing.length === 0) ||
    (n === 5 && !!trialCurrent) ||
    (n === 6 && !!result);

  const heading = (n: number) => (
    <h3
      id={`${id}-passo-${n}`}
      tabIndex={-1}
      ref={(el) => {
        headings.current[n] = el;
      }}
    >
      {n + 1}. {STEPS[n]}
    </h3>
  );

  return (
    <section className="riquadro" aria-labelledby="titolo-importazione">
      <h2 id="titolo-importazione">Importazione da altri programmi</h2>
      <p>
        Porta nella cartella i dati di un altro programma: anagrafica, esenzioni, scelta del medico,
        nucleo familiare, problemi, allergie, diario, anamnesi, stili di vita, esame obiettivo,
        parametri, esami, vaccinazioni, terapie e ricette passate. Per ogni foglio del file scegli
        dove vanno i dati e da quali colonne; il programma controlla ogni riga come se la scrivessi
        a mano. Prima si prova senza scrivere, poi si importa. Nulla di quanto c’è già in cartella
        viene sovrascritto.
      </p>
      <nav aria-label="Passi dell’importazione">
        <ol className="schede passi-importazione">
          {STEPS.map((label, n) => (
            <li key={label}>
              <button
                type="button"
                className="scheda"
                aria-current={step === n ? 'step' : undefined}
                disabled={!reachable(n)}
                onClick={() => setStep(n)}
              >
                {n + 1}. {label}
              </button>
            </li>
          ))}
        </ol>
      </nav>

      {step === 0 && (
        <section aria-labelledby={`${id}-passo-0`}>
          {heading(0)}
          <FileStep catalog={catalog} upload={upload} onUploaded={onUploaded} />
          {upload && (
            <div className="azioni">
              <button
                type="button"
                className="pulsante pulsante-primario"
                onClick={() => setStep(1)}
              >
                <Icon name="apri" /> Avanti: dove vanno i dati
              </button>
            </div>
          )}
        </section>
      )}

      {step === 1 && upload && (
        <section aria-labelledby={`${id}-passo-1`}>
          {heading(1)}
          <p className="aiuto">
            Il programma propone una destinazione quando riconosce i nomi delle colonne: è solo un
            suggerimento. Un foglio senza destinazione non si importa.
          </p>
          <SheetsStep
            catalog={catalog}
            upload={upload}
            tables={tables}
            parts={parts}
            onHeader={(t, h) => void onHeader(t, h)}
            onChange={(k, p) => void onPartChange(k, p)}
            onAdd={onAdd}
            onRemove={(k) => setParts((list) => list.filter((p) => p.key !== k))}
          />
          <div className="azioni">
            <button
              type="button"
              className="pulsante pulsante-primario"
              disabled={parts.length === 0 || parts.some((p) => !p.destinazione)}
              onClick={() => setStep(2)}
            >
              <Icon name="apri" /> Avanti: colonne e campi
            </button>
            {parts.some((p) => !p.destinazione) && (
              <p className="aiuto">Scegli la destinazione di ogni foglio da importare.</p>
            )}
          </div>
        </section>
      )}

      {step === 2 && upload && (
        <section aria-labelledby={`${id}-passo-2`}>
          {heading(2)}
          <FieldsStep catalog={catalog} tables={tables} parts={parts} onField={onField} />
          <div className="campo campo-stretto">
            <label htmlFor={`${id}-programma`}>
              Programma d’origine (facoltativo, come lo chiami tu)
            </label>
            <input
              id={`${id}-programma`}
              value={programma}
              maxLength={100}
              onChange={(e) => setProgramma(e.target.value)}
            />
          </div>
          {missing.length > 0 && (
            <Notice kind="avviso">
              Mancano campi obbligatori:{' '}
              {missing.map((m) => `«${m.label}» (foglio «${m.part.tabella}»)`).join(', ')}.
            </Notice>
          )}
          <div className="azioni">
            <button
              type="button"
              className="pulsante pulsante-primario"
              disabled={busy || missing.length > 0}
              onClick={() => void doPreview()}
            >
              <Icon name="cerca" /> Mostra l’anteprima
            </button>
          </div>
          <fieldset className="riquadro">
            <legend>Salva questa mappatura come profilo</legend>
            <p className="aiuto">
              Il profilo contiene i nomi delle colonne, le destinazioni e le corrispondenze dei
              valori, mai le righe del file. Si riusa con il prossimo file dello stesso tipo.
            </p>
            <div className="campo-con-pulsante">
              <label className="visivamente-nascosto" htmlFor={`${id}-profilo`}>
                Nome del profilo
              </label>
              <input
                id={`${id}-profilo`}
                value={profileName}
                maxLength={100}
                placeholder="Nome del profilo"
                onChange={(e) => setProfileName(e.target.value)}
              />
              <button
                type="button"
                className="pulsante"
                disabled={busy || !profileName.trim() || parts.length === 0}
                onClick={() => void saveProfile()}
              >
                <Icon name="archivio" /> Salva il profilo
              </button>
            </div>
            {profileSaved && <Notice kind="fatto">Profilo «{profileSaved}» salvato.</Notice>}
          </fieldset>
        </section>
      )}

      {step === 3 && preview && (
        <section aria-labelledby={`${id}-passo-3`}>
          {heading(3)}
          <p className="aiuto">
            Le prime righe di ogni destinazione come entrerebbero in cartella, con i controlli di
            ogni riga. Nulla è ancora scritto. L’abbinamento ai pazienti e i doppioni si vedono
            nella prova senza scrivere.
          </p>
          <PreviewView catalog={catalog} preview={preview} />
          <div className="azioni">
            <button type="button" className="pulsante" onClick={() => setStep(2)}>
              <Icon name="indietro" /> Torna a colonne e campi
            </button>
            <button type="button" className="pulsante pulsante-primario" onClick={() => setStep(4)}>
              <Icon name="apri" /> Avanti: prova senza scrivere
            </button>
          </div>
        </section>
      )}

      {step === 4 && upload && (
        <section aria-labelledby={`${id}-passo-4`}>
          {heading(4)}
          <p>
            La prova fa tutto quello che farebbe l’importazione, compresi abbinamento dei pazienti e
            doppioni, e alla fine annulla ogni scrittura: le cartelle non cambiano.
          </p>
          <div className="azioni">
            <button
              type="button"
              className="pulsante pulsante-primario"
              disabled={busy}
              onClick={() => void doTrial()}
            >
              <Icon name="ripeti" /> {busy ? 'Prova in corso…' : 'Fai la prova (non scrive nulla)'}
            </button>
          </div>
          {trial && !trialCurrent && (
            <Notice kind="avviso">La mappatura è cambiata dopo la prova: rifai la prova.</Notice>
          )}
          {trialCurrent && (
            <>
              <Notice kind="fatto">Prova finita: nessun dato è stato scritto.</Notice>
              <CountsView counts={trialCurrent.conteggi} dryRun />
              <ReportView
                catalog={catalog}
                rows={trialCurrent.rapporto}
                truncated={trialCurrent.rapportoTroncato}
              />
              <div className="azioni">
                <a
                  className="pulsante"
                  href={`/api/importazioni/${trialCurrent.id}/rapporto`}
                  download
                >
                  <Icon name="ricette" /> Scarica il rapporto della prova (CSV)
                </a>
                <button
                  type="button"
                  className="pulsante pulsante-primario"
                  onClick={() => setStep(5)}
                >
                  <Icon name="apri" /> Avanti: importa
                </button>
              </div>
            </>
          )}
        </section>
      )}

      {step === 5 && trialCurrent && (
        <section aria-labelledby={`${id}-passo-5`}>
          {heading(5)}
          <p>
            Si scriveranno {trialCurrent.conteggi.scritte.toLocaleString('it-IT')} righe (
            {trialCurrent.conteggi.voci.toLocaleString('it-IT')} voci) e si completeranno{' '}
            {trialCurrent.conteggi.pazientiCompletati} pazienti già in cartella; le{' '}
            {trialCurrent.conteggi.scartate.toLocaleString('it-IT')} righe scartate restano fuori.
            Tutto in una volta: se qualcosa non va, non si scrive nulla.
          </p>
          <div className="casella">
            <input
              id={`${id}-conferma`}
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            <label htmlFor={`${id}-conferma`}>
              Ho controllato la prova: importa i dati nel mio archivio
            </label>
          </div>
          <div className="azioni">
            <button
              type="button"
              className="pulsante pulsante-primario"
              disabled={busy || !confirmed}
              onClick={() => void doImport()}
            >
              <Icon name="fatto" /> {busy ? 'Importazione in corso…' : 'Importa'}
            </button>
          </div>
        </section>
      )}

      {step === 6 && result && (
        <section aria-labelledby={`${id}-passo-6`}>
          {heading(6)}
          <Notice kind="fatto">Importazione finita.</Notice>
          <CountsView counts={result.conteggi} dryRun={false} />
          <ReportView
            catalog={catalog}
            rows={result.rapporto}
            truncated={result.rapportoTroncato}
          />
          <div className="azioni">
            <a className="pulsante" href={`/api/importazioni/${result.id}/rapporto`} download>
              <Icon name="ricette" /> Scarica il rapporto (CSV)
            </a>
            <button type="button" className="pulsante" onClick={reset}>
              <Icon name="aggiungi" /> Nuova importazione
            </button>
          </div>
        </section>
      )}

      <ErrorMessage error={error} />

      <section aria-labelledby={`${id}-storia`}>
        <h3 id={`${id}-storia`}>Storia delle importazioni</h3>
        <ImportHistory refresh={refresh} />
      </section>
      <section aria-labelledby={`${id}-profili`}>
        <h3 id={`${id}-profili`}>Profili d’importazione</h3>
        <ImportProfiles
          refresh={refresh}
          canApply={!!upload}
          onApply={applyProfile}
          onArchived={() => setRefresh((n) => n + 1)}
        />
      </section>
    </section>
  );
}
