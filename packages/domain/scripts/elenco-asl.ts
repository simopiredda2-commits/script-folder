import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

/**
 * Genera `src/asl-elenco.ts` dal file delle aziende sanitarie locali del Ministero della Salute:
 * dataset «Aziende Sanitarie Locali - ASL» dei dati aperti del Ministero (D267). Indirizzo, byte e
 * impronta del file usato sono in docs/provenienze.md.
 *
 *   pnpm --filter @mmg/domain asl:elenco -- --csv FILE --aggiornato AAAA-MM-GG
 *
 * Il file è in ISO-8859-1, con il punto e virgola e una riga per ASL e per anno, dal 2010. Si
 * tengono le righe dell'anno più recente, con i quattro campi che servono: codice e nome della
 * regione, codice e nome dell'azienda. Indirizzi e recapiti non servono e non si copiano.
 * `--aggiornato` è la «Data ultimo aggiornamento» della pagina del dataset: nel file non c'è.
 */
const { values } = parseArgs({
  options: { csv: { type: 'string' }, aggiornato: { type: 'string' } },
});
if (!values.csv || !values.aggiornato || !/^\d{4}-\d{2}-\d{2}$/.test(values.aggiornato))
  throw new Error('Uso: --csv FILE --aggiornato AAAA-MM-GG');

const bytes = readFileSync(values.csv);
const sha256 = createHash('sha256').update(bytes).digest('hex');
const lines = new TextDecoder('latin1').decode(bytes).split(/\r?\n/).filter(Boolean);
const header = lines[0]!.split(';').map((c) => c.trim());
const col = (name: string) => {
  const i = header.indexOf(name);
  if (i < 0) throw new Error(`Colonna «${name}» non trovata`);
  return i;
};
const [YEAR, REGION_CODE, REGION_NAME, CODE, NAME] = [
  'ANNO',
  'CODICE REGIONE',
  'DENOMINAZIONE REGIONE',
  'CODICE AZIENDA',
  'DENOMINAZIONE AZIENDA',
].map(col) as [number, number, number, number, number];

const rows = lines.slice(1).map((l) => l.split(';').map((c) => c.trim()));
const year = Math.max(...rows.map((r) => Number(r[YEAR])));
const list = rows
  .filter((r) => Number(r[YEAR]) === year)
  .map((r) => ({
    regionCode: r[REGION_CODE]!,
    regionName: r[REGION_NAME]!,
    code: r[CODE]!,
    name: r[NAME]!,
  }))
  .sort((a, b) => a.regionCode.localeCompare(b.regionCode) || a.code.localeCompare(b.code));

for (const a of list)
  if (!/^\d{3}$/.test(a.regionCode) || !/^\d{3}$/.test(a.code) || !a.name || !a.regionName)
    throw new Error(`Riga non valida: ${JSON.stringify(a)}`);

const out = `// File generato da scripts/elenco-asl.ts: non si modifica a mano (D267).

/**
 * Aziende sanitarie locali dell'anno ${year}, dai dati aperti del Ministero della Salute: dataset
 * «Aziende Sanitarie Locali - ASL», aggiornato il ${values.aggiornato.split('-').reverse().join('/')}. File usato: ${bytes.length} byte,
 * SHA-256 ${sha256}
 * (indirizzo in docs/provenienze.md). Licenza IODL 2.0: fonte Ministero della Salute. Del file
 * restano codice e nome di regione e azienda; indirizzi e recapiti non si copiano.
 */
export const ASL_SOURCE = {
  year: ${year},
  updated: '${values.aggiornato}',
  bytes: ${bytes.length},
  sha256: '${sha256}',
} as const;

export interface HealthUnit {
  /** Codice della regione, tre cifre (010 il Piemonte). */
  regionCode: string;
  regionName: string;
  /** Codice dell'azienda, tre cifre: unico dentro la regione. */
  code: string;
  name: string;
}

export const ASL_LIST: readonly HealthUnit[] = ${JSON.stringify(list, null, 2)};
`;
const target = join(import.meta.dirname, '..', 'src', 'asl-elenco.ts');
writeFileSync(target, out);
console.log(`${target}: ${list.length} aziende dell'anno ${year}`);
