import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { ErrorMessage, Loading, Notice, PageHeader } from '../components/common';
import { Icon } from '../components/Icon';
import { PrintHint } from '../components/PrintHint';
import { api, ApiError } from '../lib/api';
import { dateTime } from '../lib/format';
import { useApi } from '../lib/useApi';
import { PatientBanner, type Patient, type Summary } from './RecordPage';

interface Item {
  id: string;
  etichetta: string;
  incluso: boolean;
  manca: string[];
}
type SectionKey =
  | 'allergie'
  | 'terapie'
  | 'problemi'
  | 'anamnesiFamiliare'
  | 'parametri'
  | 'stiliDiVita'
  | 'capacitaMotoria';
interface Content {
  sezioni: Record<SectionKey, Item[]>;
  assenze: Record<'allergie' | 'terapie' | 'problemi' | 'anamnesiFamiliare', string>;
  esclusi: { oscurate: number; riservate: number };
  nonInseribili: { etichetta: string; motivo: string; sezione?: SectionKey }[];
}
interface Problem {
  type: string;
  title: string;
  detail: string;
}
interface Pss {
  id: string;
  stato: 'draft' | 'validated' | 'signed' | 'submitted' | 'published' | 'replaced' | 'discarded';
  statoNome: string;
  versione: number;
  documento: string;
  contenuto?: Content;
  sostituisce: string | null;
  ultimoProblema: Problem | null;
  validatoIl: string | null;
  firmatoIl: string | null;
  inviatoIl: string | null;
  pubblicatoIl: string | null;
  sostituitoIl: string | null;
}
interface Overview {
  versioni: Pss[];
  inLavorazione: Pss | null;
  mancano: string[];
  puoFirmare: boolean;
}

/** Le sezioni del Profilo, nell'ordine del documento; le prime quattro sono obbligatorie. */
const SECTIONS: { key: SectionKey; title: string; mandatory: boolean }[] = [
  { key: 'allergie', title: 'Allergie e intolleranze', mandatory: true },
  { key: 'terapie', title: 'Terapie farmacologiche', mandatory: true },
  {
    key: 'problemi',
    title: 'Patologie croniche, organi mancanti, trapianti, malformazioni',
    mandatory: true,
  },
  { key: 'anamnesiFamiliare', title: 'Anamnesi familiare', mandatory: true },
  { key: 'parametri', title: 'Parametri (facoltativi)', mandatory: false },
  { key: 'stiliDiVita', title: 'Stili di vita (facoltativi)', mandatory: false },
  { key: 'capacitaMotoria', title: 'Capacità motoria', mandatory: false },
];

/** Come si dice un'assenza: «nessuna nota» lo sceglie il medico; per difetto «nessuna informazione». */
const ABSENCES: Record<string, { value: string; label: string }[]> = {
  allergie: [
    { value: 'no-allergy-info', label: 'Nessuna informazione sulle allergie' },
    { value: 'no-known-allergies', label: 'Nessuna allergia nota' },
  ],
  terapie: [
    { value: 'no-medication-info', label: 'Nessuna informazione sulle terapie' },
    { value: 'no-known-medications', label: 'Nessuna terapia nota' },
  ],
  problemi: [
    { value: 'no-problem-info', label: 'Nessuna informazione' },
    { value: 'no-known-problems', label: 'Nessun problema noto' },
  ],
  anamnesiFamiliare: [
    { value: 'no-problem-info', label: 'Nessuna informazione' },
    { value: 'no-known-problems', label: 'Nessuna patologia nota in famiglia' },
  ],
};

/** Che cosa dire dopo la firma o il controllo dello stato: pubblicato, o solo preso in carico. */
const outcome = (p: Pss) =>
  p.stato === 'published'
    ? 'Profilo firmato e pubblicato nel Fascicolo.'
    : 'Profilo firmato e preso in carico dal Gateway: è pubblicato quando i dati arrivano all’indice nazionale (INI).';

/** Minuscola iniziale dentro una frase, ma non sulle sigle («AIC», «ICD-9-CM»). */
const lowerFirst = (s: string) =>
  s.length > 1 && s[1] === s[1]!.toLowerCase() ? s[0]!.toLowerCase() + s.slice(1) : s;

const failure = (e: unknown) =>
  e instanceof ApiError ? e : new ApiError(0, 'Servizio non raggiungibile');

/**
 * Profilo Sanitario Sintetico (tappa 11): il programma propone dalla cartella, il medico sceglie e
 * conferma di aver controllato; poi la validazione del Gateway, la firma e la pubblicazione nel
 * Fascicolo. Le voci oscurate non entrano mai; le riservate non si propongono.
 */
export function HealthProfilePage() {
  const { id } = useParams<{ id: string }>();
  const record = useApi<{ paziente: Patient; riepilogo: Summary | null }>(`/api/pazienti/${id}`);
  const overview = useApi<Overview>(`/api/pazienti/${id}/profilo-sanitario`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  // La casella cambia subito; con la risposta del servizio vale quello che ha salvato, quindi se
  // ha rifiutato torna com'era (come nell'archivio, D84).
  const [picked, setPicked] = useState<Record<string, boolean>>({});
  const [pickedAbsence, setPickedAbsence] = useState<Record<string, string>>({});
  useEffect(() => {
    setPicked({});
    setPickedAbsence({});
  }, [overview.data]);
  if (record.loading && !record.data) return <Loading what="dati della cartella" />;
  if (!record.data) return <ErrorMessage error={record.error} />;
  const p = record.data.paziente;
  const base = `/api/pazienti/${id}/profilo-sanitario`;
  const o = overview.data;
  const open = o?.inLavorazione ?? null;

  async function run<T>(fn: () => Promise<T>, message: string | ((result: T) => string)) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const result = await fn();
      setDone(typeof message === 'string' ? message : message(result));
      setConfirmed(false);
    } catch (e) {
      setError(failure(e));
    } finally {
      setBusy(false);
      overview.reload();
    }
  }
  const choose = (body: object) =>
    run(() => api(`${base}/${open!.id}`, { method: 'PATCH', body }), 'Scelta salvata.');

  return (
    <>
      <PageHeader
        title="Profilo sanitario sintetico"
        trail={
          <>
            <Link to={`/pazienti/${id}`}>
              {p.firstName} {p.lastName}
            </Link>{' '}
            <span aria-hidden="true">/</span> <span>Profilo sanitario sintetico</span>
          </>
        }
      />
      <PatientBanner patient={p} summary={record.data.riepilogo} />
      {overview.loading && !o && <Loading what="dati del Profilo" />}
      <ErrorMessage error={overview.error} />
      {o && o.mancano.length > 0 && (
        <Notice kind="avviso">
          <p>Prima di firmare il Profilo manca:</p>
          <ul>
            {o.mancano.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
          {o.mancano.some((m) => m.startsWith('Medico:')) && o.puoFirmare && (
            <p className="collegamento-solo">
              <Link to="/profilo/recapiti">Apri «Recapiti di studio»</Link>
            </p>
          )}
          {o.mancano.some((m) => m.startsWith('Impostazioni del Fascicolo')) && (
            <p>
              Le impostazioni del Fascicolo le inserisce l’amministratore dello studio, in
              «Strumenti».
            </p>
          )}
        </Notice>
      )}
      {done && <Notice kind="fatto">{done}</Notice>}
      <ErrorMessage error={error} />

      {o && !open && (
        <section className="riquadro" aria-labelledby="titolo-nuovo-profilo">
          <h2 id="titolo-nuovo-profilo">
            {o.versioni.length ? 'Versione nuova' : 'Primo Profilo'}
          </h2>
          <p className="tenue">
            Il programma propone dalla cartella i dati che il Profilo deve contenere; poi controlli
            tu, voce per voce.
          </p>
          {o.puoFirmare ? (
            <button
              type="button"
              className="pulsante"
              disabled={busy}
              onClick={() =>
                void run(
                  () => api(`${base}/bozza`, { method: 'POST' }),
                  'Bozza preparata dalla cartella.',
                )
              }
            >
              <Icon name="aggiungi" /> <span>Prepara il Profilo dalla cartella</span>
            </button>
          ) : (
            <p>Il Profilo lo prepara e lo firma il medico di famiglia del paziente.</p>
          )}
        </section>
      )}

      {open?.contenuto && (
        <section className="riquadro" aria-labelledby="titolo-in-lavorazione">
          <h2 id="titolo-in-lavorazione">
            Versione {open.versione}: {open.statoNome.toLowerCase()}
          </h2>
          {open.ultimoProblema && (
            <Notice kind="errore">
              Gateway: {open.ultimoProblema.title} {open.ultimoProblema.detail}
            </Notice>
          )}
          <Exclusions c={open.contenuto} />
          {SECTIONS.map((s) => (
            <Section
              key={s.key}
              section={s}
              items={open.contenuto!.sezioni[s.key].map((i) =>
                i.id in picked ? { ...i, incluso: picked[i.id]! } : i,
              )}
              absence={
                s.mandatory
                  ? (pickedAbsence[s.key] ??
                    open.contenuto!.assenze[s.key as keyof Content['assenze']])
                  : undefined
              }
              recorded={
                open.contenuto!.sezioni[s.key].length +
                open.contenuto!.nonInseribili.filter((n) => n.sezione === s.key).length
              }
              completeHref={
                s.key === 'terapie'
                  ? (itemId) => `/pazienti/${id}/terapie/${itemId}/modifica`
                  : undefined
              }
              editable={open.stato === 'draft' && o!.puoFirmare && !busy}
              onToggle={(itemId, included) => {
                setPicked((x) => ({ ...x, [itemId]: included }));
                void choose({ scelte: { [s.key]: { [itemId]: included } } });
              }}
              onAbsence={(value) => {
                setPickedAbsence((x) => ({ ...x, [s.key]: value }));
                void choose({ assenze: { [s.key]: value } });
              }}
            />
          ))}
          {open.stato === 'draft' && o!.puoFirmare && (
            <div className="azioni-profilo">
              <div className="casella">
                <input
                  id="conferma-profilo"
                  type="checkbox"
                  // Ferma mentre si salva una scelta: la conferma vale per il contenuto salvato.
                  disabled={busy}
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                />
                <label htmlFor="conferma-profilo">
                  Ho controllato il contenuto del Profilo, voce per voce
                </label>
              </div>
              <button
                type="button"
                className="pulsante"
                disabled={!confirmed || busy}
                onClick={() =>
                  void run(
                    () =>
                      api(`${base}/${open.id}/valida`, {
                        method: 'POST',
                        body: { confermo: true },
                      }),
                    'Validato dal Gateway. Ora puoi firmarlo e pubblicarlo.',
                  )
                }
              >
                <Icon name="fatto" /> <span>Valida con il Gateway</span>
              </button>
              <button
                type="button"
                className="pulsante pulsante-piatto"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => api(`${base}/bozza`, { method: 'POST' }),
                    'Bozza aggiornata dalla cartella.',
                  )
                }
              >
                <Icon name="storico" /> <span>Aggiorna dalla cartella</span>
              </button>
              <button
                type="button"
                className="pulsante pulsante-piatto"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => api(`${base}/${open.id}/scarta`, { method: 'POST' }),
                    'Bozza scartata.',
                  )
                }
              >
                <Icon name="annulla" /> <span>Scarta la bozza</span>
              </button>
            </div>
          )}
          {open.stato === 'submitted' && (
            <div className="azioni-profilo">
              <p>
                Preso in carico dal Gateway il {dateTime(open.inviatoIl)}: è pubblicato quando i
                dati risultano arrivati all’indice nazionale (INI).
              </p>
              {o!.puoFirmare && (
                <button
                  type="button"
                  className="pulsante"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => api<Pss>(`${base}/${open.id}/stato`, { method: 'POST' }),
                      outcome,
                    )
                  }
                >
                  <Icon name="ripeti" /> <span>Controlla lo stato</span>
                </button>
              )}
            </div>
          )}
          {(open.stato === 'validated' || open.stato === 'signed') && o!.puoFirmare && (
            <div className="azioni-profilo">
              <p>
                {open.stato === 'validated'
                  ? `Validato dal Gateway il ${dateTime(open.validatoIl)}: va firmato e pubblicato entro 5 giorni.`
                  : `Firmato il ${dateTime(open.firmatoIl)}: la pubblicazione è da riprovare.`}
              </p>
              <a
                className="pulsante pulsante-piatto"
                href={`${base}/${open.id}/pdf`}
                target="_blank"
                rel="noreferrer"
              >
                <Icon name="apri" /> <span>Apri il PDF</span>
              </a>
              <button
                type="button"
                className="pulsante"
                disabled={busy}
                onClick={() =>
                  void run(
                    () => api<Pss>(`${base}/${open.id}/firma-e-pubblica`, { method: 'POST' }),
                    outcome,
                  )
                }
              >
                <Icon name="firma" />{' '}
                <span>
                  {open.stato === 'validated' ? 'Firma e pubblica' : 'Riprova la pubblicazione'}
                </span>
              </button>
              {open.stato === 'validated' && (
                <button
                  type="button"
                  className="pulsante pulsante-piatto"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => api(`${base}/${open.id}/scarta`, { method: 'POST' }),
                      'Profilo scartato.',
                    )
                  }
                >
                  <Icon name="annulla" /> <span>Scarta</span>
                </button>
              )}
            </div>
          )}
        </section>
      )}

      {o && o.versioni.length > 0 && (
        <section className="riquadro" aria-labelledby="titolo-versioni">
          <h2 id="titolo-versioni">Versioni nel Fascicolo</h2>
          <ul className="voci">
            {o.versioni.map((v) => (
              <li key={v.id} className="voce">
                <p>
                  <strong>Versione {v.versione}</strong> – {v.statoNome}
                  {v.pubblicatoIl && <> il {dateTime(v.pubblicatoIl)}</>}
                  {v.sostituitoIl && <>; sostituita il {dateTime(v.sostituitoIl)}</>}
                </p>
                {/* L'identificativo con il suo nome, non un codice da solo (suggerimento S9, D259). */}
                <p className="tenue">
                  Identificativo nel Fascicolo: <span className="codice">{v.documento}</span>
                </p>
                <a
                  className="pulsante pulsante-piatto"
                  href={`${base}/${v.id}/pdf`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Icon name="stampa" /> <span>PDF firmato della versione {v.versione}</span>
                </a>
              </li>
            ))}
          </ul>
          <PrintHint kind="profilo_sanitario" />
        </section>
      )}
    </>
  );
}

function Exclusions({ c }: { c: Content }) {
  const lines = [
    c.esclusi.oscurate > 0 &&
      `${c.esclusi.oscurate} ${c.esclusi.oscurate === 1 ? 'voce oscurata' : 'voci oscurate'} dal paziente: non entrano mai nel Profilo.`,
    c.esclusi.riservate > 0 &&
      `${c.esclusi.riservate} ${c.esclusi.riservate === 1 ? 'voce riservata' : 'voci riservate'}: non si propongono; se vuoi che entri, togli la riservatezza nella cartella.`,
  ].filter(Boolean) as string[];
  if (!lines.length && !c.nonInseribili.length) return null;
  return (
    <Notice kind="info">
      {lines.map((l) => (
        <p key={l}>{l}</p>
      ))}
      {c.nonInseribili.length > 0 && (
        <>
          <p>Voci che non possono entrare così come sono:</p>
          <ul>
            {c.nonInseribili.map((n) => (
              <li key={`${n.etichetta}-${n.motivo}`}>
                {n.etichetta}: {lowerFirst(n.motivo)}
              </li>
            ))}
          </ul>
        </>
      )}
    </Notice>
  );
}

function Section({
  section,
  items,
  recorded,
  completeHref,
  absence,
  editable,
  onToggle,
  onAbsence,
}: {
  section: { key: SectionKey; title: string; mandatory: boolean };
  items: Item[];
  /** Voci della cartella per la sezione, anche quelle che non possono entrare (D259). */
  recorded: number;
  /** Dove si completano i dati che mancano a una voce: per le terapie, la loro scheda. */
  completeHref?: (itemId: string) => string;
  absence?: string;
  editable: boolean;
  onToggle: (itemId: string, included: boolean) => void;
  onAbsence: (value: string) => void;
}) {
  const anyIncluded = items.some((i) => i.incluso);
  // «Nessuna … nota» solo con la sezione vuota in cartella: altrimenti il Profilo direbbe il
  // falso (audit D259). Resta «Nessuna informazione», che il servizio scrive per difetto.
  const noInfo = ABSENCES[section.key]?.find((a) => !a.value.startsWith('no-known'));
  return (
    <fieldset className="sezione-profilo">
      <legend>{section.title}</legend>
      {items.length === 0 && <p className="tenue">Niente in cartella.</p>}
      {items.map((i) => (
        <div key={i.id}>
          <div className="casella">
            <input
              id={`profilo-${i.id}`}
              type="checkbox"
              checked={i.incluso}
              disabled={!editable || i.manca.length > 0}
              aria-describedby={i.manca.length ? `manca-${i.id}` : undefined}
              onChange={(e) => onToggle(i.id, e.target.checked)}
            />
            <label htmlFor={`profilo-${i.id}`}>{i.etichetta}</label>
          </div>
          {i.manca.length > 0 && (
            <p id={`manca-${i.id}`} className="manca-voce">
              <Icon name="avviso" />{' '}
              <span>Non può entrare: {i.manca.map(lowerFirst).join('; ')}.</span>
              {completeHref && (
                <>
                  {' '}
                  <Link to={completeHref(i.id)}>Completa la scheda di {i.etichetta}</Link>
                </>
              )}
            </p>
          )}
        </div>
      ))}
      {section.mandatory && !anyIncluded && absence && recorded > 0 && noInfo && (
        <p className="tenue">
          Nessuna voce inclusa: nel Profilo si scrive «{noInfo.label}». «Nessuna … nota» non si può
          scrivere, perché in cartella ci sono voci: includile o completa i dati che mancano.
        </p>
      )}
      {section.mandatory && !anyIncluded && absence && recorded === 0 && (
        <fieldset className="scelta-in-riga">
          <legend>Sezione obbligatoria senza voci: nel Profilo si scrive</legend>
          {ABSENCES[section.key]!.map((a) => (
            <div key={a.value} className="casella">
              <input
                id={`assenza-${section.key}-${a.value}`}
                type="radio"
                name={`assenza-${section.key}`}
                checked={absence === a.value}
                disabled={!editable}
                onChange={() => onAbsence(a.value)}
              />
              <label htmlFor={`assenza-${section.key}-${a.value}`}>{a.label}</label>
            </div>
          ))}
        </fieldset>
      )}
    </fieldset>
  );
}
