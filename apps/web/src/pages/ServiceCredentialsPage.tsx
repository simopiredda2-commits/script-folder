import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ErrorMessage, Loading, Notice, PageHeader } from '../components/common';
import { Icon } from '../components/Icon';
import { api, ApiError } from '../lib/api';
import type { CredentialsStatus, ServiceStatus } from '../lib/credentials';
import { date, dateTime, studioToday } from '../lib/format';
import { regionalReturnText } from '../lib/return-reasons';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';

/**
 * Credenziali dei servizi del medico (D100–D102): Sistema TS e RUPAR Piemonte, cifrate e mai
 * rilette; codice di sessione del secondo fattore. Solo il medico le vede e le cambia.
 */
export function ServiceCredentialsPage() {
  const { isDoctor } = useSession();
  const st = useApi<CredentialsStatus>(isDoctor ? '/api/profilo/credenziali' : null);
  // Ritorno dalla pagina regionale (D109): esito nell'indirizzo, letto una volta e poi tolto. Del
  // motivo c'è solo il codice; il testo è del programma (D193).
  const [params, setParams] = useSearchParams();
  const [regionalOutcome] = useState(() =>
    params.get('accesso')
      ? { ok: params.get('accesso') === 'ok', why: regionalReturnText(params.get('motivo')) }
      : null,
  );
  useEffect(() => {
    if (params.get('accesso')) setParams({}, { replace: true });
  }, [params, setParams]);
  if (!isDoctor)
    return (
      <>
        <PageHeader title="Credenziali dei servizi" />
        <Notice kind="info">
          Le credenziali dei servizi sono personali del medico: la segreteria e l’amministratore non
          le vedono e non le usano.
        </Notice>
      </>
    );
  if (st.loading && !st.data) return <Loading what="credenziali dei servizi" />;
  if (!st.data) return <ErrorMessage error={st.error} />;
  return (
    <>
      <PageHeader
        title="Credenziali dei servizi"
        actions={
          <Link className="pulsante" to="/profilo/recapiti">
            <Icon name="pazienti" /> <span>Recapiti di studio</span>
          </Link>
        }
      />
      <p className="sottotitolo">
        Servono a mandare ricette e certificati a tuo nome. Sono salvate cifrate e, una volta
        salvate, non si rileggono: né qui né altrove. Le vedi e le cambi solo tu.
      </p>
      {regionalOutcome &&
        (regionalOutcome.ok ? (
          <Notice kind="fatto">Accesso regionale attivo: puoi mandare le ricette SSN.</Notice>
        ) : (
          <Notice kind="errore">Accesso regionale non riuscito: {regionalOutcome.why}.</Notice>
        ))}
      <div className="griglia-credenziali">
        {st.data.servizi.map((s) => (
          <ServiceCard key={s.servizio} s={s} onChange={st.reload} />
        ))}
      </div>
    </>
  );
}

function ServiceCard({ s, onChange }: { s: ServiceStatus; onChange: () => void }) {
  const base = `/api/profilo/credenziali/${s.servizio}`;
  const id = (f: string) => `${s.servizio}-${f}`;
  const [utente, setUtente] = useState('');
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [changedOn, setChangedOn] = useState('');
  const [code, setCode] = useState('');
  const [testCode, setTestCode] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await fn();
      setDone(ok);
      onChange();
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError(0, 'Servizio non raggiungibile'));
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    run(async () => {
      await api(base, {
        method: 'PUT',
        body: {
          ...(utente ? { utente } : {}),
          ...(password ? { password } : {}),
          ...(pin ? { pin } : {}),
          ...(changedOn ? { passwordCambiataIl: changedOn } : {}),
        },
      });
      setUtente('');
      setPassword('');
      setPin('');
      setChangedOn('');
    }, 'Credenziali salvate.');

  const remove = () =>
    run(async () => {
      await api(base, { method: 'DELETE' });
      setConfirmDelete(false);
    }, 'Credenziali cancellate.');

  const requestCode = () =>
    run(async () => {
      const r = await api<{ inviato: boolean; codiceDiProva: string | null }>(
        `${base}/sessione/richiesta`,
        { method: 'POST' },
      );
      setTestCode(r.codiceDiProva);
      if (r.codiceDiProva) setCode(r.codiceDiProva);
    }, 'Codice richiesto: arriva all’email che hai certificato presso il servizio.');

  const activate = () =>
    run(async () => {
      await api(`${base}/sessione`, { method: 'POST', body: { codice: code.trim() } });
      setCode('');
      setTestCode(null);
    }, 'Codice di sessione attivo.');

  const revoke = () =>
    run(() => api(`${base}/sessione`, { method: 'DELETE' }), 'Codice di sessione revocato.');

  /** Accesso regionale con SPID o CIE (D109): si va alla pagina della Regione e si torna qui. */
  const startRegional = () =>
    run(async () => {
      const r = await api<{ indirizzo: string }>(`${base}/accesso-regionale`, { method: 'POST' });
      window.location.assign(r.indirizzo);
    }, 'Apertura della pagina regionale…');

  const regionalActive = s.sessione.attiva && s.sessione.modalita === 'spid_cie';
  const emailActive = s.sessione.attiva && s.sessione.modalita !== 'spid_cie';

  return (
    <section className="riquadro" aria-labelledby={id('titolo')}>
      <h2 id={id('titolo')}>
        <Icon name="lucchetto" /> {s.nome}
      </h2>
      <p className="tenue">{s.uso}</p>
      {s.impostate ? (
        <p>
          Impostate: utente <span className="codice">{s.utente}</span>, password cambiata il{' '}
          {date(s.passwordCambiataIl)}
          {s.scadenzaPassword ? `, scade il ${date(s.scadenzaPassword)}` : ''}.
        </p>
      ) : (
        <p>Non impostate.</p>
      )}
      {s.statoPassword === 'in_scadenza' && (
        <Notice kind="avviso">
          La password scade il {date(s.scadenzaPassword)}: cambiala sul portale del servizio, poi
          inserisci qui quella nuova.
        </Notice>
      )}
      {s.statoPassword === 'scaduta' && (
        <Notice kind="errore">
          La password risulta scaduta il {date(s.scadenzaPassword)}: finché non la cambi, il
          servizio può rifiutare gli invii.
        </Notice>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <fieldset disabled={busy}>
          <legend>{s.impostate ? 'Cambia le credenziali' : 'Inserisci le credenziali'}</legend>
          {s.impostate && (
            <p className="aiuto">Scrivi solo ciò che cambia; il resto resta com’è.</p>
          )}
          <div className="campo">
            <label htmlFor={id('utente')}>Utente</label>
            <input
              id={id('utente')}
              autoComplete="off"
              required={!s.impostate}
              value={utente}
              onChange={(e) => setUtente(e.target.value)}
            />
          </div>
          <div className="campo">
            <label htmlFor={id('password')}>Password</label>
            <input
              id={id('password')}
              type="password"
              autoComplete="new-password"
              required={!s.impostate}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <div className="campo">
            <label htmlFor={id('pin')}>PIN</label>
            <input
              id={id('pin')}
              type="password"
              inputMode="numeric"
              autoComplete="off"
              required={!s.impostate}
              value={pin}
              onChange={(e) => setPin(e.target.value)}
            />
          </div>
          <div className="campo">
            <label htmlFor={id('cambio')}>Data del cambio della password</label>
            <input
              id={id('cambio')}
              type="date"
              max={studioToday()}
              aria-describedby={id('cambio-aiuto')}
              value={changedOn}
              onChange={(e) => setChangedOn(e.target.value)}
            />
            <p className="aiuto" id={id('cambio-aiuto')}>
              Se non la indichi e scrivi una password nuova, vale oggi.
            </p>
          </div>
          <div className="azioni">
            <button type="submit" className="pulsante pulsante-primario">
              <Icon name="fatto" /> <span>Salva</span>
            </button>
            {s.impostate &&
              (confirmDelete ? (
                <button type="button" className="pulsante" onClick={() => void remove()}>
                  <Icon name="annulla" /> <span>Conferma la cancellazione</span>
                </button>
              ) : (
                <button type="button" className="pulsante" onClick={() => setConfirmDelete(true)}>
                  <Icon name="annulla" /> <span>Cancella le credenziali</span>
                </button>
              ))}
          </div>
        </fieldset>
      </form>

      {s.accessoRegionale && (
        <fieldset disabled={busy}>
          <legend>Accesso regionale con SPID o CIE</legend>
          <p>
            {regionalActive
              ? `Attivo fino a ${dateTime(s.sessione.scadeIl)}.`
              : 'Non attivo: per le ricette SSN si entra con SPID o CIE sulla pagina della Regione.'}
          </p>
          <p className="aiuto">
            La Regione riconosce il medico e autorizza il programma fino alla scadenza che indica;
            poi si rientra. Con questo accesso le credenziali RUPAR non servono per le ricette.
          </p>
          <div className="azioni">
            <button
              type="button"
              className="pulsante pulsante-primario"
              onClick={() => void startRegional()}
            >
              <Icon name="apri" /> <span>Entra con SPID o CIE</span>
            </button>
            {regionalActive && (
              <button type="button" className="pulsante" onClick={() => void revoke()}>
                <Icon name="annulla" /> <span>Esci dall’accesso regionale</span>
              </button>
            )}
          </div>
        </fieldset>
      )}
      {s.secondoFattore && (
        <fieldset disabled={busy || !s.impostate}>
          <legend>
            {s.accessoRegionale
              ? 'In alternativa: codice di sessione via email'
              : 'Codice di sessione (secondo fattore)'}
          </legend>
          <p>
            {emailActive
              ? `Attivo fino a ${dateTime(s.sessione.scadeIl)}.`
              : s.accessoRegionale
                ? 'Non attivo. Serve con le credenziali RUPAR, al posto dell’accesso con SPID o CIE.'
                : 'Non attivo: serve per mandare le ricette.'}
          </p>
          <p className="aiuto">
            Il codice arriva all’email che hai certificato presso il servizio. Ne vale uno alla
            volta: chiederne uno nuovo annulla il precedente.
          </p>
          <div className="azioni">
            <button type="button" className="pulsante" onClick={() => void requestCode()}>
              <Icon name="apri" /> <span>Chiedi il codice</span>
            </button>
            {emailActive && (
              <button type="button" className="pulsante" onClick={() => void revoke()}>
                <Icon name="annulla" /> <span>Revoca il codice</span>
              </button>
            )}
          </div>
          {testCode && (
            <Notice kind="info">
              Ambiente di prova: il servizio simulato restituisce il codice anche qui, come
              l’ambiente di prova della Regione. È già nel campo qui sotto.
            </Notice>
          )}
          <div className="campo">
            <label htmlFor={id('codice')}>Codice ricevuto per email</label>
            <div className="campo-con-pulsante">
              <input
                id={id('codice')}
                autoComplete="off"
                className="codice"
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
              <button
                type="button"
                className="pulsante pulsante-primario"
                disabled={!code.trim()}
                onClick={() => void activate()}
              >
                <Icon name="fatto" /> <span>Attiva</span>
              </button>
            </div>
          </div>
        </fieldset>
      )}
      <ErrorMessage error={error} />
      {done && <Notice kind="fatto">{done}</Notice>}
    </section>
  );
}
