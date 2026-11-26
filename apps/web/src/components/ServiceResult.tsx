import { money } from '../lib/format';

/** La nota del nomenclatore di una prestazione (DPCM LEA, allegati 4 e 4D; D276). */
export interface ServiceNote {
  note: string;
  kind: 'condizione' | 'appropriatezza';
  text: string;
}

/** Una prestazione del catalogo, come la restituisce la ricerca (D153). */
export interface ServiceResultData {
  regionalCode: string;
  nationalCode: string | null;
  description: string;
  branch: string | null;
  fee: string | null;
  notes: string | null;
  /** Il materiale tra quadre, per esteso se la sigla è nota. */
  material?: { sigla: string; significato: string } | null;
  /** Prestazione a ciclo e sedute al più del ciclo, dal catalogo (D276). */
  cycle?: boolean | null;
  sessions?: number | null;
  /** La nota del nomenclatore, se l'elenco delle note è in uso (D276). */
  note?: ServiceNote | null;
}

/** «condizione di erogabilità» o «indicazione di appropriatezza prescrittiva». */
export const NOTE_KIND_TEXT = {
  condizione: 'condizione di erogabilità',
  appropriatezza: 'indicazione di appropriatezza prescrittiva',
} as const;

/** «A ciclo, al più 10 sedute», o «A ciclo» se il catalogo non dice le sedute. */
export const cycleText = (sessions: number | null | undefined) =>
  sessions ? `A ciclo, al più ${sessions} sedute` : 'A ciclo';

/**
 * Testo di un risultato della ricerca delle prestazioni: descrizione, materiale per esteso e i
 * due codici della ricetta, del catalogo regionale e del nomenclatore («codice DM»). La tariffa è
 * quella indicativa del catalogo, a titolo informativo; ciclo e nota quando ci sono (D276).
 */
export function ServiceResultText({ s }: { s: ServiceResultData }) {
  return (
    <div>
      <strong>{s.description}</strong>
      {s.material && <div>Materiale: {s.material.significato}</div>}
      <div className="tenue">
        {[s.branch, s.fee && `tariffa indicativa ${money(s.fee)}`, s.notes]
          .filter(Boolean)
          .join(' · ')}
      </div>
      {(s.cycle || s.note) && (
        <div>
          {[
            s.cycle && cycleText(s.sessions),
            s.note && `Nota ${s.note.note}, ${NOTE_KIND_TEXT[s.note.kind]}`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
      )}
      <div className="codice tenue">
        Catalogo {s.regionalCode}
        {s.nationalCode ? ` · nomenclatore (DM) ${s.nationalCode}` : ''}
      </div>
    </div>
  );
}
