import { PRIORITY } from '../lib/format';
import { Notice } from './common';

/**
 * La condizione clinica secondo le tabelle RAO, Raggruppamenti di attesa omogenei (D285): il
 * medico sceglie la condizione del paziente e il programma mette la classe della tabella, che il
 * medico può cambiare. Senza la scelta del medico la classe resta vuota.
 */

export type RaoClass = 'U' | 'B' | 'D' | 'P';

export interface RaoIndication {
  /** La chiave che la ricetta conserva: fonte, tabella, riga e indicazione. */
  chiave: string;
  numero: string;
  testo: string;
  /** «Altro (10%)»: la condizione si descrive nel quesito. */
  altro: boolean;
}

export interface RaoRow {
  classe: 'emergenza' | RaoClass;
  pediatria: boolean;
  attesa: string;
  gruppo: string | null;
  daNota: boolean;
  nonPreviste: string | null;
  indicazioni: RaoIndication[];
}

/** Una tabella come la dà il servizio (`/api/rao/tabelle`). */
export interface RaoTable {
  fonte: string;
  titoloFonte: string;
  ambito: 'nazionale' | 'regionale';
  controllatoDa: string | null;
  noteDelDocumento: Record<string, string> | null;
  id: string;
  servizi: string[];
  testata: string;
  pagine: number[];
  note: string[];
  prestazioni: string[];
  righe: RaoRow[];
}

export interface RaoChoice {
  key: string;
  testo: string;
  classe: RaoClass;
  altro: boolean;
}

/** La condizione di una chiave, con la classe della sua riga; null per le righe d'emergenza. */
export function raoChoiceOf(tables: readonly RaoTable[], key: string): RaoChoice | null {
  if (!key) return null;
  for (const t of tables)
    for (const r of t.righe)
      for (const v of r.indicazioni)
        if (v.chiave === key && r.classe !== 'emergenza')
          return { key, testo: v.testo, classe: r.classe, altro: v.altro };
  return null;
}

/**
 * Che cosa cambia nella ricetta con la scelta della condizione: la classe è quella della
 * condizione; il quesito prende il testo della condizione se è vuoto o se è ancora il testo della
 * condizione di prima. Con «Altro» il quesito resta al medico, che descrive le condizioni.
 */
export function afterRaoChoice(
  choice: RaoChoice,
  before: RaoChoice | null,
  question: string,
): { priority: RaoClass; question: string } {
  const fill = !choice.altro && (!question.trim() || question === before?.testo);
  return { priority: choice.classe, question: fill ? choice.testo : question };
}

const selectable = (t: RaoTable) =>
  [...t.righe.filter((r) => !r.pediatria), ...t.righe.filter((r) => r.pediatria)].filter(
    (r) => r.classe !== 'emergenza' && r.indicazioni.length > 0,
  );

export function RaoConditionField({
  tables,
  value,
  priority,
  onChange,
}: {
  tables: readonly RaoTable[];
  /** La chiave della condizione scelta; vuota se nessuna. */
  value: string;
  /** La classe della ricetta, com'è adesso. */
  priority: string;
  onChange: (choice: RaoChoice | null) => void;
}) {
  const choice = raoChoiceOf(tables, value);
  const several = tables.length > 1;
  const emergency = tables.flatMap((t) =>
    t.righe
      .filter((r) => r.classe === 'emergenza' && r.indicazioni.length > 0)
      .map((r) => ({ t, r })),
  );
  const notes = tables.flatMap((t) => t.note.map((n) => ({ t, n })));
  return (
    <div className="campo condizione-rao">
      <label htmlFor="condizione-rao">Condizione clinica (RAO)</label>
      <select
        id="condizione-rao"
        value={choice ? value : ''}
        aria-describedby="condizione-rao-aiuto"
        onChange={(e) => onChange(raoChoiceOf(tables, e.target.value))}
      >
        <option value="">Nessuna: la classe la scelgo io</option>
        {tables.flatMap((t) =>
          selectable(t).map((r) => {
            const label = [
              several ? t.servizi.join(' / ') : null,
              `${PRIORITY[r.classe]} · ${r.attesa}`,
              r.pediatria ? 'età pediatrica' : null,
              r.gruppo,
              r.daNota ? 'dalle note della tabella' : null,
            ]
              .filter(Boolean)
              .join(' · ');
            return (
              <optgroup
                key={`${t.fonte}:${t.id}:${r.classe}:${r.pediatria}:${r.attesa}`}
                label={label}
              >
                {r.indicazioni.map((v) => (
                  <option key={v.chiave} value={v.chiave}>
                    {v.testo}
                  </option>
                ))}
              </optgroup>
            );
          }),
        )}
      </select>
      <p id="condizione-rao-aiuto" className="aiuto">
        Scegli la condizione del paziente: il programma mette la classe della tabella, che puoi
        cambiare. Tabelle:{' '}
        {tables
          .map(
            (t) =>
              `${t.titoloFonte}, tabella ${t.id}${t.controllatoDa ? '' : ' (trascrizione da controllare)'}`,
          )
          .join('; ')}
        .
      </p>
      {choice?.altro && (
        <p className="aiuto">
          «Altro» presuppone la descrizione in dettaglio delle condizioni cliniche: scrivila nel
          quesito.
        </p>
      )}
      {choice && priority && priority !== choice.classe && (
        <Notice kind="avviso">
          La classe della ricetta, {PRIORITY[priority] ?? priority}, non è quella della condizione
          scelta, {PRIORITY[choice.classe]}.
        </Notice>
      )}
      {(emergency.length > 0 || notes.length > 0) && (
        <details className="rao-promemoria">
          <summary>Promemoria e note delle tabelle</summary>
          {emergency.map(({ t, r }) => (
            <div key={`${t.fonte}:${t.id}:${r.pediatria}`}>
              <p>
                Invio al pronto soccorso{r.pediatria ? ', età pediatrica' : ''}
                {several ? ` (${t.servizi.join(' / ')})` : ''}: condizioni che la tabella elenca
                come promemoria, non per la ricetta.
              </p>
              <ul>
                {r.indicazioni.map((v) => (
                  <li key={v.chiave}>{v.testo}</li>
                ))}
              </ul>
            </div>
          ))}
          {notes.length > 0 && (
            <ul>
              {notes.map(({ t, n }) => (
                <li key={`${t.fonte}:${t.id}:${n}`}>{n}</li>
              ))}
            </ul>
          )}
        </details>
      )}
    </div>
  );
}
