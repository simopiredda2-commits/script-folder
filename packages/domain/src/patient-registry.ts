import { z } from 'zod';
import {
  checkFiscalCode,
  MONTH_LETTERS,
  nameCode,
  surnameCode,
  type FiscalCodeProblem,
} from './codice-fiscale';
import { ICD9_DIAGNOSIS_PATTERN } from './sick-leave';

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

/** Problema formale del codice fiscale, in chiaro; null se è formalmente corretto. */
export function fiscalCodeProblem(code: string): string | null {
  const r = checkFiscalCode(code);
  return r.valid ? null : FISCAL_CODE_PROBLEMS[r.problem ?? 'struttura'];
}

/** Sesso, con le parole dell'interfaccia. */
export const PATIENT_SEXES = [
  { key: 'M', label: 'Maschile' },
  { key: 'F', label: 'Femminile' },
] as const;

/**
 * DM 23/12/1976, art. 6: nei casi di omocodia le cifre si sostituiscono con lettere (0 = L, 1 = M,
 * …, 9 = V). Le posizioni (da 0) sono quelle dei sette caratteri numerici: anno, giorno, codice
 * del luogo. Gli stessi valori di `codice-fiscale.ts`, che li tiene privati.
 */
const OMOCODIA_LETTERS = 'LMNPQRSTUV';
const NUMERIC_POSITIONS = [6, 7, 9, 10, 12, 13, 14];

/** Il codice con le cifre al posto delle lettere dell'omocodia, per confrontarlo con i dati. */
function withDigits(code: string): string {
  const chars = [...code];
  for (const p of NUMERIC_POSITIONS) {
    const i = OMOCODIA_LETTERS.indexOf(chars[p]!);
    if (i >= 0) chars[p] = String(i);
  }
  return chars.join('');
}

const MONTH_NAMES = [
  'gennaio',
  'febbraio',
  'marzo',
  'aprile',
  'maggio',
  'giugno',
  'luglio',
  'agosto',
  'settembre',
  'ottobre',
  'novembre',
  'dicembre',
] as const;

/** I dati dell'identità che si confrontano con il codice fiscale; quelli assenti si saltano. */
export interface FiscalCodeCheckInput {
  codiceFiscale: string;
  cognome?: string | null;
  nome?: string | null;
  sesso?: 'M' | 'F' | null;
  nascita?: string | null;
  luogoNascitaCodice?: string | null;
}

/**
 * Coerenza del codice fiscale con cognome, nome, data e sesso, luogo di nascita (DM 23/12/1976,
 * artt. 3, 4 e 5): una frase per ogni parte che non torna, vuoto se tutto torna o se il codice non è
 * formalmente corretto (quel problema lo dice `fiscalCodeProblem`). È un avviso, non un blocco:
 * l'unico codice valido è quello attribuito dall'Agenzia delle Entrate, che nei casi di omocodia
 * cambia i caratteri numerici e che può differire dai dati per altre ragioni.
 */
export function fiscalCodeCoherence(id: FiscalCodeCheckInput): string[] {
  const code = id.codiceFiscale.trim().toUpperCase();
  if (!checkFiscalCode(code).valid) return [];
  const plain = withDigits(code);
  const out: string[] = [];
  if (id.cognome?.trim()) {
    const expected = surnameCode(id.cognome);
    if (expected !== plain.slice(0, 3))
      out.push(
        `Cognome: dal cognome si ottiene «${expected}», nel codice fiscale c’è «${plain.slice(0, 3)}»`,
      );
  }
  if (id.nome?.trim()) {
    const expected = nameCode(id.nome);
    if (expected !== plain.slice(3, 6))
      out.push(
        `Nome: dal nome si ottiene «${expected}», nel codice fiscale c’è «${plain.slice(3, 6)}»`,
      );
  }
  const birth = id.nascita ? /^\d{2}(\d{2})-(\d{2})-(\d{2})$/.exec(id.nascita) : null;
  if (birth) {
    const [, year, month, day] = birth;
    if (year !== plain.slice(6, 8))
      out.push(
        `Anno di nascita: nel codice fiscale c’è «${plain.slice(6, 8)}», dalla data si ottiene «${year}»`,
      );
    const expectedMonth = MONTH_LETTERS[Number(month) - 1];
    const codeMonth = plain[8]!;
    if (expectedMonth && expectedMonth !== codeMonth) {
      const codeMonthName = MONTH_NAMES[(MONTH_LETTERS as readonly string[]).indexOf(codeMonth)];
      out.push(
        `Mese di nascita: nel codice fiscale c’è «${codeMonth}» (${codeMonthName}), dalla data si ottiene «${expectedMonth}» (${MONTH_NAMES[Number(month) - 1]})`,
      );
    }
    const codeDay = Number(plain.slice(9, 11));
    const birthDay = Number(day);
    if (id.sesso) {
      // Art. 5: per le donne il giorno aumenta di 40.
      const expected = birthDay + (id.sesso === 'F' ? 40 : 0);
      if (codeDay !== expected) {
        if (id.sesso === 'M' && codeDay === birthDay + 40)
          out.push('Sesso: il codice fiscale indica sesso femminile (giorno aumentato di 40)');
        else if (id.sesso === 'F' && codeDay === birthDay)
          out.push('Sesso: il codice fiscale indica sesso maschile (giorno non aumentato di 40)');
        else
          out.push(
            `Giorno di nascita: nel codice fiscale c’è «${plain.slice(9, 11)}», dalla data e dal sesso si ottiene «${String(expected).padStart(2, '0')}»`,
          );
      }
    } else if ((codeDay > 40 ? codeDay - 40 : codeDay) !== birthDay) {
      out.push(
        `Giorno di nascita: nel codice fiscale c’è «${plain.slice(9, 11)}», la data dice ${birthDay}`,
      );
    }
  }
  const place = id.luogoNascitaCodice?.trim().toUpperCase();
  if (place && place !== plain.slice(11, 15))
    out.push(
      `Luogo di nascita: nel codice fiscale c’è «${plain.slice(11, 15)}», il codice del luogo indicato è «${place}»`,
    );
  return out;
}

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
  if (p.causaDecesso && p.stato && p.stato !== 'deceduto')
    issues.push('La causa del decesso vale solo per un paziente deceduto');
  if (p.causaDecesso && !ICD9_DIAGNOSIS_PATTERN.test(p.causaDecesso))
    issues.push('Causa del decesso: non è nel formato ICD-9-CM (es. 410.9, V17.3)');
  if (p.canalePromemoria && p.canalePromemoria !== 'carta' && !p.recapitoPromemoria)
    issues.push('Per il canale scelto serve il recapito (R15)');
  if (p.canalePromemoria && !p.canaleSceltoIl)
    issues.push('Serve la data in cui il paziente ha scelto il canale (R15)');
  if (p.canaleSceltoIl && p.canaleSceltoIl > today)
    issues.push('La data della scelta del canale è nel futuro');
  return issues;
}

/** Date di nascita e di decesso: la nascita non è nel futuro e il decesso non la precede. */
export function lifeDatesIssues(
  nascita: string,
  decedutoIl: string | null | undefined,
  today: string,
): string[] {
  const issues: string[] = [];
  if (nascita > today) issues.push('La data di nascita è nel futuro');
  if (decedutoIl && decedutoIl < nascita)
    issues.push('La data del decesso viene prima della nascita');
  return issues;
}

/** Due periodi hanno almeno un giorno in comune; una fine assente vuol dire «senza fine». */
export function periodsOverlap(
  a: { from: string; to?: string | null },
  b: { from: string; to?: string | null },
): boolean {
  const END = '9999-12-31';
  return a.from <= (b.to ?? END) && b.from <= (a.to ?? END);
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

/** Periodo di una scelta del medico: data della scelta, scadenza, cessazione con il motivo. */
const doctorChoicePeriod = {
  dal: isoDate,
  scadenza: isoDate.nullable().optional(),
  cessataIl: isoDate.nullable().optional(),
  motivoCessazione: optionalText(300),
};
const ceasedAfterChoice = (c: { dal: string; cessataIl?: string | null }) =>
  !c.cessataIl || c.cessataIl >= c.dal;

/** Scelta del medico registrata a mano (in attesa di AURA). */
export const doctorChoiceSchema = z
  .object({ medicoId: z.uuid(), ...doctorChoicePeriod })
  .strict()
  .refine(ceasedAfterChoice, 'La cessazione viene dopo la scelta');
export type DoctorChoiceInput = z.infer<typeof doctorChoiceSchema>;

/**
 * La stessa scelta senza il medico, per l'importazione: lì il medico è sempre il titolare che
 * importa (il programma conosce solo i medici dello studio). Stessi campi e stessi controlli.
 */
export const doctorChoicePeriodSchema = z
  .object(doctorChoicePeriod)
  .strict()
  .refine(ceasedAfterChoice, 'La cessazione viene dopo la scelta');
export type DoctorChoicePeriodInput = z.infer<typeof doctorChoicePeriodSchema>;

/** Periodo in cui vale una scelta: dalla scelta alla prima fra cessazione e scadenza. */
export function choiceValidity(c: {
  dal: string;
  scadenza?: string | null;
  cessataIl?: string | null;
}): { from: string; to: string | null } {
  return {
    from: c.dal,
    to: [c.cessataIl, c.scadenza].filter((d): d is string => !!d).sort()[0] ?? null,
  };
}

/**
 * Problemi di coerenza di una scelta del medico, in chiaro; vuoto se tutto torna. Il medico non
 * conta: vale per la scelta scritta a mano e per quella importata.
 */
export function doctorChoiceIssues(
  c: DoctorChoicePeriodInput & { medicoId?: string },
  today: string,
): string[] {
  const issues: string[] = [];
  if (c.scadenza && c.scadenza < c.dal) issues.push('La scadenza viene dopo la scelta');
  if (c.cessataIl && c.cessataIl > today) issues.push('La data della cessazione è nel futuro');
  if (c.cessataIl && !c.motivoCessazione?.trim()) issues.push('Per la cessazione serve il motivo');
  if (c.motivoCessazione?.trim() && !c.cessataIl)
    issues.push('Il motivo della cessazione vale solo con la data della cessazione');
  return issues;
}

/** Lunghezza minima del motivo di una correzione dell'identità: una frase, non una sigla. */
export const IDENTITY_FIX_REASON_MIN = 10;
