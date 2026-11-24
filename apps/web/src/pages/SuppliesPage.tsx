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
  /** Allegato del DPCM con il nomenclatore della categoria (D218). */
  allegato?: string | null;
}

/** Una voce del nomenclatore dei presidi del DPCM LEA (D218). */
interface CatalogItem {
  codice: string;
  descrizione: string;
  gruppo: string;
  allegato: string;
  atto: string | null;
  /** La quantità stampata nell'allegato e l'intestazione della sua colonna, se ci sono (D237). */
  quantita?: string | null;
  intestazioneQuantita?: string | null;
}

interface Catalog {
  presidi: CatalogItem[];
  malattieRare: CatalogItem[];
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
  /**
   * Che cosa chiede il rinnovo (D239): la categoria «Medicazioni avanzate» per una voce che il
   * titolare ha scelto dopo, la prima prescrizione dello specialista se manca, i mesi massimi.
   */
  rinnovo?: {
    categoria: 'medicazione_avanzata' | null;
    chiedeSpecialista: boolean;
    mesiMassimi: number | null;
  };
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
  const supplies = useApi<{
    presidi: Supply[];
    puoScrivere: boolean;
    /** Le voci dell'allegato 2 che il titolare considera medicazioni avanzate (D237). */
    medicazioniAvanzate?: string[];
  }>(`/api/pazienti/${id}/presidi`);
  const categories = useApi<{ categorie: Category[] }>('/api/presidi/categorie');
  const catalog = useApi<Catalog>('/api/presidi/nomenclatore');
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
          catalog={catalog.data ?? { presidi: [], malattieRare: [] }}
          advancedCodes={supplies.data?.medicazioniAvanzate ?? []}
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
  // Il rinnovo che chiede qualcosa (D239) si conferma in un modulo; gli altri con un clic.
  const needs = s.rinnovo;
  const maxMonths = needs?.mesiMassimi ?? null;
  const asks =
    !!needs &&
    (needs.categoria !== null ||
      needs.chiedeSpecialista ||
      (maxMonths !== null && s.mesi > maxMonths));
  const [renewing, setRenewing] = useState(false);
  const [renewal, setRenewal] = useState({
    specialista: s.primoSpecialista ?? '',
    il: s.primoSpecialistaIl ?? '',
    mesi: String(maxMonths !== null ? Math.min(s.mesi, maxMonths) : s.mesi),
  });

  async function run(fn: () => Promise<unknown>, message: string) {
    setError(null);
    try {
      await fn();
      setAnnulling(false);
      setRenewing(false);
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
            aria-expanded={asks ? renewing : undefined}
            onClick={() =>
              asks
                ? setRenewing((v) => !v)
                : void run(() => api(`${base}/rinnova`, { method: 'POST', body: {} }), 'Rinnovata.')
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
      {renewing && needs && (
        <form
          className="modulo-in-riga"
          onSubmit={(e) => {
            e.preventDefault();
            void run(
              () =>
                api(`${base}/rinnova`, {
                  method: 'POST',
                  body: {
                    ...(needs.categoria ? { categoria: needs.categoria } : {}),
                    ...(needs.chiedeSpecialista
                      ? { primoSpecialista: renewal.specialista, primoSpecialistaIl: renewal.il }
                      : {}),
                    mesi: Number(renewal.mesi),
                  },
                }),
              needs.categoria ? 'Rinnovata fra le medicazioni avanzate.' : 'Rinnovata.',
            );
          }}
        >
          <p className="aiuto" id={`rinnovo-aiuto-${s.id}`}>
            {needs.categoria
              ? 'La voce è fra le medicazioni avanzate scelte dal titolare: il rinnovo passa nella categoria «Medicazioni avanzate», dove la prima prescrizione è dello specialista e il medico di famiglia prescrive per al massimo 6 mesi.'
              : 'Fra le medicazioni avanzate la prima prescrizione è dello specialista e il medico di famiglia prescrive per al massimo 6 mesi.'}
          </p>
          {needs.chiedeSpecialista && (
            <>
              <div className="campo">
                <label htmlFor={`rinnovo-specialista-${s.id}`}>
                  Rinnovo: specialista della prima prescrizione
                </label>
                <input
                  id={`rinnovo-specialista-${s.id}`}
                  required
                  maxLength={200}
                  value={renewal.specialista}
                  aria-describedby={`rinnovo-aiuto-${s.id}`}
                  onChange={(e) => setRenewal((r) => ({ ...r, specialista: e.target.value }))}
                />
              </div>
              <div className="campo">
                <label htmlFor={`rinnovo-il-${s.id}`}>Rinnovo: data della prima prescrizione</label>
                <input
                  id={`rinnovo-il-${s.id}`}
                  type="date"
                  required
                  max={studioToday()}
                  value={renewal.il}
                  onChange={(e) => setRenewal((r) => ({ ...r, il: e.target.value }))}
                />
              </div>
            </>
          )}
          <div className="campo">
            <label htmlFor={`rinnovo-mesi-${s.id}`}>Rinnovo: mesi</label>
            <input
              id={`rinnovo-mesi-${s.id}`}
              required
              inputMode="numeric"
              pattern={maxMonths !== null ? `[1-${maxMonths}]` : '[0-9]{1,2}'}
              value={renewal.mesi}
              onChange={(e) => setRenewal((r) => ({ ...r, mesi: e.target.value }))}
            />
          </div>
          <button type="submit" className="pulsante pulsante-primario">
            <Icon name="ripeti" /> <span>Conferma il rinnovo</span>
          </button>
        </form>
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
  catalog,
  advancedCodes,
  problems,
  onSaved,
}: {
  patientId: string;
  categories: Category[];
  catalog: Catalog;
  advancedCodes: string[];
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
  const [itemFilter, setItemFilter] = useState('');
  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));
  const category = categories.find((c) => c.chiave === f.categoria);
  const advanced = f.categoria === 'medicazione_avanzata';
  // Il nomenclatore dell'allegato della categoria, se trascritto e controllato (D218). Le voci
  // dell'allegato 2 che il titolare considera medicazioni avanzate stanno solo in quella categoria,
  // dove vale la regola dello specialista (D237).
  const advancedSet = new Set(advancedCodes);
  const isAdvanced = (i: CatalogItem) => i.allegato === '2' && advancedSet.has(i.codice);
  const annex = advanced ? '2' : (category?.allegato ?? null);
  const items = annex
    ? catalog.presidi.filter(
        (i) => i.allegato === annex && (advanced ? isAdvanced(i) : !isAdvanced(i)),
      )
    : [];
  const rare = annex ? catalog.malattieRare.filter((i) => i.allegato === annex) : [];
  const chosen = items.findIndex((i) => i.descrizione === f.prodotto && i.codice === f.codice);
  const chosenItem = chosen >= 0 ? items[chosen] : undefined;
  // Una ricerca per parole, in qualunque ordine, al posto di scorrere decine di voci lunghe
  // (suggerimento S12 dell'audit, D259); la voce già scelta resta nell'elenco.
  const words = itemFilter.toLocaleLowerCase('it').split(/\s+/).filter(Boolean);
  const matches = (i: CatalogItem) =>
    words.every((w) =>
      `${i.descrizione} ${i.codice} ${i.gruppo}`.toLocaleLowerCase('it').includes(w),
    );
  const shown = (i: CatalogItem, index: number) => index === chosen || matches(i);
  // Quante voci hanno le parole: la voce già scelta resta in elenco ma non si conta.
  const shownCount = items.filter(matches).length;
  const groups = [...new Set(items.filter(shown).map((i) => i.gruppo))];
  // La voce vuota è «scrivi a mano»: prodotto e codice si svuotano, e non diventano quelli della
  // prima voce (Number('') è 0). Un codice rimasto da un'altra voce sarebbe sbagliato (D232).
  const pick = (index: string) => {
    const item = index === '' ? undefined : items[Number(index)];
    setF((x) =>
      item
        ? { ...x, prodotto: item.descrizione, codice: item.codice }
        : chosen >= 0
          ? { ...x, prodotto: '', codice: '' }
          : x,
    );
  };

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
            onChange={(e) => {
              const categoria = e.target.value;
              // Una voce scelta dal nomenclatore vale per la sua categoria: cambiando categoria
              // prodotto e codice si svuotano, come con «scrivi a mano» (D239). Quelli scritti a
              // mano restano.
              setF((x) =>
                chosen >= 0 ? { ...x, categoria, prodotto: '', codice: '' } : { ...x, categoria },
              );
            }}
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
        {items.length > 0 && (
          <div className="campo">
            <label htmlFor="presidio-nomenclatore-cerca">Cerca nel nomenclatore</label>
            <input
              id="presidio-nomenclatore-cerca"
              type="search"
              value={itemFilter}
              autoComplete="off"
              aria-describedby="presidio-nomenclatore-trovate"
              onChange={(e) => setItemFilter(e.target.value)}
            />
            <p className="aiuto" id="presidio-nomenclatore-trovate" role="status">
              {words.length === 0
                ? `${items.length} voci: scrivi una o più parole per restringere l’elenco.`
                : shownCount === 0
                  ? 'Nessuna voce con queste parole.'
                  : shownCount === 1
                    ? '1 voce con queste parole.'
                    : `${shownCount} voci con queste parole.`}
            </p>
          </div>
        )}
        {items.length > 0 && (
          <div className="campo">
            <label htmlFor="presidio-nomenclatore">Dal nomenclatore (allegato {annex})</label>
            <select
              id="presidio-nomenclatore"
              value={chosen >= 0 ? String(chosen) : ''}
              aria-describedby={
                chosenItem?.quantita
                  ? 'presidio-nomenclatore-aiuto presidio-nomenclatore-quantita'
                  : 'presidio-nomenclatore-aiuto'
              }
              onChange={(e) => pick(e.target.value)}
            >
              <option value="">Scrivi il prodotto o scegli dal nomenclatore</option>
              {groups.map((g) => (
                <optgroup key={g} label={g}>
                  {items.map((i, index) =>
                    i.gruppo === g && shown(i, index) ? (
                      <option key={`${i.codice}-${i.descrizione}`} value={String(index)}>
                        {i.descrizione} · {i.codice}
                      </option>
                    ) : null,
                  )}
                </optgroup>
              ))}
            </select>
            <p className="aiuto" id="presidio-nomenclatore-aiuto">
              Riempie prodotto e codice. Fonte: {items[0]!.atto ?? `allegato ${annex}`}.
            </p>
            {chosenItem?.quantita && (
              // La quantità come la stampa l'allegato, senza controlli sul fabbisogno (D237).
              <p className="aiuto" id="presidio-nomenclatore-quantita">
                Quantità nel nomenclatore: <strong>{chosenItem.quantita}</strong>
                {chosenItem.intestazioneQuantita ? ` («${chosenItem.intestazioneQuantita}»)` : ''}.
                Il fabbisogno lo decide il medico.
              </p>
            )}
            {rare.length > 0 && (
              <details className="malattie-rare">
                <summary>Malattie rare che danno diritto a questi presidi (art. 13)</summary>
                <ul>
                  {rare.map((r) => (
                    <li key={r.codice}>
                      <span className="codice">{r.codice}</span> {r.descrizione}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
        <div className="campi-in-riga">
          {field('prodotto', 'Prodotto', { required: true, maxLength: 500 })}
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
