import { useId, useState } from 'react';
import { query } from '../lib/api';
import { useApi } from '../lib/useApi';
import { useDebounced } from '../pages/PrescriptionEditor';
import { DataVersions, ErrorMessage, Notice, type DatasetVersion } from './common';
import { Icon } from './Icon';

/** Una diagnosi del catalogo ICD-9-CM, come la restituisce il servizio (D186). */
export interface Diagnosis {
  code: string;
  description: string;
  parentCode: string | null;
  includedTerms: string | null;
  notes: string | null;
  chapter: string | null;
  section: string | null;
  /** Ha sottocodici: per la codifica va scelto il codice più specifico. */
  category: boolean;
  /** I padri, dal più generale: danno il senso ai titoli brevi («Altro», «Linfonodi»). */
  path: { code: string; description: string }[];
}

interface SearchResponse {
  diagnosi: Diagnosis[];
  totale: number;
  versioni: DatasetVersion[];
}

/** La forma di un codice delle diagnosi, per non chiedere al servizio mentre si scrive. */
const CODE_SHAPE = /^[EV]?\d{2,3}(?:\.\d{1,2})?$/i;

function NoCatalog() {
  return (
    <Notice kind="info">
      Il catalogo ICD-9-CM non è in uso: entra dopo il controllo della trascrizione. Intanto il
      codice si scrive a mano.
    </Notice>
  );
}

/**
 * Ricerca delle diagnosi per descrizione o per codice (D186): parole in qualunque ordine, i titoli
 * dei padri per capire quelli brevi. Le categorie con sottocodici portano ai sottocodici; un codice
 * finale si usa con un pulsante. Non suggerisce diagnosi: cerca nella classificazione.
 */
export function DiagnosisSearch({
  onPick,
  label = 'Cerca il codice per descrizione',
}: {
  onPick: (d: Diagnosis) => void;
  label?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const q = useDebounced(text).trim();
  const search = useApi<SearchResponse>(open && q ? `/api/diagnosi${query({ q })}` : null);
  const hits = search.data?.diagnosi ?? [];
  const more = search.data ? search.data.totale - hits.length : 0;
  return (
    <div className="ricerca-diagnosi">
      <button
        type="button"
        className="pulsante pulsante-piatto"
        aria-expanded={open}
        aria-controls={`${id}-pannello`}
        onClick={() => setOpen((o) => !o)}
      >
        <Icon name="cerca" /> <span>{open ? 'Chiudi la ricerca' : label}</span>
      </button>
      {open && (
        <div id={`${id}-pannello`} className="riquadro-interno">
          <div role="search" className="ricerca">
            <label htmlFor={`${id}-q`}>Catalogo ICD-9-CM: parole della diagnosi o codice</label>
            <div className="ricerca-campo">
              <Icon name="cerca" />
              <input
                id={`${id}-q`}
                type="search"
                autoComplete="off"
                value={text}
                onChange={(e) => setText(e.target.value)}
                // Invio nella ricerca non salva il modulo intorno.
                onKeyDown={(e) => {
                  if (e.key === 'Enter') e.preventDefault();
                }}
              />
            </div>
            <p className="aiuto">Per esempio «asma riacutizzazione», «frattura colles» o 401.9.</p>
          </div>
          <ErrorMessage error={search.error} />
          {search.data && search.data.versioni.length === 0 ? (
            <NoCatalog />
          ) : (
            <>
              <ul className="risultati" aria-live="polite">
                {hits.map((d) => (
                  <li key={d.code} className="risultato">
                    <div>
                      <span className="codice">{d.code}</span> <strong>{d.description}</strong>
                      {d.path.length > 0 && (
                        <div className="tenue">{d.path.map((p) => p.description).join(' › ')}</div>
                      )}
                      {d.includedTerms && <div className="tenue">Comprende: {d.includedTerms}</div>}
                      {d.category && (
                        <div className="tenue">
                          Categoria: per la codifica si sceglie un sottocodice.
                        </div>
                      )}
                    </div>
                    {d.category ? (
                      <button
                        type="button"
                        className="pulsante pulsante-piatto"
                        onClick={() => setText(d.code)}
                      >
                        <Icon name="apri" /> <span>Sottocodici di {d.code}</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="pulsante"
                        onClick={() => {
                          onPick(d);
                          setOpen(false);
                        }}
                      >
                        <Icon name="fatto" /> <span>Usa {d.code}</span>
                      </button>
                    )}
                  </li>
                ))}
                {q && search.data && hits.length === 0 && (
                  <li className="tenue">Nessuna diagnosi per «{q}».</li>
                )}
              </ul>
              {more > 0 && (
                <p className="aiuto">
                  Altre {more} voci rispondono alla ricerca: aggiungi una parola per trovarle.
                </p>
              )}
              {search.data && (
                <DataVersions versions={search.data.versioni} label="Catalogo ICD-9-CM" />
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Il titolo del codice scritto nel campo, dal catalogo in uso (D186). Avvisa se il codice non c'è
 * (il Sistema TS rifiuta i codici che non conosce: errore 631) o se è una categoria con
 * sottocodici, che per la codifica non si usa (DM 28/10/2020, nota a V07.0). Senza catalogo in
 * uso non dice nulla: vale il controllo del formato.
 */
export function DiagnosisCodeInfo({ code }: { code: string }) {
  const c = useDebounced(code.trim());
  const info = useApi<{ diagnosi: Diagnosis | null; disponibile: boolean }>(
    CODE_SHAPE.test(c) ? `/api/diagnosi/${encodeURIComponent(c)}` : null,
  );
  if (!CODE_SHAPE.test(c) || !info.data?.disponibile) return null;
  const d = info.data.diagnosi;
  if (!d) {
    return (
      <Notice kind="avviso">
        Il codice {c} non è nel catalogo ICD-9-CM in uso: controllalo. Il Sistema TS rifiuta i
        codici che non conosce.
      </Notice>
    );
  }
  if (d.category) {
    return (
      <Notice kind="avviso">
        {d.code} · {d.description}: è una categoria con sottocodici. Per la codifica si usa il
        codice più specifico.
      </Notice>
    );
  }
  return (
    <p className="aiuto" role="status">
      <span className="codice">{d.code}</span> · {d.description}
    </p>
  );
}
