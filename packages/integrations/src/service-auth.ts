/**
 * Credenziali e secondo fattore verso i servizi esterni (tappa 8, D100–D102; D301).
 *
 * Le credenziali passano a ogni chiamata come argomento a parte (`ServiceAuth`): non stanno nei
 * messaggi, che si conservano nel registro degli invii. Il secondo fattore è l'Id-Sessione:
 *
 * - Sistema TS: «ID-SESSIONE» nell'intestazione `Authorization2F: Bearer`, valido «per almeno 8
 *   ore» per la ricetta SSN (autenticazione forte, ricetta SSN, versione 1.1 del 3/6/2025, 5);
 *   chiesto via web service, arriva all'email certificata (autenticazione forte, web service,
 *   versione 1.1 del 12/1/2026, 5.2 e 5.4).
 * - Il servizio della regione dello studio: il suo secondo fattore, e l'accesso con SPID o CIE
 *   della regione se c'è, li dà il pacchetto della regione (D301).
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
   * Token dell'accesso con SPID o CIE della regione (OAuth2, D109): sostituisce utente, password e
   * PIN, e con lui non va nessun altro dato di autenticazione.
   */
  bearer?: string | null;
  /**
   * Come il programma si presenta al servizio della regione per questo medico, se la regione lo
   * chiede: il codice che la regione ha assegnato al programma, con il codice ASL del medico
   * (D266, D301). Non è un dato di autenticazione: con il token non va.
   */
  software?: string | null;
}

/**
 * Problema di accesso segnalato dal servizio: credenziali (utente, password o PIN) o secondo
 * fattore. L'adattatore vero lo ricava dai codici del servizio (da completare con le specifiche).
 */
export type AuthProblem = 'credentials' | 'session';

export type SessionRequestResult =
  | {
      outcome: 'sent';
      /** Solo nell'ambiente di prova di un servizio che lo fa: il codice torna anche nella risposta. */
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

/**
 * Dati comuni alle chiamate del secondo fattore. `auth.software` va a ogni chiamata del servizio
 * della regione che lo chiede (D301); il Sistema TS non lo usa.
 */
export interface SecondFactorCall {
  auth: ServiceAuth;
  fiscalCode: string;
}

export interface SecondFactorGateway {
  readonly service: CredentialService;
  readonly environment: 'simulator' | 'test' | 'production';
  /** Chiede un Id-Sessione: il servizio lo manda all'email certificata del medico. */
  requestCode(input: SecondFactorCall): Promise<SessionRequestResult>;
  /** Verifica un Id-Sessione e ne restituisce la scadenza. */
  check(input: SecondFactorCall & { sessionId: string }): Promise<SessionCheckResult>;
  revoke(input: SecondFactorCall & { sessionId: string }): Promise<SessionRevokeResult>;
}

/**
 * Chi sa dire se un Id-Sessione o un token vale adesso: i simulatori del secondo fattore e
 * dell'accesso regionale, per i simulatori dei servizi che li ricevono.
 */
export interface SimulatedValidity {
  isValid(value: string | null | undefined): boolean;
}

/**
 * Controllo di forma che fanno i simulatori: non conoscono le credenziali vere, rifiutano solo
 * quelle mancanti. Il simulatore di un servizio della regione può usare le parole del suo
 * servizio (D301).
 */
export function authShapeProblem(
  auth: ServiceAuth | undefined,
): { code: string; message: string } | null {
  // Con il token non va nessun altro dato di autenticazione.
  if (auth?.bearer)
    return auth.username || auth.password || auth.pin || auth.sessionId
      ? {
          code: 'CREDENZIALI',
          message:
            'Con il token dell’accesso con SPID o CIE non si mandano utente, password, PIN né Id-Sessione (simulato)',
        }
      : null;
  if (!auth?.username?.trim() || !auth.password)
    return { code: 'CREDENZIALI', message: 'Utente o password mancanti (simulato)' };
  if (!auth.pin) return { code: 'PIN', message: 'PIN mancante (simulato)' };
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
  /** Il nome del servizio nei messaggi del simulatore. Per difetto la chiave. */
  label?: string;
  /**
   * Il servizio della regione che vuole in ogni chiamata come si presenta il programma (D301): il
   * motivo del rifiuto se `auth.software` manca o non va, o null. Senza, non si controlla.
   */
  softwareProblem?: (software: string | null | undefined) => string | null;
  /** Codice del rifiuto per `softwareProblem`. Per difetto «GESTIONALE». */
  softwareCode?: string;
}

/**
 * Simulatore del secondo fattore. Una richiesta nuova invalida l'Id-Sessione precedente dello
 * stesso medico; il Sistema TS ammette anche un secondo Id-Sessione in attesa, che qui non si
 * simula. Le «email» restano in `outbox`.
 */
export class SimulatedSecondFactor implements SecondFactorGateway, SimulatedValidity {
  readonly environment = 'simulator' as const;
  private readonly sessions = new Map<
    string,
    { fiscalCode: string; validUntil: number; revoked: boolean }
  >();
  /** Email simulate con il codice: nel servizio vero vanno all'email certificata del medico. */
  readonly outbox: { fiscalCode: string; code: string }[] = [];
  /** Come si è presentato il programma a ogni chiamata, per le prove (solo con `softwareProblem`). */
  readonly receivedSoftware: (string | null)[] = [];

  constructor(
    readonly service: CredentialService,
    private readonly options: SimulatedSecondFactorOptions = {},
  ) {}

  private now(): number {
    return (this.options.now?.() ?? new Date()).getTime();
  }

  /** Il controllo di come si presenta il programma, se il servizio lo vuole. */
  private softwareRefusal(software: string | null | undefined): string | null {
    if (!this.options.softwareProblem) return null;
    this.receivedSoftware.push(software ?? null);
    return this.options.softwareProblem(software);
  }

  requestCode(input: SecondFactorCall): Promise<SessionRequestResult> {
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
            ? 'Password scaduta (simulato)'
            : 'Credenziali non valide (simulato)',
        authProblem: 'credentials',
        raw: { simulatore: true },
      });
    const software = this.softwareRefusal(input.auth.software);
    if (software)
      return Promise.resolve({
        outcome: 'rejected',
        code: this.options.softwareCode ?? 'GESTIONALE',
        message: software,
        raw: { simulatore: true, esito: 'programma non riconosciuto' },
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

  check(input: SecondFactorCall & { sessionId: string }): Promise<SessionCheckResult> {
    const software = this.softwareRefusal(input.auth.software);
    if (software)
      return Promise.resolve({ outcome: 'invalid', message: software, raw: { simulatore: true } });
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

  revoke(input: SecondFactorCall & { sessionId: string }): Promise<SessionRevokeResult> {
    if (this.options.softwareProblem) this.receivedSoftware.push(input.auth.software ?? null);
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
    return this.options.label ?? this.service;
  }
}
