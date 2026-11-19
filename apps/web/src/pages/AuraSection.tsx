import { useState } from 'react';
import { Link } from 'react-router';
import { ErrorMessage, Loading, Notice } from '../components/common';
import { Icon } from '../components/Icon';
import { api, type ApiError } from '../lib/api';
import { dateTime, plural } from '../lib/format';
import { useApi } from '../lib/useApi';
import { failure } from './NewPatientPage';

/** Com'è andato l'ultimo controllo su AURA (D197). */
export type AuraOutcome =
  'aggiornato' | 'non_trovato' | 'ambiguo' | 'non_raggiungibile' | 'rifiutato' | 'spento';

export interface AuraChange {
  quando: string;
  tipo: 'esenzione' | 'scelta';
  variazione: 'nuova' | 'cambiata' | 'tolta';
  descrizione: string;
  avvio?: 'notte' | 'notifica' | 'manuale' | 'ricetta';
}

interface AuraState {
  disponibile: boolean;
  ambiente: 'simulator' | 'test' | 'production';
  idAura: string | null;
  controllatoIl: string | null;
  esito: AuraOutcome | null;
  messaggio: string | null;
  aggiornatoIl: string | null;
  variazioni: AuraChange[];
}

/** Ogni esito con un simbolo e una parola, non solo con il colore. */
const OUTCOME: Record<AuraOutcome, { text: string; kind: 'fatto' | 'avviso' | 'errore' | 'info' }> =
  {
    aggiornato: { text: 'Allineato con AURA', kind: 'fatto' },
    non_trovato: { text: 'Non trovato in AURA', kind: 'avviso' },
    ambiguo: { text: 'Più assistiti in AURA con lo stesso codice fiscale', kind: 'avviso' },
    non_raggiungibile: { text: 'AURA non raggiungibile', kind: 'avviso' },
    rifiutato: { text: 'Risposta di AURA non accettata', kind: 'errore' },
    spento: { text: 'AURA non collegata', kind: 'info' },
  };

export const CHANGE_LABEL: Record<AuraChange['variazione'], string> = {
  nuova: 'Nuova',
  cambiata: 'Cambiata',
  tolta: 'Tolta',
};

const KIND_LABEL: Record<AuraChange['tipo'], string> = {
  esenzione: 'Esenzione',
  scelta: 'Scelta del medico',
};

const TRIGGER_LABEL: Record<NonNullable<AuraChange['avvio']>, string> = {
  notte: 'controllo di ogni notte',
  notifica: 'notifica di AURA',
  manuale: 'aggiornamento dal pannello',
  ricetta: 'prima di una ricetta',
};

const UNAVAILABLE =
  'AURA non è ancora collegata al servizio vero: esenzioni e scelte si inseriscono a mano.';

/**
 * AURA, l'anagrafe regionale degli assistiti (D197): com'è andato l'ultimo controllo, il pulsante
 * «Aggiorna da AURA» per chi scrive nell'archivio, le ultime variazioni arrivate.
 */
export function AuraSection({
  patientId,
  canWrite,
  onUpdated,
}: {
  patientId: string;
  canWrite: boolean;
  /** Esenzioni o scelte cambiate: il pannello e la testata si ricaricano. */
  onUpdated: () => void;
}) {
  const st = useApi<AuraState>(`/api/pazienti/${patientId}/aura`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<{
    text: string;
    kind: 'fatto' | 'avviso' | 'errore' | 'info';
  } | null>(null);

  async function update() {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const r = await api<{ esito: AuraOutcome; messaggio: string | null; variazioni: number }>(
        `/api/pazienti/${patientId}/aura`,
        { method: 'POST' },
      );
      const o = OUTCOME[r.esito];
      setDone(
        r.esito === 'aggiornato'
          ? {
              kind: 'fatto',
              text: r.variazioni
                ? `Aggiornato da AURA: ${plural(r.variazioni, 'variazione', 'variazioni')}.`
                : 'Aggiornato da AURA: nessuna variazione.',
            }
          : { kind: o.kind, text: `${o.text}${r.messaggio ? `: ${r.messaggio}` : ''}.` },
      );
      st.reload();
      if (r.variazioni) onUpdated();
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  }

  const s = st.data;
  return (
    <section className="riquadro" id="aura" aria-labelledby="titolo-aura">
      <h2 id="titolo-aura">
        <Icon name="ripeti" /> AURA, anagrafe regionale
      </h2>
      <p className="aiuto">
        Esenzioni e scelte del medico arrivano da AURA: a ogni variazione, ogni notte e prima di una
        ricetta con esenzione. Quelle arrivate da AURA non si modificano qui; quelle inserite a mano
        restano come sono.
      </p>
      {st.loading && !s && <Loading what="stato di AURA" />}
      <ErrorMessage error={st.error} />
      {s && (
        <>
          {!s.disponibile && <Notice kind="info">{UNAVAILABLE}</Notice>}
          {s.disponibile && s.ambiente === 'simulator' && (
            <Notice kind="info">
              Collegamento simulato: i dati arrivano dal simulatore di AURA, con assistiti
              inventati.
            </Notice>
          )}
          <dl className="dati">
            <dt>Stato</dt>
            <dd>
              {s.esito ? (
                <span className={`etichetta etichetta-${OUTCOME[s.esito].kind}`}>
                  <Icon name={OUTCOME[s.esito].kind === 'fatto' ? 'fatto' : 'avviso'} size={16} />{' '}
                  {OUTCOME[s.esito].text}
                </span>
              ) : (
                'Mai controllato'
              )}
            </dd>
            {s.messaggio && (
              <>
                <dt>Motivo</dt>
                <dd>{s.messaggio}</dd>
              </>
            )}
            <dt>Identificativo AURA</dt>
            <dd className="codice">{s.idAura ?? '—'}</dd>
            <dt>Ultimo controllo</dt>
            <dd>{s.controllatoIl ? dateTime(s.controllatoIl) : '—'}</dd>
            <dt>Allineato l’ultima volta</dt>
            <dd>{s.aggiornatoIl ? dateTime(s.aggiornatoIl) : '—'}</dd>
          </dl>
          {canWrite && s.disponibile && (
            <button
              type="button"
              className="pulsante"
              disabled={busy}
              onClick={() => void update()}
            >
              <Icon name="ripeti" />{' '}
              <span>{busy ? 'Controllo in corso…' : 'Aggiorna da AURA'}</span>
            </button>
          )}
          {done && <Notice kind={done.kind}>{done.text}</Notice>}
          <ErrorMessage error={error} />
          <h3>Ultime variazioni da AURA</h3>
          {s.variazioni.length === 0 ? (
            <p className="tenue">Nessuna variazione arrivata da AURA.</p>
          ) : (
            <div className="tabella-scorrevole">
              <table className="tabella">
                <caption>Ultime variazioni arrivate da AURA</caption>
                <thead>
                  <tr>
                    <th scope="col">Quando</th>
                    <th scope="col">Che cosa</th>
                    <th scope="col">Variazione</th>
                    <th scope="col">Che cosa dice AURA</th>
                  </tr>
                </thead>
                <tbody>
                  {s.variazioni.map((v) => (
                    <tr key={`${v.quando}-${v.descrizione}`}>
                      <td>
                        {dateTime(v.quando)}
                        {v.avvio && <span className="tenue"> ({TRIGGER_LABEL[v.avvio]})</span>}
                      </td>
                      <td>{KIND_LABEL[v.tipo]}</td>
                      <td>{CHANGE_LABEL[v.variazione]}</td>
                      <th scope="row">{v.descrizione}</th>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

interface StudioChanges {
  disponibile: boolean;
  giorni: number;
  variazioni: (AuraChange & { paziente: { id: string; cognome: string; nome: string } })[];
}

/**
 * Pagina Oggi: le variazioni arrivate da AURA negli ultimi giorni, dei pazienti che l'utente vede.
 * Senza variazioni non si mostra.
 */
export function AuraChangesToday() {
  const r = useApi<StudioChanges>('/api/aura/variazioni?giorni=7');
  // Una risposta inattesa non deve far cadere la pagina Oggi.
  const list = Array.isArray(r.data?.variazioni) ? r.data.variazioni : [];
  if (list.length === 0) return null;
  return (
    <section aria-labelledby="titolo-aura-oggi" className="riquadro">
      <h2 id="titolo-aura-oggi">
        <Icon name="ripeti" /> Variazioni da AURA
      </h2>
      <p className="tenue">
        Esenzioni e scelte cambiate nell’anagrafe regionale negli ultimi{' '}
        {plural(r.data?.giorni ?? 7, 'giorno', 'giorni')}.
      </p>
      <ul className="elenco-semplice">
        {list.map((v) => (
          <li key={`${v.quando}-${v.paziente.id}-${v.descrizione}`}>
            <Link to={`/pazienti/${v.paziente.id}/amministrazione#aura`}>
              {v.paziente.nome} {v.paziente.cognome}
            </Link>
            : {CHANGE_LABEL[v.variazione].toLowerCase()} – {v.descrizione}
            <span className="tenue"> ({dateTime(v.quando)})</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
