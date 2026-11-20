import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { toCsv } from '../export/csv';
import type { DistintaRow } from './service';

/**
 * Formati della distinta delle prestazioni aggiuntive (D212), come dati in
 * `apps/api/distinte/ppip-formati.json`: il formato dell'ASL si aggiunge lì, quando Regione e ASL
 * diranno come lo vogliono, senza cambiare il codice.
 */
export const FORMATS_FILE = join(import.meta.dirname, '..', '..', 'distinte', 'ppip-formati.json');

/** I campi di una riga della distinta che un formato può usare. */
export const DISTINTA_FIELDS = [
  'data',
  'cognome',
  'nome',
  'indirizzo',
  'codiceFiscale',
  'codice',
  'sezione',
  'descrizione',
  'quantita',
  'luogo',
  'autorizzazione',
  'compensoUnitario',
  'importo',
  'protocolloInvio',
] as const satisfies readonly (keyof DistintaRow)[];

const formatSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    titolo: z.string().min(1),
    fonte: z.string().min(1),
    formatoData: z.enum(['gg/mm/aaaa', 'aaaa-mm-gg']),
    decimali: z.enum(['virgola', 'punto']),
    colonne: z
      .array(z.object({ intestazione: z.string().min(1), campo: z.enum(DISTINTA_FIELDS) }).strict())
      .min(1),
  })
  .strict();

export const formatsSchema = z
  .object({
    versione: z.string().regex(/^\d{4}-\d{2}-\d{2}\.\d+$/),
    formati: z.array(formatSchema).min(1),
  })
  .strict()
  .refine((f) => new Set(f.formati.map((x) => x.id)).size === f.formati.length, {
    message: 'Ogni formato ha un id diverso',
  });

export type DistintaFormat = z.infer<typeof formatSchema>;

export function loadFormats(file: string = FORMATS_FILE) {
  return formatsSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

const DEFAULT_FORMAT = 'acn-allegato-6';

export function formatById(id: string | undefined, file?: string): DistintaFormat | undefined {
  return loadFormats(file).formati.find((f) => f.id === (id ?? DEFAULT_FORMAT));
}

/** La distinta in CSV, nel formato dato. */
export function distintaCsv(rows: readonly DistintaRow[], format: DistintaFormat): string {
  const date = (iso: string) =>
    format.formatoData === 'gg/mm/aaaa'
      ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`
      : iso;
  const number = (n: number) =>
    format.decimali === 'virgola' ? n.toFixed(2).replace('.', ',') : n.toFixed(2);
  const headers = format.colonne.map((c) => c.intestazione);
  const out = rows.map((r) =>
    Object.fromEntries(
      format.colonne.map((c) => {
        const v = r[c.campo];
        const value =
          v === null || v === undefined
            ? null
            : c.campo === 'data'
              ? date(String(v))
              : c.campo === 'compensoUnitario' || c.campo === 'importo'
                ? number(Number(v))
                : v;
        return [c.intestazione, value];
      }),
    ),
  );
  return toCsv(headers, out);
}
