import {
  ACTIVITY_REGIMES,
  CONTACT_ACCESS_TYPES,
  CONTACT_MODES,
  PROBLEM_STATES,
  SMOKING_STATUSES,
  STRUCTURE_TYPES,
} from '@mmg/domain';
import { SIAP_VALUES_FILE } from '@mmg/reference';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * I valori ammessi dei tracciati del SIAP (D284): tipologie e dettagli delle prestazioni (allegati
 * 1 e 2 delle specifiche funzionali del Ministero, versione 1.3) e i domini dei campi, ognuno con
 * la chiave che il programma usa. Si leggono dal file della trascrizione, controllato qui: chiavi
 * tutte presenti e una volta sola, codici unici.
 */

const value = <const K extends readonly [string, ...string[]]>(keys: K) =>
  z
    .object({
      chiave: z.enum(keys),
      codice: z.number().int().min(0),
      descrizione: z.string().min(1),
    })
    .strict();

/** Un dominio: ogni chiave del programma una volta sola, ogni codice una volta sola. */
const domain = <const K extends readonly [string, ...string[]]>(keys: K) =>
  z
    .array(value(keys))
    .refine((vs) => keys.every((k) => vs.filter((v) => v.chiave === k).length === 1), {
      message: 'Ogni chiave del programma ha un valore, uno solo',
    })
    .refine((vs) => new Set(vs.map((v) => v.codice)).size === vs.length, {
      message: 'Codici ripetuti',
    });

const detail = z
  .object({ codice: z.number().int().min(1), descrizione: z.string().min(1) })
  .strict();

const typology = z
  .object({
    codice: z.number().int().min(0),
    descrizione: z.string().min(1),
    /** Il nome dell'allegato 1 quando non è quello della definizione del campo e dell'allegato 2. */
    descrizioneAllegato1: z.string().min(1).optional(),
    dettagli: z
      .array(detail)
      .min(1)
      .refine((ds) => new Set(ds.map((d) => d.codice)).size === ds.length, {
        message: 'Dettagli ripetuti',
      }),
  })
  .strict();

export const siapValuesSchema = z
  .object({
    tipo: z.literal('siap_valori_ammessi'),
    atto: z.string().min(1),
    versione: z.string().min(1),
    sha256_origine: z.string().regex(/^[0-9a-f]{64}$/),
    trascritto_da: z.string().min(1),
    trascritto_il: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    controllato_da: z.string().min(1).nullable(),
    nota: z.string().min(1),
    tipologie: z
      .array(typology)
      .min(1)
      .refine((ts) => new Set(ts.map((t) => t.codice)).size === ts.length, {
        message: 'Tipologie ripetute',
      }),
    modalitaContatto: domain(CONTACT_MODES),
    regimeAttivita: domain(ACTIVITY_REGIMES),
    tipologiaAccesso: domain(CONTACT_ACCESS_TYPES),
    statoProblema: domain(PROBLEM_STATES),
    fumo: domain(SMOKING_STATUSES),
    tipoStruttura: domain(STRUCTURE_TYPES),
  })
  .strict();

export type SiapValues = z.infer<typeof siapValuesSchema>;

let cached: SiapValues | undefined;

/** I valori del file della trascrizione, letti e controllati una volta. */
export function siapValues(file: string = SIAP_VALUES_FILE): SiapValues {
  if (file !== SIAP_VALUES_FILE)
    return siapValuesSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  cached ??= siapValuesSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  return cached;
}

/** La tipologia e il dettaglio esistono nei valori in uso. */
export function knownActivity(values: SiapValues, typologyCode: number, detailCode: number) {
  const t = values.tipologie.find((x) => x.codice === typologyCode);
  return !!t && t.dettagli.some((d) => d.codice === detailCode);
}
