import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { ErrorMessage, Loading, Notice, PageHeader } from '../components/common';
import { Icon } from '../components/Icon';
import { api, ApiError } from '../lib/api';
import { PLAN_VALIDITY_LABEL, type Plan } from '../lib/clinical';
import { date, plural, studioToday } from '../lib/format';
import { useApi } from '../lib/useApi';
import { PatientBanner, type Patient, type Summary } from './RecordPage';

const failure = (e: unknown) =>
  e instanceof ApiError ? e : new ApiError(0, 'Servizio non raggiungibile');

interface PlanForm {
  farmaco: string;
  aic: string;
  principioAttivo: string;
  rilasciatoIl: string;
  scadeIl: string;
  centro: string;
  specialista: string;
  confezioniAutorizzate: string;
  posologia: string;
  note: string;
  cartaceo: boolean;
  riservato: boolean;
}

const blank = (): PlanForm => ({
  farmaco: '',
  aic: '',
  principioAttivo: '',
  rilasciatoIl: studioToday(),
  scadeIl: '',
  centro: '',
  specialista: '',
  confezioniAutorizzate: '',
  posologia: '',
  note: '',
  cartaceo: false,
  riservato: false,
});

const fromPlan = (p: Plan): PlanForm => ({
  farmaco: p.farmaco,
  aic: p.aic ?? '',
  principioAttivo: p.principioAttivo ?? '',
  rilasciatoIl: p.rilasciatoIl,
  scadeIl: p.scadeIl,
  centro: p.centro ?? '',
  specialista: p.specialista ?? '',
  confezioniAutorizzate: p.confezioniAutorizzate ? String(p.confezioniAutorizzate) : '',
  posologia: p.posologia ?? '',
  note: p.note ?? '',
  cartaceo: p.cartaceo,
  riservato: p.riservato,
});

function toBody(f: PlanForm) {
  const opt = (v: string) => v.trim() || undefined;
  return {
    farmaco: f.farmaco.trim(),
    aic: opt(f.aic),
    principioAttivo: opt(f.principioAttivo),
    rilasciatoIl: f.rilasciatoIl,
    scadeIl: f.scadeIl,
    centro: opt(f.centro),
    specialista: opt(f.specialista),
    confezioniAutorizzate: f.confezioniAutorizzate.trim()
      ? Number(f.confezioniAutorizzate)
      : undefined,
    posologia: opt(f.posologia),
    note: opt(f.note),
    cartaceo: f.cartaceo || undefined,
    riservato: f.riservato || undefined,
  };
}

/**
 * Piani terapeutici (tappa 9): quelli che R5 e R6 leggono prima dell'invio della ricetta, con
 * rilascio, scadenza, confezioni autorizzate e posologia del piano. Non si cancellano: si
 * annullano con un motivo, e un piano annullato non vale più per le regole.
 */
export function PlansPage() {
  const { id } = useParams<{ id: string }>();
  const record = useApi<{ paziente: Patient; riepilogo: Summary | null }>(`/api/pazienti/${id}`);
  const plans = useApi<{ piani: Plan[]; puoScrivere: boolean }>(`/api/pazienti/${id}/piani`);
  const [editing, setEditing] = useState<Plan | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  if (record.loading && !record.data) return <Loading what="dati della cartella" />;
  if (!record.data) return <ErrorMessage error={record.error} />;
  const p = record.data.paziente;
  const canWrite = plans.data?.puoScrivere ?? false;
  const refresh = () => {
    plans.reload();
    record.reload();
  };

  return (
    <>
      <PageHeader
        title="Piani terapeutici"
        trail={
          <>
            <Link to={`/pazienti/${id}`}>
              {p.firstName} {p.lastName}
            </Link>{' '}
            <span aria-hidden="true">/</span> <span>Piani terapeutici</span>
          </>
        }
      />
      <PatientBanner patient={p} summary={record.data.riepilogo} />
      {canWrite && (
        <PlanEditor
          key={editing?.id ?? 'nuovo'}
          patientId={id!}
          plan={editing}
          onDone={(message) => {
            setEditing(null);
            setSaved(message);
            refresh();
          }}
          onCancel={() => setEditing(null)}
        />
      )}
      {saved && <Notice kind="fatto">{saved}</Notice>}
      <section className="riquadro" aria-labelledby="titolo-piani">
        <h2 id="titolo-piani">Piani in cartella</h2>
        {plans.loading && !plans.data && <Loading what="piani terapeutici" />}
        <ErrorMessage error={plans.error} />
        {plans.data && plans.data.piani.length === 0 && (
          <p className="tenue">Nessun piano terapeutico.</p>
        )}
        {plans.data && plans.data.piani.length > 0 && (
          <ul className="voci">
            {plans.data.piani.map((x) => (
              <PlanItem
                key={x.id}
                plan={x}
                patientId={id!}
                canWrite={canWrite}
                onEdit={() => {
                  setEditing(x);
                  window.scrollTo({ top: 0 });
                }}
                onChanged={refresh}
              />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function PlanItem({
  plan: x,
  patientId,
  canWrite,
  onEdit,
  onChanged,
}: {
  plan: Plan;
  patientId: string;
  canWrite: boolean;
  onEdit: () => void;
  onChanged: () => void;
}) {
  const [annulling, setAnnulling] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const annulled = x.stato === 'annullato';

  async function annul(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api(`/api/pazienti/${patientId}/piani/${x.id}/annulla`, {
        method: 'POST',
        body: { motivo: reason },
      });
      setAnnulling(false);
      onChanged();
    } catch (err) {
      setError(failure(err));
    }
  }

  return (
    <li className={`voce${annulled ? ' voce-annullata' : ''}`}>
      <p className="voce-testo">
        <strong className={annulled ? 'testo-annullato' : undefined}>{x.farmaco}</strong>
        {x.aic && <span className="codice"> AIC {x.aic}</span>}
        {x.principioAttivo && <span className="tenue"> · {x.principioAttivo}</span>}
      </p>
      <p className="voce-dati">
        {annulled ? (
          <span className="etichetta">Annullato</span>
        ) : (
          <span className="etichetta">{PLAN_VALIDITY_LABEL[x.validita]}</span>
        )}
        <span>
          dal {date(x.rilasciatoIl)} al {date(x.scadeIl)}
          {!annulled && x.validita === 'valido'
            ? ` · scade tra ${plural(x.giorniAllaScadenza, 'giorno', 'giorni')}`
            : ''}
        </span>
        {x.confezioniAutorizzate !== null && (
          <span>
            {plural(x.confezioniAutorizzate, 'confezione autorizzata', 'confezioni autorizzate')}
          </span>
        )}
        {x.cartaceo && <span className="etichetta">Cartaceo</span>}
        {x.riservato && <span className="etichetta">Riservato</span>}
      </p>
      {(x.centro || x.specialista || x.posologia) && (
        <p className="tenue">
          {[x.centro, x.specialista, x.posologia && `posologia: ${x.posologia}`]
            .filter(Boolean)
            .join(' · ')}
        </p>
      )}
      {x.note && <p className="tenue">Note: {x.note}</p>}
      {annulled && x.motivoAnnullamento && (
        <p className="tenue">Motivo dell’annullamento: {x.motivoAnnullamento}</p>
      )}
      {canWrite && !annulled && (
        <div className="azioni">
          <button type="button" className="pulsante pulsante-piatto" onClick={onEdit}>
            <Icon name="storico" /> <span>Modifica</span>
            <span className="visivamente-nascosto"> il piano di {x.farmaco}</span>
          </button>
          <button
            type="button"
            className="pulsante pulsante-piatto"
            aria-expanded={annulling}
            onClick={() => setAnnulling((v) => !v)}
          >
            <Icon name="annulla" /> <span>Annulla il piano</span>
            <span className="visivamente-nascosto"> di {x.farmaco}</span>
          </button>
        </div>
      )}
      {annulling && (
        <form className="modulo-in-riga" onSubmit={(e) => void annul(e)}>
          <div className="campo">
            <label htmlFor={`motivo-piano-${x.id}`}>Motivo dell’annullamento</label>
            <input
              id={`motivo-piano-${x.id}`}
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

function PlanEditor({
  patientId,
  plan,
  onDone,
  onCancel,
}: {
  patientId: string;
  plan: Plan | null;
  onDone: (message: string) => void;
  onCancel: () => void;
}) {
  const [f, setF] = useState<PlanForm>(() => (plan ? fromPlan(plan) : blank()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const set = (k: keyof PlanForm) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));
  const today = studioToday();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api(
        plan ? `/api/pazienti/${patientId}/piani/${plan.id}` : `/api/pazienti/${patientId}/piani`,
        { method: plan ? 'PUT' : 'POST', body: toBody(f) },
      );
      if (!plan) setF(blank());
      onDone(plan ? 'Modifiche salvate.' : 'Piano registrato.');
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  }

  const field = (
    k: Exclude<keyof PlanForm, 'cartaceo' | 'riservato'>,
    label: string,
    props: Record<string, unknown> = {},
    narrow = false,
  ) => (
    <div className={`campo${narrow ? ' campo-stretto' : ''}`}>
      <label htmlFor={`piano-${k}`}>{label}</label>
      <input id={`piano-${k}`} value={f[k]} onChange={set(k)} {...props} />
    </div>
  );

  return (
    <form className="riquadro" onSubmit={(e) => void submit(e)} aria-labelledby="titolo-piano">
      <h2 id="titolo-piano">
        <Icon name={plan ? 'storico' : 'aggiungi'} />{' '}
        {plan ? `Modifica del piano di ${plan.farmaco}` : 'Nuovo piano terapeutico'}
      </h2>
      <fieldset disabled={busy}>
        <legend className="visivamente-nascosto">Dati del piano</legend>
        <div className="campi-in-riga">
          {field('farmaco', 'Farmaco', { required: true, maxLength: 300 })}
          {field('principioAttivo', 'Principio attivo', { maxLength: 300 })}
          {field(
            'aic',
            'Codice AIC',
            { className: 'codice', inputMode: 'numeric', pattern: '[0-9]{9}', maxLength: 9 },
            true,
          )}
        </div>
        <div className="campi-in-riga">
          {field(
            'rilasciatoIl',
            'Rilasciato il',
            { type: 'date', required: true, max: today },
            true,
          )}
          {field(
            'scadeIl',
            'Scade il',
            { type: 'date', required: true, min: f.rilasciatoIl },
            true,
          )}
          {field('confezioniAutorizzate', 'Confezioni autorizzate', {
            inputMode: 'numeric',
            pattern: '[0-9]{1,3}',
          })}
        </div>
        <div className="campi-in-riga">
          {field('centro', 'Centro che l’ha rilasciato', { maxLength: 200 })}
          {field('specialista', 'Specialista', { maxLength: 200 })}
        </div>
        <div className="campi-in-riga">
          {field('posologia', 'Posologia del piano', { maxLength: 500 })}
          {field('note', 'Note', { maxLength: 1000 })}
        </div>
        <div className="casella">
          <input
            id="piano-cartaceo"
            type="checkbox"
            checked={f.cartaceo}
            onChange={(e) => setF((x) => ({ ...x, cartaceo: e.target.checked }))}
          />
          <label htmlFor="piano-cartaceo">
            Piano cartaceo (in Piemonte, per esempio la Nota 85)
          </label>
        </div>
        <div className="casella">
          <input
            id="piano-riservato"
            type="checkbox"
            checked={f.riservato}
            onChange={(e) => setF((x) => ({ ...x, riservato: e.target.checked }))}
          />
          <label htmlFor="piano-riservato">Riservato: lo vede solo il medico</label>
        </div>
        <div className="azioni">
          <button type="submit" className="pulsante pulsante-primario">
            <Icon name="fatto" /> <span>{plan ? 'Salva le modifiche' : 'Registra il piano'}</span>
          </button>
          {plan && (
            <button type="button" className="pulsante" onClick={onCancel}>
              <Icon name="annulla" /> <span>Lascia com’era</span>
            </button>
          )}
        </div>
      </fieldset>
      <ErrorMessage error={error} />
    </form>
  );
}
