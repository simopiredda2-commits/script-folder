/** Date AAAA-MM-GG in UTC: niente fusi orari nei conti delle regole. */
const DAY_MS = 24 * 60 * 60 * 1000;

function parse(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d);
}

function format(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return format(parse(date) + days * DAY_MS);
}

export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return format(Date.UTC(y!, m! - 1 + months, d));
}

/** Giorni da `from` a `to` (positivi se `to` è dopo). */
export function daysBetween(from: string, to: string): number {
  return Math.round((parse(to) - parse(from)) / DAY_MS);
}

/** GG/MM/AAAA, per i messaggi. */
export function italian(date: string): string {
  const [y, m, d] = date.split('-');
  return `${d}/${m}/${y}`;
}
