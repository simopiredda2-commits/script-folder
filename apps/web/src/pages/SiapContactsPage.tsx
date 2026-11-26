import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ErrorMessage, Loading, Notice, PageHeader, ResultNotice } from '../components/common';
import { Icon } from '../components/Icon';
import { api, ApiError } from '../lib/api';
import { date, studioToday } from '../lib/format';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';

/** Un'attività del contatto: tipologia e dettaglio dell'allegato 2 del Ministero, quantità. */
export interface Service {
  tipologia: number;
  dettaglio: number;
  quantita: number;
}

type Status = 'proposto' | 'confermato' | 'da_aggiornare' | 'scartato';

export interface ContactView {
  id: string | null;
  paziente: { id: string; cognome: string; nome: string; codiceFiscale: string };
  giorno: string;
  stato: Status;
  atti: { tipo: string; id: string; descrizione: string; nuovo: boolean }[];
  attiTolti: number;
  proposta: {
    modalita: string;
    regime: string;
    accesso: string;
    problema: string;
    statoProblema: string;
    prestazioni: Service[];
  };
  aggiornamento: Service[] | null;
  contatto: null | {
    progressivo: number | null;
    struttura: { codice: string | null; tipo: string | null };
    modalita: string | null;
    regime: string | null;
    accesso: string | null;
    problema: {
      codice: string | null;
      stato: string | null;
      apertoIl: string | null;
      voce: string | null;
    };
    prestazioni: Service[];
    motivoScarto: string | null;
    decisoIl: string;
  };
}

interface Value {
  chiave: string;
  codice: number;
  descrizione: string;
}

export interface Listing {
  dal: string;
  al: string;
  struttura: { codice: string | null; tipo: string | null };
  contatti: ContactView[];
  problemi: Record<
    string,
    {
      voce: string;
      codice: string;
      descrizione: string;
      cronico: boolean;
      quesito: boolean;
      inizio: string;
    }[]
  >;
  tipologie: {
    codice: number;
    descrizione: string;
    dettagli: { codice: number; descrizione: string }[];
  }[];
  modalita: Value[];
  accessi: Value[];
  statiProblema: Value[];
}

interface Choice {
  modalita: string;
  accesso: string;
  problema: string | null;
  prestazioni: Service[];
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

const STATUS_LABEL: Record<Status, string> = {
  proposto: 'Proposto',
  confermato: 'Confermato',
  da_aggiornare: 'Da aggiornare',
  scartato: 'Scartato',
};
/** Colore e parola insieme (D69): il colore accompagna, non sostituisce. */
const STATUS_CLASS: Record<Status, string> = {
  proposto: 'stato stato-draft',
  confermato: 'stato stato-sent',
  da_aggiornare: 'stato stato-draft',
  scartato: 'stato',
};

const describe = (values: Value[], key: string | null) =>
  values.find((v) => v.chiave === key)?.descrizione ?? 'Non noto';

/** Le scelte da cui parte il modulo: quelle del contatto, o la proposta degli atti. */
function startingChoice(c: ContactView, mode: 'conferma' | 'modifica' | 'aggiorna'): Choice {
  if (mode === 'conferma' || !c.contatto)
    return {
      modalita: c.proposta.modalita,
      accesso: c.proposta.accesso,
      problema: c.contatto?.problema.voce ?? null,
      prestazioni: c.proposta.prestazioni,
    };
  return {
    modalita: c.contatto.modalita ?? c.proposta.modalita,
    accesso: c.contatto.accesso ?? c.proposta.accesso,
    problema: c.contatto.problema.voce,
    prestazioni: mode === 'aggiorna' && c.aggiornamento ? c.aggiornamento : c.contatto.prestazioni,
  };
}

/**
 * Contatti per il SIAP (D291): il programma propone un contatto per paziente e giorno dagli atti
 * del medico; il medico lo conferma, lo cambia o lo scarta. Solo i medici, ognuno per gli atti
 * suoi; la segreteria no (regola 5). Il periodo sta nell'indirizzo.
 */
export function SiapContactsPage() {
  const { state } = useSession();
  const ownsArchive = state.status === 'ready' && !!state.me.archivio;
  const [params, setParams] = useSearchParams();
  const today = studioToday();
  const dal = ISO.test(params.get('dal') ?? '') ? params.get('dal')! : today;
  const al = ISO.test(params.get('al') ?? '') ? params.get('al')! : today;
  const [from, setFrom] = useState(dal);
  const [to, setTo] = useState(al);
  const r = useApi<Listing>(`/api/siap/contatti?dal=${dal}&al=${al}`);
  const [done, setDone] = useState<string | null>(null);

  function show(e: FormEvent) {
    e.preventDefault();
    setDone(null);
    setParams({ dal: from, al: to }, { replace: true });
  }

  const data = r.data;
  const days = data ? [...new Set(data.contatti.map((c) => c.giorno))] : [];
  const count = (s: Status) => data?.contatti.filter((c) => c.stato === s).length ?? 0;
  return (
    <>
      <PageHeader
        title="Contatti per il SIAP"
        trail={
          ownsArchive ? (
            <>
              <Link to="/archivio?sezione=siap">Archivio</Link> <span aria-hidden="true">/</span>{' '}
              <span>Contatti per il SIAP</span>
            </>
          ) : undefined
        }
      />
      <form className="riquadro" onSubmit={show} aria-labelledby="titolo-periodo-siap">
        <h2 id="titolo-periodo-siap">Periodo</h2>
        <div className="campi-in-riga">
          <div className="campo">
            <label htmlFor="siap-dal">Dal</label>
            <input
              id="siap-dal"
              type="date"
              required
              max={to || undefined}
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="campo">
            <label htmlFor="siap-al">Al (compreso)</label>
            <input
              id="siap-al"
              type="date"
              required
              min={from || undefined}
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
        </div>
        <div className="azioni">
          <button type="submit" className="pulsante pulsante-primario">
            <Icon name="cerca" /> <span>Mostra i contatti</span>
          </button>
        </div>
        <p className="aiuto">
          Un contatto per paziente e giorno, dagli atti tuoi: note del diario, ricette inviate o
          stampate, certificati, vaccinazioni, prestazioni aggiuntive, presidi. Il programma propone
          modalità, accesso e attività con l’elenco del Ministero; tu confermi, cambi o scarti. Al
          SIAP andranno i contatti confermati, quando ci sarà il collegamento con la Regione. Al più
          31 giorni alla volta.
        </p>
      </form>

      {r.loading && !data && <Loading what="contatti" />}
      <ErrorMessage error={r.error} />
      {done && <ResultNotice>{done}</ResultNotice>}
      {data && !data.struttura.codice && (
        <Notice kind="avviso">
          <p>
            Il codice della struttura per il SIAP non c’è ancora: lo scrive l’amministratore dello
            studio in Strumenti, «Dati dello studio». I contatti si confermano lo stesso; il codice
            entra nel contatto alla prima modifica dopo.
          </p>
        </Notice>
      )}
      {data && (
        <>
          <p role="status">
            Dal {date(data.dal)} al {date(data.al)}: {data.contatti.length}{' '}
            {data.contatti.length === 1 ? 'contatto' : 'contatti'} — {count('proposto')} da
            confermare, {count('da_aggiornare')} da aggiornare, {count('confermato')} confermati,{' '}
            {count('scartato')} scartati.
          </p>
          {data.contatti.length === 0 && (
            <p className="tenue">Nel periodo non ci sono atti tuoi che facciano un contatto.</p>
          )}
          {days.map((d) => (
            <section key={d} className="riquadro" aria-labelledby={`siap-giorno-${d}`}>
              <h2 id={`siap-giorno-${d}`}>{date(d)}</h2>
              <ul className="elenco-blocchi">
                {data.contatti
                  .filter((c) => c.giorno === d)
                  .map((c) => (
                    <ContactCard
                      key={`${c.paziente.id}|${c.giorno}`}
                      contact={c}
                      listing={data}
                      onDone={(message) => {
                        setDone(message);
                        r.reload();
                      }}
                    />
                  ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </>
  );
}

function ServicesTable({
  services,
  listing,
  caption,
}: {
  services: Service[];
  listing: Listing;
  caption: string;
}) {
  const name = (s: Service) => {
    const t = listing.tipologie.find((x) => x.codice === s.tipologia);
    const d = t?.dettagli.find((x) => x.codice === s.dettaglio);
    return {
      tipologia: t?.descrizione ?? String(s.tipologia),
      dettaglio: d?.descrizione ?? String(s.dettaglio),
    };
  };
  return (
    <div className="tabella-scorrevole">
      <table className="tabella">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Tipologia</th>
            <th scope="col">Dettaglio</th>
            <th scope="col" className="numero">
              Quantità
            </th>
          </tr>
        </thead>
        <tbody>
          {services.map((s) => {
            const n = name(s);
            return (
              <tr key={`${s.tipologia}.${s.dettaglio}`}>
                <td>
                  <span className="codice">{s.tipologia}</span> {n.tipologia}
                </td>
                <td>
                  <span className="codice">{s.dettaglio}</span> {n.dettaglio}
                </td>
                <td className="numero">{s.quantita}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ContactCard({
  contact: c,
  listing,
  onDone,
}: {
  contact: ContactView;
  listing: Listing;
  onDone: (message: string) => void;
}) {
  const [form, setForm] = useState<null | 'conferma' | 'modifica' | 'aggiorna' | 'scarta'>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const who = `${c.paziente.cognome} ${c.paziente.nome}`;
  const problems = listing.problemi[c.paziente.id] ?? [];
  const shown = c.contatto && c.stato !== 'scartato' ? c.contatto : null;
  const problemOf = (voce: string | null) => problems.find((p) => p.voce === voce);

  async function save(choice: Choice, mode: 'conferma' | 'modifica' | 'aggiorna') {
    setError(null);
    setBusy(true);
    try {
      if (mode === 'conferma' || !c.id || c.stato === 'scartato') {
        const res = await api<{ progressivo: number }>('/api/siap/contatti/conferma', {
          method: 'POST',
          body: { paziente: c.paziente.id, giorno: c.giorno, ...choice },
        });
        onDone(
          `Contatto di ${who} del ${date(c.giorno)} confermato: numero ${res.progressivo} del giorno.`,
        );
      } else {
        await api(`/api/siap/contatti/${c.id}`, { method: 'PUT', body: choice });
        onDone(`Contatto di ${who} del ${date(c.giorno)} aggiornato.`);
      }
      setForm(null);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'Servizio non raggiungibile'));
    } finally {
      setBusy(false);
    }
  }

  async function discard(reason: string) {
    setError(null);
    setBusy(true);
    try {
      await api('/api/siap/contatti/scarta', {
        method: 'POST',
        body: { paziente: c.paziente.id, giorno: c.giorno, motivo: reason },
      });
      setForm(null);
      onDone(`Contatto di ${who} del ${date(c.giorno)} scartato.`);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'Servizio non raggiungibile'));
    } finally {
      setBusy(false);
    }
  }

  const headingId = `siap-${c.paziente.id}-${c.giorno}`;
  return (
    <li className="riquadro scheda-contatto" aria-labelledby={headingId}>
      <h3 id={headingId}>
        <Link to={`/pazienti/${c.paziente.id}`}>{who}</Link>{' '}
        <span className={STATUS_CLASS[c.stato]}>
          {STATUS_LABEL[c.stato]}
          {c.stato !== 'scartato' && c.contatto?.progressivo
            ? `, n. ${c.contatto.progressivo}`
            : ''}
        </span>
      </h3>
      <p className="tenue">
        <span className="codice">{c.paziente.codiceFiscale}</span>
      </p>
      <h4>Atti del giorno</h4>
      <ul className="elenco-semplice">
        {c.atti.map((a) => (
          <li key={`${a.tipo}:${a.id}`}>
            {a.descrizione}
            {a.nuovo && <span className="etichetta"> dopo la conferma</span>}
          </li>
        ))}
        {c.attiTolti > 0 && (
          <li>
            {c.attiTolti === 1
              ? 'Un atto contato alla conferma non c’è più (annullato).'
              : `${c.attiTolti} atti contati alla conferma non ci sono più (annullati).`}
          </li>
        )}
      </ul>
      {c.stato === 'scartato' && c.contatto && (
        <p>
          <strong>Scartato:</strong> {c.contatto.motivoScarto}
        </p>
      )}
      <dl className="dati-in-riga">
        <dt>Modalità</dt>
        <dd>{describe(listing.modalita, shown?.modalita ?? c.proposta.modalita)}</dd>
        <dt>Accesso</dt>
        <dd>{describe(listing.accessi, shown?.accesso ?? c.proposta.accesso)}</dd>
        <dt>Problema</dt>
        <dd>
          {shown?.problema.voce ? (
            <>
              <span className="codice">{shown.problema.codice}</span>{' '}
              {problemOf(shown.problema.voce)?.descrizione ?? ''} ·{' '}
              {describe(listing.statiProblema, shown.problema.stato)}
            </>
          ) : (
            <>
              <span className="codice">V70.0</span> generico, stato non noto
            </>
          )}
        </dd>
      </dl>
      <ServicesTable
        services={shown?.prestazioni ?? c.proposta.prestazioni}
        listing={listing}
        caption={shown ? 'Attività e prestazioni confermate' : 'Attività e prestazioni proposte'}
      />
      {c.stato === 'da_aggiornare' && c.aggiornamento && (
        <ServicesTable
          services={c.aggiornamento}
          listing={listing}
          caption="Con gli atti nuovi diventerebbero"
        />
      )}
      <ErrorMessage error={error} />
      {form === null && (
        <div className="azioni">
          {(c.stato === 'proposto' || c.stato === 'scartato') && (
            <>
              <button
                type="button"
                className="pulsante pulsante-primario"
                disabled={busy}
                onClick={() => void save(startingChoice(c, 'conferma'), 'conferma')}
              >
                <Icon name="fatto" /> <span>Conferma</span>
              </button>
              <button type="button" className="pulsante" onClick={() => setForm('conferma')}>
                <Icon name="apri" /> <span>Cambia e conferma</span>
              </button>
            </>
          )}
          {c.stato === 'da_aggiornare' && (
            <>
              <button
                type="button"
                className="pulsante pulsante-primario"
                disabled={busy}
                onClick={() => void save(startingChoice(c, 'aggiorna'), 'aggiorna')}
              >
                <Icon name="ripeti" /> <span>Aggiorna con gli atti nuovi</span>
              </button>
              <button type="button" className="pulsante" onClick={() => setForm('aggiorna')}>
                <Icon name="apri" /> <span>Cambia e aggiorna</span>
              </button>
            </>
          )}
          {c.stato === 'confermato' && (
            <button type="button" className="pulsante" onClick={() => setForm('modifica')}>
              <Icon name="apri" /> <span>Modifica</span>
            </button>
          )}
          {c.stato !== 'scartato' && (
            <button type="button" className="pulsante" onClick={() => setForm('scarta')}>
              <Icon name="annulla" /> <span>Scarta</span>
            </button>
          )}
        </div>
      )}
      {form === 'scarta' && (
        <DiscardForm idBase={headingId} busy={busy} onSave={discard} onBack={() => setForm(null)} />
      )}
      {form && form !== 'scarta' && (
        <ContactForm
          idBase={headingId}
          listing={listing}
          problems={problems}
          start={startingChoice(c, form)}
          action={
            form === 'modifica'
              ? 'Salva le modifiche'
              : form === 'aggiorna'
                ? 'Aggiorna'
                : 'Conferma'
          }
          busy={busy}
          onSave={(choice) => void save(choice, form)}
          onBack={() => setForm(null)}
        />
      )}
    </li>
  );
}

function DiscardForm({
  idBase,
  busy,
  onSave,
  onBack,
}: {
  idBase: string;
  busy: boolean;
  onSave: (reason: string) => Promise<void>;
  onBack: () => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <form
      className="modulo-in-riga"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave(reason);
      }}
    >
      <div className="campo">
        <label htmlFor={`${idBase}-motivo`}>Motivo dello scarto</label>
        <input
          id={`${idBase}-motivo`}
          required
          maxLength={500}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <p className="aiuto">
          Per esempio: stesso episodio di un altro giorno, atto senza incontro con il paziente.
        </p>
      </div>
      <div className="azioni">
        <button type="submit" className="pulsante pulsante-primario" disabled={busy}>
          <Icon name="annulla" /> <span>Scarta il contatto</span>
        </button>
        <button type="button" className="pulsante" disabled={busy} onClick={onBack}>
          <Icon name="indietro" /> <span>Torna indietro</span>
        </button>
      </div>
    </form>
  );
}

function ContactForm({
  idBase,
  listing,
  problems,
  start,
  action,
  busy,
  onSave,
  onBack,
}: {
  idBase: string;
  listing: Listing;
  problems: Listing['problemi'][string];
  start: Choice;
  action: string;
  busy: boolean;
  onSave: (choice: Choice) => void;
  onBack: () => void;
}) {
  const [choice, setChoice] = useState<Choice>(start);
  const set = (patch: Partial<Choice>) => setChoice((c) => ({ ...c, ...patch }));
  const setService = (i: number, patch: Partial<Service>) =>
    set({ prestazioni: choice.prestazioni.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  const firstDetail = (tipologia: number) =>
    listing.tipologie.find((t) => t.codice === tipologia)?.dettagli[0]?.codice ?? 1;
  return (
    <form
      className="modulo-contatto"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(choice);
      }}
    >
      <div className="campi-in-riga">
        <div className="campo">
          <label htmlFor={`${idBase}-modalita`}>Modalità</label>
          <select
            id={`${idBase}-modalita`}
            value={choice.modalita}
            onChange={(e) => set({ modalita: e.target.value })}
          >
            {listing.modalita.map((m) => (
              <option key={m.chiave} value={m.chiave}>
                {m.descrizione}
              </option>
            ))}
          </select>
        </div>
        <div className="campo">
          <label htmlFor={`${idBase}-accesso`}>Tipologia di accesso</label>
          <select
            id={`${idBase}-accesso`}
            value={choice.accesso}
            onChange={(e) => set({ accesso: e.target.value })}
          >
            {listing.accessi.map((m) => (
              <option key={m.chiave} value={m.chiave}>
                {m.descrizione}
              </option>
            ))}
          </select>
        </div>
        <div className="campo">
          <label htmlFor={`${idBase}-problema`}>Problema</label>
          <select
            id={`${idBase}-problema`}
            value={choice.problema ?? ''}
            onChange={(e) => set({ problema: e.target.value || null })}
          >
            <option value="">V70.0, generico (stato non noto)</option>
            {problems.map((p) => (
              <option key={p.voce} value={p.voce}>
                {p.codice} {p.descrizione}
                {p.quesito ? ' (quesito aperto)' : p.cronico ? ' (cronico)' : ''}
              </option>
            ))}
          </select>
        </div>
      </div>
      <fieldset>
        <legend>Attività e prestazioni (al più 15)</legend>
        {choice.prestazioni.map((s, i) => {
          const typology = listing.tipologie.find((t) => t.codice === s.tipologia);
          return (
            <div className="campi-in-riga" key={i}>
              <div className="campo">
                <label htmlFor={`${idBase}-tipologia-${i}`}>Tipologia</label>
                <select
                  id={`${idBase}-tipologia-${i}`}
                  value={s.tipologia}
                  onChange={(e) => {
                    const t = Number(e.target.value);
                    setService(i, { tipologia: t, dettaglio: firstDetail(t) });
                  }}
                >
                  {listing.tipologie.map((t) => (
                    <option key={t.codice} value={t.codice}>
                      {t.codice} {t.descrizione}
                    </option>
                  ))}
                </select>
              </div>
              <div className="campo">
                <label htmlFor={`${idBase}-dettaglio-${i}`}>Dettaglio</label>
                <select
                  id={`${idBase}-dettaglio-${i}`}
                  value={s.dettaglio}
                  onChange={(e) => setService(i, { dettaglio: Number(e.target.value) })}
                >
                  {(typology?.dettagli ?? []).map((d) => (
                    <option key={d.codice} value={d.codice}>
                      {d.codice} {d.descrizione}
                    </option>
                  ))}
                </select>
              </div>
              <div className="campo campo-stretto">
                <label htmlFor={`${idBase}-quantita-${i}`}>Quantità</label>
                <input
                  id={`${idBase}-quantita-${i}`}
                  type="number"
                  min={1}
                  max={9}
                  required
                  value={s.quantita}
                  onChange={(e) => setService(i, { quantita: Number(e.target.value) })}
                />
              </div>
              <button
                type="button"
                className="pulsante"
                aria-label={`Togli l’attività ${i + 1}`}
                disabled={choice.prestazioni.length === 1}
                onClick={() => set({ prestazioni: choice.prestazioni.filter((_, j) => j !== i) })}
              >
                <Icon name="annulla" /> <span>Togli</span>
              </button>
            </div>
          );
        })}
        <button
          type="button"
          className="pulsante"
          disabled={choice.prestazioni.length >= 15}
          onClick={() =>
            set({
              prestazioni: [...choice.prestazioni, { tipologia: 1, dettaglio: 2, quantita: 1 }],
            })
          }
        >
          <Icon name="aggiungi" /> <span>Aggiungi un’attività</span>
        </button>
      </fieldset>
      <div className="azioni">
        <button type="submit" className="pulsante pulsante-primario" disabled={busy}>
          <Icon name="fatto" /> <span>{action}</span>
        </button>
        <button type="button" className="pulsante" disabled={busy} onClick={onBack}>
          <Icon name="indietro" /> <span>Torna indietro</span>
        </button>
      </div>
    </form>
  );
}
