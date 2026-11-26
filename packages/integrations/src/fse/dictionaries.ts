/**
 * Dizionari ufficiali del Fascicolo copiati in `fse-ufficiale/dizionari` (D131): per gli elenchi
 * da cui il medico sceglie (allergeni, organi mancanti) e per il controllo dei codici nel
 * simulatore del Gateway. I file sono CSV con colonne «version,code,description,release_date».
 */

import { readFileSync } from 'node:fs';

export const FSE_DICTIONARIES = {
  route: '2.16.840.1.113883.5.112',
  absentAllergies: '2.16.840.1.113883.11.22.9',
  absentMedications: '2.16.840.1.113883.11.22.15',
  absentProblems: '2.16.840.1.113883.11.22.17',
  allergens: '2.16.840.1.113883.2.9.77.22.11.2',
  familyObservation: '2.16.840.1.113883.2.9.77.22.11.9',
  chronicity: '2.16.840.1.113883.2.9.77.22.11.10',
  clinicalStatus: '2.16.840.1.113883.2.9.77.22.11.11',
  authorCode: '2.16.840.1.113883.2.9.77.22.11.13',
  motorCapacity: '2.16.840.1.113883.2.9.77.22.11.15',
  missingOrgans: '2.16.840.1.113883.2.9.77.22.11.17',
  actCode: '2.16.840.1.113883.5.4',
  intoleranceType: '2.16.840.1.113883.1.11.19700',
  observationValue: '2.16.840.1.113883.5.1063',
  roleCode: '2.16.840.1.113883.5.111',
  gender: '2.16.840.1.113883.5.1',
  confidentiality: '2.16.840.1.113883.5.25',
} as const;

export interface DictionaryEntry {
  code: string;
  description: string;
}

/** Una riga CSV con i campi tra virgolette (come nei file del Ministero). */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const cache = new Map<string, DictionaryEntry[]>();

/** Le voci di un dizionario, senza doppioni (alcuni file ripetono un codice per versione). */
export function fseDictionary(oid: string): DictionaryEntry[] {
  const hit = cache.get(oid);
  if (hit) return hit;
  const text = readFileSync(
    new URL(`../../fse-ufficiale/dizionari/${oid}.csv`, import.meta.url),
    'utf8',
  );
  const seen = new Map<string, DictionaryEntry>();
  for (const line of text.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const [, code, description] = parseCsvLine(line);
    if (code && !seen.has(code)) seen.set(code, { code, description: description ?? '' });
  }
  const entries = [...seen.values()];
  cache.set(oid, entries);
  return entries;
}

/** La voce del dizionario con quel codice, se c'è. */
export function fseDictionaryEntry(oid: string, code: string): DictionaryEntry | undefined {
  return fseDictionary(oid).find((e) => e.code === code);
}

let loinc: DictionaryEntry[] | undefined;

/** I codici LOINC che il programma scrive, dall'estratto del dizionario ufficiale. */
export function loincExtract(): DictionaryEntry[] {
  if (!loinc) {
    const text = readFileSync(
      new URL('../../fse-ufficiale/loinc/estratto.csv', import.meta.url),
      'utf8',
    );
    loinc = text
      .split(/\r?\n/)
      .slice(1)
      .filter((l) => l.trim())
      .map((l) => {
        const [, code, description] = parseCsvLine(l);
        return { code: code!, description: description ?? '' };
      });
  }
  return loinc;
}
