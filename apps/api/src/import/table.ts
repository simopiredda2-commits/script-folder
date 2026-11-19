import { PARSE_DEADLINE_MS } from './limits';
import type { ImportMapping } from './mapping';

/**
 * Tabella letta da un file non fidato (tappa 15): un foglio di un XLSX o il CSV intero. Le righe
 * vuote non ci sono; ogni riga tiene il suo numero nel file, per il rapporto.
 */
export interface TableRecord {
  /** Numero della riga nel file (CSV) o nel foglio (XLSX), da 1. */
  line: number;
  /** Celle come testi, tutte della stessa larghezza. */
  cells: string[];
  /**
   * Tipo di ogni cella di un XLSX, un carattere per cella: «t» testo, «n» numero, «d» data (la
   * cella contiene già AAAA-MM-GG), «b» sì/no («1» o «0»), «e» errore del foglio, «o» orario.
   * Assente per i CSV: tutto testo.
   */
  kinds?: string;
}

export interface ImportTable {
  /** Nome del foglio, o «CSV». */
  name: string;
  records: TableRecord[];
  width: number;
}

export type FileFormat = 'csv' | 'xlsx' | 'json' | 'mmg-esportazione';

export interface ReadFile {
  format: FileFormat;
  tables: ImportTable[];
  /** Codifica del testo (CSV e JSON). */
  encoding?: string;
  /** Separatore del CSV; null se il file ha una colonna sola. */
  separator?: string | null;
  /** XLSX con le date nel sistema 1904. */
  date1904?: boolean;
  /** Mappatura già pronta, per i formati che il programma conosce (la nostra esportazione). */
  proposed?: ImportMapping;
  /** Note della lettura, senza valori del file: righe iniziali saltate, sistema delle date. */
  notes: string[];
}

/**
 * Il file non entra: messaggio in chiaro, senza valori del file (un messaggio d'errore può finire
 * nei log o in una schermata condivisa).
 */
export class FileRejected extends Error {
  constructor(
    message: string,
    /** 413 per i file troppo grandi, 400 per gli altri. */
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

/** Tempo massimo di una lettura: i cicli lunghi lo controllano ogni tanto. */
export class Deadline {
  private readonly until: number;
  private tick = 0;
  constructor(
    ms = PARSE_DEADLINE_MS,
    private readonly now: () => number = () => Date.now(),
  ) {
    this.until = now() + ms;
  }
  /** Da chiamare nei cicli: controlla l'orologio una volta ogni migliaio di passi. */
  check(): void {
    if (++this.tick % 1024 !== 0) return;
    if (this.now() > this.until)
      throw new FileRejected(
        'La lettura del file ha superato il tempo massimo: dividilo in file più piccoli.',
      );
  }
}

/** «A», «B», …, «Z», «AA»: la lettera di una colonna da zero. */
export function columnLetter(index: number): string {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

/** Elenco breve di numeri di riga per un messaggio: «12, 40, 41 e altre 3». */
export function lineList(lines: number[], max = 10): string {
  const shown = lines.slice(0, max).join(', ');
  return lines.length > max ? `${shown} e altre ${lines.length - max}` : shown;
}
