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
 *   all'email certificata, verificabile (CheckToken) e revocabile (REL-STC-01, autenticazione
 *   forte, V08 del 23/09/2026, 4.2). Nell'ambiente di prova torna anche nella risposta. Vale 8 ore
 *   per i servizi di prescrizione; un Id-Sessione nuovo revoca il precedente (V08, 3).
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
   * password e PIN. Va nell'intestazione `X-OAuth2-Authorization: Bearer <jwt>`, senza
   * l'autenticazione Basic e con `<pinCode></pinCode>` vuoto (REL-STC-01 V08, 4.3.6).
   */
  bearer?: string | null;
  /**
   * Codice del gestionale con il codice ASL del medico (`regionalSoftwareId`). Con l'Id-Sessione
   * per email va nell'intestazione `X-Gestionale` delle chiamate al SAR (REL-STC-01 V08, 4.2.5) e
   * nell'informazione aggiuntiva «APP» delle chiamate del secondo fattore della RUPAR (4.2.1–4.2.3).
   * Non è un dato di autenticazione: con il token non va (4.3.6).
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
      /** Solo nell'ambiente di prova: il codice torna anche nella risposta (REL-STC-01 V08, 4.2.1). */
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
 * Dati comuni alle chiamate del secondo fattore. Per la RUPAR Piemonte `auth.software` è
 * l'informazione aggiuntiva «APP», obbligatoria nella richiesta, nella verifica e nella revoca
 * dell'Id-Sessione (REL-STC-01 V08, 4.2.1–4.2.3): il codice del gestionale seguito da «_» e dal
 * codice dell'ASL del medico (`regionalSoftwareId`). Il Sistema TS non la usa.
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
 * Codice del gestionale come lo assegna la Regione all'avvio dell'autocertificazione (REL-STC-01
 * V08, 4.3.1). La V08 non ne dà la forma; l'esempio è MIOAPPLICATIVO. Qui: lettere, cifre, «-» e
 * «_», fino a 64 caratteri.
 */
export const REGIONAL_SOFTWARE_CODE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** Il codice del gestionale con il codice dell'azienda: MIOAPPLICATIVO_301. */
export const REGIONAL_SOFTWARE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}_\d{3}$/;

/**
 * Come il gestionale si presenta ai servizi della Regione Piemonte (REL-STC-01 V08): il codice
 * che la Regione gli assegna, «_» e il codice dell'azienda, che per i medici di medicina generale
 * è l'ASL presso cui operano (esempio della V08: MIOAPPLICATIVO_301). È lo stesso valore in tre
 * punti (D266):
 *
 * - il `client_id` dell'accesso con SPID o CIE (4.3.1, p. 28; 4.3.2, p. 32; 4.3.4 e 4.3.5);
 * - l'intestazione `X-Gestionale` delle chiamate al SAR con l'Id-Sessione per email (4.2.5, p. 25);
 * - l'informazione aggiuntiva «APP» delle richieste dell'Id-Sessione per email (4.2.1, p. 17).
 */
export function regionalSoftwareId(
  softwareCode: string | null | undefined,
  aslCode: string | null | undefined,
): { ok: true; value: string } | { ok: false; code: 'GESTIONALE' | 'ASL'; message: string } {
  const software = softwareCode?.trim() ?? '';
  if (!REGIONAL_SOFTWARE_CODE.test(software))
    return {
      ok: false,
      code: 'GESTIONALE',
      message: software
        ? `Codice del gestionale non valido: «${software}» (lettere, cifre, «-» e «_»)`
        : 'Manca il codice del gestionale assegnato dalla Regione (REL-STC-01 V08, 4.3.1)',
    };
  const asl = aslCode?.trim() ?? '';
  if (!/^\d{3}$/.test(asl))
    return {
      ok: false,
      code: 'ASL',
      message: asl
        ? `Codice ASL del medico non valido: «${asl}» (tre cifre, per esempio 301)`
        : 'Manca il codice ASL del medico: lo scrive l’amministratore nei dati del medico, in Strumenti › Utenti e ruoli (REL-STC-01 V08, 4.3.1)',
    };
  return { ok: true, value: `${software}_${asl}` };
}

/**
 * Controllo di forma che fanno i simulatori: non conoscono le credenziali vere, ripetono solo i
 * rifiuti del SAR per credenziali o PIN mancanti (specifiche del SAR per i prescrittori, 3.1.1 e
 * 4: «Credenziali invalide (from client)», «EA01 - Inserire il PinCode»).
 */
export function authShapeProblem(
  auth: ServiceAuth | undefined,
): { code: string; message: string } | null {
  // Con il token non va nessun altro dato di autenticazione (REL-STC-01 V08, 4.3.6).
  if (auth?.bearer)
    return auth.username || auth.password || auth.pin || auth.sessionId
      ? {
          code: 'CREDENZIALI',
          message:
            'Con il token SPID o CIE non si mandano utente, password, PIN né Id-Sessione (REL-STC-01 V08, 4.3.6)',
        }
      : null;
  if (!auth?.username?.trim() || !auth.password)
    return { code: 'CREDENZIALI', message: 'Credenziali invalide (from client)' };
  if (!auth.pin) return { code: 'EA01', message: 'Inserire il PinCode' };
  return null;
}

/**
 * Autenticazione di una chiamata SOAP ai servizi della ricetta del SIRPED, come la vuole la V08
 * di REL-STC-01. Serve all'adattatore vero del SAR; qui la provano le prove.
 *
 * - Con il token SPID o CIE (4.3.6): solo `X-OAuth2-Authorization: Bearer <jwt>`; niente
 *   `Authorization: Basic`, `<pinCode>` vuoto, nessun altro dato di autenticazione.
 * - Con l'Id-Sessione dell'email certificata (4.1.1, 4.2.5): `Authorization: Basic` con utente e
 *   password RUPAR, `X-idSessione: Bearer <Id-Sessione>`, `X-Gestionale` con il codice del
 *   gestionale seguito da «_» e dal codice dell'ASL (per esempio MIOAPPLICATIVO_301); il PIN va
 *   nella richiesta, cifrato con il certificato della Regione (SAR V06, 3.1.2): lo cifra
 *   l'adattatore.
 *
 * `X-Gestionale` è `auth.software`, cioè `regionalSoftwareId` con il codice ASL del medico (D266).
 */
export function sarAuthentication(auth: ServiceAuth):
  | {
      outcome: 'ok';
      headers: Record<string, string>;
      /** Contenuto di `<pinCode>`: vuoto con il token, altrimenti il PIN da cifrare. */
      pinCode: { kind: 'vuoto' } | { kind: 'da-cifrare'; pin: string };
    }
  | { outcome: 'problem'; code: string; message: string } {
  const shape = authShapeProblem(auth);
  if (shape) return { outcome: 'problem', ...shape };
  if (auth.bearer)
    return {
      outcome: 'ok',
      headers: { 'X-OAuth2-Authorization': `Bearer ${auth.bearer}` },
      pinCode: { kind: 'vuoto' },
    };
  if (!auth.sessionId)
    return {
      outcome: 'problem',
      code: 'ID_SESSIONE',
      message: 'Manca l’Id-Sessione (secondo fattore)',
    };
  const gestionale = auth.software?.trim() ?? '';
  if (!gestionale)
    return {
      outcome: 'problem',
      code: 'GESTIONALE',
      message: 'Manca il codice del gestionale per X-Gestionale (REL-STC-01 V08, 4.2.5)',
    };
  if (!REGIONAL_SOFTWARE_ID.test(gestionale))
    return {
      outcome: 'problem',
      code: 'GESTIONALE',
      message:
        'X-Gestionale è il codice del gestionale seguito da «_» e dal codice dell’ASL del medico, per esempio MIOAPPLICATIVO_301 (REL-STC-01 V08, 4.2.5)',
    };
  const basic = btoa(
    String.fromCharCode(...new TextEncoder().encode(`${auth.username}:${auth.password}`)),
  );
  return {
    outcome: 'ok',
    headers: {
      Authorization: `Basic ${basic}`,
      'X-idSessione': `Bearer ${auth.sessionId}`,
      'X-Gestionale': gestionale,
    },
    pinCode: { kind: 'da-cifrare', pin: auth.pin! },
  };
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
  /** Informazione aggiuntiva «APP» di ogni chiamata, per le prove (solo RUPAR Piemonte). */
  readonly receivedSoftware: (string | null)[] = [];

  constructor(
    readonly service: CredentialService,
    private readonly options: SimulatedSecondFactorOptions = {},
  ) {}

  private now(): number {
    return (this.options.now?.() ?? new Date()).getTime();
  }

  /**
   * La RUPAR Piemonte vuole l'informazione aggiuntiva «APP» in ogni chiamata (REL-STC-01 V08,
   * 4.2.1–4.2.3): senza, o in un'altra forma, il servizio simulato rifiuta come quello vero.
   */
  private softwareProblem(software: string | null | undefined): string | null {
    if (this.service !== 'rupar_piemonte') return null;
    this.receivedSoftware.push(software ?? null);
    return software && REGIONAL_SOFTWARE_ID.test(software)
      ? null
      : 'Informazione aggiuntiva APP mancante o non valida: codice del gestionale seguito da «_» e dal codice dell’ASL (REL-STC-01 V08, 4.2.1) (simulato)';
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
            ? 'Password scaduta (from client)'
            : 'Credenziali invalide (from client)',
        authProblem: 'credentials',
        raw: { simulatore: true },
      });
    const app = this.softwareProblem(input.auth.software);
    if (app)
      return Promise.resolve({
        outcome: 'rejected',
        code: 'APP',
        message: app,
        raw: { simulatore: true, esito: 'informazione aggiuntiva APP' },
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
    const app = this.softwareProblem(input.auth.software);
    if (app)
      return Promise.resolve({ outcome: 'invalid', message: app, raw: { simulatore: true } });
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
    if (this.service === 'rupar_piemonte') this.receivedSoftware.push(input.auth.software ?? null);
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
