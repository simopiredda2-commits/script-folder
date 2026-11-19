import { useId, useState } from 'react';
import { Icon } from '../../components/Icon';
import { date } from '../../lib/format';
import type { Catalog, Counts, PreviewResult, ReportRow } from './types';
import { OUTCOME_KIND, OUTCOME_LABELS } from './types';

const ICON = { fatto: 'fatto', info: 'info', avviso: 'avviso', errore: 'blocco' } as const;

/** Un valore trasformato come lo vede il medico: date in GG/MM/AAAA, sì e no in parole. */
const show = (v: string | number | boolean | null | undefined, kind?: string) =>
  v === null || v === undefined
    ? '—'
    : typeof v === 'boolean'
      ? v
        ? 'Sì'
        : 'No'
      : kind === 'date' && typeof v === 'string'
        ? date(v)
        : String(v);

/** Passo 4: le prime righe trasformate di ogni destinazione, con i problemi. */
export function PreviewView({ catalog, preview }: { catalog: Catalog; preview: PreviewResult }) {
  return (
    <>
      {preview.parti.map((p) => {
        const dest = catalog.destinazioni.find((d) => d.key === p.destinazione);
        const keys = [...new Set(p.righe.flatMap((r) => Object.keys(r.valori)))];
        const label = (k: string) => dest?.fields.find((f) => f.key === k)?.label ?? k;
        const kind = (k: string) => dest?.fields.find((f) => f.key === k)?.kind;
        return (
          <div key={p.indice} className="tabella-scorrevole">
            <table className="tabella">
              <caption>
                {dest?.label ?? p.destinazione} dal foglio «{p.tabella}»: prime {p.righe.length}{' '}
                righe di {p.totale.toLocaleString('it-IT')}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Riga</th>
                  {keys.map((k) => (
                    <th key={k} scope="col">
                      {label(k)}
                    </th>
                  ))}
                  <th scope="col">Controlli</th>
                </tr>
              </thead>
              <tbody>
                {p.righe.map((r) => (
                  <tr key={r.riga}>
                    <th scope="row" className="numero">
                      {r.riga}
                    </th>
                    {keys.map((k) => (
                      <td key={k}>{show(r.valori[k], kind(k))}</td>
                    ))}
                    <td>
                      <Checks errors={r.errori} warnings={r.avvisi} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </>
  );
}

function Checks({ errors, warnings }: { errors: string[]; warnings: string[] }) {
  if (!errors.length && !warnings.length)
    return (
      <span className="esito-aggiornamento esito-fatto">
        <Icon name="fatto" /> Va bene
      </span>
    );
  return (
    <ul className="elenco-semplice">
      {errors.map((e) => (
        <li key={e} className="esito-errore">
          <Icon name="blocco" /> <strong>Da correggere:</strong> {e}
        </li>
      ))}
      {warnings.map((w) => (
        <li key={w} className="esito-avviso">
          <Icon name="avviso" /> <strong>Avviso:</strong> {w}
        </li>
      ))}
    </ul>
  );
}

/** Conteggi della prova o dell'importazione, in parole. */
export function CountsView({ counts, dryRun }: { counts: Counts; dryRun: boolean }) {
  const written = dryRun ? 'Righe che si scriverebbero' : 'Righe scritte';
  return (
    <dl className="dati">
      <dt>Righe lette</dt>
      <dd>{counts.righe.toLocaleString('it-IT')}</dd>
      <dt>{written}</dt>
      <dd>{counts.scritte.toLocaleString('it-IT')}</dd>
      <dt>Voci {dryRun ? 'che si scriverebbero' : 'scritte'} (una riga può darne più d’una)</dt>
      <dd>{counts.voci.toLocaleString('it-IT')}</dd>
      <dt>Pazienti nuovi</dt>
      <dd>{counts.pazientiNuovi.toLocaleString('it-IT')}</dd>
      <dt>Pazienti già in cartella completati</dt>
      <dd>{counts.pazientiCompletati}</dd>
      <dt>Già presenti</dt>
      <dd>{counts.giaPresenti.toLocaleString('it-IT')}</dd>
      <dt>Doppioni nel file</dt>
      <dd>{counts.doppioni.toLocaleString('it-IT')}</dd>
      <dt>Scartate</dt>
      <dd>{counts.scartate.toLocaleString('it-IT')}</dd>
      <dt>Con avvisi</dt>
      <dd>{counts.conAvvisi.toLocaleString('it-IT')}</dd>
      {counts.escluse > 0 && (
        <>
          <dt>Righe senza destinazione</dt>
          <dd>{counts.escluse.toLocaleString('it-IT')}</dd>
        </>
      )}
    </dl>
  );
}

const SHOWN = 300;

/** Rapporto riga per riga, con un filtro per esito. */
export function ReportView({
  catalog,
  rows,
  truncated,
}: {
  catalog: Catalog;
  rows: ReportRow[];
  truncated: boolean;
}) {
  const id = useId();
  const [filter, setFilter] = useState<'problemi' | 'tutte' | 'scartata' | 'avvisi'>('problemi');
  const selected = rows.filter((r) =>
    filter === 'tutte'
      ? true
      : filter === 'scartata'
        ? r.esito === 'scartata'
        : filter === 'avvisi'
          ? r.avvisi.length > 0
          : r.esito === 'scartata' || r.esito === 'doppione' || r.avvisi.length > 0,
  );
  const label = (k: string) => catalog.destinazioni.find((d) => d.key === k)?.label ?? k;
  return (
    <>
      <div className="campo campo-stretto">
        <label htmlFor={`${id}-filtro`}>Righe del rapporto da mostrare</label>
        <select
          id={`${id}-filtro`}
          value={filter}
          onChange={(e) => setFilter(e.target.value as typeof filter)}
        >
          <option value="problemi">Scartate, doppioni e con avvisi</option>
          <option value="scartata">Solo le scartate</option>
          <option value="avvisi">Solo quelle con avvisi</option>
          <option value="tutte">Tutte</option>
        </select>
      </div>
      {selected.length === 0 ? (
        <p>
          <Icon name="fatto" /> Nessuna riga da mostrare con questo filtro.
        </p>
      ) : (
        <div className="tabella-scorrevole">
          <table className="tabella">
            <caption>
              Rapporto riga per riga
              {selected.length > SHOWN ? `: prime ${SHOWN} di ${selected.length}` : ''}
            </caption>
            <thead>
              <tr>
                <th scope="col">Foglio e riga</th>
                <th scope="col">Destinazione</th>
                <th scope="col">Esito</th>
                <th scope="col">Motivi e avvisi</th>
              </tr>
            </thead>
            <tbody>
              {selected.slice(0, SHOWN).map((r) => {
                const kind = OUTCOME_KIND[r.esito];
                return (
                  <tr key={`${r.parte}-${r.riga}`}>
                    <th scope="row">
                      {r.tabella}, riga {r.riga}
                    </th>
                    <td>{label(r.destinazione)}</td>
                    <td>
                      <span className={`esito-aggiornamento esito-${kind}`}>
                        <Icon name={ICON[kind]} /> {OUTCOME_LABELS[r.esito]}
                      </span>
                    </td>
                    <td>
                      {r.motivi.join(' · ')}
                      {r.avvisi.length > 0 && (
                        <p className="esito-avviso">
                          <Icon name="avviso" /> <strong>Avvisi:</strong> {r.avvisi.join(' · ')}
                        </p>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {truncated && (
        <p className="aiuto">
          Il rapporto salvato contiene le prime righe; i conteggi sono completi.
        </p>
      )}
    </>
  );
}
