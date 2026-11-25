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
import { DOMParser } from '@xmldom/xmldom';
import { unzipSync, strFromU8 } from 'fflate';
import {
  decryptSimulated,
  dpcmPackage,
  SIMULATED_DPCM_CRYPTO,
  type DpcmAnalyticResult,
  type DpcmPrescription,
  type DpcmReceipt,
  type DpcmSendState,
  type DpcmServices,
  type DpcmSummaryResult,
} from './dpcm';
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
  /** Ricetta DPCM: esito della ricevuta di accoglienza. Per difetto: accolta. */
  decideDpcmReceipt?: (p: DpcmPrescription) => 'accepted' | 'rejected' | 'unreachable' | 'timeout';
  /**
   * Ricetta DPCM: stato finale dell'elenco sintetico e messaggi dell'elenco analitico. Per difetto
   * 2 (senza errori), oppure 3 con l'avviso 2090 se arriva il giorno dopo la compilazione.
   */
  decideDpcm?: (p: DpcmPrescription) =>
    | {
        state: Exclude<DpcmSendState, 1>;
        errors?: { code: string; description: string }[];
      }
    // Nessuna scelta: l'esito di sempre (2, o 3 con l'avviso 2090).
    | undefined;
  /** Quante letture dell'elenco sintetico rispondono «in attesa di elaborazione» (1). Per difetto 1. */
  dpcmPendingChecks?: number;
  /** Orologio del simulatore, per il giorno di ricezione delle ricette DPCM. */
  now?: () => Date;
}

/** Una ricetta DPCM ricevuta dal simulatore. */
interface ReceivedDpcm {
  prescription: DpcmPrescription;
  xml: string;
  acceptedAt: Date;
  checks: number;
  result: { state: Exclude<DpcmSendState, 1>; errors: { code: string; description: string }[] };
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
/** Il giorno a Roma, come la data di compilazione della ricetta: il SAR è in Piemonte. */
const romeDate = (d: Date) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(d);

export class SimulatedGateway implements PrescriptionGateway, SarRegionalServices, DpcmServices {
  readonly environment = 'simulator' as const;
  private counter = 0;
  /** Codice dell'ultimo lotto dato: parte da un numero a caso (vedi sopra). */
  private lotCounter = Math.floor(Math.random() * 1_000_000);
  private readonly issued = new Map<string, { cancelled: boolean }>();
  /** Lotti dati: inizio comune dei 1000 NRE → codice fiscale del medico. */
  private readonly lots = new Map<string, string>();
  /** Richieste del lotto ricevute, per le prove. */
  readonly lotRequests: { regionCode: string; lotType: string; doctorFiscalCode: string }[] = [];
  /** Ricette DPCM accolte, per protocollo. */
  private readonly dpcm = new Map<string, ReceivedDpcm>();
  private dpcmCounter = 0;
  /** File DPCM ricevuti, per le prove: nome e XML letto dallo zip. */
  readonly dpcmFiles: { fileName: string; xml: string }[] = [];
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

  /** Le credenziali per i servizi DPCM: utente, password e PIN RUPAR, niente token (V06, 3.1.1). */
  private dpcmAuthProblem(auth: ServiceAuth): { code: string; message: string } | null {
    if (this.system !== 'sar')
      return { code: 'SIM-DPCM', message: 'Le ricette DPCM le riceve il SAR (simulato)' };
    if (auth?.bearer)
      return {
        code: 'CREDENZIALI',
        message: 'Per la ricetta DPCM servono utente, password e PIN RUPAR (V06, 3.1.1) (simulato)',
      };
    return authShapeProblem(auth);
  }

  /**
   * «invioTelematicoSanita» (6.1.1): compone il file con la cifratura simulata, poi lo legge come il
   * SAR: nome del file, zip, XML, NRE del lotto del medico. Ricevuta con un protocollo di 23 cifre
   * che comincia con «99», riconoscibile come simulato.
   */
  sendDpcm(
    input: { prescription: DpcmPrescription; fileName: string },
    auth: ServiceAuth,
  ): Promise<DpcmReceipt> {
    const problem = this.dpcmAuthProblem(auth);
    const reject = (code: string, message: string, authProblem?: 'credentials') =>
      Promise.resolve<DpcmReceipt>({
        outcome: 'rejected',
        code,
        message,
        ...(authProblem ? { authProblem } : {}),
        raw: { simulatore: this.system, codiceEsito: code },
      });
    if (problem) return reject(problem.code, problem.message, 'credentials');
    const decided = this.options.decideDpcmReceipt?.(input.prescription) ?? 'accepted';
    if (decided === 'unreachable')
      return Promise.resolve({
        outcome: decided,
        message: `${this.label()} non raggiungibile (simulato)`,
      });
    if (decided === 'timeout')
      return Promise.resolve({
        outcome: decided,
        message: `${this.label()}: nessuna risposta in tempo (simulato)`,
      });
    if (decided === 'rejected')
      return reject(
        '200',
        "il file non è stato accolto perché c'è un errore nell'applicazione ed è necessario contattare l'assistenza (simulato)",
      );
    if (input.fileName.length < 6 || input.fileName.length > 60)
      return reject(
        '101',
        "il campo 'nomeFileAllegato' deve essere di almeno 6 caratteri: il file non è stato accolto",
      );
    let xml: string;
    try {
      const { zip } = dpcmPackage(input.prescription, {
        pinCode: auth?.pin ?? '',
        crypto: SIMULATED_DPCM_CRYPTO,
        xmlName: input.fileName.replace(/\.zip$/, '.xml'),
      });
      const files = Object.values(unzipSync(zip));
      if (files.length !== 1)
        return reject('103', 'il file non è stato accolto perché l’allegato è vuoto');
      xml = strFromU8(files[0]!);
    } catch (err) {
      return reject('SIM-STRUTTURA', `File della ricetta non valido (simulato): ${String(err)}`);
    }
    const read = this.readDpcm(xml);
    if (typeof read === 'string') return reject('SIM-STRUTTURA', read);
    const nreProblem = this.nreProblem(read.nre, read.doctorFiscalCode);
    if (nreProblem) return reject(nreProblem.code, nreProblem.message);
    this.issued.set(read.nre, { cancelled: false });
    this.dpcmFiles.push({ fileName: input.fileName, xml });
    this.dpcmCounter += 1;
    const protocol = `99${String(this.dpcmCounter).padStart(21, '0')}`;
    const acceptedAt = this.options.now?.() ?? new Date();
    // L'avviso 2090 del manuale dei codici (DPCM 26.3.2008): ricetta ricevuta dopo il giorno di
    // compilazione; non si corregge.
    const late = romeDate(acceptedAt) > input.prescription.compiledAt;
    const result = this.options.decideDpcm?.(input.prescription) ?? {
      state: late ? 3 : 2,
      errors: late
        ? [
            {
              code: '2090',
              description: 'Avviso: Data compilazione precedente alla data di ricezione',
            },
          ]
        : [],
    };
    this.dpcm.set(protocol, {
      prescription: input.prescription,
      xml,
      acceptedAt,
      checks: 0,
      result: { state: result.state, errors: result.errors ?? [] },
    });
    return Promise.resolve({
      outcome: 'accepted',
      protocol,
      acceptedAt: acceptedAt.toISOString(),
      size: xml.length,
      raw: { simulatore: this.system, protocolloSAC: protocol, codiceEsito: '000' },
    });
  }

  /** I campi che il simulatore controlla, letti dal file come farebbe il SAR. */
  private readDpcm(xml: string): { nre: string; doctorFiscalCode: string } | string {
    const doc = new DOMParser().parseFromString(xml, 'text/xml');
    const one = (name: string) => doc.getElementsByTagName(name)[0]?.textContent ?? '';
    if (one('TipoInvio') !== 'RPS') return 'TipoInvio diverso da «RPS» (V06, 4.2.1) (simulato)';
    if (!/^\d{5}$/.test(one('Bar1')) || !/^\d{10}$/.test(one('Bar2')))
      return 'Bar1 e Bar2 senza il numero del Poligrafico (simulato)';
    if (!decryptSimulated(one('CodiceAss')) || !decryptSimulated(one('PinCode')))
      return 'Codice fiscale dell’assistito o PIN non cifrati (V06, 3.1.2) (simulato)';
    return { nre: one('Ricetta1'), doctorFiscalCode: one('Ricetta2') };
  }

  /** «elencoSintetico» per protocollo (6.4): la prima lettura dice «in attesa», poi lo stato. */
  dpcmSummary(input: { protocol: string }, auth: ServiceAuth): Promise<DpcmSummaryResult> {
    const problem = this.dpcmAuthProblem(auth);
    if (problem)
      return Promise.resolve({
        outcome: 'rejected',
        ...problem,
        authProblem: 'credentials',
        raw: { simulatore: this.system },
      });
    const r = this.dpcm.get(input.protocol);
    if (!r)
      return Promise.resolve({
        outcome: 'rejected',
        code: 'SIM-PROTOCOLLO',
        message: `Protocollo ${input.protocol} sconosciuto (simulato)`,
        raw: { simulatore: this.system },
      });
    const pending = this.options.dpcmPendingChecks ?? 1;
    const state: DpcmSendState = r.checks < pending ? 1 : r.result.state;
    r.checks += 1;
    return Promise.resolve({
      outcome: 'ok',
      state,
      raw: { simulatore: this.system, protocolloSac: input.protocol, statoInvio: state },
    });
  }

  /** «elencoAnalitico» per protocollo (6.5): il codice a barre della ricetta e i messaggi. */
  dpcmAnalytic(input: { protocol: string }, auth: ServiceAuth): Promise<DpcmAnalyticResult> {
    const problem = this.dpcmAuthProblem(auth);
    if (problem)
      return Promise.resolve({
        outcome: 'rejected',
        ...problem,
        authProblem: 'credentials',
        raw: { simulatore: this.system },
      });
    const r = this.dpcm.get(input.protocol);
    if (!r)
      return Promise.resolve({
        outcome: 'rejected',
        code: 'SIM-PROTOCOLLO',
        message: `Protocollo ${input.protocol} sconosciuto (simulato)`,
        raw: { simulatore: this.system },
      });
    const record = {
      protocol: input.protocol,
      acceptedAt: r.acceptedAt.toISOString(),
      barcode: `${r.prescription.bar1}${r.prescription.bar2}`,
      errors: r.result.errors,
    };
    return Promise.resolve({
      outcome: 'ok',
      records: [record],
      raw: { simulatore: this.system, ...record },
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
