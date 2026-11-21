import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import {
  DataVersions,
  ErrorMessage,
  Loading,
  Notice,
  PageHeader,
  type DatasetVersion,
} from '../components/common';
import { Icon } from '../components/Icon';
import { ServiceResultText, type ServiceResultData } from '../components/ServiceResult';
import { RegistryNote, type DrugRegistry } from '../components/Registries';
import {
  isSuspended,
  ShortageNote,
  SuspendedNote,
  type DrugShortage,
} from '../components/Shortage';
import { ReminderPanel } from '../components/ReminderPanel';
import { SendPanel } from '../components/SendPanel';
import { api, ApiError, query } from '../lib/api';
import { ACCESS_TYPE, date, money, PRIORITY, REMINDER_CHANNEL } from '../lib/format';
import { usePersistentState } from '../lib/storage';
import {
  count,
  listPath,
  packageLines,
  useStudioList,
  type ListItem,
  type PackageLine,
  type PackageService,
} from '../lib/studio-lists';
import { useApi } from '../lib/useApi';
import { PatientBanner, posology, type Patient, type Summary, type TherapyRow } from './RecordPage';

export interface Drug {
  aic: string;
  name: string | null;
  pack: string | null;
  activeIngredient: string | null;
  atc: string | null;
  drugClass: string | null;
  price: string | null;
  aifaNote: string | null;
  dpc: boolean;
  planRequired: boolean | null;
  /** Ditta titolare dell'AIC: per i generici, il fornitore (D151). */
  holder: string | null;
  /** Lista di trasparenza AIFA (D202): prezzo di riferimento e differenza dal prezzo al pubblico. */
  referencePrice?: string | null;
  priceDifference?: string | null;
  /** Annotazione della lista di trasparenza, in parole. */
  transparencyRemark?: string | null;
  /** Carenza secondo l'elenco AIFA in vigore (D202). */
  shortage?: DrugShortage | null;
  /** Stato amministrativo della confezione nell'anagrafica AIFA in vigore (D205). */
  adminState?: string | null;
  /** Registri e piani terapeutici AIFA attivi per lo stesso ATC (D206). */
  registries?: DrugRegistry[];
}

export type Service = ServiceResultData;

interface Line {
  key: string;
  therapyId?: string;
  drugAic?: string | null;
  drugName?: string | null;
  activeIngredient?: string | null;
  /** Codice del catalogo regionale. */
  serviceCode?: string | null;
  /** Codice del nomenclatore, «codice DM» (D154). */
  serviceNationalCode?: string | null;
  serviceDescription?: string | null;
  quantity: number;
  aifaNote?: string | null;
  posologyText?: string;
  byActiveIngredient?: boolean;
  notSubstitutable?: boolean;
  notSubstitutableReason?: string;
  /** Ricetta bianca ripetibile, solo se diverso dalla regola del farmaco (D93). */
  repeatCount?: string;
  validityMonths?: string;
}

const SEARCH_DELAY_MS = 250;
/** Chiave stabile di una riga, anche dopo un ricaricamento (lo stato è ricordato). */
const newKey = () => crypto.randomUUID();

/** Ricerca con un piccolo ritardo, per non interrogare il servizio a ogni tasto. */
export function useDebounced(value: string, ms = SEARCH_DELAY_MS): string {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

interface PriorVoice {
  ricetta: {
    id: string;
    stato: string;
    nre: string | null;
    inviataIl: string | null;
    cartaceaIl: string | null;
    preparataIl: string;
    etichettaErogazione: string | null;
  };
}

/**
 * La stessa prestazione già prescritta (il caso di Simone: il paziente dice di non averla
 * prenotata). Si vede subito quando e con che NRE, e lo stato presso l'ente se è stato verificato.
 */
function AlreadyPrescribed({
  patientId,
  code,
  description,
}: {
  patientId: string;
  code: string | null;
  description: string | null;
}) {
  const q = query({ prestazione: code, descrizione: code ? null : description });
  const h = useApi<{ voci: PriorVoice[] }>(`/api/pazienti/${patientId}/storico-prescrizioni${q}`);
  const prior = (h.data?.voci ?? []).filter(
    (v) => v.ricetta.stato === 'sent' || v.ricetta.stato === 'paper',
  );
  const last = prior[0];
  if (!last) return null;
  const r = last.ricetta;
  return (
    <Notice kind="avviso">
      <p>
        Già prescritta{prior.length > 1 ? ` ${prior.length} volte; l’ultima` : ''} il{' '}
        {date(r.inviataIl ?? r.cartaceaIl ?? r.preparataIl)}
        {r.nre && (
          <>
            {' '}
            (NRE <span className="codice">{r.nre}</span>)
          </>
        )}
        {r.etichettaErogazione
          ? `. Presso l’ente: ${r.etichettaErogazione.toLowerCase()}.`
          : '. Stato presso l’ente non ancora verificato.'}{' '}
        Prima di prescriverla di nuovo, verifica lo stato nello{' '}
        <Link to={`/pazienti/${patientId}/prestazioni${q}`}>storico della prestazione</Link>.
      </p>
    </Notice>
  );
}

/** Descrizione breve di un farmaco della banca dati: confezione, ditta, classe, nota, DPC, piano. */
export function drugFacts(d: Drug): string[] {
  return [
    d.pack,
    d.holder && `ditta ${d.holder}`,
    d.drugClass && `classe ${d.drugClass}`,
    d.aifaNote && `Nota ${d.aifaNote}`,
    d.dpc && 'in DPC',
    d.planRequired && 'piano terapeutico obbligatorio',
    d.price && money(d.price),
    d.referencePrice && `prezzo di riferimento ${money(d.referencePrice)}`,
    d.priceDifference &&
      Number(d.priceDifference) > 0 &&
      `differenza dal riferimento ${money(d.priceDifference)}`,
    d.transparencyRemark,
  ].filter((x): x is string => !!x);
}

/**
 * Una riga in ricetta, chiusa (D242): che cosa c'è senza aprirla. Confezioni e posologia per i
 * farmaci, quantità e codici per le prestazioni; le scelte che vincolano il farmacista si dicono.
 */
export function lineSummary(
  l: {
    quantity: number;
    posologyText?: string;
    byActiveIngredient?: boolean;
    notSubstitutable?: boolean;
    repeatCount?: string;
    validityMonths?: string;
    serviceCode?: string | null;
    serviceNationalCode?: string | null;
  },
  mode: 'farmaci' | 'specialistica',
  white = false,
): string {
  if (mode === 'specialistica')
    return [
      `quantità ${l.quantity}`,
      l.serviceCode && `catalogo ${l.serviceCode}`,
      l.serviceNationalCode && `nomenclatore (DM) ${l.serviceNationalCode}`,
    ]
      .filter(Boolean)
      .join(' · ');
  return [
    `${l.quantity} ${l.quantity === 1 ? 'confezione' : 'confezioni'}`,
    l.posologyText?.trim() || 'posologia non indicata',
    l.byActiveIngredient && 'per principio attivo',
    l.notSubstitutable && 'non sostituibile',
    white && l.repeatCount && `ripetibile ${l.repeatCount} volte`,
    white && l.validityMonths && `validità ${l.validityMonths} mesi`,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function PrescriptionEditor({ mode }: { mode: 'farmaci' | 'specialistica' }) {
  const { id } = useParams<{ id: string }>();
  const record = useApi<{ paziente: Patient; riepilogo: Summary | null }>(`/api/pazienti/${id}`);
  const therapies = useApi<{ terapie: TherapyRow[] }>(
    mode === 'farmaci' ? `/api/pazienti/${id}/terapie` : null,
  );
  // La ricetta in corso è ricordata per paziente (D68): si passa a un'altra cartella e si torna.
  const k = (field: string) => `ricetta:${id}:${mode}:${field}`;
  const [kind, setKind, resetKind] = usePersistentState(
    k('tipo'),
    mode === 'farmaci' ? 'pharma_ssn' : 'specialist_ssn',
  );
  const [lines, setLines, resetLines] = usePersistentState<Line[]>(k('righe'), []);
  const [exemption, setExemption, resetExemption] = usePersistentState(k('esenzione'), '');
  const [channel, setChannel, resetChannel] = usePersistentState(k('canale'), '');
  const [accessType, setAccessType, resetAccess] = usePersistentState(k('accesso'), 'first');
  const [priority, setPriority, resetPriority] = usePersistentState(k('priorita'), 'P');
  const [question, setQuestion, resetQuestion] = usePersistentState(k('quesito'), '');
  const [obscured, setObscured, resetObscured] = usePersistentState(k('oscurato'), false);
  const [text, setText] = useState('');
  const q = useDebounced(text);
  const search = useApi<{ farmaci?: Drug[]; prestazioni?: Service[]; versioni: DatasetVersion[] }>(
    q.trim()
      ? `/api/${mode === 'farmaci' ? 'farmaci' : 'prestazioni'}${query({ q: q.trim() })}`
      : null,
  );
  const versions = useApi<{ versioni: DatasetVersion[] }>(`/api/banche-dati`);
  // Elenchi dello studio (tappa 14): i pacchetti nella specialistica, le posologie nei farmaci.
  const packages = useStudioList(mode === 'specialistica' ? 'pacchetto' : null);
  const posologies = useStudioList(mode === 'farmaci' ? 'posologia' : null);
  const [draft, setDraft, resetDraft] = usePersistentState<{
    id: string;
    status: string;
    lineIds: Record<string, string>;
    nre?: string;
  } | null>(k('bozza'), null);
  const startOver = () => {
    for (const reset of [resetKind, resetLines, resetExemption, resetChannel, resetAccess]) reset();
    for (const reset of [resetPriority, resetQuestion, resetDraft, resetObscured]) reset();
  };
  const [error, setError] = useState<ApiError | null>(null);
  // Le righe in ricetta restano chiuse: si aprono col clic sulla riga (D242).
  const [openLines, setOpenLines] = useState<ReadonlySet<string>>(() => new Set());
  const toggleLine = (key: string) =>
    setOpenLines((open) => {
      const next = new Set(open);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  // La pagina in una schermata (D242): la cornice prende l'altezza dello schermo e le due colonne
  // scorrono ciascuna nel suo riquadro. Gli stili sono in global.css, solo per gli schermi larghi
  // e alti abbastanza: altrove la pagina scorre come le altre.
  useEffect(() => {
    document.documentElement.classList.add('schermo-unico');
    return () => document.documentElement.classList.remove('schermo-unico');
  }, []);

  if (record.loading && !record.data) return <Loading what="dati della cartella" />;
  if (!record.data) return <ErrorMessage error={record.error} />;
  const p = record.data.paziente;
  const exemptions = record.data.riepilogo?.esenzioni ?? [];
  const versionKinds =
    mode === 'farmaci' ? ['farmaci', 'farmaci_classe', 'farmaci_dpc'] : ['prestazioni'];
  const shownVersions = (search.data?.versioni ?? versions.data?.versioni)?.filter((v) =>
    versionKinds.includes(v.kind),
  );

  const add = (l: Omit<Line, 'key'>) => setLines((ls) => [...ls, { ...l, key: newKey() }]);
  // Le posologie dello studio, come suggerimenti nella posologia delle righe dei farmaci.
  const posologyTexts = [...new Set((posologies.data?.voci ?? []).map((p) => p.etichetta))];
  const update = (key: string, patch: Partial<Line>) =>
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  async function save() {
    setError(null);
    try {
      const body = {
        kind,
        exemptionCode: exemption || null,
        reminderChannel: channel || null,
        ...(mode === 'specialistica'
          ? { accessType, priority, diagnosticQuestion: question || null }
          : {}),
        ...(kind !== 'white' && obscured ? { obscured: true } : {}),
        lines: lines.map(
          ({
            key: _k,
            posologyText,
            notSubstitutableReason,
            repeatCount,
            validityMonths,
            ...l
          }) => ({
            ...l,
            posologyText: posologyText || null,
            notSubstitutableReason: notSubstitutableReason || null,
            ...(kind === 'white'
              ? {
                  repeatCount: repeatCount ? Number(repeatCount) : null,
                  validityMonths: validityMonths ? Number(validityMonths) : null,
                }
              : {}),
          }),
        ),
      };
      const r = await api<{ id: string }>(`/api/pazienti/${id}/ricette`, { method: 'POST', body });
      const list = await api<{
        ricette: {
          id: string;
          status: string;
          righe: {
            id: string;
            position: number;
            drugName: string | null;
            serviceDescription: string | null;
          }[];
        }[];
      }>(`/api/pazienti/${id}/ricette`);
      const created = list.ricette.find((x) => x.id === r.id);
      setDraft({
        id: r.id,
        status: created?.status ?? 'draft',
        lineIds: Object.fromEntries(
          (created?.righe ?? []).map((l) => [l.id, l.drugName ?? l.serviceDescription ?? '']),
        ),
      });
    } catch (e) {
      setError(e instanceof ApiError ? e : null);
    }
  }

  const title = mode === 'farmaci' ? 'Nuova ricetta' : 'Ricetta specialistica';
  const locked = draft !== null;
  // Titolo e dati del paziente: in una riga sola quando la pagina sta in una schermata (D242).
  const header = (
    <div className="testata-ricetta">
      <PageHeader
        title={title}
        trail={
          <>
            <Link to={`/pazienti/${id}`}>
              {p.firstName} {p.lastName}
            </Link>{' '}
            <span aria-hidden="true">/</span> <span>{title}</span>
          </>
        }
      />
      <PatientBanner patient={p} summary={record.data.riepilogo} />
    </div>
  );

  // Paziente deceduto: la ricetta non si fa (R19, D199). Lo si dice subito, con il rimedio.
  if (p.status === 'deceased')
    return (
      <>
        {header}
        <Notice kind="errore">
          <p>
            <strong>
              Il paziente risulta deceduto{p.deceasedOn ? ` il ${date(p.deceasedOn)}` : ''}: la
              ricetta non si fa.
            </strong>{' '}
            Se lo stato è sbagliato, correggilo nei{' '}
            <Link to={`/pazienti/${id}/amministrazione`}>dati amministrativi</Link> della cartella.
          </p>
        </Notice>
      </>
    );

  return (
    <>
      {header}

      <div className="griglia-ricetta">
        <section className="riquadro" aria-labelledby="titolo-cerca">
          <h2 id="titolo-cerca">
            {mode === 'farmaci' ? 'Banca dati farmaci' : 'Catalogo regionale'}
          </h2>
          {mode === 'farmaci' && (
            <fieldset className="scelta scelta-in-riga" disabled={locked}>
              <legend>Tipo di ricetta</legend>
              {[
                ['pharma_ssn', 'Farmaceutica SSN'],
                ['white', 'Bianca (a carico del paziente)'],
              ].map(([v, label]) => (
                <div key={v} className="casella">
                  <input
                    type="radio"
                    id={`tipo-${v}`}
                    name="tipo"
                    value={v}
                    checked={kind === v}
                    onChange={() => setKind(v!)}
                  />
                  <label htmlFor={`tipo-${v}`}>{label}</label>
                </div>
              ))}
            </fieldset>
          )}
          <div role="search" className="ricerca">
            <label htmlFor="cerca-voce">
              {mode === 'farmaci'
                ? 'Farmaco, principio attivo, codice AIC o ATC'
                : 'Prestazione, branca o codice'}
            </label>
            <div className="ricerca-campo">
              <Icon name="cerca" />
              <input
                id="cerca-voce"
                type="search"
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={locked}
                autoComplete="off"
              />
            </div>
          </div>
          <DataVersions
            versions={shownVersions}
            label={mode === 'farmaci' ? 'Banche dati dei farmaci' : 'Catalogo'}
            compact
          />
          <ErrorMessage error={search.error} />
          <ul className="risultati" aria-live="polite">
            {search.data?.farmaci?.map((d) => (
              <li key={d.aic} className="risultato">
                <div>
                  <strong>{d.name ?? d.activeIngredient}</strong>
                  <div className="tenue">{drugFacts(d).join(' · ')}</div>
                  <div className="codice tenue">AIC {d.aic}</div>
                  {isSuspended(d.adminState) && <SuspendedNote />}
                  {d.shortage && <ShortageNote shortage={d.shortage} />}
                  <RegistryNote registries={d.registries ?? []} />
                </div>
                <button
                  type="button"
                  className="pulsante"
                  disabled={locked}
                  onClick={() =>
                    add({
                      drugAic: d.aic,
                      drugName: [d.name, d.pack].filter(Boolean).join(' '),
                      activeIngredient: d.activeIngredient,
                      aifaNote: d.aifaNote,
                      quantity: 1,
                    })
                  }
                >
                  <Icon name="aggiungi" /> <span>Aggiungi</span>
                </button>
              </li>
            ))}
            {search.data?.prestazioni?.map((s) => (
              <li key={s.regionalCode} className="risultato">
                <ServiceResultText s={s} />
                <button
                  type="button"
                  className="pulsante"
                  disabled={locked}
                  onClick={() =>
                    add({
                      serviceCode: s.regionalCode,
                      serviceNationalCode: s.nationalCode,
                      serviceDescription: s.description,
                      quantity: 1,
                    })
                  }
                >
                  <Icon name="aggiungi" /> <span>Aggiungi</span>
                </button>
              </li>
            ))}
            {q &&
              search.data &&
              (search.data.farmaci ?? search.data.prestazioni ?? []).length === 0 && (
                <li className="tenue">Nessun risultato per «{q}».</li>
              )}
          </ul>
          {mode === 'specialistica' && (
            <PackagePicker
              packages={packages.data?.voci ?? null}
              inPrescription={lines.map((l) => l.serviceCode)}
              disabled={locked}
              onAdd={(added) =>
                setLines((ls) => [...ls, ...added.map((l) => ({ ...l, key: newKey() }))])
              }
            />
          )}
          {mode === 'specialistica' && (
            <ManualServiceForm disabled={locked} onAdd={(l) => add({ ...l, quantity: 1 })} />
          )}
          {mode === 'farmaci' && (therapies.data?.terapie ?? []).length > 0 && (
            <>
              <h3>Dalla terapia in corso</h3>
              <ul className="risultati">
                {therapies
                  .data!.terapie.filter((t) => t.status === 'active')
                  .map((t) => (
                    <li key={t.id} className="risultato">
                      <div>
                        <strong>{t.drugName}</strong>
                        <div className="tenue">{posology(t)}</div>
                      </div>
                      <button
                        type="button"
                        className="pulsante"
                        disabled={locked}
                        onClick={() =>
                          add({
                            therapyId: t.id,
                            drugAic: t.drugAic,
                            drugName: t.drugName,
                            activeIngredient: t.activeIngredient,
                            aifaNote: t.aifaNote,
                            quantity: 1,
                            posologyText: posology(t),
                          })
                        }
                      >
                        <Icon name="aggiungi" /> <span>Aggiungi</span>
                      </button>
                    </li>
                  ))}
              </ul>
            </>
          )}
        </section>

        <section className="riquadro" aria-labelledby="titolo-ricetta">
          <h2 id="titolo-ricetta">In ricetta</h2>
          {lines.length === 0 && (
            <p className="tenue">
              Aggiungi un {mode === 'farmaci' ? 'farmaco' : 'prestazione'} dalla ricerca.
            </p>
          )}
          <ol className="righe-ricetta">
            {lines.map((l, n) => {
              const name = l.drugName ?? l.serviceDescription;
              const open = openLines.has(l.key);
              return (
                <li key={l.key} className={`riga-ricetta${open ? ' aperta' : ''}`}>
                  <div className="riga-ricetta-testa">
                    <button
                      type="button"
                      className="riga-ricetta-apri"
                      aria-expanded={open}
                      aria-controls={`dettagli-${l.key}`}
                      onClick={() => toggleLine(l.key)}
                    >
                      <Icon name="apri" />
                      <span className="riga-ricetta-testo">
                        <strong className="riga-ricetta-nome">
                          {n + 1}. {name}
                        </strong>
                        <span className="tenue">{lineSummary(l, mode, kind === 'white')}</span>
                      </span>
                    </button>
                    {l.aifaNote && <span className="etichetta">Nota {l.aifaNote}</span>}
                  </div>
                  {mode === 'specialistica' && (l.serviceCode || l.serviceDescription) && (
                    <AlreadyPrescribed
                      patientId={id!}
                      code={l.serviceCode ?? null}
                      description={l.serviceDescription ?? null}
                    />
                  )}
                  <fieldset
                    id={`dettagli-${l.key}`}
                    className="riga-ricetta-dettagli"
                    disabled={locked}
                    hidden={!open}
                  >
                    <legend className="visivamente-nascosto">
                      Dettagli della riga {n + 1}: {name}
                    </legend>
                    {mode === 'specialistica' && l.serviceCode && (
                      <p className="codice tenue">
                        Catalogo {l.serviceCode}
                        {l.serviceNationalCode
                          ? ` · nomenclatore (DM) ${l.serviceNationalCode}`
                          : ' · nomenclatore (DM) dal catalogo in uso'}
                      </p>
                    )}
                    <div className="campi-riga">
                      <div className="campo campo-stretto">
                        <label htmlFor={`q-${l.key}`}>
                          {mode === 'farmaci' ? 'Confezioni' : 'Quantità'}
                        </label>
                        <input
                          id={`q-${l.key}`}
                          type="number"
                          min={1}
                          max={99}
                          value={l.quantity}
                          onChange={(e) =>
                            update(l.key, { quantity: Math.max(1, Number(e.target.value) || 1) })
                          }
                        />
                      </div>
                      {mode === 'farmaci' && (
                        <div className="campo">
                          <label htmlFor={`p-${l.key}`}>Posologia</label>
                          <input
                            id={`p-${l.key}`}
                            list={posologyTexts.length ? 'posologie-studio' : undefined}
                            value={l.posologyText ?? ''}
                            onChange={(e) => update(l.key, { posologyText: e.target.value })}
                          />
                        </div>
                      )}
                    </div>
                    {mode === 'farmaci' && (
                      <>
                        <div className="casella">
                          <input
                            type="checkbox"
                            id={`pa-${l.key}`}
                            checked={!!l.byActiveIngredient}
                            onChange={(e) =>
                              update(l.key, { byActiveIngredient: e.target.checked })
                            }
                          />
                          <label htmlFor={`pa-${l.key}`}>
                            Per principio attivo{' '}
                            <span className="tenue">· il farmacista può dare un equivalente</span>
                          </label>
                        </div>
                        <div className="casella">
                          <input
                            type="checkbox"
                            id={`ns-${l.key}`}
                            checked={!!l.notSubstitutable}
                            onChange={(e) => update(l.key, { notSubstitutable: e.target.checked })}
                          />
                          <label htmlFor={`ns-${l.key}`}>
                            Non sostituibile{' '}
                            <span className="tenue">
                              · vincola il farmacista; serve una motivazione (R13)
                            </span>
                          </label>
                        </div>
                        {l.notSubstitutable && (
                          <div className="campo">
                            <label htmlFor={`nsm-${l.key}`}>
                              Motivazione della non sostituibilità
                            </label>
                            <input
                              id={`nsm-${l.key}`}
                              value={l.notSubstitutableReason ?? ''}
                              onChange={(e) =>
                                update(l.key, { notSubstitutableReason: e.target.value })
                              }
                            />
                          </div>
                        )}
                        {kind === 'white' && (
                          <div className="campi-riga">
                            <div className="campo campo-stretto">
                              <label htmlFor={`rip-${l.key}`}>Ripetibile (volte)</label>
                              <input
                                id={`rip-${l.key}`}
                                inputMode="numeric"
                                value={l.repeatCount ?? ''}
                                onChange={(e) =>
                                  update(l.key, { repeatCount: e.target.value.replace(/\D/g, '') })
                                }
                                aria-describedby={`rip-aiuto-${l.key}`}
                              />
                            </div>
                            <div className="campo campo-stretto">
                              <label htmlFor={`val-${l.key}`}>Validità (mesi)</label>
                              <input
                                id={`val-${l.key}`}
                                inputMode="numeric"
                                value={l.validityMonths ?? ''}
                                onChange={(e) =>
                                  update(l.key, {
                                    validityMonths: e.target.value.replace(/\D/g, ''),
                                  })
                                }
                                aria-describedby={`rip-aiuto-${l.key}`}
                              />
                            </div>
                            <p className="aiuto" id={`rip-aiuto-${l.key}`}>
                              Solo se diversi dalla regola del farmaco: altrimenti vale quella, e il
                              SAC controlla le ripetizioni.
                            </p>
                          </div>
                        )}
                      </>
                    )}
                    <button
                      type="button"
                      className="pulsante pulsante-piatto"
                      onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
                    >
                      <Icon name="annulla" /> <span>Togli dalla ricetta</span>
                    </button>
                  </fieldset>
                </li>
              );
            })}
          </ol>
          {posologyTexts.length > 0 && (
            <datalist id="posologie-studio">
              {posologyTexts.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          )}

          <fieldset className="dati-ricetta" disabled={locked}>
            <legend>Dati della ricetta</legend>
            {mode === 'specialistica' && (
              <>
                <fieldset className="scelta scelta-in-riga">
                  <legend>Tipo di accesso</legend>
                  {Object.entries(ACCESS_TYPE).map(([v, label]) => (
                    <div key={v} className="casella">
                      <input
                        type="radio"
                        id={`accesso-${v}`}
                        name="accesso"
                        checked={accessType === v}
                        onChange={() => setAccessType(v)}
                      />
                      <label htmlFor={`accesso-${v}`}>{label}</label>
                    </div>
                  ))}
                </fieldset>
                <fieldset className="scelta scelta-in-riga">
                  <legend>Classe di priorità</legend>
                  {Object.entries(PRIORITY).map(([v, label]) => (
                    <div key={v} className="casella">
                      <input
                        type="radio"
                        id={`priorita-${v}`}
                        name="priorita"
                        checked={priority === v}
                        onChange={() => setPriority(v)}
                      />
                      <label htmlFor={`priorita-${v}`}>{label}</label>
                    </div>
                  ))}
                </fieldset>
                <div className="campo">
                  <label htmlFor="quesito">Quesito diagnostico</label>
                  <textarea
                    id="quesito"
                    rows={2}
                    value={question}
                    onChange={(e) => setQuestion(e.target.value)}
                  />
                  <p className="aiuto">Obbligatorio sulla ricetta specialistica (R14).</p>
                </div>
              </>
            )}
            {/* L'esenzione resta sempre in vista (D242). */}
            <div className="campo">
              <label htmlFor="esenzione">Esenzione</label>
              <select
                id="esenzione"
                value={exemption}
                onChange={(e) => setExemption(e.target.value)}
              >
                <option value="">Nessuna</option>
                {exemptions.map((e) => (
                  <option key={e.codice} value={e.codice}>
                    {e.codice}
                  </option>
                ))}
              </select>
            </div>
            {/*
              Promemoria e oscuramento, usati di rado: chiusi in una riga che dice la scelta in
              corso, si aprono col clic (D242).
            */}
            <details className="altre-opzioni">
              <summary>
                <Icon name="apri" />
                <span>
                  Altre opzioni:{' '}
                  <span className="tenue">
                    {[
                      channel
                        ? `promemoria: ${(REMINDER_CHANNEL[channel] ?? channel).toLowerCase()}`
                        : 'promemoria con il canale del paziente',
                      kind !== 'white' &&
                        (obscured ? 'nome e indirizzo oscurati' : 'nome e indirizzo in chiaro'),
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                </span>
              </summary>
              <div className="campo">
                <label htmlFor="canale">Promemoria al paziente</label>
                <select id="canale" value={channel} onChange={(e) => setChannel(e.target.value)}>
                  <option value="">Il canale scelto dal paziente</option>
                  {Object.entries(REMINDER_CHANNEL).map(([v, label]) => (
                    <option key={v} value={v}>
                      {label}
                    </option>
                  ))}
                </select>
                <p className="aiuto">
                  Solo i canali scelti dal paziente e i suoi recapiti o dei delegati (R15, R16).
                </p>
              </div>
              {kind !== 'white' && (
                <div className="casella">
                  <input
                    type="checkbox"
                    id="oscurato"
                    checked={obscured}
                    onChange={(e) => setObscured(e.target.checked)}
                  />
                  <label htmlFor="oscurato">
                    <strong>Oscura nome e indirizzo</strong>{' '}
                    <span className="tenue">
                      Lo chiede il paziente: non compaiono sul promemoria né all’erogatore; il
                      codice fiscale resta.
                    </span>
                  </label>
                </div>
              )}
            </details>
          </fieldset>
          <ErrorMessage error={error} />
          {/* I pulsanti restano in vista in fondo al riquadro, anche quando la ricetta scorre (D242). */}
          {!draft && (
            <div className="azioni azioni-ricetta">
              <button
                type="button"
                className="pulsante pulsante-primario"
                disabled={lines.length === 0}
                onClick={() => void save()}
              >
                <Icon name="ricette" /> <span>Prepara la ricetta</span>
              </button>
              {lines.length > 0 && (
                <button type="button" className="pulsante" onClick={startOver}>
                  <Icon name="ripeti" /> <span>Ricomincia</span>
                </button>
              )}
            </div>
          )}
          {draft && draft.status === 'sent' && (
            <>
              <Notice kind="fatto">
                Ricetta inviata.
                {draft.nre && (
                  <>
                    {' '}
                    NRE <span className="codice">{draft.nre}</span>
                  </>
                )}
              </Notice>
              <ReminderPanel prescriptionId={draft.id} patientId={id!} kind={kind} />
            </>
          )}
          {draft && draft.status === 'paper' && (
            <Notice kind="fatto">Ricetta rossa pronta per la stampa.</Notice>
          )}
          {draft && draft.status !== 'sent' && draft.status !== 'paper' && (
            <>
              <Notice kind="fatto">Ricetta preparata in bozza. Si controlla e poi si firma.</Notice>
              <SendPanel
                prescriptionId={draft.id}
                status={draft.status}
                lineNames={draft.lineIds}
                onChange={(status, nre) => setDraft({ ...draft, status, ...(nre ? { nre } : {}) })}
              />
            </>
          )}
          {draft && (
            <div className="azioni">
              <button type="button" className="pulsante" onClick={startOver}>
                <Icon name="ripeti" /> <span>Nuova ricetta da capo</span>
              </button>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

interface PackageOutcome {
  name: string;
  added: number;
  missing: PackageService[];
  already: PackageService[];
  noCatalog: boolean;
}

/**
 * Pacchetti dello studio (tappa 14): «Aggiungi un pacchetto» mette in ricetta le sue prestazioni,
 * cercate nel catalogo in vigore come dalla ricerca delle prestazioni, con i due codici (D154).
 * Quelle che il catalogo in vigore non ha non si aggiungono e si dicono; quelle già in ricetta non
 * si ripetono. Finché l'elenco non arriva (packages null) non si vede nulla.
 */
export function PackagePicker({
  packages,
  inPrescription,
  disabled,
  onAdd,
}: {
  packages: ListItem<'pacchetto'>[] | null;
  inPrescription: (string | null | undefined)[];
  disabled: boolean;
  onAdd: (lines: PackageLine[]) => void;
}) {
  const [chosen, setChosen] = useState('');
  const [outcome, setOutcome] = useState<PackageOutcome | null>(null);
  if (!packages) return null;
  if (packages.length === 0)
    return (
      <p className="aiuto">
        I pacchetti di prestazioni dello studio si preparano in{' '}
        <Link to={listPath('pacchetto')}>Strumenti › Elenchi dello studio</Link>.
      </p>
    );
  const pkg = packages.find((p) => p.id === chosen);
  const addPackage = () => {
    if (!pkg) return;
    const r = packageLines(pkg, inPrescription);
    if (r.add.length) onAdd(r.add);
    setOutcome({
      name: pkg.etichetta,
      added: r.add.length,
      missing: r.missing,
      already: r.already,
      noCatalog: pkg.catalogo === null,
    });
  };
  return (
    <fieldset disabled={disabled}>
      <legend>Aggiungi un pacchetto</legend>
      <div className="campo">
        <label htmlFor="pacchetto-studio">Pacchetto dello studio</label>
        <select
          id="pacchetto-studio"
          value={chosen}
          onChange={(e) => {
            setChosen(e.target.value);
            setOutcome(null);
          }}
        >
          <option value="">Scegli un pacchetto</option>
          {packages.map((p) => (
            <option key={p.id} value={p.id}>
              {p.etichetta} ({count(p.dati.prestazioni.length, 'prestazione', 'prestazioni')})
            </option>
          ))}
        </select>
      </div>
      <div className="azioni">
        <button type="button" className="pulsante" disabled={!pkg} onClick={addPackage}>
          <Icon name="aggiungi" /> <span>Aggiungi in ricetta</span>
        </button>
      </div>
      {outcome && outcome.added > 0 && (
        <Notice kind="fatto">
          {outcome.added === 1 ? 'Aggiunta' : 'Aggiunte'}{' '}
          {count(outcome.added, 'prestazione', 'prestazioni')} del pacchetto «{outcome.name}».
        </Notice>
      )}
      {outcome && outcome.missing.length > 0 && (
        <Notice kind="avviso">
          <p>
            {outcome.noCatalog
              ? 'Nessun catalogo delle prestazioni in uso: le prestazioni del pacchetto non si possono cercare e non si aggiungono:'
              : outcome.missing.length === 1
                ? 'Non aggiunta, perché non è nel catalogo in vigore oggi:'
                : 'Non aggiunte, perché non sono nel catalogo in vigore oggi:'}
          </p>
          <ul>
            {outcome.missing.map((s) => (
              <li key={s.codice}>
                <span className="codice">{s.codice}</span> {s.descrizione}
              </li>
            ))}
          </ul>
          <p>
            Cercale nel catalogo, oppure aggiorna il pacchetto in{' '}
            <Link to={listPath('pacchetto')}>Strumenti › Elenchi dello studio</Link>.
          </p>
        </Notice>
      )}
      {outcome && outcome.already.length > 0 && (
        <Notice kind="info">
          Già in ricetta, non {outcome.already.length === 1 ? 'aggiunta' : 'aggiunte'} di nuovo:{' '}
          {outcome.already.map((s) => s.codice).join(', ')}.
        </Notice>
      )}
    </fieldset>
  );
}

/**
 * Prestazione scritta a mano (D154): solo se il catalogo del programma non ha ancora un codice
 * nuovo. Il SAR controlla i due codici sul catalogo che la Regione ha trasmesso; all'invio il
 * programma avvisa (R18) e chiede un motivo, che resta registrato.
 */
function ManualServiceForm({
  disabled,
  onAdd,
}: {
  disabled: boolean;
  onAdd: (l: {
    serviceCode: string;
    serviceNationalCode: string;
    serviceDescription: string;
  }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState('');
  const [national, setNational] = useState('');
  const [description, setDescription] = useState('');
  const ready = code.trim() && national.trim() && description.trim();
  if (!open) {
    return (
      <p>
        <button
          type="button"
          className="pulsante pulsante-piatto"
          disabled={disabled}
          onClick={() => setOpen(true)}
        >
          <Icon name="aggiungi" /> <span>Prestazione non ancora nel catalogo: scrivila a mano</span>
        </button>
      </p>
    );
  }
  return (
    <fieldset className="modulo-a-mano" disabled={disabled}>
      <legend>Prestazione scritta a mano</legend>
      <p className="aiuto">
        Solo se il catalogo del programma non è ancora aggiornato. Il SAR controlla i due codici sul
        catalogo della Regione e rifiuta la ricetta se non li trova; all’invio serve un motivo.
      </p>
      <div className="campo">
        <label htmlFor="a-mano-catalogo">Codice del catalogo regionale</label>
        <input
          id="a-mano-catalogo"
          className="codice"
          value={code}
          onChange={(e) => setCode(e.target.value)}
        />
      </div>
      <div className="campo">
        <label htmlFor="a-mano-nomenclatore">Codice del nomenclatore (DM)</label>
        <input
          id="a-mano-nomenclatore"
          className="codice"
          value={national}
          onChange={(e) => setNational(e.target.value)}
        />
      </div>
      <div className="campo">
        <label htmlFor="a-mano-descrizione">Descrizione, come nel catalogo della Regione</label>
        <input
          id="a-mano-descrizione"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="azioni">
        <button
          type="button"
          className="pulsante"
          disabled={!ready}
          onClick={() => {
            onAdd({
              serviceCode: code.trim(),
              serviceNationalCode: national.trim(),
              serviceDescription: description.trim(),
            });
            setCode('');
            setNational('');
            setDescription('');
            setOpen(false);
          }}
        >
          <Icon name="aggiungi" /> <span>Aggiungi in ricetta</span>
        </button>
        <button type="button" className="pulsante pulsante-piatto" onClick={() => setOpen(false)}>
          <span>Chiudi</span>
        </button>
      </div>
    </fieldset>
  );
}
