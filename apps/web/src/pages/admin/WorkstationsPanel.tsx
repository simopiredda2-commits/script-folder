import { useRef, useState, type FormEvent, type RefObject } from 'react';
import { ErrorMessage, Loading, Notice } from '../../components/common';
import { Icon } from '../../components/Icon';
import { api, ApiError } from '../../lib/api';
import { date } from '../../lib/format';
import { useApi } from '../../lib/useApi';

interface Workstation {
  id: string;
  nome: string;
  condivisa: boolean;
  note: string | null;
  creataIl: string;
  archiviataIl: string | null;
}
interface WorkstationList {
  postazioni: Workstation[];
  archiviate: Workstation[];
  puoModificare: boolean;
}

const failure = (e: unknown) =>
  e instanceof ApiError ? e : new ApiError(0, 'Servizio non raggiungibile');

const kindLabel = (w: Workstation) => (w.condivisa ? 'Condivisa' : 'Personale');

/**
 * Postazioni dello studio (tappa 14): il nome che ognuno scrive all'accesso, condivisa
 * (ambulatorio, segreteria) o personale, con le note. Le vedono tutti; le aggiunge, le modifica e
 * le archivia l'amministratore. Non si cancellano: archiviata, una postazione resta nello storico e
 * il suo nome torna libero.
 */
export function WorkstationsPanel() {
  const list = useApi<WorkstationList>('/api/studio/postazioni');
  const [editing, setEditing] = useState<Workstation | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const nameField = useRef<HTMLInputElement>(null);

  async function run(fn: () => Promise<unknown>, message: string) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await fn();
      setDone(message);
      setEditing(null);
      list.reload();
      return true;
    } catch (e) {
      setError(failure(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function edit(w: Workstation) {
    setEditing(w);
    setDone(null);
    setError(null);
    // Il modulo cambia sotto la tabella: il cursore va sul nome, da lì si continua.
    setTimeout(() => nameField.current?.focus(), 0);
  }

  function archive(w: Workstation) {
    if (
      !window.confirm(
        `Archiviare la postazione «${w.nome}»? Resta nello storico e il suo nome torna libero.`,
      )
    )
      return;
    void run(
      () => api(`/api/studio/postazioni/${w.id}/archivia`, { method: 'POST', body: {} }),
      `Postazione «${w.nome}» archiviata.`,
    );
  }

  if (list.loading && !list.data) return <Loading what="postazioni" />;
  if (!list.data) return <ErrorMessage error={list.error} />;
  const { postazioni, archiviate, puoModificare } = list.data;

  return (
    <section className="riquadro" aria-labelledby="titolo-postazioni">
      <h2 id="titolo-postazioni">
        <Icon name="stampa" /> Postazioni dello studio
      </h2>
      <p>
        Il nome che ognuno scrive all’accesso, per ogni computer dello studio: condivisa
        (ambulatorio, segreteria) o personale. Serve a ricordare le preferenze di stampa di ogni
        postazione. Una postazione non si cancella: si archivia.
      </p>
      {postazioni.length === 0 ? (
        <p className="tenue">Nessuna postazione.</p>
      ) : (
        <div className="tabella-scorrevole">
          <table className="tabella">
            <caption>Postazioni attive</caption>
            <thead>
              <tr>
                <th scope="col">Nome</th>
                <th scope="col">Tipo</th>
                <th scope="col">Note</th>
                {puoModificare && <th scope="col">Azioni</th>}
              </tr>
            </thead>
            <tbody>
              {postazioni.map((w) => (
                <tr key={w.id}>
                  <td>{w.nome}</td>
                  <td>{kindLabel(w)}</td>
                  <td>{w.note ?? '—'}</td>
                  {puoModificare && (
                    <td>
                      <div className="azioni">
                        <button
                          type="button"
                          className="pulsante"
                          disabled={busy}
                          aria-label={`Modifica la postazione «${w.nome}»`}
                          onClick={() => edit(w)}
                        >
                          Modifica
                        </button>
                        <button
                          type="button"
                          className="pulsante pulsante-piatto"
                          disabled={busy}
                          aria-label={`Archivia la postazione «${w.nome}»`}
                          onClick={() => archive(w)}
                        >
                          <Icon name="archivio" /> <span>Archivia</span>
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {done && <Notice kind="fatto">{done}</Notice>}
      {puoModificare ? (
        <WorkstationForm
          key={editing?.id ?? 'nuova'}
          editing={editing}
          busy={busy}
          nameField={nameField}
          onCancel={() => setEditing(null)}
          onSubmit={(body) =>
            run(
              () =>
                editing
                  ? api(`/api/studio/postazioni/${editing.id}`, { method: 'PATCH', body })
                  : api('/api/studio/postazioni', { method: 'POST', body }),
              editing
                ? `Postazione «${body.nome}» salvata.`
                : `Postazione «${body.nome}» aggiunta.`,
            )
          }
        />
      ) : (
        <Notice kind="info">Le postazioni le gestisce l’amministratore dello studio.</Notice>
      )}
      <ErrorMessage error={error} />
      {archiviate.length > 0 && (
        <>
          <h3>Postazioni archiviate</h3>
          <ul>
            {archiviate.map((w) => (
              <li key={w.id}>
                {w.nome} <span className="tenue">({kindLabel(w).toLowerCase()})</span>, archiviata
                il {date(w.archiviataIl)}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

interface WorkstationBody {
  nome: string;
  condivisa: boolean;
  note: string | null;
}

function WorkstationForm({
  editing,
  busy,
  nameField,
  onCancel,
  onSubmit,
}: {
  editing: Workstation | null;
  busy: boolean;
  nameField: RefObject<HTMLInputElement | null>;
  onCancel: () => void;
  onSubmit: (body: WorkstationBody) => Promise<boolean>;
}) {
  const [name, setName] = useState(editing?.nome ?? '');
  const [shared, setShared] = useState(editing?.condivisa ?? true);
  const [notes, setNotes] = useState(editing?.note ?? '');

  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await onSubmit({ nome: name.trim(), condivisa: shared, note: notes.trim() || null });
    if (ok && !editing) {
      setName('');
      setNotes('');
      setShared(true);
    }
  }

  return (
    <form className="modulo" onSubmit={(e) => void submit(e)} aria-labelledby="titolo-postazione">
      <h3 id="titolo-postazione">
        {editing ? `Modifica la postazione «${editing.nome}»` : 'Nuova postazione'}
      </h3>
      <fieldset disabled={busy}>
        <legend className="visivamente-nascosto">Dati della postazione</legend>
        <div className="campo">
          <label htmlFor="postazione-nome">Nome della postazione</label>
          <input
            id="postazione-nome"
            ref={nameField}
            required
            maxLength={100}
            autoComplete="off"
            aria-describedby="postazione-nome-aiuto"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <p className="aiuto" id="postazione-nome-aiuto">
            Come lo scrive chi accede da quel computer. Due postazioni attive non possono avere lo
            stesso nome.
          </p>
        </div>
        <fieldset className="scelta-in-riga">
          <legend>Tipo di postazione</legend>
          <div className="casella">
            <input
              id="postazione-condivisa"
              type="radio"
              name="postazione-tipo"
              checked={shared}
              onChange={() => setShared(true)}
            />
            <label htmlFor="postazione-condivisa">
              Condivisa <span className="tenue">(ambulatorio, segreteria)</span>
            </label>
          </div>
          <div className="casella">
            <input
              id="postazione-personale"
              type="radio"
              name="postazione-tipo"
              checked={!shared}
              onChange={() => setShared(false)}
            />
            <label htmlFor="postazione-personale">Personale</label>
          </div>
        </fieldset>
        <div className="campo">
          <label htmlFor="postazione-note">Note (facoltative)</label>
          <textarea
            id="postazione-note"
            rows={2}
            maxLength={500}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <div className="azioni">
          <button type="submit" className="pulsante pulsante-primario">
            <Icon name={editing ? 'fatto' : 'aggiungi'} />{' '}
            <span>{editing ? 'Salva le modifiche' : 'Aggiungi la postazione'}</span>
          </button>
          {editing && (
            <button type="button" className="pulsante pulsante-piatto" onClick={onCancel}>
              <Icon name="annulla" /> <span>Annulla la modifica</span>
            </button>
          )}
        </div>
      </fieldset>
    </form>
  );
}
