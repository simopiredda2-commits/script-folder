import { readdirSync, readFileSync } from 'node:fs';
import { regionalDataDirs } from '@mmg/regions';
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
 * Trascrizioni nazionali che il programma porta con sé: le diagnosi ICD-9-CM (D186), gli allegati
 * del DPCM LEA, le prestazioni aggiuntive dell'ACN. Entrano in uso quando una persona le ha
 * controllate. Quelle delle regioni stanno nei pacchetti regionali (D292).
 */
export const TRANSCRIPTIONS_DIR = join(DATA_DIR, 'trascrizioni');

/** Le cartelle delle trascrizioni: quella nazionale e quelle dei pacchetti regionali (D292). */
export const TRANSCRIPTION_DIRS: readonly string[] = [
  TRANSCRIPTIONS_DIR,
  ...regionalDataDirs('trascrizioni'),
];

/** Sinonimi e sigle dei materiali per la ricerca delle prestazioni (D153). */
export const SERVICE_SEARCH_DATA = join(DATA_DIR, 'ricerca-prestazioni.json');

/**
 * Valori ammessi dei tracciati del SIAP, dalle specifiche funzionali del Ministero (versione 1.3),
 * con la chiave che il programma usa per ogni valore (D284).
 */
export const SIAP_VALUES_FILE = join(DATA_DIR, 'siap', 'valori-ministero-1.3.json');

/**
 * Cartella dei dati nazionali del SIAP: i valori del Ministero e la corrispondenza fra le voci
 * dell'ACN e i dettagli della tipologia «PIPP» (D291).
 */
export const SIAP_DIR = join(DATA_DIR, 'siap');

/**
 * Le cartelle delle corrispondenze delle prestazioni aggiuntive per il SIAP: quella nazionale e
 * quelle dei pacchetti regionali, con gli accordi delle regioni (D291, D292).
 */
export const SIAP_DIRS: readonly string[] = [SIAP_DIR, ...regionalDataDirs('siap')];

/**
 * Tabelle RAO, Raggruppamenti di attesa omogenei (D285): il manuale di AGENAS e, dai pacchetti
 * regionali, le tabelle delle regioni (D292), trascritti con il legame ai codici del nomenclatore di
 * oggi. Prima il manuale nazionale, poi i file di ogni pacchetto in ordine di nome.
 */
export const RAO_FILES: readonly string[] = [
  join(DATA_DIR, 'rao', 'agenas-manuale-2020.json'),
  ...regionalDataDirs('rao').flatMap((d) =>
    readdirSync(d)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => join(d, f)),
  ),
];

/** Legge un file di mappature (per difetto quello del repository). */
export function loadMappings(path: string = join(DATA_DIR, 'mappature.json')): MappingSet {
  return parseMappings(JSON.parse(readFileSync(path, 'utf-8')));
}
