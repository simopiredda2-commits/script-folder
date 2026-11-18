import { PRESCRIPTION_KINDS } from '@mmg/domain';
import { z } from 'zod';

const lineSchema = z
  .object({
    therapyId: z.uuid().nullable().optional(),
    drugAic: z.string().max(20).nullable().optional(),
    drugName: z.string().max(300).nullable().optional(),
    activeIngredient: z.string().max(300).nullable().optional(),
    /** Codice del catalogo regionale (codCatalogoPrescr). */
    serviceCode: z.string().max(40).nullable().optional(),
    /** Codice del nomenclatore, «codice DM» (codProdPrest): dal catalogo o scritto a mano (D154). */
    serviceNationalCode: z.string().trim().max(40).nullable().optional(),
    serviceDescription: z.string().max(500).nullable().optional(),
    quantity: z.number().int().min(1).max(99),
    aifaNote: z.string().max(20).nullable().optional(),
    byActiveIngredient: z.boolean().optional(),
    notSubstitutable: z.boolean().optional(),
    notSubstitutableReason: z.string().max(500).nullable().optional(),
    posologyText: z.string().max(500).nullable().optional(),
    /** Ricetta bianca ripetibile, solo se diverso dalla regola del farmaco (D93). */
    repeatCount: z.number().int().min(0).max(99).nullable().optional(),
    validityMonths: z.number().int().min(1).max(99).nullable().optional(),
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
    /** Canale del promemoria e recapito (R15, R16); vuoto = promemoria cartaceo. */
    reminderChannel: z
      .enum(['paper', 'email', 'pec', 'sms', 'messaging_app', 'phone', 'fse'])
      .nullable()
      .optional(),
    reminderContact: z.string().trim().max(200).nullable().optional(),
    /** Su richiesta del paziente: cognome, nome e indirizzo oscurati (oscuramDati). */
    obscured: z.boolean().optional(),
    lines: z.array(lineSchema).min(1).max(10),
  })
  .strict()
  .refine(
    (d) =>
      d.kind === 'white' || d.lines.every((l) => l.repeatCount == null && l.validityMonths == null),
    { message: 'La ripetibilità si indica solo sulla ricetta bianca', path: ['lines'] },
  )
  .refine((d) => !d.obscured || d.kind === 'pharma_ssn' || d.kind === 'specialist_ssn', {
    message: 'L’oscuramento di nome e indirizzo vale per le ricette SSN',
    path: ['obscured'],
  });

export const repeatSchema = z.object({ terapie: z.array(z.uuid()).min(1).max(20) }).strict();

export const cancelSchema = z.object({ motivo: z.string().trim().min(1).max(500) }).strict();
