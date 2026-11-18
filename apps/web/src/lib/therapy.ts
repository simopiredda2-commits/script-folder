/**
 * Scheda della terapia: le voci degli elenchi e i calcoli che la scheda propone, che il medico
 * può sempre correggere (D80). Gli elenchi sono quelli dei prototipi della scheda.
 */

export const DOSE_UNITS = ['compressa', 'capsula', 'bustina', 'goccia', 'unità'] as const;

export const FREQUENCIES = [
  '1 volta al giorno',
  '2 volte al giorno',
  '3 volte al giorno',
  'a giorni alterni',
  '1 volta a settimana',
] as const;

export const TIMES_OF_DAY = ['al mattino', 'a pranzo', 'la sera', 'indifferente'] as const;

export const ROUTES = ['per bocca', 'sottocute', 'inalatoria', 'cutanea', 'oculare'] as const;

/** Quante volte al giorno, per ogni frequenza dell'elenco. */
const TIMES_PER_DAY: Record<string, number> = {
  '1 volta al giorno': 1,
  '2 volte al giorno': 2,
  '3 volte al giorno': 3,
  'a giorni alterni': 1 / 2,
  '1 volta a settimana': 1 / 7,
};

/** La dose scritta dal medico: «1», «2», «0,5», «1/2». Altro testo: non è un numero. */
export function parseDose(text: string | null | undefined): number | null {
  const t = (text ?? '').trim().replace(',', '.');
  if (/^\d+(?:\.\d+)?$/.test(t)) return Number(t);
  const fraction = /^(\d+)\s*\/\s*(\d+)$/.exec(t);
  if (fraction && Number(fraction[2]) > 0) return Number(fraction[1]) / Number(fraction[2]);
  return null;
}

/**
 * Unità al giorno per il contatore (R11): dose × volte al giorno, con tre decimali al più.
 * Vuoto quando non si può dire (al bisogno, dose che non è un numero, frequenza fuori elenco):
 * allora il contatore non conta e la ricetta non lo usa.
 */
export function dailyUnits(
  dose: string | null | undefined,
  frequency: string | null | undefined,
  kind: string,
): string | null {
  if (kind === 'as_needed') return null;
  const d = parseDose(dose);
  const times = frequency ? TIMES_PER_DAY[frequency] : undefined;
  if (d === null || d <= 0 || times === undefined) return null;
  return String(Math.round(d * times * 1000) / 1000);
}

const PLURAL: Record<string, string> = {
  compressa: 'compresse',
  capsula: 'capsule',
  bustina: 'bustine',
  goccia: 'gocce',
  unità: 'unità',
};

const SPOKEN: Record<string, string> = {
  '1 volta al giorno': 'una volta al giorno',
  '2 volte al giorno': 'due volte al giorno',
  '3 volte al giorno': 'tre volte al giorno',
  '1 volta a settimana': 'una volta a settimana',
};

export interface Posology {
  dose?: string | null;
  doseUnit?: string | null;
  frequency?: string | null;
  timeOfDay?: string | null;
  route?: string | null;
  kind?: string;
}

/** Come la legge il paziente: «1 compressa una volta al giorno, la sera, per bocca». */
export function patientReading(t: Posology): string {
  const d = parseDose(t.dose);
  const unit = t.doseUnit
    ? d !== null && d > 1
      ? (PLURAL[t.doseUnit] ?? t.doseUnit)
      : t.doseUnit
    : '';
  const first = [t.dose?.trim(), unit, t.frequency ? (SPOKEN[t.frequency] ?? t.frequency) : '']
    .filter(Boolean)
    .join(' ');
  const when = t.timeOfDay && t.timeOfDay !== 'indifferente' ? t.timeOfDay : null;
  const text = [first, when, t.route].filter(Boolean).join(', ');
  if (t.kind === 'as_needed') return text ? `${text}, al bisogno` : 'Al bisogno';
  return text;
}

/** Il momento della giornata per lo schema orario; «indifferente» e il vuoto vanno insieme. */
export function scheduleMoment(t: Posology): string {
  if (t.kind === 'as_needed') return 'Al bisogno';
  switch (t.timeOfDay) {
    case 'al mattino':
      return 'Mattino';
    case 'a pranzo':
      return 'Pranzo';
    case 'la sera':
      return 'Sera';
    default:
      return 'In qualsiasi momento';
  }
}

export const SCHEDULE_MOMENTS = [
  'Mattino',
  'Pranzo',
  'Sera',
  'In qualsiasi momento',
  'Al bisogno',
] as const;
