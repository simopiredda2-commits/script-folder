import { useEffect } from 'react';
import { ErrorMessage, Loading, Notice } from '../components/common';
import { Icon } from '../components/Icon';
import { dateTime } from '../lib/format';
import { useApi } from '../lib/useApi';

type Outcome = 'in_corso' | 'ok' | 'da_verificare' | 'errore' | 'interrotto';

interface RunSummary {
  id: string;
  avvio: 'comando' | 'automatico' | 'pulsante';
  chi: string;
  iniziato: string;
  finito: string | null;
  esito: Outcome | null;
  messaggio: string | null;
  fonti: string[];
  conteggi: {
    invariati: number;
    nuovi: number;
    daVerificare: number;
    errori: number;
    importati: number;
  } | null;
}

interface Issue {
  level: 'errore' | 'da_verificare';
  source: string;
  file: string;
  what: string;
  notes: string[];
}

interface UpdatesStatus {
  configurato: boolean;
  automatico: { ora: string; prossimo: string | null } | null;
  nomiFonti: Record<string, string>;
  inCorso: RunSummary | null;
  ultimo: (RunSummary & { daControllare: Issue[] }) | null;
  giri: RunSummary[];
}

const TRIGGER: Record<RunSummary['avvio'], string> = {
  comando: 'Comando sul server',
  automatico: 'Automatico, di notte',
  pulsante: 'Pulsante «Aggiorna adesso»',
};

const OUTCOME: Record<Outcome, { label: string; kind: 'fatto' | 'avviso' | 'errore' | 'info' }> = {
  in_corso: { label: 'In corso', kind: 'info' },
  ok: { label: 'Tutto a posto', kind: 'fatto' },
  da_verificare: { label: 'Da verificare', kind: 'avviso' },
  errore: { label: 'Errore', kind: 'errore' },
  interrotto: { label: 'Interrotto', kind: 'avviso' },
};

const ICON = { fatto: 'fatto', avviso: 'avviso', errore: 'blocco', info: 'info' } as const;

/** Che cosa vuol dire l'esito per chi usa le banche dati. */
const MEANING: Record<Exclude<Outcome, 'in_corso'>, string> = {
  ok: 'Le fonti sono state controllate; le versioni nuove che hanno superato i controlli sono in uso.',
  da_verificare:
    'Alcune versioni nuove aspettano una persona (controllo o trascrizione). Fino ad allora resta in uso la versione precedente.',
  errore:
    'Qualche fonte non è stata controllata o qualche file non è entrato in uso. Per quelle banche dati resta in uso la versione precedente.',
  interrotto:
    'L’aggiornamento si è fermato prima della fine. Resta in uso la versione precedente; il prossimo aggiornamento riprende da capo.',
};

function OutcomeText({ esito }: { esito: Outcome | null }) {
  const o = OUTCOME[esito ?? 'errore'];
  return (
    <span className={`esito-aggiornamento esito-${o.kind}`}>
      <Icon name={ICON[o.kind]} /> {o.label}
    </span>
  );
}

function counts(r: RunSummary) {
  const c = r.conteggi;
  if (!c) return null;
  const checked = c.invariati + c.nuovi + c.daVerificare + c.errori;
  return `File controllati: ${checked} (invariati ${c.invariati}, nuovi o aggiornati ${c.nuovi}, da verificare ${c.daVerificare}, non scaricati ${c.errori}). Versioni nuove in uso: ${c.importati}.`;
}

/**
 * Aggiornamento delle banche dati (D156): quando parte, com'è andato l'ultimo, che cosa va
 * controllato a mano. Le banche dati sono comuni a tutti gli studi del servizio: le aggiorna chi
 * gestisce il servizio, ogni notte e con il comando sul server; lo studio vede lo stato (D192).
 */
export function DataUpdatesSection() {
  const status = useApi<UpdatesStatus>('/api/banche-dati/aggiornamenti');
  const running = status.data?.inCorso ?? null;
  const { reload } = status;

  // Mentre un aggiornamento gira, la pagina lo segue.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(reload, 2000);
    return () => clearInterval(t);
  }, [running, reload]);

  if (status.loading && !status.data) return <Loading what="aggiornamenti delle banche dati" />;
  if (!status.data) return <ErrorMessage error={status.error} />;
  const s = status.data;
  const sourceName = (id: string) => s.nomiFonti[id] ?? id;

  return (
    <section aria-labelledby="titolo-aggiornamenti">
      <h2 id="titolo-aggiornamenti">Aggiornamento delle banche dati</h2>
      <p>
        Farmaci AIFA, catalogo regionale delle prestazioni, esenzioni, farmaci in distribuzione per
        conto e comuni vengono dalle fonti ufficiali. A ogni aggiornamento il programma controlla le
        fonti e scarica solo ciò che è cambiato. Una versione nuova entra in uso solo se supera i
        controlli; altrimenti resta in uso la precedente. I documenti in PDF si scaricano e si
        segnalano: i loro dati entrano solo dopo una trascrizione controllata.
      </p>
      <p>
        Le banche dati sono le stesse per tutti gli studi del servizio: le aggiorna chi gestisce il
        servizio, e lo studio non deve fare nulla.
      </p>
      {!s.configurato ? (
        <Notice kind="info">
          In questa installazione le banche dati non si aggiornano dal programma: le aggiorna chi
          gestisce il server.
        </Notice>
      ) : s.automatico ? (
        <p>
          <strong>Aggiornamento automatico: ogni notte alle {s.automatico.ora}.</strong>
          {s.automatico.prossimo && <> Prossimo: {dateTime(s.automatico.prossimo)}.</>}
        </p>
      ) : (
        <p>
          <strong>Aggiornamento automatico non attivo</strong>: le banche dati le aggiorna chi
          gestisce il servizio, con il comando sul server.
        </p>
      )}
      {running && (
        <Notice kind="info">
          Aggiornamento in corso dal {dateTime(running.iniziato)} ({TRIGGER[running.avvio]}). La
          pagina si aggiorna da sola.
        </Notice>
      )}

      <h3>Ultimo aggiornamento</h3>
      {!s.ultimo ? (
        <p className="tenue">Nessun aggiornamento registrato.</p>
      ) : (
        <>
          <p>
            {dateTime(s.ultimo.iniziato)} · {TRIGGER[s.ultimo.avvio]} ({s.ultimo.chi}) ·{' '}
            <OutcomeText esito={s.ultimo.esito} />
          </p>
          {s.ultimo.esito && s.ultimo.esito !== 'in_corso' && <p>{MEANING[s.ultimo.esito]}</p>}
          {counts(s.ultimo) && <p className="tenue">{counts(s.ultimo)}</p>}
          {s.ultimo.messaggio && <p>{s.ultimo.messaggio}</p>}
          {s.ultimo.daControllare.length > 0 && (
            <>
              <h4>Da controllare</h4>
              <p className="tenue">Questi controlli li segue chi gestisce il servizio.</p>
              <ul className="da-controllare">
                {s.ultimo.daControllare.map((i, n) => (
                  <li key={n}>
                    <span
                      className={`esito-aggiornamento esito-${i.level === 'errore' ? 'errore' : 'avviso'}`}
                    >
                      <Icon name={i.level === 'errore' ? 'blocco' : 'avviso'} />{' '}
                      {i.level === 'errore' ? 'Errore' : 'Da verificare'}
                    </span>{' '}
                    {i.source ? `${sourceName(i.source)} · ` : ''}
                    <span className="codice">{i.file}</span>: {i.what}
                    {i.notes.length > 0 && (
                      <ul>
                        {i.notes.map((note, k) => (
                          <li key={k}>{note}</li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      {s.giri.length > 0 && (
        <table className="tabella">
          <caption>Aggiornamenti recenti</caption>
          <thead>
            <tr>
              <th scope="col">Inizio</th>
              <th scope="col">Avvio</th>
              <th scope="col">Esito</th>
              <th scope="col">Versioni nuove in uso</th>
            </tr>
          </thead>
          <tbody>
            {s.giri.map((r) => (
              <tr key={r.id}>
                <td>{dateTime(r.iniziato)}</td>
                <td>{TRIGGER[r.avvio]}</td>
                <td>
                  <OutcomeText esito={r.esito} />
                </td>
                <td className="numero">{r.conteggi?.importati ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
