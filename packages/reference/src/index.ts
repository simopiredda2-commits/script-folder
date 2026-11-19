import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type MappingSet, parseMappings } from './mapping';

export * from './changes';
export * from './csv';
export * from './diagnoses';
export * from './files';
export * from './kinds';
export * from './mapping';
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

/** Legge un file di mappature (per difetto quello del repository). */
export function loadMappings(path: string = join(DATA_DIR, 'mappature.json')): MappingSet {
  return parseMappings(JSON.parse(readFileSync(path, 'utf-8')));
}
