/**
 * Servizi del SAR della Regione Piemonte oltre alla ricetta dematerializzata (D269): il lotto di
 * NRE con cui la cartella numera le ricette (SIRPED, «Cartelle cliniche MMG e PLS», V06 del
 * 10/04/2026, 3.2 e 4.1). Le credenziali sono «esclusivamente» utente, password e PIN RUPAR, senza
 * autenticazione multifattore (3.1.1). Qui l'interfaccia; il simulatore è in `simulator.ts`
 * (regola 7).
 */

import type { NreLotCode } from '@mmg/domain';
import type { AuthProblem, ServiceAuth } from './service-auth';

export type LotResult =
  | { outcome: 'assigned'; lot: NreLotCode; raw: unknown }
  | {
      outcome: 'rejected';
      /** I codici della V06 (4.1, p. 11): 02–06; per le credenziali quelli del simulatore. */
      code: string;
      message: string;
      authProblem?: AuthProblem;
      raw: unknown;
    }
  | { outcome: 'unreachable'; message: string }
  | { outcome: 'timeout'; message: string };

export interface SarRegionalServices {
  /**
   * «Richiesta Lotto» (V06, 4.1; Sistema TS, «Gestione del numero ricetta elettronica», v2 del
   * 21/05/2012, §2.2 e §3.1): codice della regione, tipo di lotto (in Piemonte solo 1) e codice
   * fiscale del medico a cui il SAR lo assegna.
   */
  requestLot(
    input: { regionCode: string; lotType: string; doctorFiscalCode: string },
    auth: ServiceAuth,
  ): Promise<LotResult>;
}

/** Il SAR dato al servizio sa anche dare i lotti di NRE? I simulatori sì. */
export function isSarRegionalServices(gateway: unknown): gateway is SarRegionalServices {
  return typeof (gateway as Partial<SarRegionalServices> | null)?.requestLot === 'function';
}
