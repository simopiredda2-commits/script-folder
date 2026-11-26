import type { ServiceAuth } from '../service-auth';

/**
 * Aprire il Fascicolo della regione del paziente dalla cartella clinica, senza riscrivere le
 * credenziali (D220): il contratto nazionale. Lo attua il pacchetto della regione dello studio
 * (D288, D297), con le specifiche del suo servizio di accesso e il suo simulatore (regola 7).
 *
 * Il programma chiede al servizio della regione un indirizzo, che il medico apre nel browser: vale
 * una volta. Le credenziali del medico per i servizi della regione passano a parte e non entrano
 * nei registri.
 */

export interface FseAccessRequest {
  /** Codice fiscale del paziente. */
  patientFiscalCode: string;
  /** IP della postazione che aprirà la pagina; null se non noto. */
  clientIp: string | null;
  /** Filtro dell'elenco dei documenti (uno di `documentTypes`); null per tutti. */
  documentType: string | null;
}

export type FseAccessResult =
  /** L'indirizzo da aprire nel browser: vale una volta. */
  | { outcome: 'success'; url: string }
  /** Le credenziali del medico per i servizi della regione rifiutate o incomplete. */
  | { outcome: 'credentials'; code: string; message: string }
  | { outcome: 'failure'; code: string; message: string }
  | { outcome: 'unreachable'; message: string };

/** La pagina simulata della regione, aperta con l'indirizzo dato dal simulatore. */
export interface SimulatedFseAccessPage {
  /** 200 se la pagina si apre, 403 se l'indirizzo non vale (già usato, scaduto, inventato). */
  status: 200 | 403;
  text: string;
}

export interface RegionalFseAccess {
  readonly environment: 'simulator' | 'test' | 'production';
  /** I tipi di documento per il filtro dell'elenco, con le parole della regione. */
  readonly documentTypes: Readonly<Record<string, string>>;
  /** Le parole per il medico, della regione: frasi intere, mai pezzi da comporre. */
  readonly texts: {
    /** Sopra il modulo: a chi si chiede l'accesso, con quali credenziali, che cosa controlla. */
    intro: string;
    /** Con il simulatore: che si apre una pagina di prova, e con chi si attiva quello vero. */
    simulated: string;
    /** Quando il collegamento non è attivo: con chi si attiva. */
    notActive: string;
    /** Quando le credenziali sono rifiutate: che cosa controllare, e dove. */
    credentials: string;
  };
  /** Il servizio delle credenziali del medico, per portarlo alla pagina giusta. */
  readonly credentialService: string;
  authenticate(request: FseAccessRequest, auth: ServiceAuth): Promise<FseAccessResult>;
  /**
   * Solo i simulatori: la pagina della regione, servita dal programma al posto di quella vera. Si
   * apre con il token dell'indirizzo; un token che il simulatore non ha dato, già usato o scaduto
   * dà la pagina d'errore (403).
   */
  simulatedPage?(token: string, clientIp: string | null): SimulatedFseAccessPage;
}

/**
 * Un tipo di documento del filtro: solo le chiavi dell'elenco, non quelle che ogni oggetto ha dal
 * suo prototipo («constructor», «toString», «__proto__»…), D232.
 */
export const isDocumentTypeOf = (access: Pick<RegionalFseAccess, 'documentTypes'>, code: string) =>
  Object.hasOwn(access.documentTypes, code);
