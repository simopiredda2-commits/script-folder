import { date } from '../lib/format';
import { Icon } from './Icon';

/** Un registro di monitoraggio o un piano terapeutico AIFA per lo stesso ATC del farmaco (D206). */
export interface DrugRegistry {
  /** Il farmaco del registro, come lo scrive AIFA. */
  name: string;
  activeIngredient: string | null;
  atc: string | null;
  /** «Registro», «Piano Terapeutico», «Registro semplificato»…: come lo scrive AIFA. */
  type: string | null;
  state: string | null;
  condition: string | null;
  /** «Indicazione rimborsata» dell'elenco, con le sue parole. */
  indication: string | null;
  since: string | null;
  /** La scheda sul sito di AIFA; null se l'indirizzo non è in https su aifa.gov.it. */
  sheetUrl: string | null;
}

/** Nei risultati della ricerca: i registri in una riga, per nome e tipo (D206). */
export function RegistryNote({ registries }: { registries: readonly DrugRegistry[] }) {
  if (!registries.length) return null;
  const items = registries.map((r) => (r.type ? `${r.name} (${r.type})` : r.name));
  return (
    <span className="registro-aifa">
      <Icon name="info" />
      <span>
        <strong>Registri e piani AIFA</strong> per lo stesso ATC: {[...new Set(items)].join(', ')}.
      </span>
    </span>
  );
}

/**
 * Nei dati del farmaco: ogni registro con tipo, data, patologia e indicazione rimborsata, con le
 * parole dell'elenco AIFA, e il collegamento alla scheda. Il programma non dice se il registro
 * riguarda il paziente (regola 3): lo dice l'elenco, per farmaco e indicazione.
 */
export function RegistryDetails({ registries }: { registries: readonly DrugRegistry[] }) {
  if (!registries.length) return null;
  return (
    <div className="registro-aifa registro-aifa-dettagli">
      <Icon name="info" />
      <div>
        <strong>Registri e piani AIFA</strong> per lo stesso ATC, dall’elenco dei registri attivi:
        <ul className="elenco-semplice">
          {registries.map((r, i) => (
            <li key={`${r.name}-${r.condition ?? ''}-${i}`}>
              <strong>{r.name}</strong>
              {r.type ? `: ${r.type}` : ''}
              {r.state ? `, ${r.state.toLowerCase()}` : ''}
              {r.since ? ` dal ${date(r.since)}` : ''}
              {r.condition ? `. ${r.condition}` : ''}.
              {r.indication && (
                <span className="registro-aifa-indicazione">
                  {' '}
                  Indicazione rimborsata: {r.indication}
                </span>
              )}
              {r.sheetUrl && (
                <>
                  {' '}
                  <a href={r.sheetUrl} target="_blank" rel="noreferrer">
                    scheda di {r.name} sul sito di AIFA
                  </a>
                </>
              )}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
