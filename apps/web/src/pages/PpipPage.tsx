import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { ErrorMessage, Loading, Notice, PageHeader } from '../components/common';
import { Icon } from '../components/Icon';
import { api, ApiError } from '../lib/api';
import { archiveNames, archivesOnDay, type ArchiveMove } from '../lib/archive-moves';
import { date, money, studioToday } from '../lib/format';
import { usePersistentState } from '../lib/storage';
import { useApi } from '../lib/useApi';
import { PatientBanner, type Patient, type Summary } from './RecordPage';

/** Una voce del catalogo delle prestazioni aggiuntive in vigore alla data (D212). */
export interface CatalogItem {
  codice: string;
  sezione: string;
  descrizione: string;
  autorizzazione: boolean;
  compenso: number | null;
  note: string | null;
  atto: string | null;
  inVigoreDal: string;
}

interface PpipRecord {
  id: string;
  data: string;
  codice: string;
  sezione: string;
  descrizione: string;
  quantita: number;
  luogo: 'studio' | 'domicilio';
  nomeLuogo: string;
  autorizzazione: string | null;
  compensoUnitario: number | null;
  importo: number | null;
  note: string | null;
  stato: 'registrata' | 'annullata';
  motivoAnnullamento: string | null;
  inviata: boolean;
  /** Sta partendo con la distinta del mese (D232). */
  inInvio: boolean;
  protocolloInvio: string | null;
  registrataDa: string;
  /**
   * Nella distinta di un altro archivio: quello che aveva il paziente il giorno dell'esecuzione,
   * prima che cambiasse medico (D232, D240).
   */
  altroArchivio: string | null;
}

const failure = (e: unknown) =>
  e instanceof ApiError ? e : new ApiError(0, 'Servizio non raggiungibile');

/** Gruppi del catalogo: le sezioni A e B dell'allegato 6, poi gli accordi che aggiungono voci. */
export const SECTION_LABEL = (sezione: string) =>
  sezione === 'A'
    ? 'A · eseguibili senza autorizzazione'
    : sezione === 'B'
      ? 'B · eseguibili con autorizzazione sanitaria'
      : sezione;

/**
 * Prestazioni aggiuntive del paziente (PPIP, D212): voci e compensi dal catalogo in vigore il
 * giorno dell'esecuzione (allegato 6 dell'ACN, accordo regionale); per la sezione B gli estremi
 * dell'autorizzazione. Le registrano i medici e la segreteria; la distinta del mese la manda il
 * titolare dall'archivio.
 */
export function PpipPage() {
  const { id } = useParams<{ id: string }>();
  const record = useApi<{ paziente: Patient; riepilogo: Summary | null }>(`/api/pazienti/${id}`);
  const list = useApi<{
    prestazioni: PpipRecord[];
    puoScrivere: boolean;
    archivio: string;
    spostamenti: ArchiveMove[];
  }>(`/api/pazienti/${id}/ppip`);
  const [saved, setSaved] = useState<string | null>(null);
  if (record.loading && !record.data) return <Loading what="dati della cartella" />;
  if (!record.data) return <ErrorMessage error={record.error} />;
  const p = record.data.paziente;
  const canWrite = list.data?.puoScrivere ?? false;
  const refresh = (message: string) => {
    setSaved(message);
    list.reload();
  };

  return (
    <>
      <PageHeader
        title="Prestazioni aggiuntive"
        trail={
          <>
            <Link to={`/pazienti/${id}`}>
              {p.firstName} {p.lastName}
            </Link>{' '}
            <span aria-hidden="true">/</span> <span>Prestazioni aggiuntive</span>
          </>
        }
      />
      <PatientBanner patient={p} summary={record.data.riepilogo} />
      {canWrite && list.data && (
        <PpipForm
          patientId={id!}
          archiveId={list.data.archivio}
          moves={list.data.spostamenti ?? []}
          onSaved={() => refresh('Prestazione registrata.')}
        />
      )}
      {saved && <Notice kind="fatto">{saved}</Notice>}
      <section className="riquadro" aria-labelledby="titolo-ppip">
        <h2 id="titolo-ppip">Prestazioni registrate</h2>
        {list.loading && !list.data && <Loading what="prestazioni aggiuntive" />}
        <ErrorMessage error={list.error} />
        {list.data && list.data.prestazioni.length === 0 && (
          <p className="tenue">Nessuna prestazione aggiuntiva registrata.</p>
        )}
        {list.data && list.data.prestazioni.length > 0 && (
          <ul className="voci">
            {list.data.prestazioni.map((r) => (
              <PpipItem key={r.id} r={r} patientId={id!} canWrite={canWrite} onChanged={refresh} />
            ))}
          </ul>
        )}
        <p className="aiuto">
          La distinta del mese, con data, nome, cognome, indirizzo e codice fiscale per ogni
          prestazione (ACN, allegato 6, comma 4), è nell’archivio: «Prestazioni aggiuntive».
        </p>
      </section>
    </>
  );
}

function PpipItem({
  r,
  patientId,
  canWrite,
  onChanged,
}: {
  r: PpipRecord;
  patientId: string;
  canWrite: boolean;
  onChanged: (message: string) => void;
}) {
  const [annulling, setAnnulling] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<ApiError | null>(null);
  const annulled = r.stato === 'annullata';

  async function annul(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api(`/api/pazienti/${patientId}/ppip/${r.id}/annulla`, {
        method: 'POST',
        body: { motivo: reason },
      });
      setAnnulling(false);
      onChanged('Prestazione annullata.');
    } catch (err) {
      setError(failure(err));
    }
  }

  return (
    <li className={`voce${annulled ? ' voce-annullata' : ''}`}>
      <p className="voce-testo">
        <span className="codice">{r.codice}</span>{' '}
        <strong className={annulled ? 'testo-annullato' : undefined}>{r.descrizione}</strong>
      </p>
      <p className="voce-dati">
        <span>{date(r.data)}</span>
        <span>
          {r.quantita} × {r.nomeLuogo.toLowerCase()}
        </span>
        {r.importo !== null && <span>{money(r.importo)}</span>}
        {r.autorizzazione && <span>Autorizzazione: {r.autorizzazione}</span>}
        <span className="etichetta">
          {annulled
            ? 'Annullata'
            : r.inviata
              ? `Inviata all’ASL${r.protocolloInvio ? ` (${r.protocolloInvio})` : ''}`
              : r.inInvio
                ? 'In invio con la distinta'
                : 'Da inviare'}
        </span>
        <span className="tenue">registrata da {r.registrataDa}</span>
      </p>
      {r.altroArchivio && (
        <p className="tenue">
          Nella distinta dell’archivio «{r.altroArchivio}», che aveva il paziente il giorno
          dell’esecuzione: lì si annulla.
        </p>
      )}
      {r.note && <p className="tenue">Note: {r.note}</p>}
      {annulled && r.motivoAnnullamento && (
        <p className="tenue">Motivo dell’annullamento: {r.motivoAnnullamento}</p>
      )}
      {canWrite && !annulled && !r.inviata && !r.inInvio && !r.altroArchivio && (
        <div className="azioni">
          <button
            type="button"
            className="pulsante pulsante-piatto"
            aria-expanded={annulling}
            onClick={() => setAnnulling((v) => !v)}
          >
            <Icon name="annulla" /> <span>Annulla</span>
            <span className="visivamente-nascosto">
              {' '}
              {r.codice} del {date(r.data)}
            </span>
          </button>
        </div>
      )}
      {annulling && (
        <form className="modulo-in-riga" onSubmit={(e) => void annul(e)}>
          <div className="campo">
            <label htmlFor={`motivo-ppip-${r.id}`}>Motivo dell’annullamento</label>
            <input
              id={`motivo-ppip-${r.id}`}
              required
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <button type="submit" className="pulsante pulsante-primario">
            <Icon name="annulla" /> <span>Conferma l’annullamento</span>
          </button>
        </form>
      )}
      <ErrorMessage error={error} />
    </li>
  );
}

function PpipForm({
  patientId,
  archiveId,
  moves,
  onSaved,
}: {
  patientId: string;
  archiveId: string;
  /** Spostamenti del paziente fra gli archivi: dicono chi lo aveva il giorno dell'esecuzione. */
  moves: ArchiveMove[];
  onSaved: () => void;
}) {
  const today = studioToday();
  const empty = {
    data: today,
    codice: '',
    quantita: '1',
    luogo: 'studio',
    autorizzazione: '',
    note: '',
    archivio: '',
  };
  // Ricordato per paziente finché non si registra (D68, D129).
  const [f, setF, resetF] = usePersistentState(`bozza-ppip-${patientId}`, empty);
  const validDate = /^\d{4}-\d{2}-\d{2}$/.test(f.data);
  // La distinta è di chi aveva il paziente il giorno dell'esecuzione (D240): il giorno di uno
  // spostamento la sceglie chi registra.
  const options = validDate ? archivesOnDay(moves, archiveId, f.data) : [archiveId];
  const names = archiveNames(moves);
  const choosing = options.length > 1;
  const chosen = choosing && options.includes(f.archivio ?? '') ? f.archivio : '';
  const target = choosing ? chosen || archiveId : options[0]!;
  const catalog = useApi<{ data: string; voci: CatalogItem[] }>(
    validDate
      ? // Con gli accordi della regione e dell'ASL dell'archivio della distinta (D232, D240).
        `/api/prestazioni-aggiuntive/catalogo?data=${f.data}&archivio=${target}`
      : null,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const set = (k: keyof typeof empty) => (e: { target: { value: string } }) =>
    setF((x) => ({ ...x, [k]: e.target.value }));
  const voci = catalog.data?.voci ?? [];
  const item = voci.find((v) => v.codice === f.codice);
  const sections = [...new Set(voci.map((v) => v.sezione))];

  async function submit(e: FormEvent) {
    e.preventDefault();
    // Il giorno dello spostamento la distinta non si indovina: si sceglie (D240).
    if (choosing && !chosen) {
      setError(
        new ApiError(
          400,
          `Il ${date(f.data)} il paziente è passato a un altro archivio: scegli in quale distinta va la prestazione.`,
        ),
      );
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api(`/api/pazienti/${patientId}/ppip`, {
        method: 'POST',
        body: {
          data: f.data,
          codice: f.codice,
          quantita: Number(f.quantita),
          luogo: f.luogo,
          autorizzazione: f.autorizzazione.trim() || undefined,
          note: f.note.trim() || undefined,
          archivio: choosing ? chosen || undefined : undefined,
        },
      });
      resetF();
      onSaved();
    } catch (err) {
      setError(failure(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="riquadro" onSubmit={(e) => void submit(e)} aria-labelledby="titolo-nuova-ppip">
      <h2 id="titolo-nuova-ppip">
        <Icon name="aggiungi" /> Nuova prestazione aggiuntiva
      </h2>
      <fieldset disabled={busy}>
        <legend className="visivamente-nascosto">Dati della prestazione</legend>
        <div className="campi-in-riga">
          <div className="campo campo-stretto">
            <label htmlFor="ppip-data">Data dell’esecuzione</label>
            <input
              id="ppip-data"
              type="date"
              required
              max={today}
              value={f.data}
              onChange={set('data')}
            />
          </div>
          <div className="campo">
            <label htmlFor="ppip-codice">Prestazione</label>
            <select
              id="ppip-codice"
              required
              value={f.codice}
              aria-describedby="ppip-voce"
              onChange={set('codice')}
            >
              <option value="">Scegli la prestazione</option>
              {sections.map((sec) => (
                <optgroup key={sec} label={SECTION_LABEL(sec)}>
                  {voci
                    .filter((v) => v.sezione === sec)
                    .map((v) => (
                      <option key={v.codice} value={v.codice}>
                        {v.codice} · {v.descrizione}
                        {v.compenso !== null ? ` (${money(v.compenso)})` : ''}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </div>
        </div>
        {!choosing && target !== archiveId && (
          <Notice kind="info">
            Va nella distinta dell’archivio «{names.get(target) ?? target}»: il {date(f.data)} il
            paziente era nel suo archivio, e il compenso è del medico che ha eseguito la
            prestazione.
          </Notice>
        )}
        {choosing && (
          <fieldset className="scelta-in-riga">
            <legend>
              In quale distinta va? Il {date(f.data)} il paziente è passato a un altro archivio:
              scegli quello del medico che lo aveva quando la prestazione è stata eseguita.
            </legend>
            {options.map((a, i) => (
              <div className="casella" key={a}>
                <input
                  id={`ppip-archivio-${a}`}
                  type="radio"
                  name="ppip-archivio"
                  required
                  checked={chosen === a}
                  onChange={() => setF((x) => ({ ...x, archivio: a }))}
                />
                <label htmlFor={`ppip-archivio-${a}`}>
                  {names.get(a) ?? a}
                  {i === 0 ? ' (prima dello spostamento)' : ' (dopo lo spostamento)'}
                </label>
              </div>
            ))}
          </fieldset>
        )}
        <div id="ppip-voce" className="aiuto">
          {catalog.data && voci.length === 0 && (
            <Notice kind="avviso">
              Nessun catalogo delle prestazioni aggiuntive in vigore il {date(f.data)}: va importato
              con le banche dati, dopo il controllo della trascrizione.
            </Notice>
          )}
          {item?.note && <p>{item.note}</p>}
          {item?.atto && <p className="tenue">Fonte: {item.atto}.</p>}
        </div>
        <div className="campi-in-riga">
          <div className="campo campo-stretto">
            <label htmlFor="ppip-quantita">Quantità</label>
            <input
              id="ppip-quantita"
              required
              inputMode="numeric"
              pattern="[0-9]{1,2}"
              value={f.quantita}
              onChange={set('quantita')}
            />
          </div>
          <fieldset className="scelta-in-riga">
            <legend>Dove</legend>
            {(['studio', 'domicilio'] as const).map((k) => (
              <div className="casella" key={k}>
                <input
                  id={`ppip-luogo-${k}`}
                  type="radio"
                  name="ppip-luogo"
                  checked={f.luogo === k}
                  onChange={() => setF((x) => ({ ...x, luogo: k }))}
                />
                <label htmlFor={`ppip-luogo-${k}`}>
                  {k === 'studio' ? 'In studio' : 'A domicilio'}
                </label>
              </div>
            ))}
          </fieldset>
        </div>
        <div className="campi-in-riga">
          <div className="campo">
            <label htmlFor="ppip-autorizzazione">
              Estremi dell’autorizzazione{item?.autorizzazione ? '' : ' (se c’è)'}
            </label>
            <input
              id="ppip-autorizzazione"
              required={item?.autorizzazione ?? false}
              maxLength={200}
              aria-describedby="ppip-autorizzazione-aiuto"
              value={f.autorizzazione}
              onChange={set('autorizzazione')}
            />
            <p className="aiuto" id="ppip-autorizzazione-aiuto">
              Per le prestazioni della sezione B: l’autorizzazione va mandata con la distinta (ACN,
              allegato 6, comma 5).
            </p>
          </div>
          <div className="campo">
            <label htmlFor="ppip-note">Note</label>
            <input id="ppip-note" maxLength={500} value={f.note} onChange={set('note')} />
          </div>
        </div>
        <div className="azioni">
          <button type="submit" className="pulsante pulsante-primario">
            <Icon name="fatto" /> <span>Registra la prestazione</span>
          </button>
        </div>
      </fieldset>
      <ErrorMessage error={error} />
    </form>
  );
}
