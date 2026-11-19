import { useId, useState } from 'react';
import { Icon } from '../../components/Icon';
import { emptyField, tableKey } from './drafts';
import type { Catalog, CatalogField, FieldDraft, PartDraft, TableInfo } from './types';

/**
 * Passo 3: colonne e campi. Per ogni campo della destinazione: da quale colonna, o lo stesso valore
 * per tutte le righe, con le trasformazioni (formato delle date, tabelle di corrispondenza dei
 * valori). Le colonne proposte dal programma sono segnate «suggerita»: decide il medico.
 */
export function FieldsStep({
  catalog,
  tables,
  parts,
  onField,
}: {
  catalog: Catalog;
  tables: Record<string, TableInfo>;
  parts: PartDraft[];
  onField: (partKey: string, field: string, patch: Partial<FieldDraft>) => void;
}) {
  return (
    <>
      {parts.map((p) => {
        const dest = catalog.destinazioni.find((d) => d.key === p.destinazione);
        const info = tables[tableKey(p.tabella, p.intestazione)];
        if (!dest || !info) return null;
        return (
          <section key={p.key} className="riquadro" aria-labelledby={`${p.key}-titolo`}>
            <h4 id={`${p.key}-titolo`}>
              Foglio «{p.tabella}» → {dest.label}
            </h4>
            <p className="aiuto">
              In cartella: {dest.menu}. {dest.notes}
            </p>
            <div className="tabella-scorrevole">
              <table className="tabella">
                <caption>Campi di «{dest.label}»: i campi obbligatori sono segnati</caption>
                <thead>
                  <tr>
                    <th scope="col">Campo</th>
                    <th scope="col">Da dove arriva</th>
                    <th scope="col">Valore o trasformazione</th>
                  </tr>
                </thead>
                <tbody>
                  {dest.fields.map((f) => (
                    <FieldRow
                      key={f.key}
                      catalog={catalog}
                      field={f}
                      info={info}
                      draft={p.campi[f.key] ?? emptyField()}
                      onChange={(patch) => onField(p.key, f.key, patch)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        );
      })}
    </>
  );
}

function FieldRow({
  catalog,
  field,
  info,
  draft,
  onChange,
}: {
  catalog: Catalog;
  field: CatalogField;
  info: TableInfo;
  draft: FieldDraft;
  onChange: (patch: Partial<FieldDraft>) => void;
}) {
  const id = useId();
  const [showTable, setShowTable] = useState(false);
  const source =
    draft.modo === 'colonna' ? `col:${draft.colonna}` : draft.modo === 'costante' ? 'costante' : '';
  const column = info.colonne.find((c) => c.lettera === draft.colonna);
  const choices =
    field.kind === 'choice'
      ? (field.choices ?? [])
      : field.kind === 'boolean'
        ? [
            { key: 'sì', label: 'Sì' },
            { key: 'no', label: 'No' },
          ]
        : null;
  const canMap = draft.modo === 'colonna' && choices && column?.valori;
  return (
    <tr>
      <th scope="row">
        <span id={`${id}-nome`}>{field.label}</span>
        {field.required && <strong> (obbligatorio)</strong>}
        {draft.suggerito && draft.modo === 'colonna' && (
          <>
            {' '}
            <span className="etichetta">
              <Icon name="info" size={16} /> colonna suggerita dal nome
            </span>
          </>
        )}
        {field.hint && <p className="aiuto">{field.hint}</p>}
      </th>
      <td>
        <label className="visivamente-nascosto" htmlFor={`${id}-da`}>
          Da dove arriva «{field.label}»
        </label>
        <select
          id={`${id}-da`}
          value={source}
          onChange={(e) => {
            const v = e.target.value;
            if (v === '') onChange({ modo: 'nessuno', suggerito: false });
            else if (v === 'costante') onChange({ modo: 'costante', suggerito: false });
            else onChange({ modo: 'colonna', colonna: v.slice(4), suggerito: false });
          }}
        >
          <option value="">{field.required ? '— da scegliere —' : 'Non importare'}</option>
          <option value="costante">Lo stesso valore per tutte le righe</option>
          {info.colonne.map((c) => (
            <option key={c.lettera} value={`col:${c.lettera}`}>
              Colonna {c.lettera}
              {c.nome && !c.nome.startsWith('Colonna ') ? ` · ${c.nome}` : ''}
              {c.piene === 0 ? ' (vuota)' : ''}
            </option>
          ))}
        </select>
      </td>
      <td>
        {draft.modo === 'costante' &&
          (choices ? (
            <>
              <label className="visivamente-nascosto" htmlFor={`${id}-valore`}>
                Valore di «{field.label}» per tutte le righe
              </label>
              <select
                id={`${id}-valore`}
                value={draft.costante}
                onChange={(e) => onChange({ costante: e.target.value })}
              >
                <option value="">— scegli —</option>
                {choices.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
            </>
          ) : (
            <>
              <label className="visivamente-nascosto" htmlFor={`${id}-valore`}>
                Valore di «{field.label}» per tutte le righe
              </label>
              <input
                id={`${id}-valore`}
                value={draft.costante}
                maxLength={200}
                onChange={(e) => onChange({ costante: e.target.value })}
              />
            </>
          ))}
        {field.kind === 'date' && draft.modo !== 'nessuno' && (
          <>
            <label className="visivamente-nascosto" htmlFor={`${id}-formato`}>
              Come sono scritte le date di «{field.label}»
            </label>
            <select
              id={`${id}-formato`}
              value={draft.formatoData}
              onChange={(e) =>
                onChange({ formatoData: e.target.value as FieldDraft['formatoData'] })
              }
            >
              {catalog.formatiData.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </select>
          </>
        )}
        {(field.kind === 'number' || field.kind === 'integer') && draft.modo === 'colonna' && (
          <p className="aiuto">{catalog.regolaNumeri}</p>
        )}
        {field.kind === 'boolean' && draft.modo === 'colonna' && (
          <p className="aiuto">
            Si leggono come sì: {catalog.valoriSi.join(', ')}; come no:{' '}
            {catalog.valoriNo.join(', ')}.
          </p>
        )}
        {canMap && (
          <>
            <button
              type="button"
              className="pulsante pulsante-piatto"
              aria-expanded={showTable}
              aria-controls={`${id}-corrispondenze`}
              onClick={() => setShowTable((x) => !x)}
            >
              <Icon name="terapia" /> Corrispondenze dei valori ({column.valori!.length})
            </button>
            {showTable && (
              <table id={`${id}-corrispondenze`} className="tabella">
                <caption>Valori del file per «{field.label}» e valori della cartella</caption>
                <thead>
                  <tr>
                    <th scope="col">Nel file</th>
                    <th scope="col">In cartella</th>
                  </tr>
                </thead>
                <tbody>
                  {column.valori!.map((v, i) => (
                    <tr key={v}>
                      <th scope="row" className="codice">
                        {v}
                      </th>
                      <td>
                        <label className="visivamente-nascosto" htmlFor={`${id}-c-${i}`}>
                          Valore in cartella per «{v}»
                        </label>
                        <select
                          id={`${id}-c-${i}`}
                          value={draft.corrispondenze[v] ?? '__come__'}
                          onChange={(e) => {
                            const next = { ...draft.corrispondenze };
                            if (e.target.value === '__come__') delete next[v];
                            else next[v] = e.target.value;
                            onChange({ corrispondenze: next });
                          }}
                        >
                          <option value="__come__">Come nel file</option>
                          <option value="">Nessun valore</option>
                          {choices.map((c) => (
                            <option key={c.key} value={c.key}>
                              {c.label}
                            </option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </td>
    </tr>
  );
}
