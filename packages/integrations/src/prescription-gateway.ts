/**
 * Invio delle ricette dematerializzate.
 *
 * In Piemonte le ricette SSN (farmaceutica e specialistica) vanno al SAR della Regione
 * (progetto SIRPED), che le inoltra al SAC del Sistema TS; la ricetta bianca va al Sistema TS.
 * Qui c'è solo l'interfaccia: gli adattatori veri arriveranno con le specifiche e le credenziali
 * di collaudo. In sviluppo e nelle prove si usa il simulatore (regola 7: nessuna chiamata a
 * servizi reali).
 */

import type { DispensingState } from '@mmg/domain';
import type { AuthProblem, ServiceAuth } from './service-auth';

export type GatewaySystem = 'sar' | 'sistema_ts';

export interface PrescriptionLineMessage {
  drugAic?: string | null;
  drugName?: string | null;
  activeIngredient?: string | null;
  /** Codice del catalogo regionale (codCatalogoPrescr). */
  serviceCode?: string | null;
  /** Codice del nomenclatore, «codice DM» (codProdPrest; D154). */
  serviceNationalCode?: string | null;
  serviceDescription?: string | null;
  quantity: number;
  aifaNote?: string | null;
  /**
   * «Per principio attivo» (caso A1 delle linee guida del Sistema TS): in ricetta il gruppo di
   * equivalenza, senza l'AIC in codProdPrest. L'AIC resta qui solo per trovare il gruppo (D273).
   */
  byActiveIngredient?: boolean;
  /** nonSost: il farmaco indicato con l'AIC non si sostituisce. */
  notSubstitutable?: boolean;
  /**
   * codMotivazione: il codice della motivazione di non sostituibilità, da 1 a 4 (linee guida del
   * Sistema TS per la prescrizione del principio attivo, 3.1.3); va compilato se nonSost vale 1.
   */
  notSubstitutableCode?: string | null;
  /** Precisazione scritta dal medico, facoltativa accanto al codice: va con le note (motivazNote). */
  notSubstitutableReason?: string | null;
  /**
   * Note della riga (motivazNote): per la terapia del dolore con gli stupefacenti posologia e
   * telefono del medico, come vuole la «Nota STUP» delle specifiche del Sistema TS (D272). Vanno
   * anche sul promemoria.
   */
  notes?: string | null;
  /**
   * Ricetta bianca ripetibile: quante volte e per quanti mesi, solo se diverso dalla regola del
   * farmaco (Disciplinare tecnico della ricetta bianca, 1/12/2022: numRipetibilita, validitaFarm).
   */
  repeatCount?: number | null;
  validityMonths?: number | null;
}

export interface PrescriptionMessage {
  /** Identificativo della ricetta nel nostro database, per collegare la risposta. */
  localId: string;
  kind: 'pharma_ssn' | 'specialist_ssn' | 'white' | 'devices';
  /**
   * indicazionePrescr (IndicazionePrescr nella ricetta rossa): S suggerita, H ricovero, dalle
   * schede delle terapie, solo se tutte le righe hanno la stessa; è il campo 14 del promemoria.
   */
  prescriptionIndication?: 'S' | 'H' | null;
  patientFiscalCode: string;
  /** Il medico che firma: le ricette sono sempre a nome suo (anche se sostituto). */
  doctor: {
    userId: string;
    name: string;
    regionalCode?: string | null;
    /** Codice fiscale del medico (cfMedico1): il SAR lega a lui il lotto di NRE (V06, 4.1). */
    fiscalCode?: string | null;
  };
  /**
   * NRE della ricetta al SAR, generato dalla cartella con il lotto del medico (SIRPED, «Cartelle
   * cliniche MMG e PLS», V06, 3.2 e 4.1; D269). Dopo un rifiuto si rimanda lo stesso (4.3.1, caso
   * 3). Non c'è per la ricetta bianca: l'NRBE lo dà il Sistema TS.
   */
  nre?: string | null;
  exemptionCode?: string | null;
  priority?: 'U' | 'B' | 'D' | 'P' | null;
  accessType?: 'first' | 'subsequent' | null;
  diagnosticQuestion?: string | null;
  /**
   * Su richiesta del paziente, cognome, nome e indirizzo oscurati all'erogatore e sul promemoria
   * (specifiche del Sistema TS, prescrizione, 5/12/2024: oscuramDati).
   */
  obscured?: boolean;
  lines: PrescriptionLineMessage[];
  compiledAt: string;
}

/**
 * Ricetta accettata. Per la ricetta SSN il SAC, anche tramite il SAR, restituisce il codice di
 * autenticazione: senza, la ricetta non è valida e il promemoria non si può dare (specifiche del
 * Sistema TS, prescrizione, 5/12/2024). Per la ricetta bianca il SAC restituisce PIN-NRBE e il PDF
 * del promemoria, l'unico che il medico può rilasciare (Disciplinare tecnico, 1/12/2022).
 */
export interface AcceptedSend {
  outcome: 'accepted';
  /** NRE (ricetta SSN) o NRBE (ricetta bianca). */
  nre: string;
  authCode?: string | null;
  /** Cognome e nome del medico come li restituisce il SAC, da stampare sul promemoria. */
  doctorName?: string | null;
  pinNrbe?: string | null;
  reminderPdf?: Uint8Array | null;
  /**
   * Messaggi della ricevuta, con il loro codice. Il codice 0196 porta la frase da stampare sul
   * promemoria quando la ricetta contiene farmaci in distribuzione per conto (specifiche di stampa
   * del promemoria del Sistema TS, 28/02/2024, campo 18).
   */
  messages?: ReceiptMessage[] | null;
  raw: unknown;
}

/** Un messaggio della ricevuta di invio: codice e testo, come li restituisce il SAC. */
export interface ReceiptMessage {
  code: string;
  text: string;
}

export type SendResult =
  | AcceptedSend
  | {
      outcome: 'rejected';
      code: string;
      message: string;
      /** Rifiuto per credenziali o secondo fattore: la ricetta è giusta, l'accesso no. */
      authProblem?: AuthProblem;
      raw: unknown;
    }
  /** Il sistema non risponde: la ricetta certamente non è arrivata. */
  | { outcome: 'unreachable'; message: string }
  /** Nessuna risposta entro il tempo: non si sa se è arrivata. */
  | { outcome: 'timeout'; message: string }
  /**
   * Il SAR ha risposto con un'eccezione di sistema (SOAP fault): «negativo con fault» (V06, 4.3.1,
   * caso 4). Come per il tempo scaduto, la ricetta si annulla e si stampa la ricetta rossa.
   */
  | { outcome: 'fault'; message: string; raw: unknown };

export type CancelResult =
  | { outcome: 'accepted'; raw: unknown }
  | {
      outcome: 'rejected';
      code: string;
      message: string;
      authProblem?: AuthProblem;
      raw: unknown;
    }
  | { outcome: 'unreachable'; message: string }
  | { outcome: 'timeout'; message: string };

/**
 * Stato di erogazione chiesto all'ente (D70). Da verificare sulle specifiche del SAR e del Sistema
 * TS che il servizio esista e quali codici restituisce: qui i nomi del nostro prodotto.
 */
export type StatusResult =
  | { outcome: 'ok'; state: DispensingState; raw: unknown }
  | {
      outcome: 'rejected';
      code: string;
      message: string;
      authProblem?: AuthProblem;
      raw: unknown;
    }
  | { outcome: 'unreachable'; message: string }
  | { outcome: 'timeout'; message: string };

export interface PrescriptionGateway {
  readonly system: GatewaySystem;
  /** Ambiente: un adattatore vero dichiara «collaudo» o «produzione». */
  readonly environment: 'simulator' | 'test' | 'production';
  /** Le credenziali del medico che firma passano a parte: non entrano nel messaggio conservato. */
  send(message: PrescriptionMessage, auth: ServiceAuth): Promise<SendResult>;
  cancel(
    input: {
      nre: string;
      reason: string;
      doctor: PrescriptionMessage['doctor'];
    },
    auth: ServiceAuth,
  ): Promise<CancelResult>;
  /** Che cosa ne è stato della ricetta: presa in carico, prenotata, erogata… */
  status(
    input: { nre: string; doctor: PrescriptionMessage['doctor'] },
    auth: ServiceAuth,
  ): Promise<StatusResult>;
}

/** Il sistema a cui va ogni tipo di ricetta. */
export function systemFor(kind: PrescriptionMessage['kind']): GatewaySystem {
  return kind === 'white' ? 'sistema_ts' : 'sar';
}
