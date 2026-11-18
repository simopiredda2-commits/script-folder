import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { ErrorMessage, Loading, Notice, PageHeader } from '../components/common';
import { Icon } from '../components/Icon';
import { api, ApiError } from '../lib/api';
import type { EntryList } from '../lib/clinical';
import { date, studioToday } from '../lib/format';
import { useSession } from '../lib/session';
import { usePersistentState } from '../lib/storage';
import { useApi } from '../lib/useApi';
import { PatientBanner, type Patient, type Summary } from './RecordPage';

interface Category {
  chiave: string;
  nome: string;
  fonte: string | null;
}

interface Supply {
  id: string;
  categoria: string;
  nomeCategoria: string;
  fonte: string | null;
  prodotto: string;
  codice: string | null;
  quantitaMensile: number;
  unita: string;
  mesi: number;
  dal: string;
  al: string;
  prescrittore: 'mmg' | 'specialista';
  primoSpecialista: string | null;
  primoSpecialistaIl: string | null;
  note: string | null;
  riservato: boolean;
  stato: 'in_corso' | 'scaduta' | 'conclusa' | 'annullata';
  motivoAnnullamento: string | null;
  registrataDa: string;
}

const STATE: Record<Supply['stato'], string> = {
  in_corso: 'In corso',
  scaduta: 'Scaduta: da rinnovare',
  conclusa: 'Conclusa (rinnovata)',
  annullata: 'Annullata',
};

const failure = (e: unknown) =>
  e instanceof ApiError ? e : new ApiError(0, 'Servizio non raggiungibile');

/**
 * Presidi e assistenza integrativa (tappa 10): categorie dal DPCM 12/1/2017, fabbisogno mensile e
 * durata; rinnovo dalla prescrizione precedente; annullamento con motivo. Il modulo da consegnare
 * all'ASL dipende dall'ASL: la stampa è da completare.
 */
export function SuppliesPage() {
  const { id } = useParams<{ id: string }>();
  const { isDoctor } = useSession();
  const record = useApi<{ paziente: Patient; riepilogo: Summary | null }>(`/api/pazienti/${id}`);
  const supplies = useApi<{ presidi: Supply[]; puoScrivere: boolean }>(
    `/api/pazienti/${id}/presidi`,
  );
  const categories = useApi<{ categorie: Category[] }>('/api/presidi/categorie');
  const problems = useApi<EntryList>(
    isDoctor ? `/api/pazienti/${id}/voci?tipo=problema&annullate=no` : null,
  );
  const [saved, setSaved] = useState<string | null>(null);
  if (record.loading && !record.data) return <Loading what="dati della cartella" />;
  if (!record.data) return <ErrorMessage error={record.error} />;
  const p = record.data.paziente;
  const canWrite = supplies.data?.puoScrivere ?? false;
  const refresh = (message: string) => {
    setSaved(message);
    supplies.reload();
  };

  return (
    <>
      <PageHeader
        title="Presidi e assistenza integrativa"
        trail={
          <>
            <Link to={`/pazienti/${id}`}>
              {p.firstName} {p.lastName}
            </Link>{' '}
            <span aria-hidden="true">/</span> <span>Presidi</span>
          </>
        }
      />
      <PatientBanner patient={p} summary={record.data.riepilogo} />
      {canWrite && categories.data && (
        <SupplyForm
          patientId={id!}
          categories={categories.data.categorie}
          problems={(problems.data?.voci ?? []).map((v) => ({
            id: v.id,
            nome: String(v.dettaglio?.descrizione ?? ''),
          }))}
          onSaved={() => refresh('Prescrizione registrata.')}
        />
      )}
      {saved && <Notice kind="fatto">{saved}</Notice>}
      <section className="riquadro" aria-labelledby="titolo-presidi">
        <h2 id="titolo-presidi">Prescrizioni</h2>
        {supplies.loading && !supplies.data && <Loading what="presidi" />}
        <ErrorMessage error={supplies.error} />
        {supplies.data && supplies.data.presidi.length === 0 && (
          <p className="tenue">Nessun presidio prescritto.</p>
        )}
        {supplies.data && supplies.data.presidi.length > 0 && (
          <ul className="voci">
            {supplies.data.presidi.map((s) => (
              <SupplyItem
                key={s.id}
                s={s}
                patientId={id!}
                canWrite={canWrite}
                onChanged={refresh}
              />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function SupplyItem({
  s,
  patientId,
  canWrite,
  onChanged,
}: {
  s: Supply;
  patientId: string;
  canWrite: boolean;
  onChanged: (message: string) => void;
}) {
  const [annulling, setAnnulling] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const base = `/api/pazienti/${patientId}/presidi/${s.id}`;
  const closed = s.stato === 'annullata' || s.stato === 'conclusa';

  async function run(fn: () => Promise<unknown>, message: string) {
    setError(null);
    try {
      await fn();
      setAnnulling(false);
      onChanged(message);
    } catch (err) {
      setError(failure(err));
    }
  }

  return (
    <li className={`voce${s.stato === 'annullata' ? ' voce-annullata' : ''}`}>
      <p className="voce-testo">
        <strong className={s.stato === 'annullata' ? 'testo-annullato' : undefined}>
          {s.prodotto}
        </strong>
        {s.codice && <span className="codice"> {s.codice}</span>}
        <span className="tenue"> · {s.nomeCategoria}</span>
      </p>
      <p className="voce-dati">
        <span className="etichetta">{STATE[s.stato]}</span>
        <span>
          {s.quantitaMensile} {s.unita} al mese · dal {date(s.dal)} al {date(s.al)}
        </span>
        <span>{s.prescrittore === 'mmg' ? 'Medico di famiglia' : 'Specialista'}</span>
        {s.primoSpecialista && (
          <span>
            prima prescrizione: {s.primoSpecialista}
            {s.primoSpecialistaIl ? `, ${date(s.primoSpecialistaIl)}` : ''}
          </span>
        )}
        {s.riservato && <span className="etichetta">Riservato</span>}
      </p>
      {s.note && <p className="tenue">Note: {s.note}</p>}
      {s.stato === 'annullata' && s.motivoAnnullamento && (
        <p className="tenue">Motivo dell’annullamento: {s.motivoAnnullamento}</p>
      )}
      {canWrite && !closed && (
        <div className="azioni">
          <button
            type="button"
            className="pulsante pulsante-piatto"
            onClick={() =>
              void run(() => api(`${base}/rinnova`, { method: 'POST', body: {} }), 'Rinnovata.')
            }
          >
            <Icon name="ripeti" /> <span>Rinnova</span>
            <span className="visivamente-nascosto"> {s.prodotto}</span>
          </button>
          <button
            type="button"
            className="pulsante pulsante-piatto"
            aria-expanded={annulling}
            onClick={() => setAnnulling((v) => !v)}
          >
            <Icon name="annulla" /> <span>Annulla</span>
            <span className="visivamente-nascosto"> {s.prodotto}</span>
          </button>
        </div>
      )}
      {annulling && (
        <form
          className="modulo-in-riga"
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              () => api(`${base}/annulla`, { method: 'POST', body: { motivo: reason } }),
              'Prescrizione annullata.',
            );
          }}
        >
          <div className="campo">
            <label htmlFor={`motivo-presidio-${s.id}`}>Motivo dell’annullamento</label>
            <input
              id={`motivo-presidio-${s.id}`}
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

function SupplyForm({
  patientId,
  categories,
  problems,
  onSaved,
}: {
  patientId: string;
  categories: Category[];
  problems: { id: string; nome: string }[];
  onSaved: () => void;
}) {
  const today = studioToday();
  const empty = {
    categoria: categories[0]?.chiave ?? 'diabetici',
    prodotto: '',
    codice: '',
    quantitaMensile: '',
    unita: '',
    mesi: '6',
    dal: today,
    prescrittore: 'mmg',
    primoSpecialista: '',
    primoSpecialistaIl: '',
    indicazione: '',
    note: '',
  };
  // Ricordato per paziente finché non si registra (D68, D129).
  const [f, setF, resetF] = usePersistentState(`bozza-presidio-${patientId}`, empty);
  const [reserved, setReserved, resetReserved] = usePersistentState(
    `bozza-presidio-${patientId}-riservato`,
    false,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));
  const category = categories.find((c) => c.chiave === f.categoria);
  const advanced = f.categoria === 'medicazione_avanzata';

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const opt = (v: string) => v.trim() || undefined;
    try {
      await api(`/api/pazienti/${patientId}/presidi`, {
        method: 'POST',
        body: {
          categoria: f.categoria,
          prodotto: f.prodotto.trim(),
          codice: opt(f.codice),
          quantitaMensile: Number(f.quantitaMensile),
          unita: f.unita.trim(),
          mesi: Number(f.mesi),
          dal: f.dal,
          prescrittore: f.prescrittore,
          primoSpecialista: opt(f.primoSpecialista),
          primoSpecialistaIl: opt(f.primoSpecialistaIl),
          indicazione: opt(f.indicazione),
          note: opt(f.note),
          ...(reserved ? { riservato: true } : {}),
        },
      });
      resetF();
      resetReserved();
      onSaved();
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  }

  const field = (
    k: keyof typeof empty,
    label: string,
    props: Record<string, unknown> = {},
    narrow = false,
  ) => (
    <div className={`campo${narrow ? ' campo-stretto' : ''}`}>
      <label htmlFor={`presidio-${k}`}>{label}</label>
      <input id={`presidio-${k}`} value={f[k]} onChange={set(k)} {...props} />
    </div>
  );

  return (
    <form className="riquadro" onSubmit={(e) => void submit(e)} aria-labelledby="titolo-presidio">
      <h2 id="titolo-presidio">
        <Icon name="aggiungi" /> Nuova prescrizione di presidi
      </h2>
      <fieldset disabled={busy}>
        <legend className="visivamente-nascosto">Dati della prescrizione</legend>
        <div className="campo">
          <label htmlFor="presidio-categoria">Categoria</label>
          <select
            id="presidio-categoria"
            value={f.categoria}
            aria-describedby="presidio-fonte"
            onChange={set('categoria')}
          >
            {categories.map((c) => (
              <option key={c.chiave} value={c.chiave}>
                {c.nome}
              </option>
            ))}
          </select>
          <p className="aiuto" id="presidio-fonte">
            {category?.fonte ? `Fonte: ${category.fonte}.` : 'Fuori dalle categorie del decreto.'}
          </p>
        </div>
        <div className="campi-in-riga">
          {field('prodotto', 'Prodotto', { required: true, maxLength: 300 })}
          {field('codice', 'Codice del nomenclatore', { className: 'codice', maxLength: 30 }, true)}
        </div>
        <div className="campi-in-riga">
          {field(
            'quantitaMensile',
            'Fabbisogno al mese',
            { required: true, inputMode: 'numeric', pattern: '[0-9]{1,4}' },
            true,
          )}
          {field('unita', 'Unità', { required: true, maxLength: 50, placeholder: 'pezzi' }, true)}
          {field(
            'mesi',
            'Mesi',
            { required: true, inputMode: 'numeric', pattern: '[0-9]{1,2}' },
            true,
          )}
          {field('dal', 'Dal', { type: 'date', required: true }, true)}
        </div>
        <fieldset className="scelta-in-riga">
          <legend>Prescrive</legend>
          {(['mmg', 'specialista'] as const).map((k) => (
            <div className="casella" key={k}>
              <input
                id={`presidio-prescrittore-${k}`}
                type="radio"
                name="presidio-prescrittore"
                checked={f.prescrittore === k}
                onChange={() => setF((x) => ({ ...x, prescrittore: k }))}
              />
              <label htmlFor={`presidio-prescrittore-${k}`}>
                {k === 'mmg' ? 'Il medico di famiglia' : 'Lo specialista (trascrizione)'}
              </label>
            </div>
          ))}
        </fieldset>
        {(advanced || f.primoSpecialista) && (
          <div className="campi-in-riga">
            {field('primoSpecialista', 'Prima prescrizione: specialista', {
              maxLength: 200,
              required: advanced && f.prescrittore === 'mmg',
            })}
            {field(
              'primoSpecialistaIl',
              'Prima prescrizione: data',
              { type: 'date', max: today, required: advanced && f.prescrittore === 'mmg' },
              true,
            )}
          </div>
        )}
        {advanced && (
          <p className="aiuto">
            Medicazioni avanzate: la prima volta le prescrive lo specialista; il medico di famiglia
            le prescrive dopo, per al massimo 6 mesi.
          </p>
        )}
        <div className="campi-in-riga">
          {problems.length > 0 && (
            <div className="campo">
              <label htmlFor="presidio-indicazione">Indicazione</label>
              <select id="presidio-indicazione" value={f.indicazione} onChange={set('indicazione')}>
                <option value="">Nessuna</option>
                {problems.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.nome}
                  </option>
                ))}
              </select>
            </div>
          )}
          {field('note', 'Note', { maxLength: 1000 })}
        </div>
        <div className="casella">
          <input
            id="presidio-riservato"
            type="checkbox"
            checked={reserved}
            onChange={(e) => setReserved(e.target.checked)}
          />
          <label htmlFor="presidio-riservato">Riservato: lo vede solo il medico</label>
        </div>
        <div className="azioni">
          <button type="submit" className="pulsante pulsante-primario">
            <Icon name="fatto" /> <span>Registra la prescrizione</span>
          </button>
        </div>
      </fieldset>
      <ErrorMessage error={error} />
    </form>
  );
}
