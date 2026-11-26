/**
 * Accesso con SPID o CIE per le ricette in Piemonte (D109, D301): modalità «Id-Sessione con
 * protocollo OAuth2» del SIRPED (REL-STC-01 «Accesso ai servizi delle ricette dematerializzate
 * mediante autenticazione forte», V08 del 23/09/2026, 3.2 e 4.3; D265). Il contratto è nazionale
 * (`RegionalAuthorizationGateway`); qui com'è fatto il servizio della Regione.
 *
 * - GET /oauth2/authorize: client_id, response_type=code, redirect_uri, scope, state (al più 500
 *   caratteri), code_challenge con code_challenge_method=S256 (PKCE, RFC 7636) (4.3.1).
 * - Ritorno sul redirect_uri con code e state, oppure con error ed error_description.
 * - POST /oauth2/token con grant_type=authorization_code, code, redirect_uri, client_id,
 *   code_verifier: access_token (JWT), scope, token_type Bearer, client_id, expires_in (4.3.2).
 *   Nessun refresh_token: alla scadenza serve una nuova autorizzazione.
 * - La scadenza si legge dal campo `exp` del token, non da `expires_in`: la V08 descrive
 *   `expires_in` come «Unix time», ma nell'esempio vale 7199, una durata (4.3.2, p. 33 e 35).
 * - GET /sessionid/verify e DELETE /sessionid/revoke, con client_id e cfutente, e il token come
 *   `Authorization: Bearer` (4.3.4, 4.3.5). La revoca risponde 401 se il token è già scaduto,
 *   già revocato o sconosciuto.
 *
 * Con il token, le chiamate al SAR portano `X-OAuth2-Authorization: Bearer <jwt>`, senza
 * l'autenticazione Basic, con `<pinCode></pinCode>` vuoto e nessun altro dato di autenticazione
 * (4.3.6): `sarAuthentication` in `sar.ts`. Qui la lettura del token e il simulatore (regola 7).
 */

import { randomBytes, randomUUID } from 'node:crypto';
import {
  pkceChallenge,
  type AuthorizeRequest,
  type RegionalAuthorizationGateway,
  type RevokeResult,
  type SimulatedAuthorizationPage,
  type SimulatedValidity,
  type TokenCheck,
  type TokenResult,
} from '@mmg/integrations';
import { REGIONAL_SOFTWARE_ID } from './gestionale';

/** Scope del SIRPED per il medico prescrittore. */
export const PRESCRIBER_SCOPE = 'prescrizione';

/** Campi del token che servono al programma (V08, 4.3.2, «Formato dell'access_token»). */
export interface RegionalTokenClaims {
  /** Codice fiscale dell'utente autenticato. */
  sub: string;
  /** Gestionale per cui il token è stato rilasciato (client_id). */
  aud: string;
  /** Scadenza, istante di emissione e inizio della validità, in secondi dal 1970 (Unix time). */
  exp: number;
  iat: number | null;
  nbf: number | null;
  jti: string;
  iss: string | null;
  scope: string[];
  /** Identificativo della sessione di autenticazione (userData.idSessione). */
  sessionId: string;
  /** Codice dell'ASR dell'utente, per gli MMG l'ASL (userData.organizzazione). */
  organization: string | null;
  /** Livello e modalità dell'autenticazione (userData.livelloAautenticazione, modAautenticazione). */
  level: string | null;
  method: string | null;
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const seconds = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : null;
const scopes = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.filter((s): s is string => typeof s === 'string' && !!s)
    : typeof v === 'string'
      ? v.split(' ').filter(Boolean)
      : [];

/**
 * Legge i campi del token (il payload del JWT, in base64url). Non controlla la firma: la firma si
 * verifica con la chiave del servizio JWKS (4.3.3, `/.well-known/jwks.json`, kid «rel-oauth2-key»),
 * nell'adattatore vero. Senza `sub`, `aud`, `exp`, `jti` o `userData.idSessione`, null.
 */
export function readRegionalToken(jwt: string): RegionalTokenClaims | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(fromBase64Url(parts[1]!));
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const user = (p.userData && typeof p.userData === 'object' ? p.userData : {}) as Record<
    string,
    unknown
  >;
  const sub = text(p.sub);
  const aud = text(p.aud);
  const exp = seconds(p.exp);
  const jti = text(p.jti);
  const sessionId = text(user.idSessione);
  if (!sub || !aud || exp === null || !jti || !sessionId) return null;
  return {
    sub,
    aud,
    exp,
    iat: seconds(p.iat),
    nbf: seconds(p.nbf),
    jti,
    iss: text(p.iss),
    scope: scopes(p.scope ?? user.scope),
    sessionId,
    organization: text(user.organizzazione),
    level: text(user.livelloAautenticazione),
    method: text(user.modAautenticazione),
  };
}

/**
 * La risposta del servizio token (4.3.2) come la usa il programma: token, permessi concessi e
 * campi del token. La stessa lettura serve all'adattatore vero e al simulatore.
 */
export function tokenResultFrom(body: unknown): TokenResult {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const reject = (description: string): TokenResult => ({
    outcome: 'rejected',
    error: 'invalid_token',
    description,
    raw: body,
  });
  const accessToken = text(b.access_token);
  if (!accessToken) return reject('Risposta senza access_token');
  if (text(b.token_type)?.toLowerCase() !== 'bearer') return reject('token_type diverso da Bearer');
  const claims = readRegionalToken(accessToken);
  if (!claims)
    return reject('Token senza i campi della specifica (sub, aud, exp, jti, idSessione)');
  return {
    outcome: 'ok',
    accessToken,
    scope: b.scope === undefined ? claims.scope : scopes(b.scope),
    validUntil: new Date(claims.exp * 1000).toISOString(),
    fiscalCode: claims.sub,
    sessionId: claims.sessionId,
    clientId: claims.aud,
    raw: { ...b, access_token: '[omesso]' },
  };
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

export interface SimulatedSirpedAccessOptions {
  now?: () => Date;
  /**
   * Validità del token. Per difetto 8 ore: l'Id-Sessione dei servizi di prescrizione vale 8 ore
   * (V08, 3); quella vera è nel token (`exp`).
   */
  tokenHours?: number;
  /** Per le prove: cambia i campi del token prima di emetterlo (per esempio un `aud` diverso). */
  claims?: (claims: Record<string, unknown>) => Record<string, unknown>;
  /** Validità del codice di autorizzazione: «qualche minuto» (4.3.1). Per difetto 5. */
  codeMinutes?: number;
  /** Indirizzo della pagina simulata, servita dal programma solo in simulazione. */
  pagePath?: string;
}

/**
 * Simulatore dell'Authorization Server del SIRPED. La «pagina regionale» è servita dal programma
 * stesso (solo in simulazione) e chiama `approve`. Codici monouso, PKCE S256 verificato,
 * redirect_uri identico, token con scadenza fissa e senza rinnovo, revoca. Il token ha la forma di
 * un JWT con i campi della V08 (4.3.2) ma senza firma («alg»: «none»): l'adattatore vero, che
 * controlla la firma con la chiave del servizio JWKS, lo rifiuterebbe.
 */
export class SimulatedSirpedAccess
  implements RegionalAuthorizationGateway, SimulatedAuthorizationPage, SimulatedValidity
{
  readonly environment = 'simulator' as const;
  private readonly codes = new Map<string, PendingCode>();
  private readonly tokens = new Map<
    string,
    {
      fiscalCode: string;
      sessionId: string;
      clientId: string;
      validUntil: number;
      revoked: boolean;
    }
  >();

  constructor(private readonly options: SimulatedSirpedAccessOptions = {}) {}

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
    // Il client_id è il codice del gestionale con il codice ASL del medico (V08, 4.3.1): il
    // servizio vero conosce solo quelli registrati; il simulatore ne controlla la forma.
    if (!REGIONAL_SOFTWARE_ID.test(input.clientId))
      return reject('invalid_client', 'Parametro client_id non riconosciuto o non presente');
    if (pending.clientId !== input.clientId)
      return reject('invalid_client', 'Parametro client_id non riconosciuto');
    if (pending.redirectUri !== input.redirectUri)
      return reject('invalid_grant', 'redirect_uri diverso da quello della richiesta');
    if (pkceChallenge(input.codeVerifier) !== pending.challenge)
      return reject('invalid_client', 'code_challenge e code_verifier non corrispondenti');
    const sessionId = randomUUID();
    const issuedAt = Math.floor(this.now() / 1000);
    const validity = Math.round((this.options.tokenHours ?? 8) * 3600);
    const scope = pending.scope.join(' ');
    // Codice dell'azienda dopo l'ultimo «_» del client_id (MIOAPPLICATIVO_301: 301, V08 4.3.1).
    const organization = /_(\w+)$/.exec(input.clientId)?.[1] ?? null;
    const baseClaims: Record<string, unknown> = {
      sub: pending.fiscalCode,
      aud: input.clientId,
      nbf: issuedAt,
      iat: issuedAt,
      exp: issuedAt + validity,
      jti: randomUUID(),
      iss: 'urn:simulatore:sirped:reloauthserver',
      scope,
      userData: {
        cfutente: pending.fiscalCode,
        idSessione: sessionId,
        autenticazioneTs: authenticationTimestamp(new Date(this.now())),
        livelloAautenticazione: 'iso-iec-29115-LoA3',
        modAautenticazione: 'SpidL2',
        organizzazione: organization,
        scope,
        clientid: input.clientId,
      },
    };
    const claims = this.options.claims?.(baseClaims) ?? baseClaims;
    const accessToken = unsignedJwt(claims);
    const exp = typeof claims.exp === 'number' ? claims.exp * 1000 : this.now();
    this.tokens.set(accessToken, {
      fiscalCode: pending.fiscalCode,
      sessionId,
      clientId: input.clientId,
      validUntil: exp,
      revoked: false,
    });
    // La risposta del servizio token come nell'esempio della V08 (4.3.2): expires_in in secondi.
    return Promise.resolve(
      tokenResultFrom({
        access_token: accessToken,
        scope,
        token_type: 'Bearer',
        client_id: input.clientId,
        expires_in: Math.max(0, Math.floor((exp - this.now()) / 1000) - 1),
        simulatore: true,
      }),
    );
  }

  /** Il client_id dev'essere quello che ha chiesto il token (4.3.4). */
  verify(input: {
    clientId: string;
    accessToken: string;
    fiscalCode: string;
  }): Promise<TokenCheck> {
    const t = this.tokens.get(input.accessToken);
    if (!t || t.fiscalCode !== input.fiscalCode || t.clientId !== input.clientId)
      return Promise.resolve({ outcome: 'invalid', state: 'sconosciuto' });
    if (t.revoked) return Promise.resolve({ outcome: 'invalid', state: 'revocato' });
    if (t.validUntil <= this.now())
      return Promise.resolve({ outcome: 'invalid', state: 'scaduto' });
    return Promise.resolve({ outcome: 'valid', validUntil: new Date(t.validUntil).toISOString() });
  }

  /**
   * Come la DELETE della V08 (4.3.5): 401, «invalid», se il token è già scaduto, revocato o ignoto,
   * o se lo revoca un client_id diverso da quello che l'ha chiesto.
   */
  revoke(input: { clientId: string; accessToken: string }): Promise<RevokeResult> {
    const t = this.tokens.get(input.accessToken);
    if (!t || t.revoked || t.validUntil <= this.now() || t.clientId !== input.clientId)
      return Promise.resolve({ outcome: 'invalid' });
    t.revoked = true;
    return Promise.resolve({ outcome: 'revoked' });
  }

  /** Per il simulatore del SAR: il token vale adesso? */
  isValid(accessToken: string | null | undefined): boolean {
    if (!accessToken) return false;
    const t = this.tokens.get(accessToken);
    return !!t && !t.revoked && t.validUntil > this.now();
  }
}

/** JWT senza firma (RFC 7519, 6.1): solo per il simulatore. */
function unsignedJwt(claims: Record<string, unknown>): string {
  const part = (v: unknown) => toBase64Url(JSON.stringify(v));
  return `${part({ alg: 'none', typ: 'JWT' })}.${part(claims)}.`;
}

/**
 * Base64url senza Buffer, con btoa e atob che ci sono in Node e nel browser: il pacchetto gira
 * anche nella dimostrazione (D221).
 */
function toBase64Url(s: string): string {
  let binary = '';
  for (const byte of new TextEncoder().encode(s)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

/** «dd/MM/yyyy HH:mm.ss.SSSS», come il campo autenticazioneTs della V08 (4.3.2). */
function authenticationTimestamp(d: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(d.getDate())}/${two(d.getMonth() + 1)}/${d.getFullYear()} ${two(d.getHours())}:${two(
    d.getMinutes(),
  )}.${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(4, '0')}`;
}
