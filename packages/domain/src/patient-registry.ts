import { z } from 'zod';
import { checkFiscalCode, type FiscalCodeProblem } from './codice-fiscale';

/**
 * Dati amministrativi del paziente (tappe 14 e 15): anagrafica, dati SSN, recapiti, lavoro, stato,
 * cittadini stranieri, canale del promemoria, esenzioni, scelta del medico. Sono il contratto
 * comune del pannello amministrativo della cartella e dell'importazione da altri programmi: gli
 * stessi controlli valgono per chi scrive a mano e per un file importato.
 *
 * I nomi dei campi sono quelli delle API (italiano); le colonne del database sono in
 * `apps/api/src/db/schema/patients.ts`.
 */

const isoDate = z.iso.date();
const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).nullable().optional();

export const PATIENT_STATUSES = [
  { key: 'attivo', db: 'active', label: 'In carico' },
  { key: 'revocato', db: 'revoked', label: 'Revocato' },
  { key: 'deceduto', db: 'deceased', label: 'Deceduto' },
  { key: 'temporaneo', db: 'temporary', label: 'Temporaneo' },
] as const;
export type PatientStatusKey = (typeof PATIENT_STATUSES)[number]['key'];
export const PATIENT_STATUS_KEYS = PATIENT_STATUSES.map((s) => s.key) as [
  PatientStatusKey,
  ...PatientStatusKey[],
];

/** Canali del promemoria (R15), con le parole dell'interfaccia. */
export const REMINDER_CHANNELS = [
  { key: 'carta', db: 'paper', label: 'Promemoria cartaceo' },
  { key: 'email', db: 'email', label: 'Email' },
  { key: 'pec', db: 'pec', label: 'PEC' },
  { key: 'sms', db: 'sms', label: 'SMS' },
  { key: 'messaggistica', db: 'messaging_app', label: 'App di messaggistica' },
  { key: 'telefono', db: 'phone', label: 'Telefono (NRE comunicato a voce)' },
  { key: 'fascicolo', db: 'fse', label: 'Fascicolo Sanitario Elettronico' },
] as const;
export type ReminderChannelKey = (typeof REMINDER_CHANNELS)[number]['key'];
export const REMINDER_CHANNEL_KEYS = REMINDER_CHANNELS.map((c) => c.key) as [
  ReminderChannelKey,
  ...ReminderChannelKey[],
];

const FISCAL_CODE_PROBLEMS: Record<FiscalCodeProblem, string> = {
  lunghezza: 'il codice fiscale ha 16 caratteri',
  struttura: 'il codice fiscale non ha la struttura prevista',
  giorno: 'il giorno di nascita nel codice fiscale non è valido',
  controllo: 'il carattere di controllo del codice fiscale non torna',
};

/** Codice fiscale in maiuscolo, controllato nella struttura e nel carattere di controllo. */
export const fiscalCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .superRefine((v, ctx) => {
    const r = checkFiscalCode(v);
    if (!r.valid)
      ctx.addIssue({
        code: 'custom',
        message: FISCAL_CODE_PROBLEMS[r.problem ?? 'struttura'],
      });
  });

/** Identità: per un paziente nuovo, o per correggerla con un motivo. */
export const patientIdentitySchema = z
  .object({
    cognome: text(100),
    nome: text(100),
    sesso: z.enum(['M', 'F']),
    nascita: isoDate,
    /** Codice catastale (Belfiore) del comune o dello stato estero di nascita. */
    luogoNascitaCodice: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]\d{3}$/, 'il codice del luogo di nascita è una lettera e tre cifre')
      .nullable()
      .optional(),
    luogoNascita: optionalText(100),
    codiceFiscale: fiscalCodeSchema,
  })
  .strict();
export type PatientIdentityInput = z.infer<typeof patientIdentitySchema>;

/** Dati amministrativi modificabili: tutti facoltativi, null per svuotare. */
export const patientAdminSchema = z
  .object({
    telefono: optionalText(40),
    email: z.email().nullable().optional(),
    residenzaVia: optionalText(200),
    residenzaCivico: optionalText(20),
    residenzaCap: z
      .string()
      .trim()
      .regex(/^\d{5}$/, 'il CAP ha 5 cifre')
      .nullable()
      .optional(),
    residenzaComune: optionalText(100),
    residenzaProvincia: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z]{2}$/, 'la provincia è la sigla di due lettere')
      .nullable()
      .optional(),
    domicilio: optionalText(300),
    asl: optionalText(100),
    distretto: optionalText(100),
    tipoAssistenza: optionalText(100),
    stato: z.enum(PATIENT_STATUS_KEYS).optional(),
    decedutoIl: isoDate.nullable().optional(),
    /** Causa del decesso in ICD-9-CM, se nota. */
    causaDecesso: z.string().trim().toUpperCase().max(10).nullable().optional(),
    tesseraTeam: optionalText(40),
    enteEstero: optionalText(200),
    professione: optionalText(200),
    condizioneProfessionale: optionalText(100),
    emailDatoreLavoro: z.email().nullable().optional(),
    canalePromemoria: z.enum(REMINDER_CHANNEL_KEYS).nullable().optional(),
    recapitoPromemoria: optionalText(200),
    canaleSceltoIl: isoDate.nullable().optional(),
  })
  .strict();
export type PatientAdminInput = z.infer<typeof patientAdminSchema>;

/** Problemi di coerenza dei dati amministrativi, in chiaro; vuoto se tutto torna. */
export function patientAdminIssues(p: PatientAdminInput, today: string): string[] {
  const issues: string[] = [];
  if (p.stato === 'deceduto' && !p.decedutoIl)
    issues.push('Per un paziente deceduto serve la data');
  if (p.decedutoIl && p.decedutoIl > today) issues.push('La data del decesso è nel futuro');
  if (p.decedutoIl && p.stato && p.stato !== 'deceduto')
    issues.push('La data del decesso vale solo per un paziente deceduto');
  if (p.canalePromemoria && p.canalePromemoria !== 'carta' && !p.recapitoPromemoria)
    issues.push('Per il canale scelto serve il recapito (R15)');
  if (p.canalePromemoria && !p.canaleSceltoIl)
    issues.push('Serve la data in cui il paziente ha scelto il canale (R15)');
  return issues;
}

/** Esenzione del paziente: codice, validità, codice da riportare in ricetta. */
export const exemptionSchema = z
  .object({
    codice: z.string().trim().toUpperCase().min(1).max(20),
    dal: isoDate,
    al: isoDate.nullable().optional(),
    /** Il codice da scrivere in ricetta, se diverso dal codice dell'esenzione. */
    codiceRicetta: z.string().trim().toUpperCase().max(20).nullable().optional(),
  })
  .strict()
  .refine((e) => !e.al || e.al >= e.dal, 'La fine della validità viene dopo l’inizio');
export type ExemptionInput = z.infer<typeof exemptionSchema>;

/** Scelta del medico registrata a mano (in attesa di AURA). */
export const doctorChoiceSchema = z
  .object({
    medicoId: z.uuid(),
    dal: isoDate,
    scadenza: isoDate.nullable().optional(),
    cessataIl: isoDate.nullable().optional(),
    motivoCessazione: optionalText(300),
  })
  .strict()
  .refine((c) => !c.cessataIl || c.cessataIl >= c.dal, 'La cessazione viene dopo la scelta');
export type DoctorChoiceInput = z.infer<typeof doctorChoiceSchema>;

/** Lunghezza minima del motivo di una correzione dell'identità: una frase, non una sigla. */
export const IDENTITY_FIX_REASON_MIN = 10;
