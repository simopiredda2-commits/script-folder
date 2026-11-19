import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TEMPLATE_FIELD_TYPES, templateIssues, type CertificateTemplate } from '@mmg/domain';
import { z } from 'zod';

/**
 * Modelli dei certificati del programma (tappa 13): uno per file in `apps/api/modelli/`. Gli
 * ufficiali hanno il testo dell'atto, con la fonte e la versione (D142, D143); i proposti un testo
 * nostro dai requisiti di legge, con che cosa resta da verificare (D160). Si leggono una volta; un
 * file sbagliato ferma l'avvio, invece di dare un certificato sbagliato.
 */
export const OFFICIAL_TEMPLATES_DIR = join(import.meta.dirname, '..', '..', 'modelli');

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data AAAA-MM-GG');

const fieldSchema = z
  .object({
    key: z.string(),
    label: z.string().min(1),
    type: z.enum(TEMPLATE_FIELD_TYPES),
    required: z.boolean(),
    options: z.array(z.string().min(1)).optional(),
    help: z.string().optional(),
    max: z.number().int().positive().optional(),
    boxes: z.boolean().optional(),
  })
  .strict();

const templateSchema = z
  .object({
    key: z.string(),
    title: z.string().min(1),
    version: isoDate,
    official: z.boolean(),
    source: z
      .object({
        act: z.string().min(1),
        publication: z.string().optional(),
        url: z.url(),
        checkedOn: isoDate,
        note: z.string().optional(),
      })
      .strict(),
    validityMonths: z.number().int().positive().nullable(),
    forDoctor: z.array(z.string().min(1)),
    fields: z.array(fieldSchema),
    body: z.array(z.string().min(1)).min(1),
    signature: z.string().min(1),
    // Struttura comune (D158): riferimento, note, luogo e data, altre firme.
    reference: z.string().min(1).optional(),
    notes: z.array(z.string().min(1)).optional(),
    placeDateLabel: z.string().optional(),
    otherSignatures: z.array(z.string().min(1)).optional(),
    // Modello proposto (D160): che cosa resta da verificare.
    proposal: z.string().min(1).optional(),
  })
  .strict()
  .refine((t) => t.official !== (t.proposal !== undefined), {
    message:
      'un modello del programma è ufficiale (official true) oppure proposto (official false, con proposal)',
  });

/** Legge e controlla i modelli del programma di una cartella, ufficiali e proposti. */
export function loadOfficialTemplates(dir = OFFICIAL_TEMPLATES_DIR): CertificateTemplate[] {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  return files.map((f) => {
    const parsed = templateSchema.safeParse(JSON.parse(readFileSync(join(dir, f), 'utf8')));
    if (!parsed.success)
      throw new Error(`Modello ${f}: ${parsed.error.issues.map((i) => i.message).join('; ')}`);
    const t: CertificateTemplate = parsed.data;
    const issues = templateIssues(t);
    if (`${t.key}.json` !== f) issues.push(`il file deve chiamarsi ${t.key}.json`);
    if (issues.length) throw new Error(`Modello ${f}: ${issues.join('; ')}`);
    return t;
  });
}

let cache: CertificateTemplate[] | null = null;

/** I modelli del programma, ufficiali e proposti. */
export function officialTemplates(): CertificateTemplate[] {
  cache ??= loadOfficialTemplates();
  return cache;
}
