import { useSession, type RegionalServiceWords } from './session';

/**
 * Le parole quando la regione dello studio non ha, nel programma, il servizio delle ricette SSN:
 * generiche, perché l'interfaccia non nomina nessuna regione (D300).
 */
export const GENERIC_SERVICE: RegionalServiceWords = {
  via: 'servizio',
  nome: 'servizio della regione',
  il: 'il servizio della regione',
  al: 'al servizio della regione',
  dal: 'dal servizio della regione',
  del: 'del servizio della regione',
  ricettaRossaDpcm: false,
};

/** Il servizio delle ricette SSN della regione dello studio, con le sue parole (D300). */
export function useRegionalService(): RegionalServiceWords {
  const { state } = useSession();
  return (state.status === 'ready' ? state.me.servizioRicette : null) ?? GENERIC_SERVICE;
}

/** La prima lettera maiuscola, per le frasi che cominciano con il nome del servizio. */
export const capitalized = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
