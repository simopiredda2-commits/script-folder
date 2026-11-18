/**
 * Credenziali e secondo fattore verso i servizi esterni (tappa 8, D100–D102).
 *
 * Le credenziali passano a ogni chiamata come argomento a parte (`ServiceAuth`): non stanno nei
 * messaggi, che si conservano nel registro degli invii. Il secondo fattore è l'Id-Sessione:
 *
 * - Sistema TS: «ID-SESSIONE» nell'intestazione `Authorization2F: Bearer`, valido «per almeno 8
 *   ore» per la ricetta SSN (autenticazione forte, ricetta SSN, versione 1.1 del 3/6/2025, 5);
 *   chiesto via web service, arriva all'email certificata (autenticazione forte, web service,
 *   versione 1.1 del 12/1/2026, 5.2 e 5.4).
 * - SIRPED (Piemonte): Id-Sessione chiesto con le credenziali RUPAR (CreateAuth), mandato
 *   all'email certificata, verificabile (CheckToken) e revocabile (SIRPED, autenticazione forte,
 *   versione 4.0 del 2/3/2026, 4.2). Nell'ambiente di prova torna anche nella risposta.
 *
 * Qui l'interfaccia e il simulatore (regola 7).
 */

import { randomUUID } from 'node:crypto';
import type { CredentialService } from '@mmg/domain';

export interface ServiceAuth {
  username?: string;
  password?: string;
  pin?: string;
  /** Id-Sessione del secondo fattore, per i servizi che lo chiedono. */
  sessionId?: string | null;
  /**
   * Token dell'accesso regionale con SPID o CIE (OAuth2, D109): per il SAR sostituisce utente,
   * password e PIN (SIRPED, autenticazione forte, 4).
   */
  bearer?: string | null;
}

/**
 * Problema di accesso segnalato dal servizio: credenziali (utente, password o PIN) o secondo
 * fattore. L'adattatore vero lo ricava dai codici del servizio (da completare con le specifiche).
 */
export type AuthProblem = 'credentials' | 'session';

export type SessionRequestResult =
  | {
      outcome: 'sent';
      /** Solo nell'ambiente di prova: il codice torna anche nella risposta (SIRPED, 4.2.1). */
      testCode: string | null;
      raw: unknown;
    }
  | { outcome: 'rejected'; code: string; message: string; authProblem?: AuthProblem; raw: unknown }
  | { outcome: 'unreachable'; message: string };

export type SessionCheckResult =
  | { outcome: 'valid'; validUntil: string; raw: unknown }
  | { outcome: 'invalid'; message: string; raw: unknown }
  | { outcome: 'unreachable'; message: string };

export type SessionRevokeResult =
  { outcome: 'revoked'; raw: unknown } | { outcome: 'unreachable'; message: string };

export interface SecondFactorGateway {
  readonly service: CredentialService;
  readonly environment: 'simulator' | 'test' | 'production';
  /** Chiede un Id-Sessione: il servizio lo manda all'email certificata del medico. */
  requestCode(input: { auth: ServiceAuth; fiscalCode: string }): Promise<SessionRequestResult>;
  /** Verifica un Id-Sessione e ne restituisce la scadenza. */
  check(input: {
    auth: ServiceAuth;
    fiscalCode: string;
    sessionId: string;
  }): Promise<SessionCheckResult>;
  revoke(input: {
    auth: ServiceAuth;
    fiscalCode: string;
    sessionId: string;
  }): Promise<SessionRevokeResult>;
}

/**
 * Controllo di forma che fanno i simulatori: non conoscono le credenziali vere, ripetono solo i
 * rifiuti del SAR per credenziali o PIN mancanti (specifiche del SAR per i prescrittori, 3.1.1 e
 * 4: «Credenziali invalide (from client)», «EA01 - Inserire il PinCode»).
 */
export function authShapeProblem(
  auth: ServiceAuth | undefined,
): { code: string; message: string } | null {
  if (auth?.bearer) return null;
  if (!auth?.username?.trim() || !auth.password)
    return { code: 'CREDENZIALI', message: 'Credenziali invalide (from client)' };
  if (!auth.pin) return { code: 'EA01', message: 'Inserire il PinCode' };
  return null;
}

export interface SimulatedSecondFactorOptions {
  /** Durata di ogni Id-Sessione. Per difetto 8 ore, come il Sistema TS (D102). */
  durationHours?: number;
  now?: () => Date;
  /** Esito di ogni richiesta del codice. Per difetto: inviato. */
  decide?: () => 'sent' | 'unreachable';
  /** Credenziali che il servizio simulato rifiuta, per provare l'errore. */
  rejectCredentials?: (auth: ServiceAuth) => 'invalid' | 'expired' | null;
}

/**
 * Simulatore del secondo fattore. Una richiesta nuova invalida l'Id-Sessione precedente dello
 * stesso medico (SIRPED, 3); il Sistema TS ammette anche un secondo Id-Sessione in attesa, che qui
 * non si simula. Le «email» restano in `outbox`.
 */
export class SimulatedSecondFactor implements SecondFactorGateway {
  readonly environment = 'simulator' as const;
  private readonly sessions = new Map<
    string,
    { fiscalCode: string; validUntil: number; revoked: boolean }
  >();
  /** Email simulate con il codice: nel servizio vero vanno all'email certificata del medico. */
  readonly outbox: { fiscalCode: string; code: string }[] = [];

  constructor(
    readonly service: CredentialService,
    private readonly options: SimulatedSecondFactorOptions = {},
  ) {}

  private now(): number {
    return (this.options.now?.() ?? new Date()).getTime();
  }

  requestCode(input: { auth: ServiceAuth; fiscalCode: string }): Promise<SessionRequestResult> {
    if (this.options.decide?.() === 'unreachable')
      return Promise.resolve({
        outcome: 'unreachable',
        message: `${this.label()}: servizio del secondo fattore non raggiungibile (simulato)`,
      });
    const shape = authShapeProblem(input.auth);
    if (shape)
      return Promise.resolve({
        outcome: 'rejected',
        ...shape,
        authProblem: 'credentials',
        raw: { simulatore: true },
      });
    const refused = this.options.rejectCredentials?.(input.auth);
    if (refused)
      return Promise.resolve({
        outcome: 'rejected',
        code: refused === 'expired' ? 'PASSWORD' : 'CREDENZIALI',
        message:
          refused === 'expired'
            ? 'Password scaduta (from client)'
            : 'Credenziali invalide (from client)',
        authProblem: 'credentials',
        raw: { simulatore: true },
      });
    for (const s of this.sessions.values()) if (s.fiscalCode === input.fiscalCode) s.revoked = true;
    const code = randomUUID();
    const hours = this.options.durationHours ?? 8;
    this.sessions.set(code, {
      fiscalCode: input.fiscalCode,
      validUntil: this.now() + hours * 3_600_000,
      revoked: false,
    });
    this.outbox.push({ fiscalCode: input.fiscalCode, code });
    return Promise.resolve({
      outcome: 'sent',
      testCode: code,
      raw: { simulatore: true, emailStatus: 'Email con il codice inviata (simulato)' },
    });
  }

  check(input: {
    auth: ServiceAuth;
    fiscalCode: string;
    sessionId: string;
  }): Promise<SessionCheckResult> {
    const s = this.sessions.get(input.sessionId.trim());
    if (!s || s.fiscalCode !== input.fiscalCode || s.revoked || s.validUntil <= this.now())
      return Promise.resolve({
        outcome: 'invalid',
        message: 'Id-Sessione non valido, scaduto o revocato (simulato)',
        raw: { simulatore: true },
      });
    return Promise.resolve({
      outcome: 'valid',
      validUntil: new Date(s.validUntil).toISOString(),
      raw: { simulatore: true },
    });
  }

  revoke(input: {
    auth: ServiceAuth;
    fiscalCode: string;
    sessionId: string;
  }): Promise<SessionRevokeResult> {
    const s = this.sessions.get(input.sessionId);
    if (s) s.revoked = true;
    return Promise.resolve({ outcome: 'revoked', raw: { simulatore: true } });
  }

  /** Per i simulatori delle ricette: l'Id-Sessione vale adesso? */
  isValid(sessionId: string | null | undefined): boolean {
    if (!sessionId) return false;
    const s = this.sessions.get(sessionId);
    return !!s && !s.revoked && s.validUntil > this.now();
  }

  /** Solo per le prove: registra un Id-Sessione come se fosse arrivato per email. */
  register(sessionId: string, fiscalCode: string, validUntil: Date): void {
    this.sessions.set(sessionId, {
      fiscalCode,
      validUntil: validUntil.getTime(),
      revoked: false,
    });
  }

  private label(): string {
    return this.service === 'sistema_ts' ? 'Sistema TS' : 'SIRPED';
  }
}
