import { PRESCRIPTION_KINDS } from '@mmg/domain';
import { z } from 'zod';

const lineSchema = z
  .object({
    therapyId: z.uuid().nullable().optional(),
    drugAic: z.string().max(20).nullable().optional(),
    drugName: z.string().max(300).nullable().optional(),
    activeIngredient: z.string().max(300).nullable().optional(),
    serviceCode: z.string().max(40).nullable().optional(),
    serviceDescription: z.string().max(500).nullable().optional(),
    quantity: z.number().int().min(1).max(99),
    aifaNote: z.string().max(20).nullable().optional(),
    byActiveIngredient: z.boolean().optional(),
    notSubstitutable: z.boolean().optional(),
    notSubstitutableReason: z.string().max(500).nullable().optional(),
    posologyText: z.string().max(500).nullable().optional(),
  })
  .strict()
  .refine((l) => l.drugName || l.drugAic || l.serviceCode || l.serviceDescription, {
    message: 'Ogni riga indica un farmaco o una prestazione',
  });

/** Corpo di una ricetta nuova. Si valida dopo la guardia: anche le richieste sbagliate si registrano. */
export const draftSchema = z
  .object({
    kind: z.enum(PRESCRIPTION_KINDS),
    priority: z.enum(['U', 'B', 'D', 'P']).nullable().optional(),
    accessType: z.enum(['first', 'subsequent']).nullable().optional(),
    diagnosticQuestion: z.string().max(1000).nullable().optional(),
    exemptionCode: z.string().max(20).nullable().optional(),
    requestId: z.uuid().nullable().optional(),
    lines: z.array(lineSchema).min(1).max(10),
  })
  .strict();

export const repeatSchema = z.object({ terapie: z.array(z.uuid()).min(1).max(20) }).strict();

export const cancelSchema = z.object({ motivo: z.string().trim().min(1).max(500) }).strict();
