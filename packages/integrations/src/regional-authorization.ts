/**
 * Accesso con SPID o CIE della regione (D109, D301): il medico entra sulla pagina della regione e
 * autorizza il programma, con OAuth2 e PKCE (RFC 7636); il token che ne esce sostituisce, per le
 * ricette, utente, password, PIN e secondo fattore. Qui il contratto nazionale, con quello che il
 * nucleo fa per ogni regione: lo state, il code_verifier, lo scambio del codice, la sessione, la
 * revoca. Come si chiama il servizio, quali permessi si chiedono, com'è fatto il token e il
 * simulatore li dà il pacchetto della regione (regola 7).
 *
 * - Pagina di autorizzazione: client_id, response_type=code, redirect_uri, scope, state,
 *   code_challenge con code_challenge_method=S256.
 * - Ritorno sul redirect_uri con code e state, oppure con error ed error_description.
 * - Scambio del codice con il code_verifier: il token, i permessi concessi, chi è entrato, la
 *   scadenza e il gestionale per cui vale.
 */

import { createHash, randomBytes } from 'node:crypto';

/** code_verifier di PKCE: 43 caratteri base64url (la specifica chiede tra 43 e 128). */
export function newPkceVerifier(): string {
  return randomBytes(32).toString('base64url');
}

/** code_challenge con il metodo S256: SHA-256 del verifier, in base64url senza padding. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  scope: readonly string[];
  state: string;
  codeChallenge: string;
  /**
   * Codice fiscale del medico collegato. Solo il simulatore lo usa, per sapere «chi entra con
   * SPID»; il servizio vero lo ricava dall'identità digitale e lo mette nel token.
   */
  loginHint?: string;
}

export type TokenResult =
  | {
      outcome: 'ok';
      accessToken: string;
      /** Permessi concessi. */
      scope: string[];
      /** Fine della validità del token. */
      validUntil: string;
      /** Dal token: codice fiscale di chi si è autenticato e identificativo della sessione. */
      fiscalCode: string;
      sessionId: string;
      /** Dal token: il gestionale per cui è stato rilasciato (client_id). */
      clientId: string;
      raw: unknown;
    }
  | { outcome: 'rejected'; error: string; description: string | null; raw: unknown }
  | { outcome: 'unreachable'; message: string };

export type TokenCheck =
  | { outcome: 'valid'; validUntil: string }
  | { outcome: 'invalid'; state: 'revocato' | 'scaduto' | 'sconosciuto' }
  | { outcome: 'unreachable'; message: string };

export type RevokeResult =
  { outcome: 'revoked' } | { outcome: 'invalid' } | { outcome: 'unreachable'; message: string };

export interface RegionalAuthorizationGateway {
  readonly environment: 'simulator' | 'test' | 'production';
  /** Indirizzo della pagina di autorizzazione della regione, da aprire nel browser del medico. */
  authorizeUrl(request: AuthorizeRequest): string;
  exchange(input: {
    code: string;
    redirectUri: string;
    clientId: string;
    codeVerifier: string;
  }): Promise<TokenResult>;
  verify(input: { clientId: string; fiscalCode: string; accessToken: string }): Promise<TokenCheck>;
  /**
   * Chiude il token presso la regione: «revoked»; «invalid» se per la regione non valeva già più
   * (scaduto, revocato o sconosciuto).
   */
  revoke(input: {
    clientId: string;
    fiscalCode: string;
    accessToken: string;
  }): Promise<RevokeResult>;
}

/**
 * Il simulatore dell'accesso, con la sua pagina servita dal programma solo in simulazione: il
 * medico «entra con SPID o CIE» e la pagina chiede il codice da rimandare al ritorno (D193).
 */
export interface SimulatedAuthorizationPage {
  approve(input: {
    clientId: string;
    redirectUri: string;
    scope: string[];
    codeChallenge: string;
    fiscalCode: string;
  }): string;
}

/** È un simulatore con la sua pagina? */
export function isSimulatedAuthorizationPage(
  gateway: RegionalAuthorizationGateway,
): gateway is RegionalAuthorizationGateway & SimulatedAuthorizationPage {
  return (
    gateway.environment === 'simulator' &&
    typeof (gateway as Partial<SimulatedAuthorizationPage>).approve === 'function'
  );
}
