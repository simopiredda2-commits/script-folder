import { checkFiscalCode, nreLotPrefix, splitNre, type DispensingState } from '@mmg/domain';
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
import type { LotResult, SarRegionalServices } from './sar-services';
import {
  authShapeProblem,
  REGIONAL_SOFTWARE_ID,
  type ServiceAuth,
  type SimulatedSecondFactor,
} from './service-auth';
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
  /** Esito di ogni richiesta del lotto di NRE. Per difetto: assegnato. */
  decideLot?: (input: { regionCode: string; doctorFiscalCode: string }) => SimulatedOutcome;
}

/**
 * Simulatore del SAR (e del Sistema TS per la ricetta bianca).
 *
 * - Lotti di NRE (V06, 4.1; D269): «estratti» come nell'esempio della V06, con l'identificativo 4
 *   del lotto del SAR e un codice di 6 cifre. Il raggruppamento è «ZZ», per riconoscerli come
 *   simulati. Il simulatore ricorda a quale medico ha dato ogni lotto; i codici partono da un
 *   numero a caso, perché dopo un riavvio non ridia un lotto che il database ha già.
 * - Ricetta con l'NRE della cartella: l'NRE dev'essere di un lotto del medico che firma e non
 *   ancora usato da una ricetta accettata; dopo un rifiuto si può rimandare (4.3.1, caso 3). Un
 *   lotto «ZZ» che non ricorda l'ha dato prima di un riavvio: lo accetta, senza sapere di chi è.
 * - Ricetta senza NRE: il simulatore ne dà uno di fantasia, riconoscibile dal prefisso «SIM».
 */
export class SimulatedGateway implements PrescriptionGateway, SarRegionalServices {
  readonly environment = 'simulator' as const;
  private counter = 0;
  /** Codice dell'ultimo lotto dato: parte da un numero a caso (vedi sopra). */
  private lotCounter = Math.floor(Math.random() * 1_000_000);
  private readonly issued = new Map<string, { cancelled: boolean }>();
  /** Lotti dati: inizio comune dei 1000 NRE → codice fiscale del medico. */
  private readonly lots = new Map<string, string>();
  /** Richieste del lotto ricevute, per le prove. */
  readonly lotRequests: { regionCode: string; lotType: string; doctorFiscalCode: string }[] = [];
  /** Messaggi ricevuti, per le prove. */
  readonly received: PrescriptionMessage[] = [];
  /**
   * Con quali credenziali: utente, Id-Sessione, X-Gestionale e se c'era un token; mai password,
   * PIN o token.
   */
  readonly receivedAuth: {
    username: string;
    sessionId: string | null;
    bearer: boolean;
    software: string | null;
  }[] = [];

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
    // Con l'Id-Sessione per email il SAR vuole X-Gestionale: codice del gestionale, «_» e codice
    // ASL del medico (REL-STC-01 V08, 4.2.5). Il Sistema TS no.
    if (this.system === 'sar' && !REGIONAL_SOFTWARE_ID.test(auth.software ?? ''))
      return {
        outcome: 'rejected' as const,
        code: 'GESTIONALE',
        message: 'X-Gestionale mancante o non valido (simulato)',
        raw: { simulatore: this.system, esito: 'X-Gestionale' },
      };
    return null;
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
    if (this.system === 'sar' && message.nre) {
      const problem = this.nreProblem(message.nre, message.doctor.fiscalCode ?? null);
      if (problem)
        return {
          outcome: 'rejected',
          code: problem.code,
          message: problem.message,
          raw: { simulatore: this.system, esito: 'NRE', nre: message.nre },
        };
    }
    const outcome = this.options.decide?.(message) ?? 'accepted';
    switch (outcome) {
      case 'accepted': {
        this.counter += 1;
        const nre =
          this.system === 'sar' && message.nre
            ? message.nre
            : `SIM${this.system === 'sar' ? 'R' : 'B'}${String(this.counter).padStart(12, '0')}`;
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
      case 'fault':
        return {
          outcome,
          message: `${this.label()}: eccezione di sistema (simulato)`,
          raw: { simulatore: this.system, esito: 'fault' },
        };
    }
  }

  /**
   * L'NRE della cartella: dei lotti di questo medico e non ancora usato. Codici del simulatore:
   * quelli veri del SAR si leggono in collaudo.
   */
  private nreProblem(
    nre: string,
    doctorFiscalCode: string | null,
  ): { code: string; message: string } | null {
    const parts = splitNre(nre);
    const owner = parts ? this.lots.get(parts.prefix) : undefined;
    // Un lotto simulato dato prima di un riavvio: il simulatore non lo ricorda più.
    const beforeRestart = !owner && parts?.prefix.slice(3, 5) === 'ZZ';
    if (!owner && !beforeRestart)
      return { code: 'SIM-NRE-LOTTO', message: `NRE ${nre} fuori dai lotti assegnati (simulato)` };
    if (owner && owner !== doctorFiscalCode)
      return {
        code: 'SIM-NRE-MEDICO',
        message: `NRE ${nre} di un lotto assegnato a un altro medico (simulato)`,
      };
    if (this.issued.has(nre))
      return {
        code: 'SIM-NRE-USATO',
        message: `NRE ${nre} già usato da un'altra ricetta (simulato)`,
      };
    return null;
  }

  /** «Richiesta Lotto» come la descrive la V06 (4.1), con i suoi codici d'errore 02–06. */
  requestLot(
    input: { regionCode: string; lotType: string; doctorFiscalCode: string },
    auth: ServiceAuth,
  ): Promise<LotResult> {
    this.lotRequests.push({ ...input });
    const reject = (code: string, message: string, authProblem?: 'credentials') =>
      Promise.resolve<LotResult>({
        outcome: 'rejected',
        code,
        message,
        ...(authProblem ? { authProblem } : {}),
        raw: { simulatore: this.system, esito: code },
      });
    if (this.system !== 'sar')
      return reject('SIM-LOTTO', 'Il lotto di NRE lo dà il SAR (simulato)');
    // Solo utente, password e PIN RUPAR (V06, 3.1.1): né il token né il secondo fattore.
    if (auth?.bearer)
      return reject(
        'CREDENZIALI',
        'Per il lotto di NRE servono utente, password e PIN RUPAR (V06, 3.1.1) (simulato)',
        'credentials',
      );
    const shape = authShapeProblem(auth);
    if (shape) return reject(shape.code, shape.message, 'credentials');
    const decided = this.options.decideLot?.(input) ?? 'accepted';
    if (decided === 'timeout')
      return Promise.resolve({
        outcome: 'timeout',
        message: `${this.label()}: nessuna risposta in tempo (simulato)`,
      });
    if (decided === 'unreachable' || decided === 'fault')
      return Promise.resolve({
        outcome: 'unreachable',
        message: `${this.label()} non raggiungibile (simulato)`,
      });
    if (decided === 'rejected') return reject('SIM-LOTTO', 'Simulatore: lotto rifiutato per prova');
    if (!input.lotType.trim()) return reject('02', "Inserire l'identificativo lotto");
    if (input.lotType !== '1') return reject('03', 'Inserire un identificativo lotto valido');
    if (!input.regionCode.trim()) return reject('04', 'Inserire il codice regione');
    if (input.regionCode !== '010') return reject('05', 'Inserire un codice regione valido');
    if (!checkFiscalCode(input.doctorFiscalCode).valid)
      return reject(
        '06',
        'Inserire il codice fiscale del medico valido e/o facente parte della regione',
      );
    // Lotto «estratto»: identificativo del lotto del SAR (4) e codice di 6 cifre (V06, 4.1).
    this.lotCounter = (this.lotCounter + 1) % 1_000_000;
    const lot = {
      regionCode: '010',
      groupCode: 'ZZ',
      lotType: '4',
      lotCode: String(this.lotCounter).padStart(6, '0'),
    };
    this.lots.set(nreLotPrefix(lot), input.doctorFiscalCode);
    return Promise.resolve({
      outcome: 'assigned',
      lot,
      raw: {
        simulatore: this.system,
        CodRegione: lot.regionCode,
        CodRagLotto: lot.groupCode,
        IdentificativoLotto: lot.lotType,
        CodLotto: lot.lotCode,
        CFMedico: input.doctorFiscalCode,
      },
    });
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
