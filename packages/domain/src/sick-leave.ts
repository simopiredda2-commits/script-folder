/**
 * Certificato di malattia telematico (tappa 8). Valori e controlli dalle fonti pubbliche:
 *
 * - Specifiche tecniche per la trasmissione all'INPS dei certificati di malattia (Sistema TS,
 *   versione 3.2, 17/09/2013): tipi `tipoCertificato` (I, C, R), `tipoVisita` (A, D, P),
 *   `agevolazioni` (T, C, I), `ruolo` (S, P), schema del codice diagnosi ICD-9-CM, e i codici di
 *   errore dell'INPS ripetuti qui prima dell'invio (23, 24, 25, 26, 1003, 1004, 1007).
 * - DM 26 febbraio 2010, disciplinare tecnico (GU n. 65 del 19/3/2010): rettifica «esclusivamente
 *   entro il termine del periodo di prognosi», annullamento «esclusivamente entro il giorno
 *   successivo alla data di rilascio».
 */

export const SICK_LEAVE_TYPES = ['I', 'C', 'R'] as const;
export type SickLeaveType = (typeof SICK_LEAVE_TYPES)[number];
export const SICK_LEAVE_TYPE_LABELS: Record<SickLeaveType, string> = {
  I: 'Inizio',
  C: 'Continuazione',
  R: 'Ricaduta',
};

export const VISIT_TYPES = ['A', 'D', 'P'] as const;
export type VisitType = (typeof VISIT_TYPES)[number];
export const VISIT_TYPE_LABELS: Record<VisitType, string> = {
  A: 'Ambulatoriale',
  D: 'Domiciliare',
  P: 'Pronto soccorso',
};

export const BENEFITS = ['T', 'C', 'I'] as const;
export type Benefit = (typeof BENEFITS)[number];
export const BENEFIT_LABELS: Record<Benefit, string> = {
  T: 'Patologia grave che richiede terapia salvavita',
  C: 'Malattia per la quale è stata riconosciuta la causa di servizio',
  I: 'Stato patologico sotteso o connesso alla situazione di invalidità riconosciuta',
};

export const DOCTOR_ROLES = ['S', 'P'] as const;
export type DoctorRole = (typeof DOCTOR_ROLES)[number];

/** Codice diagnosi ICD-9-CM 2007, come nello schema XSD delle specifiche (codiceDiagnosi). */
export const ICD9_DIAGNOSIS_PATTERN = /^(E?[V0-9][0-9]{1,2}|E?[V0-9][0-9]{1,2}[.][0-9]{0,2})$/;

/** Note della diagnosi: al più 200 caratteri (tipo string200 dello schema). */
export const DIAGNOSIS_NOTES_MAX = 200;

/** Età minima dell'intestatario: sotto i 16 anni l'INPS scarta (codice 1007). */
export const MIN_WORKER_AGE = 16;

export interface SickLeaveInput {
  type: SickLeaveType;
  visit: VisitType;
  /** Date AAAA-MM-GG. */
  releaseDate: string;
  startDate: string;
  endDate: string;
  diagnosisCode?: string | null;
  diagnosisNotes?: string | null;
  workedDay?: boolean | null;
}

export interface SickLeaveIssue {
  /** Codice dell'INPS o del SAC che il controllo ripete, oppure il nome del campo. */
  code: string;
  message: string;
}

const DAY = 86_400_000;
const toTime = (iso: string) => Date.parse(`${iso}T12:00:00Z`);
const addDays = (iso: string, n: number) =>
  new Date(toTime(iso) + n * DAY).toISOString().slice(0, 10);

/**
 * Lo stesso giorno n mesi dopo; se quel mese è più corto, il suo ultimo giorno. È la lettura qui
 * scelta di «tre mesi solari successivi al rilascio» (codice 25): da verificare in collaudo.
 */
export function addMonths(iso: string, n: number): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

/** Anni compiuti alla data. */
export function ageAt(birthDate: string, at: string): number {
  const [by, bm, bd] = birthDate.split('-').map(Number) as [number, number, number];
  const [y, m, d] = at.split('-').map(Number) as [number, number, number];
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
}

/**
 * I controlli formali dell'INPS ripetuti prima dell'invio: l'errore si vede subito, non dopo uno
 * scarto. Restano dell'INPS le verifiche che richiedono i suoi archivi (codice fiscale e
 * anagrafica, indirizzo, codice ASL).
 */
export function checkSickLeave(
  c: SickLeaveInput,
  ctx: { today: string; workerBirthDate: string },
): SickLeaveIssue[] {
  const issues: SickLeaveIssue[] = [];
  const add = (code: string, message: string) => issues.push({ code, message });
  if (c.releaseDate !== ctx.today && c.releaseDate !== addDays(ctx.today, -1))
    add('26', 'Data di rilascio: deve essere oggi o ieri');
  if (c.startDate > c.releaseDate)
    add('23', 'Data di inizio della malattia: non può essere dopo la data di rilascio');
  if (c.endDate < c.releaseDate)
    add('24', 'Data di fine prognosi: non può essere prima della data di rilascio');
  if (c.endDate > addMonths(c.releaseDate, 3))
    add('25', 'Periodo troppo lungo: oltre i tre mesi solari dopo il rilascio');
  if (c.workedDay) {
    if (c.startDate !== c.releaseDate)
      add('1003', 'Giornata lavorata: la malattia comincia il giorno della visita');
    if (c.endDate <= c.releaseDate)
      add('1004', 'Giornata lavorata: la fine della prognosi va dopo il giorno della visita');
  }
  if (ageAt(ctx.workerBirthDate, c.releaseDate) < MIN_WORKER_AGE)
    add('1007', `Il lavoratore ha meno di ${MIN_WORKER_AGE} anni`);
  const code = c.diagnosisCode?.trim();
  const notes = c.diagnosisNotes?.trim();
  if (!code && !notes) add('diagnosi', 'Diagnosi: serve il codice ICD-9-CM o la descrizione');
  if (code && !ICD9_DIAGNOSIS_PATTERN.test(code))
    add('43', 'Codice diagnosi: non è nel formato ICD-9-CM (es. 487, 487.1, V17.34)');
  if (notes && notes.length > DIAGNOSIS_NOTES_MAX)
    add('diagnosi', `Descrizione della diagnosi: al più ${DIAGNOSIS_NOTES_MAX} caratteri`);
  return issues;
}

/** Rettifica: solo per anticipare la fine, ed entro la fine della prognosi (DM 26/2/2010, 3.3). */
export function canRectify(
  c: { endDate: string },
  newEndDate: string,
  today: string,
): { ok: true } | { ok: false; reason: string } {
  if (today > c.endDate)
    return { ok: false, reason: 'La rettifica è ammessa solo entro la fine della prognosi' };
  if (newEndDate >= c.endDate)
    return { ok: false, reason: 'La rettifica può solo anticipare la data di fine prognosi' };
  return { ok: true };
}

/** Annullamento: entro il giorno successivo alla data di rilascio (DM 26/2/2010, 3.4). */
export function canCancelSickLeave(
  c: { releaseDate: string },
  today: string,
): { ok: true } | { ok: false; reason: string } {
  return today <= addDays(c.releaseDate, 1)
    ? { ok: true }
    : {
        ok: false,
        reason: 'L’annullamento è ammesso solo entro il giorno successivo alla data di rilascio',
      };
}
