import { useState, type FormEvent, type ReactNode } from 'react';
import { ErrorMessage, Loading, Notice } from '../../components/common';
import { Icon } from '../../components/Icon';
import { api, ApiError } from '../../lib/api';
import { useApi } from '../../lib/useApi';

interface Range {
  min: number;
  max: number;
}
interface StudioView {
  dati: {
    nome: string;
    tipo: string;
    regione: string | null;
    indirizzo: string | null;
    cap: string | null;
    comune: string | null;
    provincia: string | null;
    telefono: string | null;
    email: string | null;
    pec: string | null;
  };
  tipi: { codice: string; nome: string }[];
  indirizzoCompleto: string | null;
  intestazione: string[];
  sicurezza: {
    minutiInattivita: number | null;
    /** Password sbagliate prima del blocco del conto: la soglia alta (D188). */
    tentativiFalliti: number | null;
    codiciSbagliati: number | null;
    minutiBlocco: number | null;
  };
  invii: { secondiAttesa: number; avviso: string | null };
  avvisi: {
    cartelleAlGiorno: number | null;
    fasciaDalle: number | null;
    fasciaAlle: number | null;
    consultazioniAftAlGiorno: number | null;
    daCompletare: string[];
    fonte: string;
  };
  daCompletare: string[];
  limiti: {
    idleLockMinutes: Range;
    maxFailedLogins: Range;
    maxFailedCodes: Range;
    failedLoginLockMinutes: Range;
    sendTimeoutSeconds: Range;
    alertDailyRecords: Range;
    alertAftDaily: Range;
    headerLines: number;
    headerLineLength: number;
  };
  puoModificare: boolean;
  puoModificareIntestazione: boolean;
}

type Fields = {
  nome: string;
  tipo: string;
  regione: string;
  indirizzo: string;
  cap: string;
  comune: string;
  provincia: string;
  telefono: string;
  email: string;
  pec: string;
  intestazione: string;
  minutiInattivita: string;
  tentativiFalliti: string;
  codiciSbagliati: string;
  minutiBlocco: string;
  secondiAttesa: string;
  cartelleAlGiorno: string;
  fasciaDalle: string;
  fasciaAlle: string;
  consultazioniAftAlGiorno: string;
};

const str = (v: string | number | null) => (v == null ? '' : String(v));

function initial(d: StudioView): Fields {
  return {
    nome: d.dati.nome,
    tipo: d.dati.tipo,
    regione: str(d.dati.regione),
    indirizzo: str(d.dati.indirizzo),
    cap: str(d.dati.cap),
    comune: str(d.dati.comune),
    provincia: str(d.dati.provincia),
    telefono: str(d.dati.telefono),
    email: str(d.dati.email),
    pec: str(d.dati.pec),
    intestazione: d.intestazione.join('\n'),
    minutiInattivita: str(d.sicurezza.minutiInattivita),
    tentativiFalliti: str(d.sicurezza.tentativiFalliti),
    codiciSbagliati: str(d.sicurezza.codiciSbagliati),
    minutiBlocco: str(d.sicurezza.minutiBlocco),
    secondiAttesa: str(d.invii.secondiAttesa),
    cartelleAlGiorno: str(d.avvisi.cartelleAlGiorno),
    fasciaDalle: str(d.avvisi.fasciaDalle),
    fasciaAlle: str(d.avvisi.fasciaAlle),
    consultazioniAftAlGiorno: str(d.avvisi.consultazioniAftAlGiorno),
  };
}

/** Vuoto vuol dire «nessun valore». */
const number = (v: string) => (v.trim() === '' ? null : Number(v));
const text = (v: string) => (v.trim() === '' ? null : v.trim());

const HOURS = Array.from({ length: 24 }, (_, h) => h);

const failure = (e: unknown) =>
  e instanceof ApiError ? e : new ApiError(0, 'Servizio non raggiungibile');

/** L'errore del servizio con l'elenco dei problemi da correggere, se c'è. */
function Problems({ error }: { error: ApiError | null }) {
  if (!error) return null;
  const list = (error.details as { problemi?: unknown } | undefined)?.problemi;
  if (!Array.isArray(list) || list.length < 2) return <ErrorMessage error={error} />;
  return (
    <div className="messaggio messaggio-errore" role="alert">
      <Icon name="avviso" />
      <div>
        <p>Da correggere:</p>
        <ul>
          {list.map((p) => (
            <li key={String(p)}>{String(p)}.</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

/**
 * Dati e impostazioni dello studio (tappa 14): dati, intestazione dei documenti, sicurezza
 * dell'accesso, tempo di attesa degli invii, soglie degli avvisi sugli accessi anomali. Li vede ogni
 * utente dello studio; li cambia l'amministratore. Senza la regione nessuna ricetta SSN parte
 * (D95): l'avviso sta in cima, ben visibile.
 */
export function StudioSection() {
  const current = useApi<StudioView>('/api/studio');
  // Il messaggio sta fuori dal modulo, che si rifà con i dati salvati.
  const [saved, setSaved] = useState(false);
  if (current.loading && !current.data) return <Loading what="dati dello studio" />;
  if (!current.data) return <ErrorMessage error={current.error} />;
  return (
    <>
      <StudioForm
        key={JSON.stringify(current.data)}
        data={current.data}
        onSaving={() => setSaved(false)}
        onSaved={() => {
          setSaved(true);
          current.reload();
        }}
      />
      {saved && <Notice kind="fatto">Dati e impostazioni dello studio salvati.</Notice>}
    </>
  );
}

function StudioForm({
  data,
  onSaving,
  onSaved,
}: {
  data: StudioView;
  onSaving: () => void;
  onSaved: () => void;
}) {
  const [f, setF] = useState(() => initial(data));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const readOnly = !data.puoModificare;
  const headerReadOnly = !data.puoModificareIntestazione;
  const canSave = data.puoModificare || data.puoModificareIntestazione;
  const set = (k: keyof Fields, v: string) => setF((x) => ({ ...x, [k]: v }));
  const l = data.limiti;
  const otherGaps = data.daCompletare.filter((g) => !g.startsWith('Regione'));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    onSaving();
    try {
      await api('/api/studio', {
        method: 'PUT',
        body: {
          ...(data.puoModificare
            ? {
                dati: {
                  nome: f.nome.trim(),
                  tipo: f.tipo,
                  regione: text(f.regione),
                  indirizzo: text(f.indirizzo),
                  cap: text(f.cap),
                  comune: text(f.comune),
                  provincia: text(f.provincia),
                  telefono: text(f.telefono),
                  email: text(f.email),
                  pec: text(f.pec),
                },
                sicurezza: {
                  minutiInattivita: number(f.minutiInattivita),
                  tentativiFalliti: number(f.tentativiFalliti),
                  codiciSbagliati: number(f.codiciSbagliati),
                  minutiBlocco: number(f.minutiBlocco),
                },
                invii: { secondiAttesa: number(f.secondiAttesa) },
                avvisi: {
                  cartelleAlGiorno: number(f.cartelleAlGiorno),
                  fasciaDalle: number(f.fasciaDalle),
                  fasciaAlle: number(f.fasciaAlle),
                  consultazioniAftAlGiorno: number(f.consultazioniAftAlGiorno),
                },
              }
            : {}),
          ...(data.puoModificareIntestazione
            ? {
                intestazione: f.intestazione
                  .split('\n')
                  .map((r) => r.trim())
                  .filter(Boolean),
              }
            : {}),
        },
      });
      onSaved();
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  }

  /** Un campo di testo con etichetta e, se serve, l'aiuto collegato. */
  const input = (
    k: keyof Fields,
    label: string,
    props: {
      help?: ReactNode;
      type?: 'text' | 'tel' | 'email' | 'number';
      required?: boolean;
      maxLength?: number;
      pattern?: string;
      inputMode?: 'numeric' | 'text';
      range?: Range;
      narrow?: boolean;
      code?: boolean;
      autoComplete?: string;
    } = {},
  ) => (
    <div className={props.narrow ? 'campo campo-stretto' : 'campo'}>
      <label htmlFor={`studio-${k}`}>{label}</label>
      <input
        id={`studio-${k}`}
        type={props.type ?? 'text'}
        className={props.code ? 'codice' : undefined}
        readOnly={readOnly}
        required={props.required}
        maxLength={props.maxLength}
        pattern={props.pattern}
        inputMode={props.inputMode}
        min={props.range?.min}
        max={props.range?.max}
        step={props.range ? 1 : undefined}
        autoComplete={props.autoComplete ?? 'off'}
        aria-describedby={props.help ? `studio-${k}-aiuto` : undefined}
        value={f[k]}
        onChange={(e) => set(k, e.target.value)}
      />
      {props.help && (
        <p className="aiuto" id={`studio-${k}-aiuto`}>
          {props.help}
        </p>
      )}
    </div>
  );
  const hour = (k: 'fasciaDalle' | 'fasciaAlle', label: string) => (
    <div className="campo campo-stretto">
      <label htmlFor={`studio-${k}`}>{label}</label>
      <select
        id={`studio-${k}`}
        disabled={readOnly}
        aria-describedby="studio-fascia-aiuto"
        value={f[k]}
        onChange={(e) => set(k, e.target.value)}
      >
        <option value="">Nessuna</option>
        {HOURS.map((h) => (
          <option key={h} value={String(h)}>
            {String(h).padStart(2, '0')}:00
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <form className="riquadro" onSubmit={(e) => void submit(e)} aria-labelledby="titolo-studio">
      <h2 id="titolo-studio">
        <Icon name="strumenti" /> Dati e impostazioni dello studio
      </h2>
      {!data.dati.regione && (
        <Notice kind="errore">
          <p>
            <strong>Manca la regione dello studio: nessuna ricetta SSN si può inviare.</strong> Va
            nell’intestazione del promemoria della ricetta (DM 2/11/2011, allegato 2, campo 1).
          </p>
          <p>
            {readOnly
              ? 'La inserisce l’amministratore dello studio.'
              : 'Scrivila qui sotto, in «Dati dello studio», e salva.'}
          </p>
        </Notice>
      )}
      {otherGaps.length > 0 && (
        <Notice kind="avviso">
          <p>Da completare:</p>
          <ul>
            {otherGaps.map((g) => (
              <li key={g}>{g}.</li>
            ))}
          </ul>
        </Notice>
      )}
      {readOnly && (
        <Notice kind="info">
          I dati e le impostazioni dello studio li cambia l’amministratore dello studio.
        </Notice>
      )}

      <fieldset disabled={busy}>
        <legend>Dati dello studio</legend>
        <div className="campi-in-riga">
          {input('nome', 'Nome dello studio', { required: true, maxLength: 200 })}
          <div className="campo">
            <label htmlFor="studio-tipo">Tipo di studio</label>
            <select
              id="studio-tipo"
              disabled={readOnly}
              value={f.tipo}
              onChange={(e) => set('tipo', e.target.value)}
            >
              {data.tipi.map((t) => (
                <option key={t.codice} value={t.codice}>
                  {t.nome}
                </option>
              ))}
            </select>
          </div>
          {input('regione', 'Regione', {
            required: true,
            maxLength: 60,
            help: 'Solo il nome, per esempio PIEMONTE: va sul promemoria della ricetta SSN, dopo «REGIONE».',
          })}
        </div>
        <div className="campi-in-riga">
          {input('indirizzo', 'Indirizzo (via e numero civico)', {
            maxLength: 100,
            autoComplete: 'street-address',
          })}
          {input('cap', 'CAP', {
            narrow: true,
            maxLength: 5,
            pattern: '[0-9]{5}',
            inputMode: 'numeric',
            code: true,
          })}
          {input('comune', 'Comune', { maxLength: 100 })}
          {input('provincia', 'Provincia', {
            narrow: true,
            maxLength: 2,
            pattern: '[A-Za-z]{2}',
            code: true,
            help: 'La sigla di 2 lettere.',
          })}
        </div>
        <p className="aiuto">
          L’indirizzo completo va sulla copia del certificato INPS per la visita in studio
          {data.indirizzoCompleto ? (
            <>
              : <strong>{data.indirizzoCompleto}</strong>.
            </>
          ) : (
            '.'
          )}
        </p>
        <div className="campi-in-riga">
          {input('telefono', 'Telefono', { type: 'tel', maxLength: 30 })}
          {input('email', 'Email', { type: 'email', maxLength: 254 })}
          {input('pec', 'PEC', { type: 'email', maxLength: 254 })}
        </div>
      </fieldset>

      <fieldset disabled={busy}>
        <legend>Intestazione dei documenti</legend>
        <div className="campo">
          <label htmlFor="studio-intestazione">Intestazione dello studio</label>
          <textarea
            id="studio-intestazione"
            rows={4}
            readOnly={headerReadOnly}
            aria-describedby="studio-intestazione-aiuto"
            value={f.intestazione}
            onChange={(e) => set('intestazione', e.target.value)}
          />
          <p className="aiuto" id="studio-intestazione-aiuto">
            Una riga per riga, al massimo {l.headerLines} di {l.headerLineLength} caratteri; la
            prima si stampa in neretto. Vale nei certificati dai modelli dei medici che non hanno
            un’intestazione loro (Strumenti › Impaginazione).
          </p>
        </div>
      </fieldset>

      <fieldset disabled={busy}>
        <legend>Sicurezza dell’accesso</legend>
        <div className="campi-in-riga">
          {input('minutiInattivita', 'Minuti di inattività prima del blocco', {
            type: 'number',
            required: true,
            range: l.idleLockMinutes,
            help: `Dopo questi minuti senza attività la sessione si blocca. Da ${l.idleLockMinutes.min} a ${l.idleLockMinutes.max}.`,
          })}
          {input('tentativiFalliti', 'Password sbagliate prima del blocco del conto', {
            type: 'number',
            required: true,
            range: l.maxFailedLogins,
            help: `Le sbaglia anche chi conosce solo il nome utente: prima del blocco, dopo le prime password sbagliate, la postazione o l’indirizzo da cui arrivano aspettano. Soglia provvisoria, da completare. Da ${l.maxFailedLogins.min} a ${l.maxFailedLogins.max}.`,
          })}
          {input('codiciSbagliati', 'Codici sbagliati prima del blocco del conto', {
            type: 'number',
            required: true,
            range: l.maxFailedCodes,
            help: `Codici a 6 cifre sbagliati all’accesso o allo sblocco, e password attuale sbagliata nel cambio: li sbaglia solo chi ha già la password o una sessione. Da ${l.maxFailedCodes.min} a ${l.maxFailedCodes.max}.`,
          })}
          {input('minutiBlocco', 'Durata del blocco (minuti)', {
            type: 'number',
            required: true,
            range: l.failedLoginLockMinutes,
            help: `Da ${l.failedLoginLockMinutes.min} a ${l.failedLoginLockMinutes.max} minuti.`,
          })}
        </div>
      </fieldset>

      <fieldset disabled={busy}>
        <legend>Invii</legend>
        {input('secondiAttesa', 'Tempo massimo di attesa (secondi)', {
          type: 'number',
          required: true,
          range: l.sendTimeoutSeconds,
          help: `Quanto si aspetta la risposta di SAR, Sistema TS e INPS: oltre, l’esito dell’invio è incerto e va controllato prima di rifarlo. La Regione Piemonte indica da 6 a 8 secondi (SIRPE, «Cartelle cliniche MMG e PLS», 4.4.7). Da ${l.sendTimeoutSeconds.min} a ${l.sendTimeoutSeconds.max}.`,
        })}
        {data.invii.avviso && <Notice kind="avviso">{data.invii.avviso}.</Notice>}
      </fieldset>

      <fieldset disabled={busy}>
        <legend>Avvisi sugli accessi anomali</legend>
        {data.avvisi.daCompletare.length > 0 ? (
          <Notice kind="avviso">
            <p>
              <strong>Finché una soglia è vuota, quell’avviso è spento.</strong> Le soglie sono da
              completare:
            </p>
            <ul>
              {data.avvisi.daCompletare.map((g) => (
                <li key={g}>{g}.</li>
              ))}
            </ul>
          </Notice>
        ) : (
          <Notice kind="fatto">Tutte le soglie sono impostate: gli avvisi sono accesi.</Notice>
        )}
        <div className="campi-in-riga">
          {input('cartelleAlGiorno', 'Cartelle diverse aperte da un utente in un giorno', {
            type: 'number',
            range: l.alertDailyRecords,
            help: 'Oltre questo numero parte un avviso. Vuoto: avviso spento.',
          })}
          {input('consultazioniAftAlGiorno', 'Consultazioni dell’AFT di un collega in un giorno', {
            type: 'number',
            range: l.alertAftDaily,
            help: 'Oltre questo numero parte un avviso. Vuoto: avviso spento.',
          })}
        </div>
        <fieldset>
          <legend>Fascia oraria degli accessi</legend>
          <div className="campi-in-riga">
            {hour('fasciaDalle', 'Dalle ore')}
            {hour('fasciaAlle', 'Alle ore')}
          </div>
        </fieldset>
        <p className="aiuto" id="studio-fascia-aiuto">
          Un accesso in questa fascia fa partire un avviso. Se l’ora d’inizio è più grande di quella
          di fine, la fascia comprende la mezzanotte. Vuote tutte e due: avviso spento.
        </p>
        <p className="aiuto">Fonte: {data.avvisi.fonte}.</p>
      </fieldset>

      {canSave && (
        <div className="azioni">
          <button type="submit" className="pulsante pulsante-primario" disabled={busy}>
            <Icon name="fatto" /> <span>Salva i dati dello studio</span>
          </button>
        </div>
      )}
      <Problems error={error} />
    </form>
  );
}
