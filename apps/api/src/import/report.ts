import { importDestination } from '@mmg/domain';
import type { Outcome, ReportRow } from './engine';

/**
 * Rapporto dell'importazione in CSV (tappa 15), da aprire con un foglio di calcolo: separatore
 * «;», UTF-8 con BOM. Contiene righe, esiti e motivi, mai i valori del file. Le celle che
 * cominciano con «=», «+», «-», «@», tabulazione o a capo sono precedute da un apice: un foglio
 * di calcolo non le esegue come formule.
 */

export const OUTCOME_LABELS: Record<Outcome, string> = {
  scritta: 'Scritta',
  completata: 'Completata',
  gia_presente: 'Già presente',
  doppione: 'Doppione nel file',
  scartata: 'Scartata',
};

/** BOM dell'UTF-8: un foglio di calcolo riconosce la codifica e mostra bene gli accenti. */
const BOM = String.fromCharCode(0xfeff);

export function csvCell(value: string): string {
  let v = value;
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[";\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function reportCsv(rows: ReportRow[]): string {
  const header = ['Destinazione', 'Foglio', 'Riga', 'Esito', 'Motivi', 'Avvisi'];
  const lines = [header.map(csvCell).join(';')];
  for (const r of rows)
    lines.push(
      [
        importDestination(r.destinazione)?.label ?? r.destinazione,
        r.tabella,
        String(r.riga),
        OUTCOME_LABELS[r.esito],
        r.motivi.join(' · '),
        r.avvisi.join(' · '),
      ]
        .map(csvCell)
        .join(';'),
    );
  return `${BOM}${lines.join('\r\n')}\r\n`;
}
