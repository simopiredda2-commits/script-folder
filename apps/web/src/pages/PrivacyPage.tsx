import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { ErrorMessage, Loading, Notice, PageHeader } from '../components/common';
import { Icon } from '../components/Icon';
import { api, ApiError } from '../lib/api';
import {
  CONSENT_STATUS_LABEL,
  useCatalog,
  type Catalog,
  type Consent,
  type Delegation,
  type EntryList,
  type Privacy,
} from '../lib/clinical';
import { date, studioToday } from '../lib/format';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';
import { entrySummary } from './ClinicalEntriesPage';
import { PatientBanner, type Patient, type Summary } from './RecordPage';

const failure = (e: unknown) =>
  e instanceof ApiError ? e : new ApiError(0, 'Servizio non raggiungibile');

/**
 * Privacy della cartella (tappa 9): consensi, compresi quelli alla consultazione del Fascicolo
 * (DM 7 settembre 2023, art. 8), deleghe (R16) e dati oscurati. Consensi e deleghe li registra
 * anche la segreteria; le voci oscurate le vede chi legge il diario.
 */
export function PrivacyPage() {
  const { id } = useParams<{ id: string }>();
  const record = useApi<{ paziente: Patient; riepilogo: Summary | null }>(`/api/pazienti/${id}`);
  const privacy = useApi<Privacy>(`/api/pazienti/${id}/privacy`);
  const catalog = useCatalog();
  const { isDoctor } = useSession();
  // Le voci oscurate le cerca solo il medico: la segreteria non legge il diario (registro pulito).
  const entries = useApi<EntryList>(isDoctor ? `/api/pazienti/${id}/voci?annullate=no` : null);
  if (record.loading && !record.data) return <Loading what="dati della cartella" />;
  if (!record.data) return <ErrorMessage error={record.error} />;
  const p = record.data.paziente;
  const canWrite = privacy.data?.puoScrivere ?? false;
  const obscured = (entries.data?.voci ?? []).filter((v) => v.oscurata);

  return (
    <>
      <PageHeader
        title="Privacy"
        trail={
          <>
            <Link to={`/pazienti/${id}`}>
              {p.firstName} {p.lastName}
            </Link>{' '}
            <span aria-hidden="true">/</span> <span>Privacy</span>
          </>
        }
      />
      <PatientBanner patient={p} summary={record.data.riepilogo} />
      {privacy.loading && !privacy.data && <Loading what="consensi e deleghe" />}
      <ErrorMessage error={privacy.error} />
      {privacy.data && catalog.data && (
        <>
          <ConsentsSection
            patientId={id!}
            consents={privacy.data.consensi}
            catalog={catalog.data}
            canWrite={canWrite}
            onChanged={privacy.reload}
          />
          <DelegationsSection
            patientId={id!}
            delegations={privacy.data.deleghe}
            canWrite={canWrite}
            onChanged={privacy.reload}
          />
        </>
      )}
      {entries.data && (
        <section className="riquadro" aria-labelledby="titolo-oscurati">
          <h2 id="titolo-oscurati">
            <Icon name="lucchetto" /> Dati oscurati
          </h2>
          <p className="aiuto">
            Su richiesta del paziente una voce si oscura: resta in cartella, ma non va nel Fascicolo
            né ai colleghi (DM 7 settembre 2023, art. 9). Si oscura o si rende di nuovo visibile
            dalla voce stessa.
          </p>
          {obscured.length === 0 ? (
            <p className="tenue">Nessuna voce oscurata.</p>
          ) : (
            <ul className="elenco-semplice">
              {obscured.map((v) => (
                <li key={v.id}>
                  <span className="cronologia-data">{date(v.data)}</span>{' '}
                  {entrySummary(v, catalog.data)}{' '}
                  <Link
                    className="pulsante pulsante-piatto"
                    to={`/pazienti/${id}/voci?tipo=${v.tipo}`}
                  >
                    <Icon name="apri" /> <span>Apri la voce</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </>
  );
}

function ConsentsSection({
  patientId,
  consents,
  catalog,
  canWrite,
  onChanged,
}: {
  patientId: string;
  consents: Consent[];
  catalog: Catalog;
  canWrite: boolean;
  onChanged: () => void;
}) {
  const today = studioToday();
  const [kind, setKind] = useState(catalog.consensi[0]?.chiave ?? 'fse_cura');
  const [status, setStatus] = useState<'dato' | 'negato'>('dato');
  const [day, setDay] = useState(today);
  const [description, setDescription] = useState('');
  const [by, setBy] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const current = (key: string) => consents.find((c) => c.tipo === key && c.inVigore);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await fn();
      setDone(ok);
      onChanged();
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    void run(async () => {
      await api(`/api/pazienti/${patientId}/consensi`, {
        method: 'POST',
        body: {
          tipo: kind,
          stato: status,
          data: day,
          ...(kind === 'altro' ? { descrizione: description.trim() } : {}),
          ...(by.trim() ? { espressoDa: by.trim() } : {}),
          ...(notes.trim() ? { note: notes.trim() } : {}),
        },
      });
      setDescription('');
      setBy('');
      setNotes('');
    }, 'Consenso registrato.');
  }

  const revoke = (c: Consent) =>
    run(
      () =>
        api(`/api/pazienti/${patientId}/consensi/${c.id}/revoca`, {
          method: 'POST',
          body: { data: today },
        }),
      'Consenso revocato.',
    );

  return (
    <section className="riquadro" aria-labelledby="titolo-consensi">
      <h2 id="titolo-consensi">Consensi</h2>
      <p className="aiuto">
        La consultazione del Fascicolo da parte di altri si consente separatamente per ogni
        finalità; il paziente può revocare e poi consentire di nuovo. La Regione registra i consensi
        nella sua anagrafe: qui resta quello che il paziente ha espresso in studio.
      </p>
      <div className="tabella-scorrevole">
        <table className="tabella">
          <caption>Consensi del Fascicolo in vigore</caption>
          <thead>
            <tr>
              <th scope="col">Consenso</th>
              <th scope="col">Stato</th>
              <th scope="col">Dal</th>
              <th scope="col">Fonte</th>
              {canWrite && <th scope="col">Azioni</th>}
            </tr>
          </thead>
          <tbody>
            {catalog.consensi
              .filter((k) => k.chiave !== 'altro')
              .map((k) => {
                const c = current(k.chiave);
                return (
                  <tr key={k.chiave}>
                    <th scope="row">{k.nome}</th>
                    <td>{c ? CONSENT_STATUS_LABEL[c.stato] : 'Non registrato'}</td>
                    <td>{c ? date(c.stato === 'revocato' ? c.revocatoIl : c.data) : '—'}</td>
                    <td className="tenue">{k.fonte}</td>
                    {canWrite && (
                      <td>
                        {c?.stato === 'dato' && (
                          <button
                            type="button"
                            className="pulsante pulsante-piatto"
                            disabled={busy}
                            onClick={() => void revoke(c)}
                          >
                            <Icon name="annulla" /> <span>Revoca oggi</span>
                            <span className="visivamente-nascosto"> {k.nome}</span>
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
      {canWrite && (
        <form onSubmit={submit}>
          <fieldset disabled={busy}>
            <legend>Registra un consenso</legend>
            <div className="campi-in-riga">
              <div className="campo">
                <label htmlFor="consenso-tipo">Consenso</label>
                <select id="consenso-tipo" value={kind} onChange={(e) => setKind(e.target.value)}>
                  {catalog.consensi.map((k) => (
                    <option key={k.chiave} value={k.chiave}>
                      {k.nome}
                    </option>
                  ))}
                </select>
              </div>
              <div className="campo campo-stretto">
                <label htmlFor="consenso-data">Data</label>
                <input
                  id="consenso-data"
                  type="date"
                  required
                  max={today}
                  value={day}
                  onChange={(e) => setDay(e.target.value)}
                />
              </div>
            </div>
            {kind === 'altro' && (
              <div className="campo">
                <label htmlFor="consenso-descrizione">Che cosa si consente</label>
                <input
                  id="consenso-descrizione"
                  required
                  maxLength={300}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
            )}
            <fieldset className="scelta-in-riga">
              <legend>Il paziente</legend>
              {(['dato', 'negato'] as const).map((s) => (
                <div className="casella" key={s}>
                  <input
                    id={`consenso-${s}`}
                    type="radio"
                    name="consenso-stato"
                    checked={status === s}
                    onChange={() => setStatus(s)}
                  />
                  <label htmlFor={`consenso-${s}`}>
                    {s === 'dato' ? 'Dà il consenso' : 'Nega il consenso'}
                  </label>
                </div>
              ))}
            </fieldset>
            <div className="campi-in-riga">
              <div className="campo">
                <label htmlFor="consenso-da">Espresso da, se non dal paziente</label>
                <input
                  id="consenso-da"
                  maxLength={200}
                  aria-describedby="consenso-da-aiuto"
                  value={by}
                  onChange={(e) => setBy(e.target.value)}
                />
                <p className="aiuto" id="consenso-da-aiuto">
                  Genitore, tutore, amministratore di sostegno o delegato (art. 8, c. 2, 3 e 5).
                </p>
              </div>
              <div className="campo">
                <label htmlFor="consenso-note">Note</label>
                <input
                  id="consenso-note"
                  maxLength={1000}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                />
              </div>
            </div>
            <div className="azioni">
              <button type="submit" className="pulsante pulsante-primario">
                <Icon name="fatto" /> <span>Registra il consenso</span>
              </button>
            </div>
          </fieldset>
        </form>
      )}
      <ErrorMessage error={error} />
      {done && <Notice kind="fatto">{done}</Notice>}
      <details className="storia">
        <summary>Tutti i consensi registrati ({consents.length})</summary>
        <ul className="elenco-semplice">
          {consents.map((c) => (
            <li key={c.id}>
              <span className="cronologia-data">{date(c.data)}</span> {c.nome}:{' '}
              {CONSENT_STATUS_LABEL[c.stato]}
              {c.revocatoIl ? ` il ${date(c.revocatoIl)}` : ''}
              {c.espressoDa ? ` · espresso da ${c.espressoDa}` : ''}
              {c.registratoDa && <span className="tenue"> · registrato da {c.registratoDa}</span>}
            </li>
          ))}
        </ul>
      </details>
    </section>
  );
}

function DelegationsSection({
  patientId,
  delegations,
  canWrite,
  onChanged,
}: {
  patientId: string;
  delegations: Delegation[];
  canWrite: boolean;
  onChanged: () => void;
}) {
  const today = studioToday();
  const empty = { nome: '', codiceFiscale: '', telefono: '', email: '', ambito: '', al: '' };
  const [f, setF] = useState(empty);
  const [from, setFrom] = useState(today);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await fn();
      setDone(ok);
      onChanged();
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    const body: Record<string, string> = {
      nome: f.nome.trim(),
      ambito: f.ambito.trim(),
      dal: from,
    };
    for (const k of ['codiceFiscale', 'telefono', 'email', 'al'] as const)
      if (f[k].trim()) body[k] = f[k].trim();
    void run(async () => {
      await api(`/api/pazienti/${patientId}/deleghe`, { method: 'POST', body });
      setF(empty);
    }, 'Delega registrata.');
  }

  return (
    <section className="riquadro" aria-labelledby="titolo-deleghe">
      <h2 id="titolo-deleghe">Deleghe</h2>
      <p className="aiuto">
        Ricette, numeri di ricetta e promemoria vanno a una persona diversa dal paziente solo se è
        un delegato registrato qui e valido quel giorno (R16).
      </p>
      {delegations.length === 0 ? (
        <p className="tenue">Nessuna delega.</p>
      ) : (
        <ul className="voci">
          {delegations.map((d) => (
            <li key={d.id} className={`voce${d.validaOggi ? '' : ' voce-annullata'}`}>
              <p className="voce-testo">
                <strong>{d.nome}</strong> · {d.ambito}
              </p>
              <p className="voce-dati">
                <span className="etichetta">
                  {d.validaOggi ? 'Valida oggi' : 'Non valida oggi'}
                </span>
                <span>
                  dal {date(d.dal)}
                  {d.al ? ` al ${date(d.al)}` : ''}
                  {d.revocataIl ? ` · revocata il ${date(d.revocataIl)}` : ''}
                </span>
                {d.codiceFiscale && <span className="codice">{d.codiceFiscale}</span>}
                {d.telefono && <span>{d.telefono}</span>}
                {d.email && <span>{d.email}</span>}
              </p>
              {canWrite && !d.revocataIl && (
                <div className="azioni">
                  <button
                    type="button"
                    className="pulsante pulsante-piatto"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () =>
                          api(`/api/pazienti/${patientId}/deleghe/${d.id}/revoca`, {
                            method: 'POST',
                            body: { data: today },
                          }),
                        'Delega revocata.',
                      )
                    }
                  >
                    <Icon name="annulla" /> <span>Revoca oggi</span>
                    <span className="visivamente-nascosto"> la delega di {d.nome}</span>
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {canWrite && (
        <form onSubmit={submit}>
          <fieldset disabled={busy}>
            <legend>Nuova delega</legend>
            <div className="campi-in-riga">
              <div className="campo">
                <label htmlFor="delega-nome">Cognome e nome del delegato</label>
                <input
                  id="delega-nome"
                  required
                  maxLength={200}
                  value={f.nome}
                  onChange={set('nome')}
                />
              </div>
              <div className="campo">
                <label htmlFor="delega-cf">Codice fiscale</label>
                <input
                  id="delega-cf"
                  className="codice"
                  maxLength={16}
                  autoComplete="off"
                  value={f.codiceFiscale}
                  onChange={set('codiceFiscale')}
                />
              </div>
            </div>
            <div className="campi-in-riga">
              <div className="campo">
                <label htmlFor="delega-telefono">Telefono</label>
                <input
                  id="delega-telefono"
                  type="tel"
                  maxLength={40}
                  value={f.telefono}
                  onChange={set('telefono')}
                />
              </div>
              <div className="campo">
                <label htmlFor="delega-email">Email</label>
                <input
                  id="delega-email"
                  type="email"
                  maxLength={200}
                  value={f.email}
                  onChange={set('email')}
                />
              </div>
            </div>
            <div className="campo">
              <label htmlFor="delega-ambito">Per che cosa vale</label>
              <input
                id="delega-ambito"
                required
                maxLength={300}
                placeholder="Ritiro di ricette e promemoria"
                value={f.ambito}
                onChange={set('ambito')}
              />
            </div>
            <div className="campi-in-riga">
              <div className="campo campo-stretto">
                <label htmlFor="delega-dal">Dal</label>
                <input
                  id="delega-dal"
                  type="date"
                  required
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </div>
              <div className="campo campo-stretto">
                <label htmlFor="delega-al">Al (facoltativo)</label>
                <input id="delega-al" type="date" min={from} value={f.al} onChange={set('al')} />
              </div>
            </div>
            <div className="azioni">
              <button type="submit" className="pulsante pulsante-primario">
                <Icon name="fatto" /> <span>Registra la delega</span>
              </button>
            </div>
          </fieldset>
        </form>
      )}
      <ErrorMessage error={error} />
      {done && <Notice kind="fatto">{done}</Notice>}
    </section>
  );
}
