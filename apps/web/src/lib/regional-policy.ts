/**
 * Le politiche di invio della regione dello studio al suo Fascicolo, come le dà il servizio dal
 * pacchetto della regione (D297): le pagine le dicono con i numeri della regione, senza scriverli.
 */
export interface RegionalPolicy {
  /** Dalla mezzanotte a quest'ora di Roma il Fascicolo della regione non riceve; null se mai. */
  quietUntilHour: number | null;
  minIntervalMs: number;
  retries: number;
  retryDelayMs: number;
  fallbackDays: number;
}

/** «1 giorno», «10 giorni». */
export const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** I minuti fra due ripetizioni ravvicinate. */
export const retryMinutes = (p: RegionalPolicy) =>
  counted(Math.round(p.retryDelayMs / 60_000), 'minuto', 'minuti');

/** «niente invii dalle 00 alle 07, 3 tentativi a 5 minuti e poi uno al giorno per 10 giorni». */
export function policyText(p: RegionalPolicy): string {
  const parts: string[] = [];
  if (p.quietUntilHour !== null)
    parts.push(`niente invii dalle 00 alle ${String(p.quietUntilHour).padStart(2, '0')}`);
  parts.push(
    `${counted(p.retries, 'tentativo', 'tentativi')} a ${retryMinutes(p)} e poi uno al giorno per ${counted(p.fallbackDays, 'giorno', 'giorni')}`,
  );
  return parts.join(', ');
}
