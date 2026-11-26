import type { CredentialService, CredentialServiceInfo, RegionalUse } from '@mmg/domain';
import type { RegionalAuthorizationGateway } from './regional-authorization';
import type { SecondFactorGateway } from './service-auth';

/**
 * Le credenziali del medico per i servizi della regione dello studio (D301): un contratto
 * nazionale, che il pacchetto della regione attua. Il nucleo conserva utente, password e PIN
 * cifrati, il secondo fattore e il token dell'accesso con SPID o CIE, e li manda alle chiamate ai
 * servizi della regione (ricetta SSN, lotti di NRE, ricetta rossa, Fascicolo). Il pacchetto dice:
 *
 * - che servizio è: la chiave con cui le credenziali si conservano, il nome corto per le rotte e
 *   gli errori, il nome, a che cosa servono, quanti mesi vale la password;
 * - quali invii della regione chiedono il secondo fattore, oltre a quelli che lo chiedono per legge
 *   (`NATIONAL_SECOND_FACTOR`);
 * - il secondo fattore del servizio, se c'è;
 * - come il programma si presenta alla regione per un medico, se la regione lo chiede;
 * - l'accesso con SPID o CIE della regione, se c'è.
 *
 * I servizi veri si chiamano con gli adattatori, che si aggiungono con l'ente; oggi i simulatori
 * (regola 7).
 */
export interface RegionalCredentials extends CredentialServiceInfo {
  readonly key: CredentialService;
  /**
   * Gli invii della regione che chiedono il secondo fattore oltre alla ricetta SSN, che lo chiede
   * sempre (DM 27/2/2025).
   */
  readonly secondFactorUses: readonly RegionalUse[];
  /** Il secondo fattore del servizio (Id-Sessione per email): oggi il simulatore. */
  readonly secondFactor?: (options: { now?: () => Date }) => SecondFactorGateway;
  /** Come il programma si presenta alla regione per un medico, se la regione lo chiede. */
  readonly software?: RegionalSoftwareIdentity;
  /** L'accesso con SPID o CIE della regione, se c'è. */
  readonly strongAccess?: RegionalStrongAccess;
}

/** Come il programma si presenta alla regione per un medico (D266, D267, D301). */
export interface RegionalSoftwareIdentity {
  /** La variabile della configurazione con il codice che la regione assegna al programma. */
  readonly variable: string;
  /** Che cosa non va nel codice della configurazione, o null. */
  codeProblem(code: string): string | null;
  /**
   * Come il programma si presenta per il medico con quel codice ASL: il `client_id` dell'accesso
   * con SPID o CIE, e `ServiceAuth.software` nelle chiamate con utente e password.
   */
  identify(code: string, aslCode: string | null | undefined): SoftwareIdentityResult;
}

export type SoftwareIdentityResult =
  { ok: true; value: string } | { ok: false; code: 'GESTIONALE' | 'ASL'; message: string };

/**
 * Il codice del programma quando la configurazione non lo dà (D267): vale solo con i simulatori.
 */
export const SIMULATED_SOFTWARE_CODE = 'SIMULATORE';

/** L'accesso con SPID o CIE della regione (D109, D301). */
export interface RegionalStrongAccess {
  /** I permessi che il programma chiede alla regione (scope): quelli delle ricette. */
  readonly scope: readonly string[];
  /**
   * Detto al medico nella pagina delle credenziali, sotto l'accesso: a che cosa servono ancora
   * utente, password e PIN del servizio.
   */
  readonly note: string;
  /** Il servizio dell'accesso: oggi il simulatore. */
  gateway(options: { now?: () => Date }): RegionalAuthorizationGateway;
}
