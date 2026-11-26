/**
 * La ricetta SSN dematerializzata nella regione dello studio (D300): contratto nazionale. Il
 * pacchetto della regione lo attua; il nucleo lo sceglie dalla regione dello studio, a ogni
 * richiesta. La ricetta bianca va sempre al Sistema TS, nazionale.
 *
 * Due vie:
 * - **servizio della regione** (`route: 'gateway'`): il programma manda la ricetta al servizio
 *   della regione, che la inoltra al SAC del Sistema TS. Il servizio può dare anche i lotti di NRE
 *   con cui la cartella numera le ricette, e ricevere la ricetta rossa in DPCM quando la
 *   dematerializzata non ha esito;
 * - **prescrittore esterno** (`route: 'external'`): la ricetta la fa un modulo della regione, che
 *   la cartella apre con una chiamata di contesto e da cui riprende l'esito. Si scrive con le
 *   specifiche della regione che lo chiede: oggi il programma non lo fa, e lo dice.
 */

import type { DpcmServices } from './dpcm';
import type { RegionalNreLots } from './nre-lots';
import type { PrescriptionGateway } from './prescription-gateway';

/**
 * Il nome del servizio delle ricette della regione, con l'articolo e le preposizioni che vuole:
 * i messaggi li compongono così, senza scegliere l'articolo per la regione.
 */
export interface RegionalServiceName {
  /** Il nome, come lo conoscono i medici della regione. */
  name: string;
  /** Con l'articolo: «il …». */
  the: string;
  /** «al …». */
  to: string;
  /** «dal …». */
  from: string;
  /** «del …». */
  of: string;
}

export interface RegionalPrescriptionTexts {
  service: RegionalServiceName;
  /**
   * Le credenziali che vuole il servizio per i lotti di NRE e la ricetta rossa in DPCM, con la
   * fonte: per esempio «utente, password e PIN …, anche con l'accesso con SPID o CIE (…)».
   */
  lotCredentials: string;
  /** A chi segnalare un errore del servizio che si ripete: «al …». */
  reportTo: string;
}

export interface RegionalPrescriptionGateway {
  readonly route: 'gateway';
  /** Invio, annullamento e stato delle ricette SSN. */
  readonly gateway: PrescriptionGateway;
  /**
   * Lotti di NRE: se ci sono, la cartella numera da sé le ricette SSN con i lotti del medico, del
   * tipo che la regione ammette. Senza, l'NRE lo dà il servizio che riceve la ricetta.
   */
  readonly nreLots?: { readonly service: RegionalNreLots; readonly lotType: string };
  /**
   * Ricetta rossa in DPCM: se c'è, la ricetta SSN farmaceutica o specialistica senza esito non si
   * rimanda; si stampa sul modulo del Poligrafico con un NRE nuovo e parte in DPCM (D270). Serve
   * anche `nreLots`.
   */
  readonly dpcm?: DpcmServices;
  /**
   * Il codice regionale del medico davanti al nome nel promemoria (campo 27): solo dove la regione
   * lo chiede.
   */
  readonly reminderDoctorCode: boolean;
  /**
   * Il servizio delle credenziali da aprire quando mancano, come lo chiama la pagina «Credenziali
   * dei servizi».
   */
  readonly credentialService: string;
  readonly texts: RegionalPrescriptionTexts;
}

export interface RegionalExternalPrescriber {
  readonly route: 'external';
  readonly texts: Pick<RegionalPrescriptionTexts, 'service'>;
}

export type RegionalPrescription = RegionalPrescriptionGateway | RegionalExternalPrescriber;

/** Quando la regione fa le ricette SSN con il suo modulo: nel programma non c'è ancora. */
export const EXTERNAL_PRESCRIBER_MISSING = (service: RegionalServiceName) =>
  `Nella regione dello studio le ricette SSN si fanno con il modulo regionale (${service.name}), aperto dalla cartella: nel programma non c’è ancora`;

/** Quando la regione dello studio non ha, nel programma, il servizio delle ricette SSN. */
export const NO_REGIONAL_PRESCRIPTION =
  'La regione dello studio non ha ancora, nel programma, il servizio delle ricette SSN';
