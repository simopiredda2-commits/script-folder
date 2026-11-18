/**
 * Invio delle ricette dematerializzate.
 *
 * In Piemonte le ricette SSN (farmaceutica e specialistica) vanno al SAR della Regione
 * (progetto SIRPED), che le inoltra al SAC del Sistema TS; la ricetta bianca va al Sistema TS.
 * Qui c'è solo l'interfaccia: gli adattatori veri arriveranno con le specifiche e le credenziali
 * di collaudo. In sviluppo e nelle prove si usa il simulatore (regola 7: nessuna chiamata a
 * servizi reali).
 */

export type GatewaySystem = 'sar' | 'sistema_ts';

export interface PrescriptionLineMessage {
  drugAic?: string | null;
  drugName?: string | null;
  activeIngredient?: string | null;
  serviceCode?: string | null;
  serviceDescription?: string | null;
  quantity: number;
  aifaNote?: string | null;
  notSubstitutable?: boolean;
  notSubstitutableReason?: string | null;
}

export interface PrescriptionMessage {
  /** Identificativo della ricetta nel nostro database, per collegare la risposta. */
  localId: string;
  kind: 'pharma_ssn' | 'specialist_ssn' | 'white' | 'devices';
  patientFiscalCode: string;
  /** Il medico che firma: le ricette sono sempre a nome suo (anche se sostituto). */
  doctor: { userId: string; name: string; regionalCode?: string | null };
  exemptionCode?: string | null;
  priority?: 'U' | 'B' | 'D' | 'P' | null;
  accessType?: 'first' | 'subsequent' | null;
  diagnosticQuestion?: string | null;
  lines: PrescriptionLineMessage[];
  compiledAt: string;
}

export type SendResult =
  | { outcome: 'accepted'; nre: string; raw: unknown }
  | { outcome: 'rejected'; code: string; message: string; raw: unknown }
  /** Il sistema non risponde: la ricetta certamente non è arrivata. */
  | { outcome: 'unreachable'; message: string }
  /** Nessuna risposta entro il tempo: non si sa se è arrivata. */
  | { outcome: 'timeout'; message: string };

export type CancelResult =
  | { outcome: 'accepted'; raw: unknown }
  | { outcome: 'rejected'; code: string; message: string; raw: unknown }
  | { outcome: 'unreachable'; message: string }
  | { outcome: 'timeout'; message: string };

export interface PrescriptionGateway {
  readonly system: GatewaySystem;
  /** Ambiente: un adattatore vero dichiara «collaudo» o «produzione». */
  readonly environment: 'simulator' | 'test' | 'production';
  send(message: PrescriptionMessage): Promise<SendResult>;
  cancel(input: {
    nre: string;
    reason: string;
    doctor: PrescriptionMessage['doctor'];
  }): Promise<CancelResult>;
}

/** Il sistema a cui va ogni tipo di ricetta. */
export function systemFor(kind: PrescriptionMessage['kind']): GatewaySystem {
  return kind === 'white' ? 'sistema_ts' : 'sar';
}
