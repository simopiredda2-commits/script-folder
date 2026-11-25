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
import type { SimulatedRegionalAuthorization } from './regional-authorization';
import { authShapeProblem, type ServiceAuth, type SimulatedSecondFactor } from './service-auth';
import { simulatedWhiteReminderPdf } from './simulated-documents';

export type SimulatedOutcome = 'accepted' | 'rejected' | 'unreachable' | 'timeout';

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
  /**
   * Catalogo regionale che la Regione ha trasmesso al Sistema TS (D154): il SAR controlla la coppia
   * «codice del nomenclatore – codice del catalogo» di ogni prestazione e rifiuta quelle che non
   * conosce. Senza, il simulatore accetta ogni coppia.
   */
  regionalCatalog?: (nationalCode: string | null, catalogCode: string | null) => boolean;
  /** Attesa prima della risposta, per provare il tempo massimo di attesa. */
  delayMs?: number;
  /**
   * Secondo fattore: se c'è, ogni chiamata deve portare un Id-Sessione valido per quel
   * simulatore (D102). Senza, il simulatore controlla solo la forma delle credenziali.
   */
  sessions?: SimulatedSecondFactor;
  /** Accesso regionale con SPID o CIE: se c'è, il token deve essere valido per quel simulatore. */
  oauth?: SimulatedRegionalAuthorization;
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
  /** Con quali credenziali: utente, Id-Sessione e se c'era un token; mai password, PIN o token. */
  readonly receivedAuth: { username: string; sessionId: string | null; bearer: boolean }[] = [];

  constructor(
    readonly system: GatewaySystem,
    private readonly options: SimulatorOptions = {},
  ) {}

  /** Rifiuto per credenziali o secondo fattore, come farebbe il servizio vero. */
  private authRefusal(auth: ServiceAuth) {
    if (auth?.bearer) {
      // Token insieme a utente, password, PIN o Id-Sessione: il SAR non lo accetta (V08, 4.3.6).
      const mixed = authShapeProblem(auth);
      if (mixed)
        return {
          outcome: 'rejected' as const,
          ...mixed,
          authProblem: 'credentials' as const,
          raw: { simulatore: this.system, esito: 'credenziali insieme al token' },
        };
      if (this.options.oauth && !this.options.oauth.isValid(auth.bearer))
        return {
          outcome: 'rejected' as const,
          code: 'TOKEN',
          message: 'Token dell’accesso regionale non valido, scaduto o revocato (simulato)',
          authProblem: 'session' as const,
          raw: { simulatore: this.system, esito: 'token' },
        };
      return null;
    }
    const shape = authShapeProblem(auth);
    if (shape)
      return {
        outcome: 'rejected' as const,
        ...shape,
        authProblem: 'credentials' as const,
        raw: { simulatore: this.system, esito: 'credenziali' },
      };
    if (this.options.sessions && !this.options.sessions.isValid(auth.sessionId))
      return {
        outcome: 'rejected' as const,
        code: 'ID_SESSIONE',
        message: 'Id-Sessione mancante, scaduto o revocato (simulato)',
        authProblem: 'session' as const,
        raw: { simulatore: this.system, esito: 'secondo fattore' },
      };
    return null;
  }

  async send(message: PrescriptionMessage, auth: ServiceAuth): Promise<SendResult> {
    this.received.push(message);
    this.receivedAuth.push({
      username: auth?.username ?? '',
      sessionId: auth?.sessionId ?? null,
      bearer: !!auth?.bearer,
    });
    if (this.options.delayMs) await new Promise((ok) => setTimeout(ok, this.options.delayMs));
    const refused = this.authRefusal(auth);
    if (refused) return refused;
    const unknown =
      message.kind === 'specialist_ssn' && this.options.regionalCatalog
        ? message.lines.find(
            (l) =>
              !this.options.regionalCatalog!(l.serviceNationalCode ?? null, l.serviceCode ?? null),
          )
        : undefined;
    if (unknown) {
      return {
        outcome: 'rejected',
        code: 'SIM-CAT',
        message: `Prestazione ${unknown.serviceCode ?? ''}: la coppia di codici nomenclatore ${unknown.serviceNationalCode ?? '—'} e catalogo ${unknown.serviceCode ?? '—'} non è nel catalogo regionale (simulato)`,
        raw: { simulatore: this.system, esito: 'codice non in catalogo' },
      };
    }
    const outcome = this.options.decide?.(message) ?? 'accepted';
    switch (outcome) {
      case 'accepted': {
        this.counter += 1;
        const nre = `SIM${this.system === 'sar' ? 'R' : 'B'}${String(this.counter).padStart(12, '0')}`;
        this.issued.set(nre, { cancelled: false });
        if (this.system === 'sar') {
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

  private label(): string {
    return this.system === 'sar' ? 'SAR' : 'Sistema TS';
  }
}
