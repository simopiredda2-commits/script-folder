/**
 * Lotti di NRE dati dal servizio della regione (D269, D300). Dove la regione lo vuole, la cartella
 * numera da sé le ricette SSN con i lotti che il servizio le dà, legati al codice fiscale del
 * medico. Il servizio li prende dal SAC del Sistema TS («Gestione del numero ricetta elettronica»,
 * versione 2 del 21/05/2012, §2.2 e §3.1). Qui l'interfaccia nazionale; il servizio e il suo
 * simulatore sono nel pacchetto della regione (regola 7).
 */

import type { NreLotCode } from '@mmg/domain';
import type { AuthProblem, ServiceAuth } from './service-auth';

export type LotResult =
  | { outcome: 'assigned'; lot: NreLotCode; raw: unknown }
  | {
      outcome: 'rejected';
      /** I codici del servizio della regione; per le credenziali quelli del simulatore. */
      code: string;
      message: string;
      authProblem?: AuthProblem;
      raw: unknown;
    }
  | { outcome: 'unreachable'; message: string }
  | { outcome: 'timeout'; message: string };

export interface RegionalNreLots {
  /**
   * «Richiesta Lotto» (Sistema TS, «Gestione del numero ricetta elettronica», v2, §2.2 e §3.1):
   * codice della regione, tipo di lotto e codice fiscale del medico a cui il servizio lo assegna.
   */
  requestLot(
    input: { regionCode: string; lotType: string; doctorFiscalCode: string },
    auth: ServiceAuth,
  ): Promise<LotResult>;
}

/** Il servizio sa anche dare i lotti di NRE? */
export function hasNreLots(gateway: unknown): gateway is RegionalNreLots {
  return typeof (gateway as Partial<RegionalNreLots> | null)?.requestLot === 'function';
}
