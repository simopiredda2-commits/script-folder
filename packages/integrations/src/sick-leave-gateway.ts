/**
 * Certificati di malattia all'INPS tramite il SAC del Sistema TS (Specifiche tecniche per la
 * trasmissione all'INPS dei certificati di malattia, versione 3.2, 17/09/2013): InviaMalattia,
 * RettificaMalattia, AnnullaMalattia. Qui l'interfaccia e il simulatore (regola 7); l'adattatore
 * vero (SOAP, autenticazione del medico) arriverà con le credenziali di collaudo.
 */

import type { Benefit, DoctorRole, SickLeaveType, VisitType } from '@mmg/domain';

export interface SickLeaveAddress {
  street: string;
  /** «SNC» se non c'è numero civico (specifiche, elemento civico). */
  number: string;
  postalCode: string;
  town: string;
  province: string;
  cadastralCode?: string | null;
}

export interface SickLeaveMessage {
  localId: string;
  doctor: { userId: string; name: string; fiscalCode: string; regionalCode?: string | null };
  workerFiscalCode: string;
  residence: SickLeaveAddress;
  availability?: { name?: string | null; address?: SickLeaveAddress | null } | null;
  sickness: {
    role: DoctorRole;
    releaseDate: string;
    startDate: string;
    endDate: string;
    visit: VisitType;
    type: SickLeaveType;
    diagnosisCode?: string | null;
    diagnosisNotes?: string | null;
    workedDay?: boolean | null;
    trauma?: boolean | null;
    benefits?: Benefit | null;
  };
}

/** Accettato dall'INPS: protocollo (idCertificato) e data di ricezione. */
export type SickLeaveResult =
  | { outcome: 'accepted'; protocol: string; receivedAt: string; raw: unknown }
  | { outcome: 'rejected'; code: string; message: string; raw: unknown }
  | { outcome: 'unreachable'; message: string }
  | { outcome: 'timeout'; message: string };

export interface SickLeaveGateway {
  readonly environment: 'simulator' | 'test' | 'production';
  send(message: SickLeaveMessage): Promise<SickLeaveResult>;
  /** Anticipa la fine della prognosi: l'INPS dà un protocollo nuovo, il vecchio non vale più. */
  rectify(input: {
    protocol: string;
    endDate: string;
    workerFiscalCode: string;
    doctor: SickLeaveMessage['doctor'];
  }): Promise<SickLeaveResult>;
  /** Annulla: il protocollo restituito è l'identificativo dell'annullamento. */
  cancel(input: {
    protocol: string;
    workerFiscalCode: string;
    doctor: SickLeaveMessage['doctor'];
  }): Promise<SickLeaveResult>;
}

export type SimulatedSickLeaveOutcome = 'accepted' | 'rejected' | 'unreachable' | 'timeout';

/**
 * Simulatore: protocolli di fantasia che cominciano con «SIM». Ripete i rifiuti dell'INPS per i
 * certificati inesistenti o già annullati o rettificati (codici 102, 104, 105, 106).
 */
export class SimulatedSickLeaveGateway implements SickLeaveGateway {
  readonly environment = 'simulator' as const;
  private counter = 0;
  private readonly issued = new Map<string, { endDate: string; closed: boolean }>();
  readonly received: SickLeaveMessage[] = [];

  constructor(
    private readonly options: {
      decide?: (op: 'invio' | 'rettifica' | 'annullamento') => SimulatedSickLeaveOutcome;
    } = {},
  ) {}

  private next(): string {
    this.counter += 1;
    return `SIM${String(this.counter).padStart(9, '0')}`;
  }

  private early(op: 'invio' | 'rettifica' | 'annullamento'): SickLeaveResult | null {
    const outcome = this.options.decide?.(op) ?? 'accepted';
    if (outcome === 'unreachable')
      return { outcome, message: 'Sistema TS non raggiungibile (simulato)' };
    if (outcome === 'timeout')
      return { outcome, message: 'Sistema TS: nessuna risposta in tempo (simulato)' };
    if (outcome === 'rejected')
      return {
        outcome,
        code: '200',
        message: 'Simulatore: errore non codificato, per prova',
        raw: { simulatore: true },
      };
    return null;
  }

  send(message: SickLeaveMessage): Promise<SickLeaveResult> {
    this.received.push(message);
    const early = this.early('invio');
    if (early) return Promise.resolve(early);
    const protocol = this.next();
    this.issued.set(protocol, { endDate: message.sickness.endDate, closed: false });
    const receivedAt = new Date().toISOString();
    return Promise.resolve({
      outcome: 'accepted',
      protocol,
      receivedAt,
      raw: { simulatore: true, idCertificato: protocol },
    });
  }

  rectify(input: { protocol: string; endDate: string }): Promise<SickLeaveResult> {
    const early = this.early('rettifica');
    if (early) return Promise.resolve(early);
    const known = this.issued.get(input.protocol);
    if (!known)
      return Promise.resolve({
        outcome: 'rejected',
        code: '104',
        message: 'Richiesta rettifica per certificato inesistente',
        raw: {},
      });
    if (known.closed)
      return Promise.resolve({
        outcome: 'rejected',
        code: '106',
        message: "Richiesta rettifica per certificato gia' annullato o rettificato",
        raw: {},
      });
    known.closed = true;
    const protocol = this.next();
    this.issued.set(protocol, { endDate: input.endDate, closed: false });
    return Promise.resolve({
      outcome: 'accepted',
      protocol,
      receivedAt: new Date().toISOString(),
      raw: { simulatore: true, idCertificato: protocol },
    });
  }

  cancel(input: { protocol: string }): Promise<SickLeaveResult> {
    const early = this.early('annullamento');
    if (early) return Promise.resolve(early);
    const known = this.issued.get(input.protocol);
    if (!known)
      return Promise.resolve({
        outcome: 'rejected',
        code: '102',
        message: 'Richiesta annullamento per certificato inesistente',
        raw: {},
      });
    if (known.closed)
      return Promise.resolve({
        outcome: 'rejected',
        code: '105',
        message: "Richiesta annullamento per certificato gia' annullato o rettificato",
        raw: {},
      });
    known.closed = true;
    const protocol = this.next();
    return Promise.resolve({
      outcome: 'accepted',
      protocol,
      receivedAt: new Date().toISOString(),
      raw: { simulatore: true, idAnnullamento: protocol },
    });
  }
}
