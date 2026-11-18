import { Link, useParams, useSearchParams } from 'react-router';
import { ErrorMessage, Loading, PageHeader, type RuleIssue } from '../components/common';
import { Icon } from '../components/Icon';
import { query } from '../lib/api';
import {
  ACCESS_TYPE,
  date,
  dateTime,
  PRESCRIPTION_KIND,
  PRESCRIPTION_STATUS,
  PRIORITY,
  THERAPY_KIND,
} from '../lib/format';
import { useApi } from '../lib/useApi';
import { PatientBanner, posology, type Patient, type TherapyRow } from './RecordPage';

interface HistoryEntry {
  ricetta: {
    id: string;
    tipo: string;
    stato: string;
    nre: string | null;
    preparataIl: string;
    preparataDa: string | null;
    firmataIl: string | null;
    firmataDa: string | null;
    inviataIl: string | null;
    cartaceaIl: string | null;
    esenzione: string | null;
    priorita: string | null;
    accesso: string | null;
    quesito: string | null;
    annullataIl: string | null;
    motivoAnnullamento: string | null;
    errore: string | null;
  };
  riga: {
    farmaco: string | null;
    principioAttivo: string | null;
    aic: string | null;
    prestazione: string | null;
    codicePrestazione: string | null;
    quantita: number;
    posologia: string | null;
    notaAifa: string | null;
    perPrincipioAttivo: boolean;
    nonSostituibile: boolean;
    motivoNonSostituibile: string | null;
  };
  controlli: {
    il: string;
    esito: string;
    versioneRegole: string;
    problemi: RuleIssue[];
    motivi: Record<string, string>;
  }[];
}

interface History {
  ultimi12Mesi: number;
  voci: HistoryEntry[];
}

const OUTCOME: Record<string, string> = { superato: 'superato', bloccato: 'bloccato' };

/** Tabella dello storico: una riga per ogni ricetta che contiene il farmaco o la prestazione. */
function HistoryTable({ history, kind }: { history: History; kind: 'farmaco' | 'prestazione' }) {
  if (history.voci.length === 0) return <p className="tenue">Nessuna prescrizione finora.</p>;
  return (
    <div className="tabella-scorrevole">
      <table className="tabella">
        <caption className="visivamente-nascosto">Storico delle prescrizioni</caption>
        <thead>
          <tr>
            <th scope="col">Data</th>
            <th scope="col">Ricetta</th>
            <th scope="col">{kind === 'farmaco' ? 'Confezioni' : 'Quantità'}</th>
            <th scope="col">Dettagli</th>
            <th scope="col">Chi</th>
            <th scope="col">Controlli</th>
          </tr>
        </thead>
        <tbody>
          {history.voci.map(({ ricetta: r, riga: l, controlli }) => (
            <tr key={`${r.id}-${l.farmaco ?? l.prestazione}`}>
              <td>{date(r.inviataIl ?? r.cartaceaIl ?? r.preparataIl)}</td>
              <td>
                <span className="etichetta">{PRESCRIPTION_STATUS[r.stato] ?? r.stato}</span>
                <div>{PRESCRIPTION_KIND[r.tipo] ?? r.tipo}</div>
                {r.nre && <div className="codice">NRE {r.nre}</div>}
                {r.annullataIl && (
                  <div>
                    Annullata il {date(r.annullataIl)}: {r.motivoAnnullamento}
                  </div>
                )}
                {r.errore && <div>Errore: {r.errore}</div>}
              </td>
              <td className="numero">{l.quantita}</td>
              <td>
                <div>{l.farmaco ?? l.prestazione}</div>
                {l.codicePrestazione && <div className="codice">{l.codicePrestazione}</div>}
                {l.aic && <div className="codice">AIC {l.aic}</div>}
                {l.posologia && <div>{l.posologia}</div>}
                {l.notaAifa && <div>Nota AIFA {l.notaAifa}</div>}
                {l.perPrincipioAttivo && <div>Per principio attivo</div>}
                {l.nonSostituibile && <div>Non sostituibile: {l.motivoNonSostituibile}</div>}
                {r.esenzione && <div>Esenzione {r.esenzione}</div>}
                {r.accesso && <div>{ACCESS_TYPE[r.accesso]}</div>}
                {r.priorita && <div>Priorità {PRIORITY[r.priorita]}</div>}
                {r.quesito && <div>Quesito: {r.quesito}</div>}
              </td>
              <td>
                <div>Preparata da {r.preparataDa}</div>
                {r.firmataDa && (
                  <div>
                    Firmata da {r.firmataDa}
                    {r.firmataIl && `, ${dateTime(r.firmataIl)}`}
                  </div>
                )}
              </td>
              <td>
                {controlli.length === 0 && <span className="tenue">nessuno</span>}
                {controlli.map((c) => (
                  <div key={c.il}>
                    {dateTime(c.il)}: {OUTCOME[c.esito] ?? c.esito}
                    {Object.entries(c.motivi).map(([rule, why]) => (
                      <div key={rule} className="tenue">
                        {rule}: {why}
                      </div>
                    ))}
                    {c.problemi
                      .filter((p) => p.severity !== 'info')
                      .map((p, i) => (
                        <div key={i} className="tenue">
                          {p.ruleId}: {p.message}
                        </div>
                      ))}
                  </div>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface TherapyFull extends TherapyRow {
  atc: string | null;
  drugClass: string | null;
  dpc: boolean;
  route: string | null;
  startOn: string;
  endOn: string | null;
  packsPerPrescription: number;
  habitualExemptionCode: string | null;
  suggestedByName: string | null;
  suggestedByFacility: string | null;
  patientInstructions: string | null;
  notReimbursable: boolean;
  byActiveIngredient: boolean;
  notSubstitutable: boolean;
  notSubstitutableReason: string | null;
  multiPrescription: boolean;
  suggestedS: boolean;
  hospitalH: boolean;
}

/** Interruttore della scheda in sola lettura: nome e una riga di spiegazione, non un'icona. */
function Option({ on, name, explanation }: { on: boolean; name: string; explanation: string }) {
  return (
    <li className="opzione">
      <span className={`opzione-stato ${on ? 'acceso' : 'spento'}`}>{on ? 'Sì' : 'No'}</span>
      <span>
        <strong>{name}</strong>
        <span className="tenue"> · {explanation}</span>
      </span>
    </li>
  );
}

/** Scheda della terapia in tre parti, con lo storico delle prescrizioni (D65). */
export function TherapyPage() {
  const { id, therapyId } = useParams<{ id: string; therapyId: string }>();
  const record = useApi<{ paziente: Patient }>(`/api/pazienti/${id}`);
  const therapies = useApi<{ terapie: TherapyFull[] }>(`/api/pazienti/${id}/terapie`);
  const history = useApi<History>(
    `/api/pazienti/${id}/storico-prescrizioni${query({ terapia: therapyId })}`,
  );
  const t = therapies.data?.terapie.find((x) => x.id === therapyId);

  if ((record.loading || therapies.loading) && !t) return <Loading what="dati della terapia" />;
  if (!record.data || !t) return <ErrorMessage error={record.error ?? therapies.error} />;
  const p = record.data.paziente;

  return (
    <>
      <PageHeader
        title={t.drugName}
        trail={
          <>
            <Link to={`/pazienti/${id}`}>
              {p.firstName} {p.lastName}
            </Link>{' '}
            <span aria-hidden="true">/</span> <span>Scheda della terapia</span>
          </>
        }
      />
      <PatientBanner patient={p} />
      <div className="griglia-cartella">
        <section className="riquadro" aria-labelledby="titolo-farmaco">
          <h2 id="titolo-farmaco">Il farmaco</h2>
          <dl className="dati">
            <dt>Principio attivo</dt>
            <dd>{t.activeIngredient ?? '—'}</dd>
            <dt>AIC</dt>
            <dd className="codice">{t.drugAic ?? '—'}</dd>
            <dt>ATC</dt>
            <dd className="codice">{t.atc ?? '—'}</dd>
            <dt>Classe</dt>
            <dd>{t.drugClass ?? '—'}</dd>
            <dt>Distribuzione per conto</dt>
            <dd>{t.dpc ? 'Sì' : 'No'}</dd>
          </dl>
          <h2>Come si prende</h2>
          <dl className="dati">
            <dt>Posologia</dt>
            <dd>{posology(t) || '—'}</dd>
            <dt>Tipo di terapia</dt>
            <dd>{THERAPY_KIND[t.kind]}</dd>
            <dt>Dal</dt>
            <dd>
              {date(t.startOn)}
              {t.endOn ? ` al ${date(t.endOn)}` : ''}
            </dd>
            <dt>Istruzioni per il paziente</dt>
            <dd>{t.patientInstructions ?? '—'}</dd>
          </dl>
        </section>
        <section className="riquadro" aria-labelledby="titolo-in-ricetta">
          <h2 id="titolo-in-ricetta">Come va in ricetta</h2>
          <dl className="dati">
            <dt>Confezioni per ricetta</dt>
            <dd>{t.packsPerPrescription}</dd>
            <dt>Esenzione abituale</dt>
            <dd>{t.habitualExemptionCode ?? 'Nessuna'}</dd>
            <dt>Nota AIFA</dt>
            <dd>{t.aifaNote ? `${t.aifaNote}: da confermare a ogni ricetta (R7)` : 'Nessuna'}</dd>
            <dt>Medico suggeritore</dt>
            <dd>{[t.suggestedByName, t.suggestedByFacility].filter(Boolean).join(', ') || '—'}</dd>
          </dl>
          <ul className="opzioni">
            <Option
              on={t.important}
              name="Importante"
              explanation="sempre visibile nella testata della cartella"
            />
            <Option on={t.reserved} name="Riservata" explanation="visibile solo al medico" />
            <Option
              on={t.kind === 'chronic'}
              name="Cronica"
              explanation="attiva il contatore e la ripetizione rapida (R11)"
            />
            <Option
              on={t.notReimbursable}
              name="Non rimborsabile SSN"
              explanation="solo su ricetta bianca (R8)"
            />
            <Option
              on={t.byActiveIngredient}
              name="Per principio attivo"
              explanation="in ricetta va il principio attivo: il farmacista può dare un equivalente"
            />
            <Option
              on={t.notSubstitutable}
              name="Non sostituibile"
              explanation={
                t.notSubstitutable && t.notSubstitutableReason
                  ? `motivo: ${t.notSubstitutableReason}`
                  : 'vincola il farmacista; serve una sintetica motivazione (R13)'
              }
            />
            <Option
              on={t.multiPrescription}
              name="Multiprescrizione"
              explanation="fino a 6 confezioni, solo con le condizioni di R3 o R4"
            />
            <Option
              on={t.suggestedS}
              name="Suggerita (S)"
              explanation="tipologia S: servono i dati del medico suggeritore"
            />
            <Option on={t.hospitalH} name="Ricovero (H)" explanation="tipologia H sulla ricetta" />
          </ul>
        </section>
      </div>
      <section className="riquadro" aria-labelledby="titolo-storico">
        <h2 id="titolo-storico">
          <Icon name="storico" /> Storico delle prescrizioni
        </h2>
        <ErrorMessage error={history.error} />
        {history.loading && !history.data && <Loading what="prescrizioni" />}
        {history.data && (
          <>
            <p>
              Confezioni prescritte negli ultimi 12 mesi:{' '}
              <strong>{history.data.ultimi12Mesi}</strong>
            </p>
            <HistoryTable history={history.data} kind="farmaco" />
          </>
        )}
      </section>
    </>
  );
}

/** Storico di una prestazione (D66), per codice regionale o per descrizione. */
export function ServiceHistoryPage() {
  const { id } = useParams<{ id: string }>();
  const [params] = useSearchParams();
  const code = params.get('prestazione');
  const description = params.get('descrizione');
  const record = useApi<{ paziente: Patient }>(`/api/pazienti/${id}`);
  const history = useApi<History>(
    `/api/pazienti/${id}/storico-prescrizioni${query({ prestazione: code, descrizione: description })}`,
  );
  const title = history.data?.voci[0]?.riga.prestazione ?? description ?? code ?? 'Prestazione';
  if (record.loading && !record.data) return <Loading what="dati della cartella" />;
  if (!record.data) return <ErrorMessage error={record.error} />;
  const p = record.data.paziente;
  return (
    <>
      <PageHeader
        title={title}
        trail={
          <>
            <Link to={`/pazienti/${id}`}>
              {p.firstName} {p.lastName}
            </Link>{' '}
            <span aria-hidden="true">/</span> <span>Storico della prestazione</span>
          </>
        }
      />
      <PatientBanner patient={p} />
      <section className="riquadro" aria-labelledby="titolo-storico-prestazione">
        <h2 id="titolo-storico-prestazione">
          <Icon name="storico" /> Storico delle prescrizioni
        </h2>
        {code && <p className="codice">Codice {code}</p>}
        <ErrorMessage error={history.error} />
        {history.data && (
          <>
            <p>
              Prescritta negli ultimi 12 mesi: <strong>{history.data.ultimi12Mesi}</strong>
            </p>
            <HistoryTable history={history.data} kind="prestazione" />
          </>
        )}
      </section>
    </>
  );
}
