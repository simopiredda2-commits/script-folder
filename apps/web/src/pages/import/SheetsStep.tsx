import { useId } from 'react';
import { Icon } from '../../components/Icon';
import { filterValues, tableKey } from './drafts';
import type { Catalog, PartDraft, TableInfo, Upload } from './types';

/**
 * Passo 2: dove vanno i dati. Per ogni foglio, la riga d'intestazione e una o più destinazioni;
 * una destinazione può prendere solo le righe con certi valori in una colonna (per esempio la
 * colonna «tipo» con «ALL» per le allergie e «PAT» per i problemi).
 */
export function SheetsStep({
  catalog,
  upload,
  tables,
  parts,
  onHeader,
  onChange,
  onAdd,
  onRemove,
}: {
  catalog: Catalog;
  upload: Upload;
  tables: Record<string, TableInfo>;
  parts: PartDraft[];
  onHeader: (tabella: string, intestazione: number) => void;
  onChange: (key: string, patch: Partial<PartDraft>) => void;
  onAdd: (tabella: string) => void;
  onRemove: (key: string) => void;
}) {
  return (
    <>
      {upload.tabelle.map((t) => {
        const own = parts.filter((p) => p.tabella === t.nome);
        const header = own[0]?.intestazione ?? t.intestazione;
        const info = tables[tableKey(t.nome, header)] ?? t;
        return (
          <SheetBlock
            key={t.nome}
            catalog={catalog}
            table={t}
            info={info}
            header={header}
            parts={own}
            onHeader={onHeader}
            onChange={onChange}
            onAdd={onAdd}
            onRemove={onRemove}
          />
        );
      })}
    </>
  );
}

function SheetBlock({
  catalog,
  table,
  info,
  header,
  parts,
  onHeader,
  onChange,
  onAdd,
  onRemove,
}: {
  catalog: Catalog;
  table: TableInfo;
  info: TableInfo;
  header: number;
  parts: PartDraft[];
  onHeader: (tabella: string, intestazione: number) => void;
  onChange: (key: string, patch: Partial<PartDraft>) => void;
  onAdd: (tabella: string) => void;
  onRemove: (key: string) => void;
}) {
  const id = useId();
  const sample = table.inizio;
  const width = Math.min(info.larghezza, 12);
  return (
    <fieldset className="riquadro">
      <legend>
        Foglio «{table.nome}» · {info.righe.toLocaleString('it-IT')} righe di dati
      </legend>
      <div className="tabella-scorrevole">
        <table className="tabella">
          <caption>Prime righe del foglio, come sono nel file</caption>
          <thead>
            <tr>
              <th scope="col">Riga</th>
              {Array.from({ length: width }, (_, i) => (
                <th key={i} scope="col">
                  {info.colonne[i]?.lettera ?? ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sample.map((r) => (
              <tr key={r.riga}>
                <th scope="row" className="numero">
                  {r.riga}
                </th>
                {Array.from({ length: width }, (_, i) => (
                  <td key={i}>{r.celle[i] ?? ''}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {info.larghezza > width && (
        <p className="aiuto">
          Sono mostrate le prime {width} colonne di {info.larghezza}.
        </p>
      )}
      <div className="campo">
        <label htmlFor={`${id}-intestazione`}>Riga con i nomi delle colonne</label>
        <select
          id={`${id}-intestazione`}
          value={header}
          onChange={(e) => onHeader(table.nome, Number(e.target.value))}
        >
          <option value={0}>Nessuna: le colonne si chiamano per lettera (A, B, C…)</option>
          {sample.map((r) => (
            <option key={r.riga} value={r.riga}>
              Riga {r.riga}: {r.celle.filter(Boolean).slice(0, 4).join(' · ')}
            </option>
          ))}
        </select>
      </div>
      {parts.length === 0 ? (
        <p>
          <Icon name="info" /> Questo foglio non si importa.
        </p>
      ) : (
        parts.map((p, n) => (
          <PartBlock
            key={p.key}
            index={n}
            catalog={catalog}
            info={info}
            part={p}
            onChange={onChange}
            onRemove={onRemove}
          />
        ))
      )}
      <div className="azioni">
        <button type="button" className="pulsante" onClick={() => onAdd(table.nome)}>
          <Icon name="aggiungi" />{' '}
          {parts.length
            ? 'Aggiungi un’altra destinazione per questo foglio'
            : 'Importa questo foglio'}
        </button>
      </div>
    </fieldset>
  );
}

function PartBlock({
  index,
  catalog,
  info,
  part,
  onChange,
  onRemove,
}: {
  index: number;
  catalog: Catalog;
  info: TableInfo;
  part: PartDraft;
  onChange: (key: string, patch: Partial<PartDraft>) => void;
  onRemove: (key: string) => void;
}) {
  const id = useId();
  const dest = catalog.destinazioni.find((d) => d.key === part.destinazione);
  const filterColumn = info.colonne.find((c) => c.lettera === part.filtroColonna);
  const chosen = new Set(filterValues(part.filtroValori));
  const filtered = part.filtroColonna !== '';
  return (
    <div className="riquadro">
      <h4>Destinazione {index + 1}</h4>
      <div className="campo">
        <label htmlFor={`${id}-dest`}>Dove vanno le righe</label>
        <select
          id={`${id}-dest`}
          value={part.destinazione}
          onChange={(e) => onChange(part.key, { destinazione: e.target.value })}
          aria-describedby={dest ? `${id}-menu` : undefined}
        >
          <option value="">— scegli il menu della cartella —</option>
          {catalog.destinazioni.map((d) => (
            <option key={d.key} value={d.key}>
              {d.label}
            </option>
          ))}
        </select>
        {dest && (
          <p id={`${id}-menu`} className="aiuto">
            In cartella: {dest.menu}. {dest.notes}
          </p>
        )}
      </div>
      <div className="casella">
        <input
          id={`${id}-filtro`}
          type="checkbox"
          checked={filtered}
          onChange={(e) =>
            onChange(part.key, {
              filtroColonna: e.target.checked ? (info.colonne[0]?.lettera ?? 'A') : '',
              filtroValori: '',
            })
          }
        />
        <label htmlFor={`${id}-filtro`}>Solo le righe con certi valori in una colonna</label>
      </div>
      {filtered && (
        <div className="campi-in-riga">
          <div className="campo">
            <label htmlFor={`${id}-fcol`}>Colonna che decide</label>
            <select
              id={`${id}-fcol`}
              value={part.filtroColonna}
              onChange={(e) =>
                onChange(part.key, { filtroColonna: e.target.value, filtroValori: '' })
              }
            >
              {info.colonne.map((c) => (
                <option key={c.lettera} value={c.lettera}>
                  {c.lettera} · {c.nome}
                </option>
              ))}
            </select>
          </div>
          {filterColumn?.valori ? (
            <fieldset className="campo">
              <legend>Valori che vanno qui</legend>
              {filterColumn.valori.map((v, i) => (
                <div key={v} className="casella">
                  <input
                    id={`${id}-fv-${i}`}
                    type="checkbox"
                    checked={chosen.has(v)}
                    onChange={(e) => {
                      const next = new Set(chosen);
                      if (e.target.checked) next.add(v);
                      else next.delete(v);
                      onChange(part.key, { filtroValori: [...next].join('\n') });
                    }}
                  />
                  <label htmlFor={`${id}-fv-${i}`}>{v}</label>
                </div>
              ))}
            </fieldset>
          ) : (
            <div className="campo">
              <label htmlFor={`${id}-fvt`}>Valori che vanno qui (uno per riga)</label>
              <textarea
                id={`${id}-fvt`}
                rows={3}
                value={part.filtroValori}
                onChange={(e) => onChange(part.key, { filtroValori: e.target.value })}
              />
            </div>
          )}
        </div>
      )}
      <div className="azioni">
        <button
          type="button"
          className="pulsante pulsante-piatto"
          onClick={() => onRemove(part.key)}
        >
          <Icon name="annulla" /> Togli questa destinazione
        </button>
      </div>
    </div>
  );
}
