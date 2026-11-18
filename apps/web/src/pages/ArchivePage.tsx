import { useState } from 'react';
import { Navigate } from 'react-router';
import { ErrorMessage, Loading, Notice, PageHeader } from '../components/common';
import { Icon } from '../components/Icon';
import { api, ApiError } from '../lib/api';
import { useSession } from '../lib/session';
import { useApi } from '../lib/useApi';

interface Settings {
  segreteriaLeggeDiario: boolean;
  segreteriaLeggeRiepilogo: boolean;
}

const SETTINGS: { key: keyof Settings; name: string; explanation: string }[] = [
  {
    key: 'segreteriaLeggeRiepilogo',
    name: 'La segreteria legge il riepilogo clinico',
    explanation:
      'Problemi, allergie, esenzioni, piani terapeutici e parametri. Spento per difetto.',
  },
  {
    key: 'segreteriaLeggeDiario',
    name: 'La segreteria legge il diario clinico',
    explanation: 'Note di visita e cronologia clinica. Spento per difetto.',
  },
];

/**
 * L'archivio del medico titolare (D84): che cosa vede la segreteria (D30) ed esportazione completa
 * in formato aperto (regola 4). Solo per chi è titolare di un archivio; ogni azione è registrata.
 */
export function ArchivePage() {
  const { state } = useSession();
  const own = state.status === 'ready' ? state.me.archivio : null;
  const settings = useApi<Settings>(own ? `/api/archivi/${own.id}/impostazioni` : null);
  const [error, setError] = useState<ApiError | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // La casella cambia subito; se il servizio rifiuta, torna com'era (D84).
  const [local, setLocal] = useState<Settings | null>(null);
  const current = local ?? settings.data;

  if (!own) return <Navigate to="/" replace />;

  async function change(key: keyof Settings, value: boolean, name: string) {
    setError(null);
    setSaved(null);
    setBusy(true);
    setLocal({ ...current!, [key]: value });
    try {
      await api(`/api/archivi/${own!.id}/impostazioni`, {
        method: 'PATCH',
        body: { [key]: value },
      });
      setSaved(`${name}: ${value ? 'acceso' : 'spento'}.`);
      settings.reload();
    } catch (e) {
      setLocal(null);
      setError(e instanceof ApiError ? e : null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader title="Archivio" />
      <p>
        Archivio: <strong>{own.nome}</strong>. I dati sono tuoi: decidi che cosa vede la segreteria
        e puoi scaricarli tutti quando vuoi.
      </p>
      <div className="griglia-cartella">
        <section className="riquadro" aria-labelledby="titolo-segreteria">
          <h2 id="titolo-segreteria">
            <Icon name="lucchetto" /> Che cosa vede la segreteria
          </h2>
          {settings.loading && !settings.data && <Loading what="impostazioni" />}
          <ErrorMessage error={settings.error ?? error} />
          {current && (
            <fieldset className="scelta" disabled={busy}>
              <legend className="visivamente-nascosto">Impostazioni della segreteria</legend>
              {SETTINGS.map((s) => (
                <div key={s.key} className="casella">
                  <input
                    type="checkbox"
                    id={`impostazione-${s.key}`}
                    checked={current[s.key]}
                    onChange={(e) => void change(s.key, e.target.checked, s.name)}
                  />
                  <label htmlFor={`impostazione-${s.key}`}>
                    <strong>{s.name}</strong> <span className="tenue">{s.explanation}</span>
                  </label>
                </div>
              ))}
            </fieldset>
          )}
          <p className="aiuto">
            I dati riservati restano sempre al medico. La segreteria prepara anagrafiche, agenda e
            bozze di ricette ripetute; firma e invio restano al medico.
          </p>
          {saved && <Notice kind="fatto">{saved}</Notice>}
        </section>

        <section className="riquadro" aria-labelledby="titolo-esportazione">
          <h2 id="titolo-esportazione">
            <Icon name="archivio" /> Esportazione completa
          </h2>
          <p>
            Tutti i dati dell&apos;archivio in formato aperto: pazienti, cartelle, terapie, ricette
            con i controlli, invii agli enti e registro degli accessi.
          </p>
          <ul className="elenco-azioni">
            <li>
              <a className="pulsante" href="/api/esportazione?formato=json" download>
                <Icon name="archivio" /> <span>Scarica in JSON (un file)</span>
              </a>
            </li>
            <li>
              <a className="pulsante" href="/api/esportazione?formato=csv" download>
                <Icon name="archivio" /> <span>Scarica in CSV (un file per tabella, in ZIP)</span>
              </a>
            </li>
          </ul>
          <p className="aiuto">
            Ogni esportazione è registrata nel registro degli accessi. Ogni sezione del file ha la
            sua impronta SHA-256, per controllare che sia integro.
          </p>
        </section>
      </div>
    </>
  );
}
