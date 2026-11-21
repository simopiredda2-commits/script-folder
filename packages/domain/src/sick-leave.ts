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

/**
 * Ciclo del certificato nel programma: bozza → in invio → inviato, oppure errore. Inviato →
 * annullato (entro il giorno dopo il rilascio) o rettificato (entro la fine della prognosi, con un
 * certificato nuovo e un protocollo nuovo). Gli stati sono del prodotto; i tempi sono del DM. Un
 * certificato rimasto «in invio» per un arresto del servizio si chiude con l'esito chiesto
 * all'INPS, come la ricetta (D233).
 */
export const CERTIFICATE_STATUSES = [
  'draft',
  'sending',
  'sent',
  'error',
  'cancelled',
  'rectified',
] as const;
export type CertificateStatus = (typeof CERTIFICATE_STATUSES)[number];

export const CERTIFICATE_STATUS_LABELS: Record<CertificateStatus, string> = {
  draft: 'Bozza',
  sending: 'In invio',
  sent: 'Inviato',
  error: 'Errore',
  cancelled: 'Annullato',
  rectified: 'Rettificato',
};

export type CertificateEvent =
  | 'edit'
  | 'start_sending'
  | 'send_succeeded'
  | 'send_failed'
  | 'cancel'
  | 'rectify'
  /**
   * Esito di un invio rimasto senza risposta, segnato dal medico dopo averlo chiesto all'INPS
   * (D233): arrivato, con il protocollo, oppure non arrivato.
   */
  | 'settle_arrived'
  | 'settle_not_arrived';

/** Perché l'ultimo invio non è andato: come per le ricette (rifiuto, rete, tempo, accesso). */
export type CertificateErrorKind = 'rejected' | 'unreachable' | 'timeout' | 'auth';

export type CertificateTransition =
  { ok: true; to: CertificateStatus } | { ok: false; reason: string };

export function certificateTransition(
  from: CertificateStatus,
  event: CertificateEvent,
  ctx: { lastErrorKind?: CertificateErrorKind | null } = {},
): CertificateTransition {
  const ok = (to: CertificateStatus): CertificateTransition => ({ ok: true, to });
  const no = (reason: string): CertificateTransition => ({ ok: false, reason });
  const kind = ctx.lastErrorKind ?? null;
  switch (event) {
    case 'edit':
      if (from === 'draft') return ok('draft');
      if (from === 'error' && (kind === 'rejected' || kind === 'auth')) return ok('draft');
      if (from === 'error')
        return no('Un certificato senza risposta dell’INPS non si modifica: riprova l’invio');
      return no('Un certificato inviato non si modifica: si rettifica o si annulla');
    case 'start_sending':
      if (from === 'draft') return ok('sending');
      if (from === 'error' && (kind === 'unreachable' || kind === 'timeout' || kind === 'auth'))
        return ok('sending');
      if (from === 'error')
        return no('L’INPS l’ha rifiutato: correggilo prima di inviarlo di nuovo');
      if (from === 'sending') return no('Invio già in corso');
      return no('Questo certificato non si può inviare');
    case 'send_succeeded':
      return from === 'sending' ? ok('sent') : no('Nessun invio in corso');
    case 'send_failed':
      return from === 'sending' ? ok('error') : no('Nessun invio in corso');
    case 'cancel':
      if (from === 'draft' || from === 'error' || from === 'sent') return ok('cancelled');
      if (from === 'sending') return no('Invio in corso: aspetta la risposta');
      return no('Già annullato o rettificato');
    case 'rectify':
      return from === 'sent' ? ok('rectified') : no('Si rettifica solo un certificato inviato');
    case 'settle_arrived':
      return from === 'sending' ? ok('sent') : no('Nessun invio senza risposta da chiudere');
    case 'settle_not_arrived':
      // L'INPS ha detto che non è arrivato: come quando non risponde, si rimanda.
      return from === 'sending' ? ok('error') : no('Nessun invio senza risposta da chiudere');
  }
}

/** Il giorno dopo, in AAAA-MM-GG: inizio di una continuazione. */
export function nextDay(iso: string): string {
  return addDays(iso, 1);
}

/** Giorni di prognosi, estremi compresi. */
export function prognosisDays(startDate: string, endDate: string): number {
  return Math.round((toTime(endDate) - toTime(startDate)) / DAY) + 1;
}

/** Indirizzo del certificato: residenza o reperibilità (schema XSD, tipo `indirizzo`). */
export interface SickLeaveAddressInput {
  street?: string | null;
  number?: string | null;
  postalCode?: string | null;
  town?: string | null;
  province?: string | null;
  cadastralCode?: string | null;
}

/** Numero civico quando non c'è (specifiche, elemento civico). */
export const NO_HOUSE_NUMBER = 'SNC';

/** Nominativo presso l'abitazione: tipo `cognome` dello schema (2–24 lettere, spazi, apostrofo). */
export const AVAILABILITY_NAME_PATTERN = /^[a-zA-Z ']{2,24}$/;

/**
 * Controlli di forma dell'indirizzo, con i codici d'errore dell'INPS: 421–437 per la residenza,
 * 461–477 per la reperibilità. Formati dallo schema XSD delle specifiche 3.2: via 2–50 caratteri,
 * civico 1–15 (SNC se manca), CAP di 5 cifre, comune fino a 25 caratteri, provincia di 2 lettere,
 * codice catastale una lettera e tre cifre; serve il codice catastale o comune e provincia.
 */
export function checkSickLeaveAddress(
  a: SickLeaveAddressInput,
  kind: 'residenza' | 'reperibilita',
): SickLeaveIssue[] {
  const rep = kind === 'reperibilita';
  const where = rep ? ' (reperibilità)' : '';
  const issues: SickLeaveIssue[] = [];
  const add = (residence: string, availability: string, message: string) =>
    issues.push({ code: rep ? availability : residence, message: `${message}${where}` });
  const street = a.street?.trim() ?? '';
  const town = a.town?.trim() ?? '';
  const province = a.province?.trim() ?? '';
  const cadastral = a.cadastralCode?.trim() ?? '';
  const number = a.number?.trim() ?? '';
  if (street.length < 2 || street.length > 50) add('421', '461', 'Via: da 2 a 50 caratteri');
  if (number.length > 15) add('422', '462', 'Numero civico: al più 15 caratteri (SNC se manca)');
  if (cadastral && !/^[A-Za-z][0-9]{3}$/.test(cadastral))
    add('434', '474', 'Codice catastale del comune: una lettera e tre cifre, per esempio H501');
  if (!cadastral && (!town || !province))
    add('433', '473', 'Serve il comune con la provincia, oppure il codice catastale');
  if (town.length > 25) add('431', '471', 'Comune: al più 25 caratteri');
  if (province && !/^[A-Za-z]{2}$/.test(province))
    add('436', '476', 'Provincia: due lettere (EE per l’estero)');
  if (!/^[0-9]{5}$/.test(a.postalCode?.trim() ?? '')) add('437', '477', 'CAP: cinque cifre');
  return issues;
}
