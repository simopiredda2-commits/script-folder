/**
 * Tipi dell'importazione nell'interfaccia (tappa 15): il catalogo delle destinazioni arriva dal
 * servizio (l'interfaccia non importa il dominio), e così l'analisi del file.
 */

export type FieldKind =
  'text' | 'date' | 'number' | 'integer' | 'boolean' | 'choice' | 'fiscalCode' | 'code';

export interface CatalogField {
  key: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  max?: number;
  choices?: { key: string; label: string; aliases?: string[] }[];
  digits?: number;
  hint?: string;
}

export interface CatalogDestination {
  key: string;
  label: string;
  menu: string;
  order: number;
  fields: CatalogField[];
  notes: string;
}

export interface Catalog {
  destinazioni: CatalogDestination[];
  formatiData: { key: 'testo' | 'seriale'; label: string }[];
  regolaNumeri: string;
  valoriSi: string[];
  valoriNo: string[];
  limiti: { dimensione: number; righe: number; colonne: number };
}

export interface ColumnRef {
  lettera: string;
  nome?: string;
}

export interface ColumnInfo {
  lettera: string;
  nome: string;
  piene: number;
  valori: string[] | null;
}

export interface TableInfo {
  nome: string;
  righe: number;
  larghezza: number;
  intestazione: number;
  inizio: { riga: number; celle: string[] }[];
  colonne: ColumnInfo[];
  suggerimento: { destinazione: string; campi: Record<string, ColumnRef> } | null;
  /** Colonne suggerite per una destinazione scelta (rotta delle colonne). */
  campi?: Record<string, ColumnRef> | null;
}

export interface Upload {
  id: string;
  file: { nome: string; dimensione: number; impronta: string };
  giaImportatoIl: string | null;
  formato: string;
  codifica: string | null;
  separatore: string | null;
  note: string[];
  tabelle: TableInfo[];
  /** Mappatura già pronta per i formati che il programma conosce (la nostra esportazione). */
  mappaturaProposta: MappingPayload | null;
}

/** Come un campo prende il suo valore. */
export interface FieldDraft {
  modo: 'nessuno' | 'colonna' | 'costante';
  colonna: string;
  costante: string;
  formatoData: 'testo' | 'seriale';
  corrispondenze: Record<string, string>;
  /** La colonna l'ha proposta il programma dal nome dell'intestazione. */
  suggerito: boolean;
}

/** Una destinazione di un foglio, con il filtro dello smistamento e i campi. */
export interface PartDraft {
  key: string;
  tabella: string;
  intestazione: number;
  destinazione: string;
  filtroColonna: string;
  filtroValori: string;
  campi: Record<string, FieldDraft>;
}

export type Outcome = 'scritta' | 'completata' | 'gia_presente' | 'doppione' | 'scartata';

export interface ReportRow {
  parte: number;
  tabella: string;
  riga: number;
  destinazione: string;
  esito: Outcome;
  motivi: string[];
  avvisi: string[];
  voci?: number;
}

export interface Counts {
  righe: number;
  scritte: number;
  completate: number;
  giaPresenti: number;
  doppioni: number;
  scartate: number;
  conAvvisi: number;
  voci: number;
  pazientiNuovi: number;
  pazientiCompletati: number;
  escluse: number;
}

export interface RunResult {
  id: string;
  stato: 'prova' | 'importato';
  conteggi: Counts;
  rapporto: ReportRow[];
  rapportoTroncato: boolean;
}

export interface PreviewResult {
  parti: {
    indice: number;
    destinazione: string;
    tabella: string;
    totale: number;
    righe: {
      riga: number;
      valori: Record<string, string | number | boolean | null>;
      errori: string[];
      avvisi: string[];
    }[];
  }[];
}

export interface MappingPayload {
  parti: {
    tabella: string;
    intestazione: number;
    destinazione: string;
    filtro?: { colonna: ColumnRef; valori: string[] } | null;
    campi: Record<
      string,
      {
        colonna?: ColumnRef | null;
        costante?: string | null;
        formatoData?: 'testo' | 'seriale';
        corrispondenze?: Record<string, string>;
      }
    >;
  }[];
  programma?: string | null;
}

export interface BatchSummary {
  id: string;
  creatoIl: string;
  finitoIl: string | null;
  file: { nome: string; dimensione: number; impronta: string };
  formato: string;
  destinazioni: { chiave: string; nome: string }[];
  programma: string | null;
  stato: 'caricato' | 'prova' | 'importato' | 'annullato';
  conteggi: Partial<Counts>;
  chi: string | null;
}

export interface Profile {
  id: string;
  nome: string;
  programma: string | null;
  formato: string;
  destinazioni: { chiave: string; nome: string }[];
  mappatura: MappingPayload;
  creatoIl: string;
  chi: string | null;
  archiviatoIl: string | null;
}

export const OUTCOME_LABELS: Record<Outcome, string> = {
  scritta: 'Scritta',
  completata: 'Completata',
  gia_presente: 'Già presente',
  doppione: 'Doppione nel file',
  scartata: 'Scartata',
};

export const OUTCOME_KIND: Record<Outcome, 'fatto' | 'info' | 'avviso' | 'errore'> = {
  scritta: 'fatto',
  completata: 'fatto',
  gia_presente: 'info',
  doppione: 'avviso',
  scartata: 'errore',
};
