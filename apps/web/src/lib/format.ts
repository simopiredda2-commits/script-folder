/** Formati e nomi dell'interfaccia, in italiano. */

const TZ = 'Europe/Rome';

/** 2026-11-18 → 18/11/2026 (le date senza ora non cambiano con il fuso). */
export function date(iso: string | null | undefined): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

/** Istante → 18/11/2026 alle 09:15, nel fuso dello studio. */
export function dateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat('it-IT', {
    timeZone: TZ,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(d);
  return `${day} alle ${time(iso)}`;
}

export function time(iso: string): string {
  return new Intl.DateTimeFormat('it-IT', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}

/** «Mercoledì 18 novembre 2026»: maiuscola solo all'inizio, i mesi restano minuscoli. */
export function longDate(isoDate: string): string {
  const text = new Intl.DateTimeFormat('it-IT', {
    timeZone: 'UTC',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(new Date(`${isoDate}T12:00:00Z`));
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Età in anni compiuti alla data di oggi. */
export function age(birthDate: string, today = new Date()): number {
  const [y, m, d] = birthDate.split('-').map(Number) as [number, number, number];
  let years = today.getFullYear() - y;
  if (today.getMonth() + 1 < m || (today.getMonth() + 1 === m && today.getDate() < d)) years--;
  return years;
}

/** Codice fiscale con le ultime cifre coperte, finché non si chiede di mostrarlo. */
export function maskedFiscalCode(cf: string): string {
  return `${cf.slice(0, 11)}•••••`;
}

export function money(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  return new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(
    Number(value),
  );
}

export const PRESCRIPTION_KIND: Record<string, string> = {
  pharma_ssn: 'Farmaceutica SSN',
  specialist_ssn: 'Specialistica SSN',
  white: 'Bianca',
  devices: 'Presidi',
};

export const PRESCRIPTION_STATUS: Record<string, string> = {
  draft: 'Bozza',
  to_sign: 'Da firmare',
  sending: 'In invio',
  sent: 'Inviata',
  error: 'Errore',
  cancelled: 'Annullata',
  paper: 'Ricetta rossa stampata',
};

export const THERAPY_KIND: Record<string, string> = {
  chronic: 'Cronica',
  as_needed: 'Al bisogno',
  cycle: 'Ciclo con data di fine',
};

export const ACCESS_TYPE: Record<string, string> = {
  first: 'Primo accesso',
  subsequent: 'Accesso successivo',
};

/** Classi di priorità della ricetta specialistica, con il loro significato. */
export const PRIORITY: Record<string, string> = {
  U: 'U – urgente',
  B: 'B – breve',
  D: 'D – differibile',
  P: 'P – programmata',
};

export const APPOINTMENT_KIND: Record<string, string> = {
  office: 'In studio',
  home: 'Domicilio',
  televisit: 'Televisita',
};

export const TIMELINE_KIND: Record<string, string> = {
  diary: 'Visita',
  problem: 'Problema',
  measurement: 'Parametro',
  anamnesis: 'Anamnesi',
  allergy: 'Allergia',
  risk_factor: 'Stile di vita',
  examination: 'Esame obiettivo',
  vaccination: 'Vaccinazione',
  lab_result: 'Esame di laboratorio',
  report: 'Referto',
  prescription: 'Ricetta',
};

export const REMINDER_CHANNEL: Record<string, string> = {
  paper: 'Promemoria stampato',
  email: 'Email',
  pec: 'PEC',
  sms: 'SMS',
  messaging_app: 'App di messaggistica',
  phone: 'Telefono',
  fse: 'Fascicolo sanitario',
};

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
