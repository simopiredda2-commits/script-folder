import { money } from '../lib/format';

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
}

/**
 * Testo di un risultato della ricerca delle prestazioni: descrizione, materiale per esteso e i
 * due codici della ricetta, del catalogo regionale e del nomenclatore («codice DM»).
 */
export function ServiceResultText({ s }: { s: ServiceResultData }) {
  return (
    <div>
      <strong>{s.description}</strong>
      {s.material && <div>Materiale: {s.material.significato}</div>}
      <div className="tenue">
        {[s.branch, s.fee && money(s.fee), s.notes].filter(Boolean).join(' · ')}
      </div>
      <div className="codice tenue">
        Catalogo {s.regionalCode}
        {s.nationalCode ? ` · nomenclatore (DM) ${s.nationalCode}` : ''}
      </div>
    </div>
  );
}
