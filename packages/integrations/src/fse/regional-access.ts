import { randomUUID } from 'node:crypto';
import type { ServiceAuth } from '../service-auth';

/**
 * Aprire il Fascicolo regionale del paziente dalla cartella clinica, senza riscrivere le
 * credenziali: «Modulo regionale di accesso semplificato dalle CCE – Specifiche di integrazione dei
 * servizi di accesso», CSI Piemonte, V03, settembre 2019 (D220).
 *
 * 1. La cartella chiama `getAuthentication` (SOAP 1.2, TLS 1.2 con certificato X.509 del fornitore)
 *    con le credenziali RUPAR del medico, il ruolo, l'IP della postazione, l'applicazione e il codice
 *    fiscale del paziente. Il servizio controlla le credenziali e chiede al Fascicolo se il paziente
 *    c'è e se ha dato il consenso alla consultazione.
 * 2. Se va bene, restituisce un token. La cartella apre nel browser la pagina regionale con il
 *    token: vale una volta, solo dall'IP dichiarato.
 *
 * Il documento è del 2019: con l'autenticazione forte di oggi (D102, D109) va chiesto al CSI se vale
 * ancora. Qui l'interfaccia e il simulatore (regola 7); l'adattatore vero si scrive con il CSI.
 */

/** Applicazione del Fascicolo per gli operatori sanitari (tabella 4 delle specifiche). */
export const FSE_ACCESS_APPLICATION = 'DMAWA';

/** Ruolo del medico di medicina generale (tabella 3 delle specifiche). */
export const FSE_ACCESS_ROLE = 'MMG';

/**
 * Tipi di documento per il filtro dell'elenco (parametro aggiuntivo TIPO_DOCUMENTO, tabella del
 * paragrafo 3.5.2 delle specifiche), con le loro parole.
 */
export const FSE_DOCUMENT_TYPES: Readonly<Record<string, string>> = {
  '57833-6': 'PRESCRIZIONE FARMACEUTICA',
  '57832-8': 'PRESCRIZIONE DIAGNOSTICA O SPECIALISTICA',
  '60591-5': 'PROFILO SANITARIO SINTETICO / PATIENT SUMMARY',
  '59284-0': 'DOCUMENTO DEI CONSENSI',
  ATTO_OPERATORIO: 'ATTO OPERATORIO',
  '29304-3': 'PRESTAZIONE FARMACEUTICA',
  '81223-0': 'PRESTAZIONE SPECIALISTICA',
  '28653-4': 'CERTIFICATO DI MALATTIA',
  '59258-4': 'VERBALE DI PRONTO SOCCORSO',
  '34105-7': 'LETTERA DI DIMISSIONE OSPEDALIERA',
  '68604-8': 'REFERTO DI RADIOLOGIA',
  '11488-4': 'REFERTO SPECIALISTICO',
  '11526-1': 'REFERTO DI ANATOMIA PATOLOGICA',
  '11502-2': 'REFERTO DI LABORATORIO',
  '57829-4': 'PRESCRIZIONE PER PRODOTTO O APPARECCHIATURE MEDICHE',
  '57827-8': 'ESENZIONE DA REDDITO',
};

/**
 * Un tipo di documento delle specifiche: solo le chiavi dell'elenco, non quelle che ogni oggetto
 * ha dal suo prototipo («constructor», «toString», «__proto__»…), D232.
 */
export const isFseDocumentType = (code: string): boolean => Object.hasOwn(FSE_DOCUMENT_TYPES, code);

/**
 * Errori del servizio `getAuthentication` (tabella 1 delle specifiche) e della pagina del
 * Fascicolo (tabella 3, «errori web-application»), con le loro parole.
 */
export const FSE_ACCESS_ERRORS = {
  AUTH_ER_000: 'Errore di sistema',
  AUTH_ER_501: 'Errore di autenticazione',
  AUTH_ER_502: 'Ruolo non valido',
  AUTH_ER_506: 'La CCE per questo operatore sanitario non è autorizzata all’accesso',
  AUTH_ER_507: 'L’applicazione remota non è disponibile a eseguire il login',
  FSE_ER_000: 'Errore di sistema',
  FSE_ER_503: 'Paziente non trovato',
  FSE_ER_504: 'Tipo documento non valido',
  FSE_ER_505: 'Il paziente non ha fornito il consenso alla consultazione',
  WEB_000: 'Errore interno al sistema. Non è stato possibile completare l’operazione',
  WEB_001: 'Token di autenticazione non valido',
  WEB_002: 'Controllo IP chiamante fallito',
} as const;
export type FseAccessErrorCode = keyof typeof FSE_ACCESS_ERRORS;

export interface FseAccessRequest {
  /** Codice fiscale del paziente (codiceFiscaleAssistito). */
  patientFiscalCode: string;
  /** IP della postazione che aprirà la pagina (ipClient); null se non noto. */
  clientIp: string | null;
  /** Filtro dell'elenco dei documenti (TIPO_DOCUMENTO); null per l'operazione predefinita. */
  documentType: string | null;
}

export type FseAccessResult =
  /** L'indirizzo da aprire nel browser, con il token: vale una volta. */
  | { outcome: 'success'; url: string }
  | { outcome: 'failure'; code: string; message: string }
  | { outcome: 'unreachable'; message: string };

export interface RegionalFseAccess {
  readonly environment: 'simulator' | 'test' | 'production';
  /** Le credenziali RUPAR del medico passano a parte: non entrano nei registri. */
  authenticate(request: FseAccessRequest, auth: ServiceAuth): Promise<FseAccessResult>;
}

export interface SimulatedRegionalFseAccessOptions {
  /**
   * Esito di ogni richiesta: «success», un codice di errore delle specifiche o «unreachable». Per
   * difetto: successo.
   */
  decide?: (request: FseAccessRequest) => 'success' | 'unreachable' | FseAccessErrorCode;
  /** Indirizzo della pagina simulata che riceve il token (servita dal programma, non dalla Regione). */
  pageUrl?: string;
}

/** Token in attesa di essere usati, al più: il simulatore non cresce senza limite (D232). */
export const MAX_TOKENS = 1000;

/** Il token che la pagina simulata riceve: per chi, da quale IP, se già usato. */
interface IssuedToken {
  patientFiscalCode: string;
  clientIp: string | null;
  documentType: string | null;
  used: boolean;
}

/** Esito dell'apertura della pagina simulata con il token (SRV-02). */
export type SimulatedFsePage =
  | { outcome: 'opened'; patientFiscalCode: string; documentType: string | null }
  | { outcome: 'error'; code: 'WEB_001' | 'WEB_002'; message: string };

/**
 * Simulatore del servizio e della pagina regionale: token in memoria, monouso e legati all'IP, come
 * nelle specifiche. Non chiama nessuno: la pagina è del programma (`pageUrl`).
 */
export class SimulatedRegionalFseAccess implements RegionalFseAccess {
  readonly environment = 'simulator' as const;
  /** Richieste ricevute, per le prove: mai le credenziali. */
  readonly received: (FseAccessRequest & { role: string; application: string })[] = [];
  private readonly tokens = new Map<string, IssuedToken>();

  constructor(private readonly options: SimulatedRegionalFseAccessOptions = {}) {}

  authenticate(request: FseAccessRequest, auth: ServiceAuth): Promise<FseAccessResult> {
    this.received.push({ ...request, role: FSE_ACCESS_ROLE, application: FSE_ACCESS_APPLICATION });
    // Le specifiche chiedono utente e password RUPAR; il PIN è facoltativo (3.3).
    if (!auth.username?.trim() || !auth.password) return Promise.resolve(failure('AUTH_ER_501'));
    if (request.documentType !== null && !isFseDocumentType(request.documentType))
      return Promise.resolve(failure('FSE_ER_504'));
    const decision = this.options.decide?.(request) ?? 'success';
    if (decision === 'unreachable')
      return Promise.resolve({
        outcome: 'unreachable',
        message: 'Servizio di accesso al Fascicolo non raggiungibile (simulato)',
      });
    if (decision !== 'success') return Promise.resolve(failure(decision));
    const token = randomUUID();
    // Al più MAX_TOKENS in memoria: il più vecchio esce, come un token scaduto (D232).
    while (this.tokens.size >= MAX_TOKENS) this.tokens.delete(this.tokens.keys().next().value!);
    this.tokens.set(token, {
      patientFiscalCode: request.patientFiscalCode,
      clientIp: request.clientIp,
      documentType: request.documentType,
      used: false,
    });
    const page = this.options.pageUrl ?? '/api/simulatori/fascicolo';
    return Promise.resolve({ outcome: 'success', url: `${page}?token=${token}` });
  }

  /**
   * La pagina regionale simulata: il token vale una volta (WEB_001) e solo dall'IP dichiarato
   * (WEB_002). Se l'IP non era noto alla richiesta, vale quello di chi chiamava il servizio: qui
   * non si controlla.
   */
  open(token: string, clientIp: string | null): SimulatedFsePage {
    const t = this.tokens.get(token);
    if (!t || t.used)
      return { outcome: 'error', code: 'WEB_001', message: FSE_ACCESS_ERRORS.WEB_001 };
    if (t.clientIp !== null && t.clientIp !== clientIp)
      return { outcome: 'error', code: 'WEB_002', message: FSE_ACCESS_ERRORS.WEB_002 };
    // Usato, non serve più: una seconda apertura non lo trova e dà WEB_001 lo stesso.
    this.tokens.delete(token);
    t.used = true;
    return {
      outcome: 'opened',
      patientFiscalCode: t.patientFiscalCode,
      documentType: t.documentType,
    };
  }
}

function failure(code: FseAccessErrorCode): FseAccessResult {
  return { outcome: 'failure', code, message: FSE_ACCESS_ERRORS[code] };
}
