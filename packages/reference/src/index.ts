import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type MappingSet, parseMappings } from './mapping';

export * from './changes';
export * from './csv';
export * from './diagnoses';
export * from './exemptions';
export * from './files';
export * from './kinds';
export * from './mapping';
export * from './pack-units';
export * from './search';
export * from './text';
export * from './xlsx';

export const DATA_DIR = join(import.meta.dirname, '..', 'data');

/**
 * Trascrizioni che il programma porta con sé: il catalogo regionale delle prestazioni e gli atti che
 * lo modificano (D159), le diagnosi ICD-9-CM (D186). Entrano in uso quando una persona le ha
 * controllate.
 */
export const REGIONAL_TRANSCRIPTIONS = join(DATA_DIR, 'trascrizioni');

/** Sinonimi e sigle dei materiali per la ricerca delle prestazioni (D153). */
export const SERVICE_SEARCH_DATA = join(DATA_DIR, 'ricerca-prestazioni.json');

/**
 * Valori ammessi dei tracciati del SIAP, dalle specifiche funzionali del Ministero (versione 1.3),
 * con la chiave che il programma usa per ogni valore (D284).
 */
export const SIAP_VALUES_FILE = join(DATA_DIR, 'siap', 'valori-ministero-1.3.json');

/**
 * Tabelle RAO, Raggruppamenti di attesa omogenei (D285): il manuale di AGENAS e le determine della
 * Regione Piemonte per la cardiologia e la gastroenterologia, trascritti con il legame ai codici del
 * nomenclatore di oggi.
 */
export const RAO_FILES = [
  'agenas-manuale-2020.json',
  'piemonte-dd973-2019.json',
  'piemonte-dd259-2019.json',
].map((f) => join(DATA_DIR, 'rao', f));

/** Legge un file di mappature (per difetto quello del repository). */
export function loadMappings(path: string = join(DATA_DIR, 'mappature.json')): MappingSet {
  return parseMappings(JSON.parse(readFileSync(path, 'utf-8')));
}
