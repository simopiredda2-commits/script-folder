/**
 * Accesso regionale con SPID o CIE per le ricette in Piemonte (D109): modalità «Id-Sessione con
 * protocollo OAuth2» del SIRPED (autenticazione forte, versione 4.0 del 2/3/2026, 3.2 e 4.3).
 *
 * - GET /oauth2/authorize: client_id, response_type=code, redirect_uri, scope, state (al più 500
 *   caratteri), code_challenge con code_challenge_method=S256 (PKCE, RFC 7636).
 * - Ritorno sul redirect_uri con code e state, oppure con error ed error_description.
 * - POST /oauth2/token con grant_type=authorization_code, code, redirect_uri, client_id,
 *   code_verifier: access_token (JWT), scope, token_type Bearer, expires_in. Nessun refresh_token:
 *   alla scadenza serve una nuova autorizzazione.
 * - GET /sessionid/verify e DELETE /sessionid/revoke, con il token come Bearer.
 *
 * Con il token le chiamate al SAR usano `Authorization: Bearer` al posto di utente, password e PIN.
 * Qui l'interfaccia e il simulatore (regola 7).
 */

import { createHash, randomBytes, randomUUID } from 'node:crypto';

/** Scope del SIRPED per il medico prescrittore. */
export const PRESCRIBER_SCOPE = 'prescrizione';

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
  scope: string[];
  state: string;
  codeChallenge: string;
  /**
   * Codice fiscale del medico collegato. Solo il simulatore lo usa, per sapere «chi entra con
   * SPID»; il servizio vero lo ricava dall'identità digitale e lo mette nel token (sub).
   */
  loginHint?: string;
}

export type TokenResult =
  | {
      outcome: 'ok';
      accessToken: string;
      scope: string[];
      /** Secondi di validità indicati dal servizio (expires_in). */
      expiresIn: number;
      /** Dal token: codice fiscale di chi si è autenticato (sub) e Id-Sessione. */
      fiscalCode: string;
      sessionId: string;
      raw: unknown;
    }
  | { outcome: 'rejected'; error: string; description: string | null; raw: unknown }
  | { outcome: 'unreachable'; message: string };

export type TokenCheck =
  | { outcome: 'valid'; validUntil: string }
  | { outcome: 'invalid'; state: 'revocato' | 'scaduto' | 'sconosciuto' }
  | { outcome: 'unreachable'; message: string };

export interface RegionalAuthorizationGateway {
  readonly environment: 'simulator' | 'test' | 'production';
  /** Indirizzo della pagina di autorizzazione regionale, da aprire nel browser del medico. */
  authorizeUrl(request: AuthorizeRequest): string;
  exchange(input: {
    code: string;
    redirectUri: string;
    clientId: string;
    codeVerifier: string;
  }): Promise<TokenResult>;
  verify(input: { clientId: string; fiscalCode: string; accessToken: string }): Promise<TokenCheck>;
  revoke(input: {
    clientId: string;
    fiscalCode: string;
    accessToken: string;
  }): Promise<{ outcome: 'revoked' } | { outcome: 'unreachable'; message: string }>;
}

interface PendingCode {
  clientId: string;
  redirectUri: string;
  scope: string[];
  challenge: string;
  fiscalCode: string;
  expiresAt: number;
  used: boolean;
}

export interface SimulatedRegionalAuthorizationOptions {
  now?: () => Date;
  /** Validità del token. Per difetto 8 ore, come il Sistema TS (D102); quella vera è nel token. */
  tokenHours?: number;
  /** Validità del codice di autorizzazione: «qualche minuto» (4.3.1). Per difetto 5. */
  codeMinutes?: number;
  /** Indirizzo della pagina simulata, servita dal programma solo in simulazione. */
  pagePath?: string;
}

/**
 * Simulatore dell'Authorization Server del SIRPED. La «pagina regionale» è servita dal programma
 * stesso (solo in simulazione) e chiama `approve` o `deny`. Codici monouso, PKCE S256 verificato,
 * redirect_uri identico, token con scadenza fissa e senza rinnovo, revoca.
 */
export class SimulatedRegionalAuthorization implements RegionalAuthorizationGateway {
  readonly environment = 'simulator' as const;
  private readonly codes = new Map<string, PendingCode>();
  private readonly tokens = new Map<
    string,
    { fiscalCode: string; sessionId: string; validUntil: number; revoked: boolean }
  >();

  constructor(private readonly options: SimulatedRegionalAuthorizationOptions = {}) {}

  private now(): number {
    return (this.options.now?.() ?? new Date()).getTime();
  }

  authorizeUrl(r: AuthorizeRequest): string {
    const q = new URLSearchParams({
      client_id: r.clientId,
      response_type: 'code',
      redirect_uri: r.redirectUri,
      scope: r.scope.join(' '),
      state: r.state,
      code_challenge: r.codeChallenge,
      code_challenge_method: 'S256',
      ...(r.loginHint ? { login_hint: r.loginHint } : {}),
    });
    return `${this.options.pagePath ?? '/api/simulatore/accesso-regionale'}?${q.toString()}`;
  }

  /** La «pagina regionale» simulata: il medico entra con SPID o CIE e autorizza. */
  approve(input: {
    clientId: string;
    redirectUri: string;
    scope: string[];
    codeChallenge: string;
    fiscalCode: string;
  }): string {
    const code = randomBytes(24).toString('base64url');
    this.codes.set(code, {
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      scope: input.scope,
      challenge: input.codeChallenge,
      fiscalCode: input.fiscalCode,
      expiresAt: this.now() + (this.options.codeMinutes ?? 5) * 60_000,
      used: false,
    });
    return code;
  }

  exchange(input: {
    code: string;
    redirectUri: string;
    clientId: string;
    codeVerifier: string;
  }): Promise<TokenResult> {
    const reject = (error: string, description: string) =>
      Promise.resolve<TokenResult>({ outcome: 'rejected', error, description, raw: { error } });
    const pending = this.codes.get(input.code);
    if (!pending || pending.used || pending.expiresAt <= this.now())
      return reject('invalid_grant', 'Codice di autorizzazione non valido, già usato o scaduto');
    pending.used = true;
    if (pending.clientId !== input.clientId)
      return reject('invalid_client', 'Parametro client_id non riconosciuto');
    if (pending.redirectUri !== input.redirectUri)
      return reject('invalid_grant', 'redirect_uri diverso da quello della richiesta');
    if (pkceChallenge(input.codeVerifier) !== pending.challenge)
      return reject('invalid_client', 'code_challenge e code_verifier non corrispondenti');
    const sessionId = randomUUID();
    const accessToken = `SIMJWT.${randomBytes(24).toString('base64url')}`;
    const seconds = Math.round((this.options.tokenHours ?? 8) * 3600);
    this.tokens.set(accessToken, {
      fiscalCode: pending.fiscalCode,
      sessionId,
      validUntil: this.now() + seconds * 1000,
      revoked: false,
    });
    return Promise.resolve({
      outcome: 'ok',
      accessToken,
      scope: pending.scope,
      expiresIn: seconds,
      fiscalCode: pending.fiscalCode,
      sessionId,
      raw: { simulatore: true, token_type: 'Bearer', expires_in: seconds, scope: pending.scope },
    });
  }

  verify(input: { accessToken: string; fiscalCode: string }): Promise<TokenCheck> {
    const t = this.tokens.get(input.accessToken);
    if (!t || t.fiscalCode !== input.fiscalCode)
      return Promise.resolve({ outcome: 'invalid', state: 'sconosciuto' });
    if (t.revoked) return Promise.resolve({ outcome: 'invalid', state: 'revocato' });
    if (t.validUntil <= this.now())
      return Promise.resolve({ outcome: 'invalid', state: 'scaduto' });
    return Promise.resolve({ outcome: 'valid', validUntil: new Date(t.validUntil).toISOString() });
  }

  revoke(input: { accessToken: string }): Promise<{ outcome: 'revoked' }> {
    const t = this.tokens.get(input.accessToken);
    if (t) t.revoked = true;
    return Promise.resolve({ outcome: 'revoked' });
  }

  /** Per il simulatore del SAR: il token vale adesso? */
  isValid(accessToken: string | null | undefined): boolean {
    if (!accessToken) return false;
    const t = this.tokens.get(accessToken);
    return !!t && !t.revoked && t.validUntil > this.now();
  }
}
