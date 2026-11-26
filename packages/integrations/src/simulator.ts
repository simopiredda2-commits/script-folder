import type { DispensingState } from '@mmg/domain';
import type {
  CancelResult,
  GatewaySystem,
  PrescriptionGateway,
  PrescriptionMessage,
  ReceiptMessage,
  SendResult,
  StatusResult,
} from './prescription-gateway';
import { authShapeProblem, type ServiceAuth, type SimulatedValidity } from './service-auth';
import { simulatedWhiteReminderPdf } from './simulated-documents';

export type SimulatedOutcome = 'accepted' | 'rejected' | 'unreachable' | 'timeout' | 'fault';

export interface SimulatorOptions {
  /** Esito di ogni invio. Per difetto: accettato. Nelle prove si sceglie caso per caso. */
  decide?: (message: PrescriptionMessage) => SimulatedOutcome;
  /** Esito di ogni annullamento. Per difetto: accettato se il numero è noto. */
  decideCancel?: (nre: string) => SimulatedOutcome;
  /**
   * Stato di erogazione di ogni ricetta. Per difetto: non ancora presa in carico, oppure già
   * annullata se è stata annullata qui.
   */
  decideStatus?: (nre: string) => DispensingState | 'unreachable' | 'timeout';
  /** Ricetta SSN accettata ma senza codice di autenticazione: per provare che il promemoria non esce. */
  omitAuthCode?: (message: PrescriptionMessage) => boolean;
  /**
   * Messaggi della ricevuta di una ricetta SSN accettata, per esempio il codice 0196 con la frase
   * sui farmaci in DPC. Per difetto nessuno: il simulatore non sa quali farmaci sono in DPC.
   */
  receiptMessages?: (message: PrescriptionMessage) => ReceiptMessage[];
  /** Attesa prima della risposta, per provare il tempo massimo di attesa. */
  delayMs?: number;
  /**
   * Secondo fattore: se c'è, ogni chiamata deve portare un Id-Sessione valido per quel
   * simulatore (D102). Senza, il simulatore controlla solo la forma delle credenziali.
   */
  sessions?: SimulatedValidity;
}

/** Un rifiuto delle credenziali, come lo dà il servizio vero. */
export type SimulatedRefusal = Extract<SendResult, { outcome: 'rejected' }>;

/**
 * Simulatore di un servizio delle ricette (regola 7): il Sistema TS, e la base del simulatore del
 * servizio della regione, che il pacchetto della regione estende con i suoi servizi (lotti di NRE,
 * ricetta rossa in DPCM) e con i suoi controlli (D300).
 *
 * - Ricetta SSN: NRE della cartella, se c'è, o uno di fantasia riconoscibile dal prefisso «SIMR»,
 *   con un codice di autenticazione di fantasia.
 * - Ricetta bianca: NRBE di fantasia («SIMB»), PIN e PDF del promemoria, come il SAC.
 */
export class SimulatedGateway implements PrescriptionGateway {
  readonly environment = 'simulator' as const;
  protected counter = 0;
  /** NRE dati o ricevuti, con lo stato dell'annullamento. */
  protected readonly issued = new Map<string, { cancelled: boolean }>();
  /** Messaggi ricevuti, per le prove. */
  readonly received: PrescriptionMessage[] = [];
  /**
   * Con quali credenziali: utente, Id-Sessione, codice del gestionale e se c'era un token; mai
   * password, PIN o token.
   */
  readonly receivedAuth: {
    username: string;
    sessionId: string | null;
    bearer: boolean;
    software: string | null;
  }[] = [];

  constructor(
    readonly system: GatewaySystem,
    protected readonly options: SimulatorOptions = {},
    /** Il nome del servizio nei messaggi del simulatore. */
    protected readonly name = system === 'sistema_ts' ? 'Sistema TS' : 'Servizio della regione',
  ) {}

  /** Il token di un accesso fatto altrove: lo controlla il simulatore che lo sa leggere. */
  protected bearerRefusal(_auth: ServiceAuth): SimulatedRefusal | null {
    return null;
  }

  /**
   * Credenziali mancanti, o mescolate al token: il rifiuto con le parole del servizio. Il
   * simulatore del servizio di una regione può dare le sue (D301).
   */
  protected shapeProblem(auth: ServiceAuth): { code: string; message: string } | null {
    return authShapeProblem(auth);
  }

  /** Controlli in più sulle credenziali, dopo utente, password, PIN e Id-Sessione. */
  protected extraAuthRefusal(_auth: ServiceAuth): SimulatedRefusal | null {
    return null;
  }

  /** Controlli in più sulla ricetta, prima dell'esito: per esempio l'NRE della cartella. */
  protected messageRefusal(_message: PrescriptionMessage): SimulatedRefusal | null {
    return null;
  }

  /** Rifiuto per credenziali o secondo fattore, come farebbe il servizio vero. */
  protected authRefusal(auth: ServiceAuth): SimulatedRefusal | null {
    if (auth?.bearer) {
      // Token insieme a utente, password, PIN o Id-Sessione: non si accetta.
      const mixed = this.shapeProblem(auth);
      if (mixed)
        return {
          outcome: 'rejected',
          ...mixed,
          authProblem: 'credentials',
          raw: { simulatore: this.system, esito: 'credenziali insieme al token' },
        };
      return this.bearerRefusal(auth);
    }
    const shape = this.shapeProblem(auth);
    if (shape)
      return {
        outcome: 'rejected',
        ...shape,
        authProblem: 'credentials',
        raw: { simulatore: this.system, esito: 'credenziali' },
      };
    if (this.options.sessions && !this.options.sessions.isValid(auth.sessionId))
      return {
        outcome: 'rejected',
        code: 'ID_SESSIONE',
        message: 'Id-Sessione mancante, scaduto o revocato (simulato)',
        authProblem: 'session',
        raw: { simulatore: this.system, esito: 'secondo fattore' },
      };
    return this.extraAuthRefusal(auth);
  }

  async send(message: PrescriptionMessage, auth: ServiceAuth): Promise<SendResult> {
    this.received.push(message);
    this.receivedAuth.push({
      username: auth?.username ?? '',
      sessionId: auth?.sessionId ?? null,
      bearer: !!auth?.bearer,
      software: auth?.software ?? null,
    });
    if (this.options.delayMs) await new Promise((ok) => setTimeout(ok, this.options.delayMs));
    const refused = this.authRefusal(auth);
    if (refused) return refused;
    // Come il SAC: codMotivazione «deve essere compilato se nonSost vale 1» (specifiche della
    // prescrizione, 08/07/2026). Di solito lo ferma prima la regola R13 (D273).
    const noReason =
      message.kind === 'pharma_ssn'
        ? message.lines.find((l) => l.notSubstitutable && !l.notSubstitutableCode?.trim())
        : undefined;
    if (noReason) {
      return {
        outcome: 'rejected',
        code: 'SIM-MOTIVAZIONE',
        message: `${noReason.drugName ?? noReason.drugAic ?? 'Farmaco'}: non sostituibile senza il codice della motivazione (simulato)`,
        raw: { simulatore: this.system, esito: 'codMotivazione mancante' },
      };
    }
    const problem = this.messageRefusal(message);
    if (problem) return problem;
    const outcome = this.options.decide?.(message) ?? 'accepted';
    switch (outcome) {
      case 'accepted': {
        this.counter += 1;
        const white = message.kind === 'white';
        const nre =
          !white && message.nre
            ? message.nre
            : `SIM${white ? 'B' : 'R'}${String(this.counter).padStart(12, '0')}`;
        this.issued.set(nre, { cancelled: false });
        if (!white) {
          // Codice di autenticazione di fantasia, riconoscibile come i numeri del simulatore.
          const authCode = this.options.omitAuthCode?.(message)
            ? null
            : `SIMAUT${String(this.counter).padStart(24, '0')}`;
          const messages = this.options.receiptMessages?.(message) ?? [];
          return {
            outcome,
            nre,
            authCode,
            doctorName: message.doctor.name,
            messages,
            raw: {
              simulatore: this.system,
              nre,
              codAutenticazione: authCode,
              ...(messages.length ? { messaggi: messages } : {}),
            },
          };
        }
        const pinNrbe = `S${String(this.counter % 10000).padStart(4, '0')}`;
        const reminderPdf = await simulatedWhiteReminderPdf({
          nrbe: nre,
          pinNrbe,
          patientFiscalCode: message.patientFiscalCode,
          compiledAt: message.compiledAt,
          lines: message.lines,
        });
        return {
          outcome,
          nre,
          pinNrbe,
          reminderPdf,
          // Il PDF non entra nel registro degli invii: lì basta sapere che c'era e quanto pesa.
          raw: {
            simulatore: this.system,
            nre,
            pinNrbe,
            pdfPromemoria: { byte: reminderPdf.length },
          },
        };
      }
      case 'rejected':
        return {
          outcome,
          code: 'SIM-001',
          message: 'Simulatore: ricetta rifiutata per prova',
          raw: { simulatore: this.system, esito: 'rifiutata' },
        };
      case 'unreachable':
        return { outcome, message: `${this.label()} non raggiungibile (simulato)` };
      case 'timeout':
        return { outcome, message: `${this.label()}: nessuna risposta in tempo (simulato)` };
      case 'fault':
        return {
          outcome,
          message: `${this.label()}: eccezione di sistema (simulato)`,
          raw: { simulatore: this.system, esito: 'fault' },
        };
    }
  }

  cancel(
    input: {
      nre: string;
      reason: string;
      doctor: PrescriptionMessage['doctor'];
    },
    auth: ServiceAuth,
  ): Promise<CancelResult> {
    const refused = this.authRefusal(auth);
    if (refused) return Promise.resolve(refused);
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

  status(
    input: { nre: string; doctor: PrescriptionMessage['doctor'] },
    auth: ServiceAuth,
  ): Promise<StatusResult> {
    const refused = this.authRefusal(auth);
    if (refused) return Promise.resolve(refused);
    const known = this.issued.get(input.nre);
    const decided = this.options.decideStatus?.(input.nre);
    if (decided === 'unreachable' || decided === 'timeout') {
      return Promise.resolve({
        outcome: decided,
        message: `${this.label()} non raggiungibile (simulato)`,
      });
    }
    if (!known && !decided) {
      return Promise.resolve({
        outcome: 'rejected',
        code: 'SIM-003',
        message: 'Simulatore: ricetta sconosciuta',
        raw: { simulatore: this.system, nre: input.nre },
      });
    }
    const state: DispensingState = decided ?? (known!.cancelled ? 'annullata' : 'non_erogata');
    return Promise.resolve({
      outcome: 'ok',
      state,
      raw: { simulatore: this.system, nre: input.nre, stato: state },
    });
  }

  protected label(): string {
    return this.name;
  }
}
