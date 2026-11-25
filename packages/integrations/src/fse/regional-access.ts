import { randomUUID } from 'node:crypto';
import type { ServiceAuth } from '../service-auth';

/**
 * Aprire il Fascicolo regionale del paziente dalla cartella clinica, senza riscrivere le
 * credenziali: «Modulo regionale di accesso semplificato dalle CCE – Specifiche di integrazione dei
 * servizi di accesso», CSI Piemonte, LCCE--SRS-01 V13, aprile 2026 (D220, D265).
 *
 * 1. La cartella chiama `getAuthentication` (SOAP 1.2, TLS 1.2 con certificato X.509 del fornitore,
 *    2.2) con le credenziali RUPAR del medico (utente, password e PIN, tutti obbligatori dalla V07),
 *    il ruolo, l'IP della postazione, l'applicazione DMAWACCE e il codice fiscale del paziente (3).
 *    Il servizio controlla le credenziali e chiede al Fascicolo se il paziente c'è e se ha dato il
 *    consenso alla consultazione.
 * 2. Se va bene, restituisce un token. La cartella apre nel browser la pagina regionale con il
 *    token (6.3): vale una volta; un token non generato dal servizio, già usato o scaduto dà WEB_001.
 *    L'IP della postazione non è più un controllo della pagina: PUA e Fascicolo lo tracciano (2.2).
 *
 * La V13 descrive anche l'accesso diretto alla pagina del Fascicolo dentro una sessione Shibboleth,
 * senza token (6.4): con l'autenticazione forte di oggi (D102, D109) è da chiedere al CSI quale dei
 * due vale per una cartella in cloud. Qui l'interfaccia e il simulatore (regola 7); l'adattatore vero
 * si scrive con il CSI.
 */

/**
 * Applicazione del Fascicolo per le cartelle cliniche (V13, tabella 5): «DMAWACCE, Servizi FSE per
 * Cartelle Cliniche». DMAWA è quella del portale dei medici e dei pediatri.
 */
export const FSE_ACCESS_APPLICATION = 'DMAWACCE';

/** Ruolo del medico di medicina generale (V13, tabella 4). */
export const FSE_ACCESS_ROLE = 'MMG';

/**
 * Pagina del Fascicolo da aprire con il token, per le applicazioni senza Shibboleth (V13, 6.3): il
 * token va nel parametro `tokenCCEMed`. Gli indirizzi della pagina, da Internet e dalla RUPAR, sono
 * in docs/fse.md: vanno nella configurazione dell'adattatore vero, non nel codice (regola 7).
 */
export const FSE_ACCESS_PAGES = {
  tokenParameter: 'tokenCCEMed',
} as const;

/**
 * Tipi di documento per il filtro dell'elenco (parametro aggiuntivo TIPO_DOCUMENTO, V13, tabella 3),
 * con le loro parole. Dalla V03 cambiano: «DOCUMENTO DEI CONSENSI» (59284-0) non c'è più; 57827-8 è
 * «ATTESTATO DI ESENZIONE»; ci sono le schede vaccinali, il piano di cura personalizzato, il bilancio
 * di salute e il certificato di condizione o malattia.
 */
export const FSE_DOCUMENT_TYPES: Readonly<Record<string, string>> = {
  '57833-6': 'PRESCRIZIONE FARMACEUTICA',
  '57832-8': 'PRESCRIZIONE DIAGNOSTICA O SPECIALISTICA',
  '60591-5': 'PROFILO SANITARIO SINTETICO / PATIENT SUMMARY',
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
  '57827-8': 'ATTESTATO DI ESENZIONE',
  'REG-87273-9': 'SCHEDA VACCINALE',
  '87273-9': 'SCHEDA VACCINALE',
  PCP: 'PIANO DI CURA PERSONALIZZATO',
  BDS: 'BILANCIO DI SALUTE',
  'REG-ESE-11488-4': 'CERTIFICATO DI CONDIZIONE O MALATTIA',
};

/**
 * Un tipo di documento delle specifiche: solo le chiavi dell'elenco, non quelle che ogni oggetto
 * ha dal suo prototipo («constructor», «toString», «__proto__»…), D232.
 */
export const isFseDocumentType = (code: string): boolean => Object.hasOwn(FSE_DOCUMENT_TYPES, code);

/**
 * Errori del servizio `getAuthentication` (V13, tabella 1, e quelli del Fascicolo, p. 18) e della
 * pagina del Fascicolo (V13, tabella 6), con le loro parole. Dalla V03: nuovi AUTH_ER_510–517 e
 * AUTH_ER_628 per i parametri mancanti; WEB_002 («Controllo IP chiamante fallito») non c'è più.
 * Gli esempi della V13 citano anche AUTH_ER_518 (p. 16) e FSE_ER_507 (p. 12), che nelle tabelle non
 * ci sono: arrivano dal servizio con il loro testo.
 */
export const FSE_ACCESS_ERRORS = {
  AUTH_ER_000: 'Errore di sistema',
  AUTH_ER_501: 'Errore di autenticazione',
  AUTH_ER_502: 'Ruolo non valido',
  AUTH_ER_506: 'La CCE per questo operatore sanitario non è autorizzata all’accesso',
  AUTH_ER_507: 'L’applicazione remota non è disponibile a eseguire il login',
  AUTH_ER_510: 'Il parametro Pin del richiedente deve essere valorizzato',
  AUTH_ER_511: 'Il parametro Ruolo Richiedente deve essere valorizzato',
  AUTH_ER_512: 'Il parametro Ip Client del Richiedente deve essere valorizzato',
  AUTH_ER_513: 'Il parametro Applicazione deve essere valorizzato',
  AUTH_ER_514: 'Il parametro cf Assistito deve essere valorizzato',
  AUTH_ER_515: 'Il Richiedente deve essere valorizzato',
  AUTH_ER_516: 'Le credenziali devono essere valorizzate',
  AUTH_ER_517: 'I parametri non sono previsti per l’applicazione',
  AUTH_ER_628: 'Un campo obbligatorio deve essere valorizzato',
  FSE_ER_000: 'Errore di sistema',
  FSE_ER_503: 'Paziente non trovato',
  FSE_ER_504: 'Tipo documento non valido',
  FSE_ER_505: 'Il paziente non ha fornito il consenso alla consultazione',
  WEB_000: 'Errore interno al sistema. Non è stato possibile completare l’operazione',
  WEB_001: 'Token di autenticazione non valido',
} as const;
export type FseAccessErrorCode = keyof typeof FSE_ACCESS_ERRORS;

export interface FseAccessRequest {
  /** Codice fiscale del paziente (codiceFiscaleAssistito). */
  patientFiscalCode: string;
  /**
   * IP della postazione che aprirà la pagina (ipClient); null se non noto. Lo schema lo dà come
   * facoltativo (0..1), la tabella degli errori ha AUTH_ER_512 se manca: da chiarire con il CSI.
   */
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
  /**
   * Minuti di validità del token. La V13 dice che un token scaduto dà WEB_001, ma non dice quanto
   * vale: da completare con il CSI. Per difetto nessuna scadenza.
   */
  tokenMinutes?: number | null;
  now?: () => Date;
  /** Indirizzo della pagina simulata che riceve il token (servita dal programma, non dalla Regione). */
  pageUrl?: string;
}

/** Token in attesa di essere usati, al più: il simulatore non cresce senza limite (D232). */
export const MAX_TOKENS = 1000;

/** Il token che la pagina simulata riceve: per chi, dichiarato da quale IP, fino a quando. */
interface IssuedToken {
  patientFiscalCode: string;
  clientIp: string | null;
  documentType: string | null;
  expiresAt: number | null;
}

/** Esito dell'apertura della pagina simulata con il token (SRV-03). */
export type SimulatedFsePage =
  | {
      outcome: 'opened';
      patientFiscalCode: string;
      documentType: string | null;
      /** L'IP dichiarato alla richiesta e quello di chi apre: si tracciano, non si confrontano (V13, 2.2). */
      declaredIp: string | null;
      openedFromIp: string | null;
    }
  | { outcome: 'error'; code: 'WEB_001'; message: string };

/**
 * Simulatore del servizio e della pagina regionale: token in memoria, monouso, come nella V13. Non
 * chiama nessuno: la pagina è del programma (`pageUrl`).
 */
export class SimulatedRegionalFseAccess implements RegionalFseAccess {
  readonly environment = 'simulator' as const;
  /** Richieste ricevute, per le prove: mai le credenziali. */
  readonly received: (FseAccessRequest & { role: string; application: string })[] = [];
  private readonly tokens = new Map<string, IssuedToken>();

  constructor(private readonly options: SimulatedRegionalFseAccessOptions = {}) {}

  authenticate(request: FseAccessRequest, auth: ServiceAuth): Promise<FseAccessResult> {
    this.received.push({ ...request, role: FSE_ACCESS_ROLE, application: FSE_ACCESS_APPLICATION });
    // Utente, password e PIN RUPAR sono tutti obbligatori (V13, 3.3; il PIN dalla V07).
    if (!auth.username?.trim() || !auth.password) return Promise.resolve(failure('AUTH_ER_516'));
    if (!auth.pin?.trim()) return Promise.resolve(failure('AUTH_ER_510'));
    if (!request.patientFiscalCode.trim()) return Promise.resolve(failure('AUTH_ER_514'));
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
    const minutes = this.options.tokenMinutes ?? null;
    this.tokens.set(token, {
      patientFiscalCode: request.patientFiscalCode,
      clientIp: request.clientIp,
      documentType: request.documentType,
      expiresAt: minutes === null ? null : this.now() + minutes * 60_000,
    });
    const page = this.options.pageUrl ?? '/api/simulatori/fascicolo';
    return Promise.resolve({ outcome: 'success', url: `${page}?token=${token}` });
  }

  private now(): number {
    return (this.options.now?.() ?? new Date()).getTime();
  }

  /**
   * La pagina regionale simulata: il token vale una volta e fino alla sua scadenza; un token non
   * generato dal servizio, già usato o scaduto dà WEB_001 (V13, tabella 6). L'IP di chi apre non si
   * confronta con quello dichiarato: si traccia (2.2).
   */
  open(token: string, clientIp: string | null): SimulatedFsePage {
    const t = this.tokens.get(token);
    // Usato o scaduto, non serve più: una seconda apertura non lo trova e dà WEB_001 lo stesso.
    this.tokens.delete(token);
    if (!t || (t.expiresAt !== null && t.expiresAt <= this.now()))
      return { outcome: 'error', code: 'WEB_001', message: FSE_ACCESS_ERRORS.WEB_001 };
    return {
      outcome: 'opened',
      patientFiscalCode: t.patientFiscalCode,
      documentType: t.documentType,
      declaredIp: t.clientIp,
      openedFromIp: clientIp,
    };
  }
}

function failure(code: FseAccessErrorCode): FseAccessResult {
  return { outcome: 'failure', code, message: FSE_ACCESS_ERRORS[code] };
}
