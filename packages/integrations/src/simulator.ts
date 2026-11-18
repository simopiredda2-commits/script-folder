import type {
  CancelResult,
  GatewaySystem,
  PrescriptionGateway,
  PrescriptionMessage,
  SendResult,
} from './prescription-gateway';

export type SimulatedOutcome = 'accepted' | 'rejected' | 'unreachable' | 'timeout';

export interface SimulatorOptions {
  /** Esito di ogni invio. Per difetto: accettato. Nelle prove si sceglie caso per caso. */
  decide?: (message: PrescriptionMessage) => SimulatedOutcome;
  /** Esito di ogni annullamento. Per difetto: accettato se il numero è noto. */
  decideCancel?: (nre: string) => SimulatedOutcome;
}

/**
 * Simulatore del SAR (e del Sistema TS per la ricetta bianca). Numeri di ricetta di
 * fantasia, riconoscibili dal prefisso «SIM»: il formato vero dell'NRE è nelle specifiche del
 * Sistema TS, da riprendere quando si scrive l'adattatore vero.
 */
export class SimulatedGateway implements PrescriptionGateway {
  readonly environment = 'simulator' as const;
  private counter = 0;
  private readonly issued = new Map<string, { cancelled: boolean }>();
  /** Messaggi ricevuti, per le prove. */
  readonly received: PrescriptionMessage[] = [];

  constructor(
    readonly system: GatewaySystem,
    private readonly options: SimulatorOptions = {},
  ) {}

  send(message: PrescriptionMessage): Promise<SendResult> {
    this.received.push(message);
    const outcome = this.options.decide?.(message) ?? 'accepted';
    switch (outcome) {
      case 'accepted': {
        this.counter += 1;
        const nre = `SIM${this.system === 'sar' ? 'R' : 'B'}${String(this.counter).padStart(12, '0')}`;
        this.issued.set(nre, { cancelled: false });
        return Promise.resolve({ outcome, nre, raw: { simulatore: this.system, nre } });
      }
      case 'rejected':
        return Promise.resolve({
          outcome,
          code: 'SIM-001',
          message: 'Simulatore: ricetta rifiutata per prova',
          raw: { simulatore: this.system, esito: 'rifiutata' },
        });
      case 'unreachable':
        return Promise.resolve({
          outcome,
          message: `${this.label()} non raggiungibile (simulato)`,
        });
      case 'timeout':
        return Promise.resolve({
          outcome,
          message: `${this.label()}: nessuna risposta in tempo (simulato)`,
        });
    }
  }

  cancel(input: {
    nre: string;
    reason: string;
    doctor: PrescriptionMessage['doctor'];
  }): Promise<CancelResult> {
    const outcome = this.options.decideCancel?.(input.nre) ?? 'accepted';
    if (outcome === 'unreachable' || outcome === 'timeout') {
      return Promise.resolve({ outcome, message: `${this.label()} non raggiungibile (simulato)` });
    }
    const known = this.issued.get(input.nre);
    if (outcome === 'rejected' || !known || known.cancelled) {
      return Promise.resolve({
        outcome: 'rejected',
        code: 'SIM-002',
        message: 'Simulatore: annullamento non ammesso',
        raw: { simulatore: this.system, nre: input.nre },
      });
    }
    known.cancelled = true;
    return Promise.resolve({
      outcome: 'accepted',
      raw: { simulatore: this.system, annullata: input.nre },
    });
  }

  private label(): string {
    return this.system === 'sar' ? 'SAR' : 'Sistema TS';
  }
}
