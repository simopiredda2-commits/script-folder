import { SIAP_DIR } from '@mmg/reference';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { siapValues, type SiapValues } from './values';

/** La tipologia «PIPP» dell'allegato 1 delle specifiche funzionali del SIAP. */
export const SIAP_PPIP_TYPOLOGY = 5;

/** I file delle corrispondenze nella cartella del SIAP: uno per serie del catalogo. */
const FILE_PATTERN = /^corrispondenze-prestazioni-aggiuntive.*\.json$/;

export const ppipMappingSchema = z
  .object({
    tipo: z.literal('siap_corrispondenze_prestazioni_aggiuntive'),
    /** La serie del catalogo delle prestazioni aggiuntive, come nella sua trascrizione. */
    serie: z.string().min(1),
    /** Dove vale il catalogo, se non in tutta Italia, come nella trascrizione (D288). */
    ambito: z
      .object({ regione: z.string().min(1).optional(), asl: z.string().min(1).optional() })
      .strict()
      .optional(),
    atto: z.string().min(1),
    trascritto_da: z.string().min(1),
    trascritto_il: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    controllato_da: z.string().min(1).nullable(),
    nota: z.string().min(1),
    /** Il dettaglio per le voci senza corrispondenza: lo dice un file solo. */
    altro: z.number().int().min(1).optional(),
    voci: z
      .array(z.object({ codice: z.string().min(1), dettaglio: z.number().int().min(1) }).strict())
      .min(1)
      .refine((vs) => new Set(vs.map((v) => v.codice)).size === vs.length, {
        message: 'Voci ripetute',
      }),
  })
  .strict();

export type PpipMappingFile = z.infer<typeof ppipMappingSchema>;

export interface PpipMappings {
  files: { name: string; data: PpipMappingFile }[];
  /** Il dettaglio «Altro», per le voci che nessun file lega a un dettaglio. */
  other: number;
  /** Il dettaglio della tipologia «PIPP» per una voce di una serie del catalogo (D291). */
  detail(series: string, code: string): number;
}

/**
 * Le corrispondenze fra le voci dei cataloghi delle prestazioni aggiuntive e i dettagli della
 * tipologia «PIPP» (D291), lette e controllate: ogni dettaglio esiste nei valori del Ministero, una
 * serie ha un file solo, il dettaglio «Altro» lo dice un file solo.
 */
export function loadPpipMappings(
  dir: string = SIAP_DIR,
  values: SiapValues = siapValues(),
): PpipMappings {
  const typology = values.tipologie.find((t) => t.codice === SIAP_PPIP_TYPOLOGY);
  if (!typology) throw new Error(`Nei valori del SIAP manca la tipologia ${SIAP_PPIP_TYPOLOGY}`);
  const known = new Set(typology.dettagli.map((d) => d.codice));
  const files = readdirSync(dir)
    .filter((f) => FILE_PATTERN.test(f))
    .sort()
    .map((name) => ({
      name,
      data: ppipMappingSchema.parse(JSON.parse(readFileSync(join(dir, name), 'utf8'))),
    }));
  const bySeries = new Map<string, Map<string, number>>();
  for (const { name, data } of files) {
    if (bySeries.has(data.serie))
      throw new Error(`${name}: la serie ${data.serie} ha già un file di corrispondenze`);
    for (const v of [...data.voci.map((x) => x.dettaglio), ...(data.altro ? [data.altro] : [])])
      if (!known.has(v))
        throw new Error(`${name}: il dettaglio ${v} non è della tipologia ${SIAP_PPIP_TYPOLOGY}`);
    bySeries.set(data.serie, new Map(data.voci.map((x) => [x.codice, x.dettaglio])));
  }
  const others = files.flatMap((f) => (f.data.altro ? [f.data.altro] : []));
  if (others.length !== 1)
    throw new Error(`Il dettaglio «Altro» lo dice un file solo: lo dicono ${others.length} file`);
  const other = others[0]!;
  return {
    files,
    other,
    detail: (series, code) => bySeries.get(series)?.get(code) ?? other,
  };
}

let cached: PpipMappings | undefined;

/** Le corrispondenze della cartella del SIAP, lette una volta. */
export function ppipMappings(): PpipMappings {
  cached ??= loadPpipMappings();
  return cached;
}
