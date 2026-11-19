import { useState } from 'react';
import { ErrorMessage, Loading } from '../../components/common';
import { Icon } from '../../components/Icon';
import { api, ApiError } from '../../lib/api';
import { dateTime } from '../../lib/format';
import { useApi } from '../../lib/useApi';
import type { BatchSummary, Profile } from './types';

const STATUS: Record<BatchSummary['stato'], { label: string; kind: 'fatto' | 'info' | 'avviso' }> =
  {
    caricato: { label: 'Caricato, non provato', kind: 'avviso' },
    prova: { label: 'Provato, non importato', kind: 'info' },
    importato: { label: 'Importato', kind: 'fatto' },
    annullato: { label: 'Annullato', kind: 'avviso' },
  };
const ICON = { fatto: 'fatto', info: 'info', avviso: 'avviso' } as const;

/** Storia delle importazioni dell'archivio, con il rapporto da scaricare. */
export function ImportHistory({ refresh }: { refresh: number }) {
  const history = useApi<{ importazioni: BatchSummary[] }>(`/api/importazioni?giro=${refresh}`);
  const [undoing, setUndoing] = useState<string | null>(null);
  if (history.loading && !history.data) return <Loading what="importazioni" />;
  if (!history.data) return <ErrorMessage error={history.error} />;
  const items = history.data.importazioni;
  if (!items.length) return <p className="tenue">Nessuna importazione ancora.</p>;
  return (
    <div className="tabella-scorrevole">
      <table className="tabella">
        <caption>Importazioni in questo archivio, dalla più recente</caption>
        <thead>
          <tr>
            <th scope="col">Caricato</th>
            <th scope="col">File</th>
            <th scope="col">Destinazioni</th>
            <th scope="col">Stato</th>
            <th scope="col">Righe</th>
            <th scope="col">Rapporto e azioni</th>
          </tr>
        </thead>
        <tbody>
          {items.map((b) => {
            const s = STATUS[b.stato];
            const c = b.conteggi;
            return (
              <tr key={b.id}>
                <th scope="row">
                  {dateTime(b.creatoIl)}
                  {b.chi && <p className="aiuto">{b.chi}</p>}
                </th>
                <td>
                  <span className="codice">{b.file.nome}</span>
                  {b.programma && <p className="aiuto">Da: {b.programma}</p>}
                </td>
                <td>{b.destinazioni.map((d) => d.nome).join(', ') || '—'}</td>
                <td>
                  <span className={`esito-aggiornamento esito-${s.kind}`}>
                    <Icon name={ICON[s.kind]} /> {s.label}
                  </span>
                </td>
                <td>
                  {c.righe !== undefined
                    ? `${c.righe} lette · ${c.scritte ?? 0} scritte · ${c.giaPresenti ?? 0} già presenti · ${c.scartate ?? 0} scartate`
                    : '—'}
                </td>
                <td>
                  <div className="azioni">
                    {b.stato !== 'caricato' && (
                      <a className="pulsante" href={`/api/importazioni/${b.id}/rapporto`} download>
                        <Icon name="ricette" /> Scarica (CSV)
                      </a>
                    )}
                    {b.stato === 'importato' && undoing !== b.id && (
                      <button
                        type="button"
                        className="pulsante pulsante-piatto"
                        onClick={() => setUndoing(b.id)}
                      >
                        <Icon name="annulla" /> Annulla l’importazione
                      </button>
                    )}
                  </div>
                  {undoing === b.id && (
                    <UndoForm
                      batchId={b.id}
                      onDone={() => {
                        setUndoing(null);
                        history.reload();
                      }}
                      onClose={() => setUndoing(null)}
                    />
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Annullamento con un motivo: le voci importate si annullano come quelle scritte a mano, nulla si
 * cancella. Il servizio dice di no se una voce è stata modificata dopo, o se l'importazione ha
 * scritto dati che non hanno ancora l'annullamento (pazienti, esenzioni, terapie).
 */
function UndoForm({
  batchId,
  onDone,
  onClose,
}: {
  batchId: string;
  onDone: () => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const fieldId = `motivo-${batchId}`;
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/importazioni/${batchId}/annulla`, {
        method: 'POST',
        body: { motivo: reason },
      });
      onDone();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'Servizio non raggiungibile'));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="riquadro">
      <div className="campo">
        <label htmlFor={fieldId}>Motivo dell’annullamento</label>
        <input
          id={fieldId}
          value={reason}
          maxLength={500}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <div className="azioni">
        <button
          type="button"
          className="pulsante pulsante-primario"
          disabled={busy || !reason.trim()}
          onClick={() => void submit()}
        >
          <Icon name="annulla" /> Annulla le voci importate
        </button>
        <button type="button" className="pulsante" onClick={onClose}>
          <Icon name="indietro" /> Lascia com’è
        </button>
      </div>
      <ErrorMessage error={error} />
    </div>
  );
}

/** Profili d'importazione dello studio: si usano su un file nuovo, si archiviano. */
export function ImportProfiles({
  refresh,
  canApply,
  onApply,
  onArchived,
}: {
  refresh: number;
  canApply: boolean;
  onApply: (p: Profile) => void;
  onArchived: () => void;
}) {
  const profiles = useApi<{ profili: Profile[] }>(`/api/importazioni/profili?giro=${refresh}`);
  const [error, setError] = useState<ApiError | null>(null);
  if (profiles.loading && !profiles.data) return <Loading what="profili" />;
  if (!profiles.data) return <ErrorMessage error={profiles.error} />;
  const list = profiles.data.profili;
  async function archive(id: string) {
    setError(null);
    try {
      await api(`/api/importazioni/profili/${id}/archivia`, { method: 'POST', body: {} });
      onArchived();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'Servizio non raggiungibile'));
    }
  }
  return (
    <>
      {list.length === 0 ? (
        <p className="tenue">
          Nessun profilo salvato. Dopo aver scelto colonne e campi di un file, puoi salvarli come
          profilo e riusarli con il file successivo dello stesso tipo.
        </p>
      ) : (
        <div className="tabella-scorrevole">
          <table className="tabella">
            <caption>Profili d’importazione dello studio</caption>
            <thead>
              <tr>
                <th scope="col">Nome</th>
                <th scope="col">Destinazioni</th>
                <th scope="col">Salvato</th>
                <th scope="col">Azioni</th>
              </tr>
            </thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id}>
                  <th scope="row">
                    {p.nome}
                    {p.programma && <p className="aiuto">Da: {p.programma}</p>}
                  </th>
                  <td>{p.destinazioni.map((d) => d.nome).join(', ')}</td>
                  <td>
                    {dateTime(p.creatoIl)}
                    {p.chi && <p className="aiuto">{p.chi}</p>}
                  </td>
                  <td>
                    <div className="azioni">
                      <button
                        type="button"
                        className="pulsante"
                        disabled={!canApply}
                        onClick={() => onApply(p)}
                      >
                        <Icon name="ripeti" /> Usa sul file caricato
                      </button>
                      <button
                        type="button"
                        className="pulsante pulsante-piatto"
                        onClick={() => void archive(p.id)}
                      >
                        <Icon name="archivio" /> Archivia
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {!canApply && list.length > 0 && (
        <p className="aiuto">Per usare un profilo, carica prima il file (passo 1).</p>
      )}
      <ErrorMessage error={error} />
    </>
  );
}
