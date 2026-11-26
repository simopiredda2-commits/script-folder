import { PRESCRIPTION_KINDS } from '@mmg/domain';
import { z } from 'zod';
import { therapyChoiceSchema } from './therapy-choice';

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
    /**
     * Numero della nota del nomenclatore (numeroNota, D276). Assente: lo dà l'elenco delle note in
     * uso; null: nessuna nota. Lo controlla R24.
     */
    serviceNote: z
      .string()
      .trim()
      .regex(/^\d{1,3}[A-Z]?$/, 'Numero della nota non valido')
      .nullable()
      .optional(),
    /** Lettera della condizione o dell'indicazione della nota (D276). */
    serviceNoteLetter: z
      .string()
      .trim()
      .regex(/^[A-Za-z]$/, 'Una lettera della nota')
      .nullable()
      .optional(),
    /** Sedute del ciclo (numsedute, D276): le controlla R10. */
    sessions: z.number().int().min(1).max(99).nullable().optional(),
    quantity: z.number().int().min(1).max(99),
    aifaNote: z.string().max(20).nullable().optional(),
    byActiveIngredient: z.boolean().optional(),
    notSubstitutable: z.boolean().optional(),
    notSubstitutableReason: z.string().max(500).nullable().optional(),
    /** Codice della motivazione di non sostituibilità (codMotivazione): lo controlla R13 (D273). */
    notSubstitutableCode: z.string().trim().max(2).nullable().optional(),
    posologyText: z.string().max(500).nullable().optional(),
    /** Ricetta bianca ripetibile, solo se diverso dalla regola del farmaco (D93). */
    repeatCount: z.number().int().min(0).max(99).nullable().optional(),
    validityMonths: z.number().int().min(1).max(99).nullable().optional(),
    /**
     * Tipo di terapia segnato sulla riga del farmaco (D283): alla firma il programma crea la terapia
     * o aggiorna quella collegata. Della segreteria è una proposta, che il medico conferma.
     */
    therapyChoice: therapyChoiceSchema.nullable().optional(),
  })
  .strict()
  .refine((l) => l.drugName || l.drugAic || l.serviceCode || l.serviceDescription, {
    message: 'Ogni riga indica un farmaco o una prestazione',
  })
  .refine((l) => !l.therapyChoice || (!l.serviceCode && !l.serviceDescription), {
    message: 'Il tipo di terapia si segna solo sulle righe dei farmaci',
    path: ['therapyChoice'],
  });

/** Corpo di una ricetta nuova. Si valida dopo la guardia: anche le richieste sbagliate si registrano. */
export const draftSchema = z
  .object({
    kind: z.enum(PRESCRIPTION_KINDS),
    priority: z.enum(['U', 'B', 'D', 'P']).nullable().optional(),
    accessType: z.enum(['first', 'subsequent']).nullable().optional(),
    diagnosticQuestion: z.string().max(1000).nullable().optional(),
    /** Condizione RAO scelta dal medico (D285): la chiave della tabella. */
    raoCondition: z.string().trim().max(120).nullable().optional(),
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
  .refine((d) => !d.raoCondition || (d.kind === 'specialist_ssn' && d.accessType === 'first'), {
    message: 'La condizione RAO vale per la ricetta specialistica del primo accesso',
    path: ['raoCondition'],
  })
  .refine((d) => !d.obscured || d.kind === 'pharma_ssn' || d.kind === 'specialist_ssn', {
    message: 'L’oscuramento di nome e indirizzo vale per le ricette SSN',
    path: ['obscured'],
  })
  .refine(
    (d) => d.kind === 'pharma_ssn' || d.kind === 'white' || d.lines.every((l) => !l.therapyChoice),
    { message: 'Il tipo di terapia si segna nella ricetta dei farmaci', path: ['lines'] },
  )
  // «Non rimborsabile SSN»: la terapia si prescrive solo su ricetta bianca (requisiti, R8).
  .refine((d) => d.kind === 'white' || d.lines.every((l) => !l.therapyChoice?.notReimbursable), {
    message:
      '«Non rimborsabile SSN» va in ricetta bianca: togli la spunta o scegli la ricetta bianca',
    path: ['lines'],
  });

export const repeatSchema = z.object({ terapie: z.array(z.uuid()).min(1).max(20) }).strict();

export const cancelSchema = z.object({ motivo: z.string().trim().min(1).max(500) }).strict();
