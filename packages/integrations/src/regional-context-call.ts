import type { ServiceAuth } from './service-auth';

/**
 * Chiamate di contesto (D220, D297): il programma apre una pagina dei servizi della regione dello
 * studio con il contesto del paziente, senza che il medico riscriva le credenziali. Il meccanismo
 * è uno, nel nucleo: il servizio della regione dà un indirizzo che vale una volta, e il medico lo
 * apre in una scheda nuova. Le destinazioni le dà il pacchetto della regione (D288), ognuna di un
 * tipo che il nucleo conosce, con il suo permesso e la sua voce nel registro degli accessi: oggi il
 * Fascicolo della regione. Gli altri tipi (il modulo della regione per la ricetta, la presa in
 * carico, le vaccinazioni, i certificati) si aggiungono con le specifiche della regione che li
 * chiede (`docs/pacchetti-regionali.md`). Le credenziali del medico per i servizi della regione
 * passano a parte e non entrano nei registri.
 */

/** I tipi di destinazione che il nucleo conosce: per ognuno un permesso e una voce nel registro. */
export const CONTEXT_CALL_KINDS = ['fascicolo'] as const;
export type ContextCallKind = (typeof CONTEXT_CALL_KINDS)[number];

export const isContextCallKind = (v: string): v is ContextCallKind =>
  (CONTEXT_CALL_KINDS as readonly string[]).includes(v);

/** Un parametro della chiamata, con le scelte della regione; senza scelta vale «tutti». */
export interface ContextCallParameter {
  key: string;
  /** Il nome del parametro nelle pagine. */
  label: string;
  /** La scelta che vale «tutti». */
  anyLabel: string;
  /** Le scelte, con le parole della regione. */
  options: Readonly<Record<string, string>>;
}

export interface ContextCallRequest {
  /** Codice fiscale del paziente. */
  patientFiscalCode: string;
  /** IP della postazione che aprirà la pagina; null se non noto. */
  clientIp: string | null;
  /** Le scelte fatte, per chiave del parametro; un parametro assente vale «tutti». */
  parameters: Readonly<Record<string, string>>;
}

export type ContextCallResult =
  /** L'indirizzo da aprire nel browser: vale una volta. */
  | { outcome: 'success'; url: string }
  /** Le credenziali del medico per i servizi della regione rifiutate o incomplete. */
  | { outcome: 'credentials'; code: string; message: string }
  | { outcome: 'failure'; code: string; message: string }
  | { outcome: 'unreachable'; message: string };

/** La pagina simulata della regione, aperta con l'indirizzo dato dal simulatore. */
export interface SimulatedContextPage {
  /** 200 se la pagina si apre, 403 se l'indirizzo non vale (già usato, scaduto, inventato). */
  status: 200 | 403;
  text: string;
}

export interface RegionalContextCall {
  readonly kind: ContextCallKind;
  readonly environment: 'simulator' | 'test' | 'production';
  /** I parametri della pagina della regione, con le loro scelte. */
  readonly parameters: readonly ContextCallParameter[];
  /** Le parole per il medico, della regione: frasi intere, mai pezzi da comporre. */
  readonly texts: {
    /** Sopra il modulo: a chi si chiede l'accesso, con quali credenziali, che cosa controlla. */
    intro: string;
    /** Con il simulatore: che si apre una pagina di prova, e con chi si attiva quella vera. */
    simulated: string;
    /** Quando il collegamento non è attivo: con chi si attiva. */
    notActive: string;
    /** Quando le credenziali sono rifiutate: che cosa controllare, e dove. */
    credentials: string;
  };
  /** Il servizio delle credenziali del medico, per portarlo alla pagina giusta. */
  readonly credentialService: string;
  /** Chiede al servizio della regione l'indirizzo della pagina, con il contesto del paziente. */
  open(request: ContextCallRequest, auth: ServiceAuth): Promise<ContextCallResult>;
  /**
   * Solo i simulatori: la pagina della regione, servita dal programma al posto di quella vera. Si
   * apre con il token dell'indirizzo; un token che il simulatore non ha dato, già usato o scaduto
   * dà la pagina d'errore (403).
   */
  simulatedPage?(token: string, clientIp: string | null): SimulatedContextPage;
}

/**
 * Una scelta del parametro: solo le chiavi dell'elenco, non quelle che ogni oggetto ha dal suo
 * prototipo («constructor», «toString», «__proto__»…), D232.
 */
export const isOptionOf = (parameter: Pick<ContextCallParameter, 'options'>, code: string) =>
  Object.hasOwn(parameter.options, code);
