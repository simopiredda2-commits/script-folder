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
import { ReminderPanel } from '../components/ReminderPanel';
import { SendPanel } from '../components/SendPanel';
import { api, ApiError, query } from '../lib/api';
import { ACCESS_TYPE, date, money, PRIORITY, REMINDER_CHANNEL } from '../lib/format';
import { usePersistentState } from '../lib/storage';
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
}

export interface Service {
  regionalCode: string;
  nationalCode: string | null;
  description: string;
  branch: string | null;
  fee: string | null;
  notes: string | null;
}

interface Line {
  key: string;
  therapyId?: string;
  drugAic?: string | null;
  drugName?: string | null;
  activeIngredient?: string | null;
  serviceCode?: string | null;
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
  ].filter((x): x is string => !!x);
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

  return (
    <>
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

      <div className="griglia-ricetta">
        <section className="riquadro" aria-labelledby="titolo-cerca">
          <h2 id="titolo-cerca">
            {mode === 'farmaci' ? 'Banca dati farmaci' : 'Catalogo regionale'}
          </h2>
          {mode === 'farmaci' && (
            <fieldset className="scelta" disabled={locked}>
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
          />
          <ErrorMessage error={search.error} />
          <ul className="risultati" aria-live="polite">
            {search.data?.farmaci?.map((d) => (
              <li key={d.aic} className="risultato">
                <div>
                  <strong>{d.name ?? d.activeIngredient}</strong>
                  <div className="tenue">{drugFacts(d).join(' · ')}</div>
                  <div className="codice tenue">AIC {d.aic}</div>
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
                <div>
                  <strong>{s.description}</strong>
                  <div className="tenue">
                    {[s.branch, s.fee && money(s.fee), s.notes].filter(Boolean).join(' · ')}
                  </div>
                  <div className="codice tenue">
                    {s.regionalCode}
                    {s.nationalCode && s.nationalCode !== s.regionalCode
                      ? ` · nomenclatore ${s.nationalCode}`
                      : ''}
                  </div>
                </div>
                <button
                  type="button"
                  className="pulsante"
                  disabled={locked}
                  onClick={() =>
                    add({
                      serviceCode: s.regionalCode,
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
            {lines.map((l, n) => (
              <li key={l.key} className="riga-ricetta">
                <fieldset disabled={locked}>
                  <legend>
                    {n + 1}. {l.drugName ?? l.serviceDescription}
                    {l.aifaNote && <span className="etichetta">Nota {l.aifaNote}</span>}
                  </legend>
                  {mode === 'specialistica' && (l.serviceCode || l.serviceDescription) && (
                    <AlreadyPrescribed
                      patientId={id!}
                      code={l.serviceCode ?? null}
                      description={l.serviceDescription ?? null}
                    />
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
                          onChange={(e) => update(l.key, { byActiveIngredient: e.target.checked })}
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
            ))}
          </ol>

          <fieldset className="dati-ricetta" disabled={locked}>
            <legend>Dati della ricetta</legend>
            {mode === 'specialistica' && (
              <>
                <fieldset className="scelta">
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
                <fieldset className="scelta">
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
                    Lo chiede il paziente: non compaiono sul promemoria né all’erogatore; il codice
                    fiscale resta.
                  </span>
                </label>
              </div>
            )}
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
          </fieldset>
          <ErrorMessage error={error} />
          {!draft && (
            <div className="azioni">
              <button
                type="button"
                className="pulsante pulsante-primario"
                disabled={lines.length === 0}
                onClick={() => void save()}
              >
                <Icon name="ricette" /> <span>Prepara la ricetta</span>
              </button>
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
          {(draft || lines.length > 0) && (
            <div className="azioni">
              <button type="button" className="pulsante" onClick={startOver}>
                <Icon name="ripeti" /> <span>{draft ? 'Nuova ricetta da capo' : 'Ricomincia'}</span>
              </button>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
