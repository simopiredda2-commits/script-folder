/**
 * Accesso con SPID o CIE al programma (D181, D189): il gestore dell'identità digitale riconosce la
 * persona e restituisce al programma il suo codice fiscale. Serve a medici e segreteria per
 * ripristinare da soli le proprie credenziali, e alla segreteria per collegare la sua identità.
 *
 * Non è l'accesso regionale del SIRPED (D109, D111): quello rilascia l'Id-Sessione delle ricette
 * solo al medico prescrittore. Qui il programma stesso si fa riconoscere la persona: per farlo
 * davvero deve essere accreditato come fornitore di servizi per SPID e per CIE, con il protocollo e
 * i parametri che l'accreditamento assegna. Quali, è da completare sulle specifiche ufficiali.
 *
 * La forma qui sotto è quella comune ai protocolli con ritorno al programma: richiesta con uno
 * state casuale e un code_challenge (PKCE, RFC 7636, metodo S256), ritorno con un codice monouso,
 * scambio del codice con il code_verifier. Qui l'interfaccia e il simulatore (regola 7).
 */

import { randomBytes } from 'node:crypto';
import { pkceChallenge } from './regional-authorization';

export interface IdentityRequest {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

export type IdentityMethod = 'spid' | 'cie';

export type IdentityResult =
  | {
      outcome: 'ok';
      /** Codice fiscale verificato dal gestore dell'identità, in maiuscolo. */
      fiscalCode: string;
      method: IdentityMethod;
      raw: unknown;
    }
  | { outcome: 'rejected'; error: string; description: string | null; raw: unknown }
  | { outcome: 'unreachable'; message: string };

export interface DigitalIdentityGateway {
  readonly environment: 'simulator' | 'test' | 'production';
  /** Indirizzo della pagina dove la persona entra con SPID o CIE, da aprire nel suo browser. */
  authorizeUrl(request: IdentityRequest): string;
  exchange(input: {
    code: string;
    redirectUri: string;
    clientId: string;
    codeVerifier: string;
  }): Promise<IdentityResult>;
}

interface PendingCode {
  clientId: string;
  redirectUri: string;
  challenge: string;
  fiscalCode: string;
  method: IdentityMethod;
  expiresAt: number;
  used: boolean;
}

export interface SimulatedDigitalIdentityOptions {
  now?: () => Date;
  /** Validità del codice di ritorno, in minuti. Per difetto 5, come l'accesso regionale. */
  codeMinutes?: number;
  /** Indirizzo della pagina simulata, servita dal programma solo in simulazione. */
  pagePath?: string;
}

/**
 * Simulatore del gestore dell'identità digitale. La sua pagina è servita dal programma (solo in
 * simulazione) e chiama `approve`: chi la usa scrive il codice fiscale di chi «entra». Per questo
 * il simulatore riconosce chiunque come chiunque, e il programma non lo usa per il ripristino delle
 * credenziali in produzione. Codici monouso, PKCE S256 verificato, redirect_uri identico.
 */
export class SimulatedDigitalIdentity implements DigitalIdentityGateway {
  readonly environment = 'simulator' as const;
  private readonly codes = new Map<string, PendingCode>();

  constructor(private readonly options: SimulatedDigitalIdentityOptions = {}) {}

  private now(): number {
    return (this.options.now?.() ?? new Date()).getTime();
  }

  authorizeUrl(r: IdentityRequest): string {
    const q = new URLSearchParams({
      client_id: r.clientId,
      response_type: 'code',
      redirect_uri: r.redirectUri,
      state: r.state,
      code_challenge: r.codeChallenge,
      code_challenge_method: 'S256',
    });
    return `${this.options.pagePath ?? '/api/simulatore/identita-digitale'}?${q.toString()}`;
  }

  /** La pagina simulata: la persona entra con SPID o con CIE; restituisce il codice di ritorno. */
  approve(input: {
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    fiscalCode: string;
    method: IdentityMethod;
  }): string {
    const code = randomBytes(24).toString('base64url');
    this.codes.set(code, {
      clientId: input.clientId,
      redirectUri: input.redirectUri,
      challenge: input.codeChallenge,
      fiscalCode: input.fiscalCode.trim().toUpperCase(),
      method: input.method,
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
  }): Promise<IdentityResult> {
    const reject = (error: string, description: string) =>
      Promise.resolve<IdentityResult>({ outcome: 'rejected', error, description, raw: { error } });
    const pending = this.codes.get(input.code);
    if (!pending || pending.used || pending.expiresAt <= this.now())
      return reject('invalid_grant', 'Codice di ritorno non valido, già usato o scaduto');
    pending.used = true;
    if (pending.clientId !== input.clientId)
      return reject('invalid_client', 'Parametro client_id non riconosciuto');
    if (pending.redirectUri !== input.redirectUri)
      return reject('invalid_grant', 'redirect_uri diverso da quello della richiesta');
    if (pkceChallenge(input.codeVerifier) !== pending.challenge)
      return reject('invalid_client', 'code_challenge e code_verifier non corrispondenti');
    return Promise.resolve({
      outcome: 'ok',
      fiscalCode: pending.fiscalCode,
      method: pending.method,
      raw: { simulatore: true, metodo: pending.method },
    });
  }
}
