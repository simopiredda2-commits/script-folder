import { useId, useState, type FormEvent } from 'react';
import { ErrorMessage, Notice } from '../../components/common';
import { Icon } from '../../components/Icon';
import { api, ApiError } from '../../lib/api';
import { date } from '../../lib/format';
import type { Catalog, Upload } from './types';

const SEPARATORS = [
  { key: 'automatico', label: 'Riconosciuto dal programma' },
  { key: ';', label: 'Punto e virgola (;)' },
  { key: ',', label: 'Virgola (,)' },
  { key: 'tab', label: 'Tabulazione' },
  { key: '|', label: 'Barra verticale (|)' },
] as const;

const FORMATS: Record<string, string> = {
  csv: 'Testo delimitato (CSV o TSV)',
  xlsx: 'Foglio di calcolo (XLSX)',
  json: 'JSON',
  'mmg-esportazione': 'Esportazione completa di questo programma',
};

export const size = (n: number) =>
  n < 1024 * 1024
    ? `${Math.max(1, Math.round(n / 1024))} kB`
    : `${(n / 1024 / 1024).toFixed(1)} MB`;

/** Il file in base64: il servizio riconosce il tipo dal contenuto, non dal nome. */
function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = typeof reader.result === 'string' ? reader.result : '';
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new ApiError(0, 'Il file non si legge'));
    reader.readAsDataURL(file);
  });
}

/** Passo 1: il file, caricato una volta sola e letto dal servizio. */
export function FileStep({
  catalog,
  upload,
  onUploaded,
}: {
  catalog: Catalog;
  upload: Upload | null;
  onUploaded: (u: Upload) => void;
}) {
  const id = useId();
  const [file, setFile] = useState<File | null>(null);
  const [separator, setSeparator] = useState<string>('automatico');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const limits = `Si leggono CSV e TSV, fogli di calcolo XLSX e JSON, fino a ${size(catalog.limiti.dimensione)}, ${catalog.limiti.righe.toLocaleString('it-IT')} righe e ${catalog.limiti.colonne} colonne per foglio.`;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file) {
      setError(new ApiError(400, 'Scegli prima il file da importare'));
      return;
    }
    if (file.size > catalog.limiti.dimensione) {
      setError(
        new ApiError(
          413,
          `Il file supera ${size(catalog.limiti.dimensione)}: dividilo in file più piccoli (per esempio un file per menu, o per anni).`,
        ),
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const contenuto = await readFile(file);
      const u = await api<Upload>('/api/importazioni', {
        method: 'POST',
        body: { nome: file.name, contenuto, separatore: separator },
      });
      onUploaded(u);
    } catch (err) {
      setError(err instanceof ApiError ? err : new ApiError(0, 'Servizio non raggiungibile'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <form className="modulo" onSubmit={(e) => void submit(e)} aria-describedby={`${id}-aiuto`}>
        <p id={`${id}-aiuto`} className="aiuto">
          {limits} Un file XLS vecchio o ODS va salvato prima come XLSX o CSV. Il file serve solo
          per questa importazione: il programma ne tiene nome, dimensione e impronta, non il
          contenuto.
        </p>
        <div className="campo">
          <label htmlFor={`${id}-file`}>File da importare</label>
          <input
            id={`${id}-file`}
            type="file"
            accept=".csv,.tsv,.txt,.xlsx,.json,text/csv,text/tab-separated-values,application/json,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </div>
        <div className="campo campo-stretto">
          <label htmlFor={`${id}-sep`}>Separatore dei campi (solo per i CSV)</label>
          <select id={`${id}-sep`} value={separator} onChange={(e) => setSeparator(e.target.value)}>
            {SEPARATORS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="azioni">
          <button type="submit" className="pulsante pulsante-primario" disabled={busy}>
            <Icon name="apri" /> {busy ? 'Lettura del file…' : 'Carica e leggi il file'}
          </button>
        </div>
      </form>
      <ErrorMessage error={error} />
      {upload && (
        <div className="riquadro" aria-live="polite">
          <h4>File letto</h4>
          <dl className="dati">
            <dt>Nome</dt>
            <dd>{upload.file.nome}</dd>
            <dt>Dimensione</dt>
            <dd>{size(upload.file.dimensione)}</dd>
            <dt>Formato</dt>
            <dd>{FORMATS[upload.formato] ?? upload.formato}</dd>
            {upload.codifica && (
              <>
                <dt>Codifica</dt>
                <dd>
                  {upload.codifica === 'cp1252' ? 'Windows-1252' : upload.codifica.toUpperCase()}
                </dd>
              </>
            )}
            {upload.formato === 'csv' && (
              <>
                <dt>Separatore</dt>
                <dd>
                  {SEPARATORS.find((s) => s.key === upload.separatore)?.label ??
                    'Nessuno (una colonna sola)'}
                </dd>
              </>
            )}
            <dt>Fogli</dt>
            <dd>
              {upload.tabelle
                .map((t) => `${t.nome}: ${t.righe.toLocaleString('it-IT')} righe`)
                .join(' · ')}
            </dd>
          </dl>
          {upload.giaImportatoIl && (
            <Notice kind="avviso">
              Questo stesso file è già stato importato il {date(upload.giaImportatoIl)}. Importarlo
              di nuovo non duplica i dati: le righe già importate risultano «già presenti».
            </Notice>
          )}
          {upload.note.length > 0 && (
            <Notice kind="info">
              <ul>
                {upload.note.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </Notice>
          )}
        </div>
      )}
    </>
  );
}
