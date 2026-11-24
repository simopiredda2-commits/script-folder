import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { ErrorMessage, Loading, Notice, PageHeader } from '../components/common';
import { DiagnosisCodeInfo, DiagnosisSearch } from '../components/DiagnosisSearch';
import { Icon } from '../components/Icon';
import { InterruptedCertificatePanel } from '../components/InterruptedCertificatePanel';
import { useBand } from '../components/PatientLayout';
import { PrintHint } from '../components/PrintHint';
import { api, ApiError } from '../lib/api';
import {
  BENEFITS,
  TYPES,
  VISITS,
  type CertAddress,
  type Certificate,
  type CertificateList,
} from '../lib/certificates';
import { date, dateTime, studioToday } from '../lib/format';
import { useSession } from '../lib/session';
import { usePersistentState } from '../lib/storage';
import { useApi } from '../lib/useApi';
import type { Patient, Summary } from './RecordPage';

const EMPTY_ADDRESS: CertAddress = { via: '', civico: '', cap: '', comune: '', provincia: '' };

interface Draft {
  id: string | null;
  tipo: 'I' | 'C' | 'R';
  visita: 'A' | 'D' | 'P';
  dataRilascio: string;
  dataInizio: string;
  dataFine: string;
  codiceDiagnosi: string;
  noteDiagnosi: string;
  giornataLavorata: boolean;
  trauma: boolean;
  agevolazioni: '' | 'T' | 'C' | 'I';
  residenza: CertAddress;
  altraReperibilita: boolean;
  nominativo: string;
  reperibilita: CertAddress;
}

const fresh = (residence: CertAddress | null): Draft => {
  const today = studioToday();
  return {
    id: null,
    tipo: 'I',
    visita: 'A',
    dataRilascio: today,
    dataInizio: today,
    dataFine: today,
    codiceDiagnosi: '',
    noteDiagnosi: '',
    giornataLavorata: false,
    trauma: false,
    agevolazioni: '',
    residenza: residence ?? EMPTY_ADDRESS,
    altraReperibilita: false,
    nominativo: '',
    reperibilita: EMPTY_ADDRESS,
  };
};

const fromCertificate = (c: Certificate): Draft => ({
  id: c.id,
  tipo: c.tipo,
  visita: c.visita,
  dataRilascio: c.dataRilascio,
  dataInizio: c.dataInizio,
  dataFine: c.dataFine,
  codiceDiagnosi: c.codiceDiagnosi ?? '',
  noteDiagnosi: c.noteDiagnosi ?? '',
  giornataLavorata: c.giornataLavorata,
  trauma: c.trauma,
  agevolazioni: c.agevolazioni ?? '',
  residenza: c.residenza ?? EMPTY_ADDRESS,
  altraReperibilita: !!c.reperibilita,
  nominativo: c.reperibilita?.nominativo ?? '',
  reperibilita: c.reperibilita?.indirizzo ?? EMPTY_ADDRESS,
});

const body = (d: Draft) => ({
  tipo: d.tipo,
  visita: d.visita,
  dataRilascio: d.dataRilascio,
  dataInizio: d.dataInizio,
  dataFine: d.dataFine,
  codiceDiagnosi: d.codiceDiagnosi.trim() || null,
  noteDiagnosi: d.noteDiagnosi.trim() || null,
  giornataLavorata: d.giornataLavorata,
  trauma: d.trauma,
  agevolazioni: d.agevolazioni || null,
  residenza: d.residenza,
  reperibilita: d.altraReperibilita
    ? {
        nominativo: d.nominativo.trim() || null,
        indirizzo: d.reperibilita.via.trim() ? d.reperibilita : null,
      }
    : null,
});

/** Problemi dei controlli dell'INPS ripetuti qui, con il codice. */
function Problems({ error }: { error: ApiError | null }) {
  const problems = (
    error?.details as { problemi?: { code: string; message: string }[] } | undefined
  )?.problemi;
  if (!problems?.length) return <ErrorMessage error={error} />;
  return (
    <div className="messaggio messaggio-errore" role="alert">
      <Icon name="blocco" />
      <div>
        <p>Da correggere prima dell’invio:</p>
        <ul>
          {problems.map((p) => (
            <li key={`${p.code}-${p.message}`}>
              <span className="codice">{p.code}</span> {p.message}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * Certificati di malattia INPS del paziente (tappa 8): bozza, controlli, firma e invio con il
 * Sistema TS; poi copia e attestato, consegne, rettifica, annullamento, continuazione.
 */
export function CertificatesPage() {
  const { id = '' } = useParams();
  const { isDoctor } = useSession();
  const record = useApi<{ paziente: Patient; riepilogo?: Summary | null }>(`/api/pazienti/${id}`);
  useBand(record.data?.paziente, record.data?.riepilogo);
  const list = useApi<CertificateList>(isDoctor ? `/api/pazienti/${id}/certificati` : null);
  // Il certificato che si sta scrivendo resta ricordato per paziente, come la ricetta (D68, D129).
  const [draft, setDraft] = usePersistentState<Draft | null>(`bozza-certificato-${id}`, null);

  const name = record.data
    ? `${record.data.paziente.firstName} ${record.data.paziente.lastName}`
    : 'Paziente';
  const header = (
    <PageHeader
      title="Certificati di malattia"
      trail={
        <>
          <Link to="/pazienti">Pazienti</Link> <span aria-hidden="true">/</span>{' '}
          <Link to={`/pazienti/${id}`}>{name}</Link> <span aria-hidden="true">/</span>{' '}
          <span>Certificati</span>
        </>
      }
    />
  );
  if (!isDoctor)
    return (
      <>
        {header}
        <Notice kind="info">
          I certificati di malattia contengono la diagnosi: li prepara e li invia il medico.
        </Notice>
      </>
    );
  if (list.loading && !list.data) return <Loading what="certificati" />;
  if (!list.data) return <ErrorMessage error={list.error} />;
  const data = list.data;

  return (
    <>
      {header}
      {draft ? (
        <CertificateForm
          patientId={id}
          initial={draft}
          onDone={() => {
            setDraft(null);
            list.reload();
          }}
        />
      ) : (
        <div className="azioni">
          <button
            type="button"
            className="pulsante pulsante-primario"
            onClick={() => setDraft(fresh(data.residenza))}
          >
            <Icon name="aggiungi" /> <span>Nuovo certificato</span>
          </button>
        </div>
      )}
      <section aria-labelledby="titolo-certificati" className="riquadro">
        <h2 id="titolo-certificati">Certificati</h2>
        {data.certificati.length === 0 ? (
          <p className="tenue">Nessun certificato.</p>
        ) : (
          <ul className="elenco-certificati">
            {data.certificati.map((c) => (
              <CertificateCard
                key={c.id}
                c={c}
                patientId={id}
                contacts={data.recapiti}
                onEdit={() => setDraft(fromCertificate(c))}
                onChange={list.reload}
              />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function AddressFields({
  prefix,
  value,
  onChange,
}: {
  prefix: string;
  value: CertAddress;
  onChange: (a: CertAddress) => void;
}) {
  const field = (key: keyof CertAddress, label: string, extra: object = {}) => (
    <div className={key === 'via' || key === 'comune' ? 'campo' : 'campo campo-stretto'}>
      <label htmlFor={`${prefix}-${key}`}>{label}</label>
      <input
        id={`${prefix}-${key}`}
        value={value[key]}
        onChange={(e) => onChange({ ...value, [key]: e.target.value })}
        {...extra}
      />
    </div>
  );
  return (
    <div className="campi-in-riga">
      {field('via', 'Via o piazza', { maxLength: 50 })}
      {field('civico', 'Numero civico', { maxLength: 15 })}
      {field('cap', 'CAP', { inputMode: 'numeric', maxLength: 5 })}
      {field('comune', 'Comune', { maxLength: 25 })}
      {field('provincia', 'Provincia', { maxLength: 2 })}
    </div>
  );
}

function CertificateForm({
  patientId,
  initial,
  onDone,
}: {
  patientId: string;
  initial: Draft;
  onDone: () => void;
}) {
  const [d, setD, resetD] = usePersistentState<Draft>(
    `bozza-certificato-${patientId}-${initial.id ?? 'nuovo'}`,
    initial,
  );
  /** Chiuso o inviato: la bozza ricordata nel browser non serve più. */
  const finish = () => {
    resetD();
    onDone();
  };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [checked, setChecked] = useState<string | null>(null);
  const set = (patch: Partial<Draft>) => setD({ ...d, ...patch });

  async function save(): Promise<string> {
    if (d.id) {
      await api(`/api/certificati/${d.id}`, { method: 'PUT', body: body(d) });
      return d.id;
    }
    const created = await api<Certificate>(`/api/pazienti/${patientId}/certificati`, {
      method: 'POST',
      body: body(d),
    });
    setD({ ...d, id: created.id });
    return created.id;
  }

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setChecked(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'Servizio non raggiungibile'));
    } finally {
      setBusy(false);
    }
  }

  const check = () =>
    run(async () => {
      const certId = await save();
      const r = await api<{ problemi: { code: string; message: string }[] }>(
        `/api/certificati/${certId}/controlla`,
        { method: 'POST' },
      );
      if (r.problemi.length) setError(new ApiError(422, 'Da correggere', { problemi: r.problemi }));
      else setChecked('Nessun problema nei controlli: si può inviare.');
    });

  const send = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const certId = await save();
      const r = await api<{ esito: string; protocollo: string | null; messaggio: string | null }>(
        `/api/certificati/${certId}/invia`,
        { method: 'POST' },
      );
      if (r.esito !== 'accepted') throw new ApiError(502, r.messaggio ?? 'Invio non riuscito');
      finish();
    });
  };

  return (
    <form className="riquadro" aria-labelledby="titolo-modulo" onSubmit={send}>
      <h2 id="titolo-modulo">{d.id ? 'Modifica del certificato' : 'Nuovo certificato'}</h2>
      <fieldset disabled={busy}>
        <legend>Dati del certificato</legend>
        <fieldset className="scelta-in-riga">
          <legend>Trattasi di</legend>
          {TYPES.map(([v, label]) => (
            <div key={v} className="casella">
              <input
                type="radio"
                id={`tipo-${v}`}
                name="tipo"
                checked={d.tipo === v}
                onChange={() => set({ tipo: v })}
              />
              <label htmlFor={`tipo-${v}`}>{label}</label>
            </div>
          ))}
        </fieldset>
        <fieldset className="scelta-in-riga">
          <legend>Visita</legend>
          {VISITS.map(([v, label]) => (
            <div key={v} className="casella">
              <input
                type="radio"
                id={`visita-${v}`}
                name="visita"
                checked={d.visita === v}
                onChange={() => set({ visita: v })}
              />
              <label htmlFor={`visita-${v}`}>{label}</label>
            </div>
          ))}
        </fieldset>
        <div className="campi-in-riga">
          <div className="campo">
            <label htmlFor="data-rilascio">Data di rilascio</label>
            <input
              id="data-rilascio"
              type="date"
              value={d.dataRilascio}
              onChange={(e) => set({ dataRilascio: e.target.value })}
            />
          </div>
          <div className="campo">
            <label htmlFor="data-inizio">Ammalato dal</label>
            <input
              id="data-inizio"
              type="date"
              value={d.dataInizio}
              onChange={(e) => set({ dataInizio: e.target.value })}
            />
          </div>
          <div className="campo">
            <label htmlFor="data-fine">Prognosi a tutto il</label>
            <input
              id="data-fine"
              type="date"
              value={d.dataFine}
              onChange={(e) => set({ dataFine: e.target.value })}
            />
          </div>
        </div>
        <div className="campi-in-riga">
          <div className="campo campo-stretto">
            <label htmlFor="codice-diagnosi">Codice ICD-9-CM</label>
            <input
              id="codice-diagnosi"
              className="codice"
              value={d.codiceDiagnosi}
              aria-describedby="codice-diagnosi-aiuto"
              onChange={(e) => set({ codiceDiagnosi: e.target.value })}
            />
            <p className="aiuto" id="codice-diagnosi-aiuto">
              Per esempio 487.1. Serve il codice o la descrizione.
            </p>
            <DiagnosisCodeInfo code={d.codiceDiagnosi} />
          </div>
          <div className="campo">
            <label htmlFor="note-diagnosi">Diagnosi</label>
            <textarea
              id="note-diagnosi"
              rows={2}
              maxLength={200}
              aria-describedby="note-diagnosi-aiuto"
              value={d.noteDiagnosi}
              onChange={(e) => set({ noteDiagnosi: e.target.value })}
            />
            <p className="aiuto" id="note-diagnosi-aiuto">
              Al più 200 caratteri. Non va al datore di lavoro.
            </p>
          </div>
        </div>
        <DiagnosisSearch onPick={(x) => set({ codiceDiagnosi: x.code })} />
        <div className="scelta-in-riga">
          <div className="casella">
            <input
              type="checkbox"
              id="giornata-lavorata"
              checked={d.giornataLavorata}
              onChange={(e) => set({ giornataLavorata: e.target.checked })}
            />
            <label htmlFor="giornata-lavorata">Giornata lavorata</label>
          </div>
          <div className="casella">
            <input
              type="checkbox"
              id="trauma"
              checked={d.trauma}
              onChange={(e) => set({ trauma: e.target.checked })}
            />
            <label htmlFor="trauma">Trauma</label>
          </div>
        </div>
        <div className="campo">
          <label htmlFor="agevolazioni">Agevolazioni</label>
          <select
            id="agevolazioni"
            value={d.agevolazioni}
            onChange={(e) => set({ agevolazioni: e.target.value as Draft['agevolazioni'] })}
          >
            <option value="">Nessuna</option>
            {BENEFITS.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </div>
      </fieldset>
      <fieldset disabled={busy}>
        <legend>Residenza o domicilio abituale</legend>
        <AddressFields
          prefix="residenza"
          value={d.residenza}
          onChange={(residenza) => set({ residenza })}
        />
        <p className="aiuto">Senza numero civico si manda «SNC».</p>
      </fieldset>
      <fieldset disabled={busy}>
        <legend>Reperibilità durante la malattia</legend>
        <div className="casella">
          <input
            type="checkbox"
            id="altra-reperibilita"
            checked={d.altraReperibilita}
            onChange={(e) => set({ altraReperibilita: e.target.checked })}
          />
          <label htmlFor="altra-reperibilita">Diversa dalla residenza</label>
        </div>
        {d.altraReperibilita && (
          <>
            <div className="campo">
              <label htmlFor="nominativo">Nominativo presso l’abitazione (se diverso)</label>
              <input
                id="nominativo"
                maxLength={24}
                value={d.nominativo}
                onChange={(e) => set({ nominativo: e.target.value })}
              />
            </div>
            <AddressFields
              prefix="reperibilita"
              value={d.reperibilita}
              onChange={(reperibilita) => set({ reperibilita })}
            />
          </>
        )}
      </fieldset>
      <Problems error={error} />
      {checked && <Notice kind="fatto">{checked}</Notice>}
      <div className="azioni">
        <button type="button" className="pulsante" disabled={busy} onClick={() => void check()}>
          <Icon name="ripeti" /> <span>Salva e controlla</span>
        </button>
        <button type="submit" className="pulsante pulsante-primario" disabled={busy}>
          <Icon name="firma" /> <span>Firma e invia all’INPS</span>
        </button>
        <button type="button" className="pulsante" disabled={busy} onClick={finish}>
          <Icon name="annulla" /> <span>Chiudi</span>
        </button>
      </div>
    </form>
  );
}

function CertificateCard({
  c,
  patientId,
  contacts,
  onEdit,
  onChange,
}: {
  c: Certificate;
  patientId: string;
  contacts: CertificateList['recapiti'];
  onEdit: () => void;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const doneRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (done) doneRef.current?.focus();
  }, [done]);
  const [newEnd, setNewEnd] = useState('');
  const [reason, setReason] = useState('');
  const [askedByWorker, setAskedByWorker] = useState(false);
  // Il PDF aperto: la sua consegna su carta si segna dopo averlo dato (audit D259).
  const [opened, setOpened] = useState<'copia' | 'attestato' | null>(null);
  const base = `/api/certificati/${c.id}`;
  const k = (s: string) => `${s}-${c.id}`;

  async function run(fn: () => Promise<string>) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      setDone(await fn());
      onChange();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'Servizio non raggiungibile'));
    } finally {
      setBusy(false);
    }
  }

  const deliver = (canale: 'email' | 'sms' | 'email_datore') =>
    run(async () => {
      const r = await api<{ recapito: string }>(`${base}/consegna`, {
        method: 'POST',
        body: canale === 'email_datore' ? { canale, richiestaDelLavoratore: true } : { canale },
      });
      return canale === 'email'
        ? `Copia e attestato inviati per email a ${r.recapito}.`
        : canale === 'sms'
          ? `SMS inviato a ${r.recapito}.`
          : `Protocollo inviato al datore di lavoro (${r.recapito}).`;
    });

  const continuation = () =>
    run(async () => {
      await api(`/api/pazienti/${patientId}/certificati`, {
        method: 'POST',
        body: { continuaDa: c.id },
      });
      return 'Continuazione preparata: è tra le bozze.';
    });

  const resend = () =>
    run(async () => {
      const r = await api<{ esito: string; messaggio: string | null }>(`${base}/invia`, {
        method: 'POST',
      });
      if (r.esito !== 'accepted') throw new ApiError(502, r.messaggio ?? 'Invio non riuscito');
      return 'Certificato inviato.';
    });

  const editable =
    c.stato === 'draft' ||
    (c.stato === 'error' && (c.errore?.tipo === 'rejected' || c.errore?.tipo === 'auth'));
  const retry =
    c.stato === 'error' && ['unreachable', 'timeout', 'auth'].includes(c.errore?.tipo ?? '');

  return (
    <li className="scheda-certificato" aria-labelledby={k('titolo')}>
      <h3 id={k('titolo')}>
        {c.etichettaTipo} · dal {date(c.dataInizio)} al {date(c.dataFine)} ({c.giorni}{' '}
        {c.giorni === 1 ? 'giorno' : 'giorni'})
      </h3>
      <p>
        <span className={`stato stato-${c.stato}`}>{c.etichettaStato}</span> · rilasciato il{' '}
        {date(c.dataRilascio)} · visita {c.etichettaVisita.toLowerCase()}
        {c.protocollo && (
          <>
            {' '}
            · protocollo <span className="codice">{c.protocollo}</span>
          </>
        )}
        {c.rettificaDi && (
          <>
            {' '}
            · rettifica del protocollo <span className="codice">{c.rettificaDi}</span>
          </>
        )}
      </p>
      {c.ricevutoIl && <p className="tenue">Ricevuto dall’INPS il {dateTime(c.ricevutoIl)}.</p>}
      {c.annullamento && (
        <p className="tenue">
          Annullato il {dateTime(c.annullamento.il)}
          {c.annullamento.protocollo ? ` (protocollo ${c.annullamento.protocollo})` : ''}:{' '}
          {c.annullamento.motivo}
        </p>
      )}
      {c.errore?.messaggio && <Notice kind="errore">{c.errore.messaggio}</Notice>}
      {c.stato === 'sending' &&
        (c.invioInterrotto ? (
          <InterruptedCertificatePanel
            certificateId={c.id}
            signedAt={c.inviatoIl}
            onChange={(message) => {
              setDone(message);
              onChange();
            }}
          />
        ) : (
          <p className="tenue">Invio all’INPS in corso: aspetta la risposta.</p>
        ))}

      <div className="azioni">
        {editable && (
          <button type="button" className="pulsante" disabled={busy} onClick={onEdit}>
            <Icon name="firma" /> <span>Modifica e invia</span>
          </button>
        )}
        {retry && (
          <button
            type="button"
            className="pulsante pulsante-primario"
            disabled={busy}
            onClick={() => void resend()}
          >
            <Icon name="ripeti" /> <span>Riprova l’invio</span>
          </button>
        )}
        {c.stato === 'sent' && (
          <>
            <a
              className="pulsante"
              href={`${base}/copia`}
              target="_blank"
              rel="noopener"
              onClick={() => setOpened('copia')}
            >
              <Icon name="stampa" /> <span>Copia per il lavoratore (PDF)</span>
            </a>
            <a
              className="pulsante"
              href={`${base}/attestato`}
              target="_blank"
              rel="noopener"
              onClick={() => setOpened('attestato')}
            >
              <Icon name="stampa" /> <span>Attestato (PDF)</span>
            </a>
            <button
              type="button"
              className="pulsante"
              disabled={busy || !contacts.email}
              onClick={() => void deliver('email')}
            >
              <Icon name="apri" /> <span>Email al lavoratore</span>
            </button>
            <button
              type="button"
              className="pulsante"
              disabled={busy || !contacts.telefono}
              onClick={() => void deliver('sms')}
            >
              <Icon name="apri" /> <span>SMS al lavoratore</span>
            </button>
            <button
              type="button"
              className="pulsante"
              disabled={busy}
              onClick={() => void continuation()}
            >
              <Icon name="aggiungi" /> <span>Continuazione</span>
            </button>
          </>
        )}
      </div>
      {c.stato === 'sent' && opened && (
        <div className="consegna-carta" role="group" aria-label="Consegna su carta">
          <p>
            Aprire il PDF non è una consegna. Quando hai stampato{' '}
            {opened === 'copia' ? 'la copia' : 'l’attestato'} e l’hai dato al lavoratore, segnalo
            qui.
          </p>
          <button
            type="button"
            className="pulsante"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api(`${base}/consegna-carta`, {
                  method: 'POST',
                  body: { documento: opened },
                });
                setOpened(null);
                return opened === 'copia'
                  ? 'Consegna della copia su carta registrata.'
                  : 'Consegna dell’attestato su carta registrata.';
              })
            }
          >
            <Icon name="fatto" /> <span>Consegnato su carta</span>
          </button>
        </div>
      )}
      {/* Preferenze di stampa della postazione per la copia e l'attestato (tappa 14). */}
      {c.stato === 'sent' && <PrintHint kind="certificato_inps" />}
      {c.stato === 'sent' && !contacts.email && (
        <p className="tenue">Nessuna email del lavoratore in anagrafica.</p>
      )}

      {c.stato === 'sent' && contacts.emailDatore && (
        <fieldset disabled={busy}>
          <legend>Al datore di lavoro: solo il numero di protocollo</legend>
          <div className="casella">
            <input
              type="checkbox"
              id={k('richiesta')}
              checked={askedByWorker}
              onChange={(e) => setAskedByWorker(e.target.checked)}
            />
            <label htmlFor={k('richiesta')}>Il lavoratore chiede di mandarlo</label>
          </div>
          <button
            type="button"
            className="pulsante"
            disabled={!askedByWorker}
            onClick={() => void deliver('email_datore')}
          >
            <Icon name="apri" /> <span>Manda il protocollo</span>
          </button>
        </fieldset>
      )}

      {c.rettificabile && (
        <fieldset disabled={busy}>
          <legend>Rettifica: anticipa la fine della prognosi</legend>
          <div className="campo">
            <label htmlFor={k('nuova-fine')}>Nuova fine della prognosi</label>
            <div className="campo-con-pulsante">
              <input
                id={k('nuova-fine')}
                type="date"
                max={c.dataFine}
                value={newEnd}
                onChange={(e) => setNewEnd(e.target.value)}
              />
              <button
                type="button"
                className="pulsante"
                disabled={!newEnd}
                onClick={() =>
                  void run(async () => {
                    const r = await api<{ protocollo: string }>(`${base}/rettifica`, {
                      method: 'POST',
                      body: { dataFine: newEnd },
                    });
                    return `Rettificato: nuovo protocollo ${r.protocollo}.`;
                  })
                }
              >
                <Icon name="fatto" /> <span>Rettifica</span>
              </button>
            </div>
          </div>
        </fieldset>
      )}

      {c.annullabile && (
        <fieldset disabled={busy}>
          <legend>{c.stato === 'sent' ? 'Annullamento all’INPS' : 'Annulla la bozza'}</legend>
          <div className="campo">
            <label htmlFor={k('motivo')}>Motivo</label>
            <div className="campo-con-pulsante">
              <input id={k('motivo')} value={reason} onChange={(e) => setReason(e.target.value)} />
              <button
                type="button"
                className="pulsante"
                disabled={reason.trim().length < 3}
                onClick={() =>
                  void run(async () => {
                    await api(`${base}/annulla`, { method: 'POST', body: { motivo: reason } });
                    return 'Certificato annullato.';
                  })
                }
              >
                <Icon name="annulla" /> <span>Annulla</span>
              </button>
            </div>
          </div>
        </fieldset>
      )}
      <ErrorMessage error={error} />
      {done && (
        // Il fuoco va al risultato: il pulsante premuto può non esserci più (WCAG 2.4.3, D239).
        <div ref={doneRef} tabIndex={-1}>
          <Notice kind="fatto">{done}</Notice>
        </div>
      )}
    </li>
  );
}
