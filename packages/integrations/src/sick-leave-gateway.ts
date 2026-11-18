/**
 * Certificati di malattia all'INPS tramite il SAC del Sistema TS (Specifiche tecniche per la
 * trasmissione all'INPS dei certificati di malattia, versione 3.2, 17/09/2013): InviaMalattia,
 * RettificaMalattia, AnnullaMalattia. Qui l'interfaccia e il simulatore (regola 7); l'adattatore
 * vero (SOAP, autenticazione del medico) arriverà con le credenziali di collaudo.
 *
 * Autenticazione (specifiche, 4.1): basic authentication con utente e password del Sistema TS e
 * PIN cifrato, oppure CNS. Le credenziali passano a parte (`ServiceAuth`), mai nel messaggio.
 */

import type { Benefit, DoctorRole, SickLeaveType, VisitType } from '@mmg/domain';
import { authShapeProblem, type AuthProblem, type ServiceAuth } from './service-auth';

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
  | {
      outcome: 'rejected';
      code: string;
      message: string;
      authProblem?: AuthProblem;
      raw: unknown;
    }
  | { outcome: 'unreachable'; message: string }
  | { outcome: 'timeout'; message: string };

export interface SickLeaveGateway {
  readonly environment: 'simulator' | 'test' | 'production';
  send(message: SickLeaveMessage, auth: ServiceAuth): Promise<SickLeaveResult>;
  /** Anticipa la fine della prognosi: l'INPS dà un protocollo nuovo, il vecchio non vale più. */
  rectify(
    input: {
      protocol: string;
      endDate: string;
      workerFiscalCode: string;
      doctor: SickLeaveMessage['doctor'];
    },
    auth: ServiceAuth,
  ): Promise<SickLeaveResult>;
  /** Annulla: il protocollo restituito è l'identificativo dell'annullamento. */
  cancel(
    input: {
      protocol: string;
      workerFiscalCode: string;
      doctor: SickLeaveMessage['doctor'];
    },
    auth: ServiceAuth,
  ): Promise<SickLeaveResult>;
}

export type SimulatedSickLeaveOutcome = 'accepted' | 'rejected' | 'unreachable' | 'timeout';
type Operation = 'invio' | 'rettifica' | 'annullamento';

/**
 * Simulatore: protocolli di fantasia che cominciano con «SIM». Ripete i rifiuti dell'INPS per i
 * certificati inesistenti o già annullati o rettificati (codici 102, 104, 105, 106).
 */
export class SimulatedSickLeaveGateway implements SickLeaveGateway {
  readonly environment = 'simulator' as const;
  private counter = 0;
  private readonly issued = new Map<string, { endDate: string; closed: boolean }>();
  readonly received: SickLeaveMessage[] = [];
  /** Con quali credenziali: solo l'utente, mai password e PIN. */
  readonly receivedAuth: { operation: Operation; username: string }[] = [];

  constructor(
    private readonly options: {
      decide?: (op: Operation) => SimulatedSickLeaveOutcome;
      now?: () => Date;
    } = {},
  ) {}

  private next(): string {
    this.counter += 1;
    return `SIM${String(this.counter).padStart(9, '0')}`;
  }

  private receivedAt(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }

  private early(op: Operation, auth: ServiceAuth): SickLeaveResult | null {
    this.receivedAuth.push({ operation: op, username: auth?.username ?? '' });
    const shape = authShapeProblem(auth);
    if (shape)
      return {
        outcome: 'rejected',
        ...shape,
        authProblem: 'credentials',
        raw: { simulatore: true, esito: 'credenziali' },
      };
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

  send(message: SickLeaveMessage, auth: ServiceAuth): Promise<SickLeaveResult> {
    this.received.push(message);
    const early = this.early('invio', auth);
    if (early) return Promise.resolve(early);
    const protocol = this.next();
    this.issued.set(protocol, { endDate: message.sickness.endDate, closed: false });
    return Promise.resolve({
      outcome: 'accepted',
      protocol,
      receivedAt: this.receivedAt(),
      raw: { simulatore: true, idCertificato: protocol },
    });
  }

  rectify(
    input: {
      protocol: string;
      endDate: string;
      workerFiscalCode: string;
      doctor: SickLeaveMessage['doctor'];
    },
    auth: ServiceAuth,
  ): Promise<SickLeaveResult> {
    const early = this.early('rettifica', auth);
    if (early) return Promise.resolve(early);
    const known = this.issued.get(input.protocol);
    if (!known)
      return Promise.resolve({
        outcome: 'rejected',
        code: '104',
        message: 'Richiesta rettifica per certificato inesistente',
        raw: { simulatore: true },
      });
    if (known.closed)
      return Promise.resolve({
        outcome: 'rejected',
        code: '106',
        message: "Richiesta rettifica per certificato gia' annullato o rettificato",
        raw: { simulatore: true },
      });
    known.closed = true;
    const protocol = this.next();
    this.issued.set(protocol, { endDate: input.endDate, closed: false });
    return Promise.resolve({
      outcome: 'accepted',
      protocol,
      receivedAt: this.receivedAt(),
      raw: { simulatore: true, idCertificato: protocol },
    });
  }

  cancel(
    input: { protocol: string; workerFiscalCode: string; doctor: SickLeaveMessage['doctor'] },
    auth: ServiceAuth,
  ): Promise<SickLeaveResult> {
    const early = this.early('annullamento', auth);
    if (early) return Promise.resolve(early);
    const known = this.issued.get(input.protocol);
    if (!known)
      return Promise.resolve({
        outcome: 'rejected',
        code: '102',
        message: 'Richiesta annullamento per certificato inesistente',
        raw: { simulatore: true },
      });
    if (known.closed)
      return Promise.resolve({
        outcome: 'rejected',
        code: '105',
        message: "Richiesta annullamento per certificato gia' annullato o rettificato",
        raw: { simulatore: true },
      });
    known.closed = true;
    const protocol = this.next();
    return Promise.resolve({
      outcome: 'accepted',
      protocol,
      receivedAt: this.receivedAt(),
      raw: { simulatore: true, idAnnullamento: protocol },
    });
  }
}
