import { checkFiscalCode, nreLotPrefix, splitNre, type NreLotCode } from '@mmg/domain';
import {
  decryptSimulated,
  dpcmPackage,
  SIMULATED_DPCM_CRYPTO,
  SimulatedGateway,
  type DpcmAnalyticResult,
  type DpcmPrescription,
  type DpcmReceipt,
  type DpcmSendState,
  type DpcmServices,
  type DpcmSummaryResult,
  type LotResult,
  type PrescriptionGateway,
  type PrescriptionMessage,
  type RegionalNreLots,
  type RegionalPrescriptionGateway,
  type ServiceAuth,
  type SimulatedOutcome,
  type SimulatedRefusal,
  type SimulatedValidity,
  type SimulatorOptions,
} from '@mmg/integrations';
import { DOMParser } from '@xmldom/xmldom';
import { strFromU8, unzipSync } from 'fflate';
import { REGIONAL_SOFTWARE_ID } from './gestionale';
import { DPCM_SEND_TYPE, SAR_LOT_TYPE, sarPrescription, sarShapeProblem } from './sar';

export interface SarSimulatorOptions extends SimulatorOptions {
  /**
   * Catalogo regionale che la Regione ha trasmesso al Sistema TS (D154): il SAR controlla la coppia
   * «codice del nomenclatore – codice del catalogo» di ogni prestazione e rifiuta quelle che non
   * conosce. Senza, il simulatore accetta ogni coppia.
   */
  regionalCatalog?: (nationalCode: string | null, catalogCode: string | null) => boolean;
  /** Accesso regionale con SPID o CIE: se c'è, il token deve essere valido per quel simulatore. */
  oauth?: SimulatedValidity;
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

/** Il giorno a Roma, come la data di compilazione della ricetta: il SAR è in Piemonte. */
const romeDate = (d: Date) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(d);

/**
 * Simulatore del SAR della Regione Piemonte (SIRPED, «Cartelle cliniche MMG e PLS», V06 del
 * 10/04/2026; accesso con SPID o CIE, REL-STC-01 V08): il simulatore nazionale delle ricette, con i
 * servizi e i controlli del SAR (D300).
 *
 * - Lotti di NRE (V06, 4.1; D269): «estratti» come nell'esempio della V06, con l'identificativo 4
 *   del lotto del SAR e un codice di 6 cifre. Il raggruppamento è «ZZ», per riconoscerli come
 *   simulati. Il simulatore ricorda a quale medico ha dato ogni lotto; i codici partono da un
 *   numero a caso, perché dopo un riavvio non ridia un lotto che il database ha già.
 * - Ricetta con l'NRE della cartella: l'NRE dev'essere di un lotto del medico che firma e non
 *   ancora usato da una ricetta accettata; dopo un rifiuto si può rimandare (4.3.1, caso 3). Un
 *   lotto «ZZ» che non ricorda l'ha dato prima di un riavvio: lo accetta, senza sapere di chi è.
 * - Ricetta senza NRE: il simulatore ne dà uno di fantasia, riconoscibile dal prefisso «SIM».
 * - Ricetta rossa in DPCM (V06, 4.2): ricevuta, elenco sintetico ed elenco analitico.
 */
export class SimulatedSar extends SimulatedGateway implements RegionalNreLots, DpcmServices {
  /** Codice dell'ultimo lotto dato: parte da un numero a caso (vedi sopra). */
  private lotCounter = Math.floor(Math.random() * 1_000_000);
  /** Lotti dati: inizio comune dei 1000 NRE → codice fiscale del medico. */
  private readonly lots = new Map<string, string>();
  /** Richieste del lotto ricevute, per le prove. */
  readonly lotRequests: { regionCode: string; lotType: string; doctorFiscalCode: string }[] = [];
  /** Ricette DPCM accolte, per protocollo. */
  private readonly dpcm = new Map<string, ReceivedDpcm>();
  private dpcmCounter = 0;
  /** File DPCM ricevuti, per le prove: nome e XML letto dallo zip. */
  readonly dpcmFiles: { fileName: string; xml: string }[] = [];

  constructor(private readonly sar: SarSimulatorOptions = {}) {
    super('regional', sar, 'SAR');
  }

  /** Le credenziali mancanti come le rifiuta il SAR (3.1.1 e 4). */
  protected override shapeProblem(auth: ServiceAuth): { code: string; message: string } | null {
    return sarShapeProblem(auth);
  }

  protected override bearerRefusal(auth: ServiceAuth): SimulatedRefusal | null {
    // Il token dell'accesso con SPID o CIE della Regione (V08, 4.3.6).
    if (this.sar.oauth && !this.sar.oauth.isValid(auth.bearer))
      return {
        outcome: 'rejected',
        code: 'TOKEN',
        message: 'Token dell’accesso regionale non valido, scaduto o revocato (simulato)',
        authProblem: 'session',
        raw: { simulatore: this.system, esito: 'token' },
      };
    return null;
  }

  protected override extraAuthRefusal(auth: ServiceAuth): SimulatedRefusal | null {
    // Con l'Id-Sessione per email il SAR vuole X-Gestionale: codice del gestionale, «_» e codice
    // ASL del medico (REL-STC-01 V08, 4.2.5). Il Sistema TS no.
    if (!REGIONAL_SOFTWARE_ID.test(auth.software ?? ''))
      return {
        outcome: 'rejected',
        code: 'GESTIONALE',
        message: 'X-Gestionale mancante o non valido (simulato)',
        raw: { simulatore: this.system, esito: 'X-Gestionale' },
      };
    return null;
  }

  protected override messageRefusal(message: PrescriptionMessage): SimulatedRefusal | null {
    const unknown =
      message.kind === 'specialist_ssn' && this.sar.regionalCatalog
        ? message.lines.find(
            (l) => !this.sar.regionalCatalog!(l.serviceNationalCode ?? null, l.serviceCode ?? null),
          )
        : undefined;
    if (unknown)
      return {
        outcome: 'rejected',
        code: 'SIM-CAT',
        message: `Prestazione ${unknown.serviceCode ?? ''}: la coppia di codici nomenclatore ${unknown.serviceNationalCode ?? '—'} e catalogo ${unknown.serviceCode ?? '—'} non è nel catalogo regionale (simulato)`,
        raw: { simulatore: this.system, esito: 'codice non in catalogo' },
      };
    if (message.nre) {
      const problem = this.nreProblem(message.nre, message.doctor.fiscalCode ?? null);
      if (problem)
        return {
          outcome: 'rejected',
          code: problem.code,
          message: problem.message,
          raw: { simulatore: this.system, esito: 'NRE', nre: message.nre },
        };
    }
    return null;
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
    // Solo utente, password e PIN RUPAR (V06, 3.1.1): né il token né il secondo fattore.
    if (auth?.bearer)
      return reject(
        'CREDENZIALI',
        'Per il lotto di NRE servono utente, password e PIN RUPAR (V06, 3.1.1) (simulato)',
        'credentials',
      );
    const shape = sarShapeProblem(auth);
    if (shape) return reject(shape.code, shape.message, 'credentials');
    const decided = this.sar.decideLot?.(input) ?? 'accepted';
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
    if (input.lotType !== SAR_LOT_TYPE)
      return reject('03', 'Inserire un identificativo lotto valido');
    if (!input.regionCode.trim()) return reject('04', 'Inserire il codice regione');
    if (input.regionCode !== '010') return reject('05', 'Inserire un codice regione valido');
    if (!checkFiscalCode(input.doctorFiscalCode).valid)
      return reject(
        '06',
        'Inserire il codice fiscale del medico valido e/o facente parte della regione',
      );
    // Lotto «estratto»: identificativo del lotto del SAR (4) e codice di 6 cifre (V06, 4.1).
    this.lotCounter = (this.lotCounter + 1) % 1_000_000;
    const lot: NreLotCode = {
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
    if (auth?.bearer)
      return {
        code: 'CREDENZIALI',
        message: 'Per la ricetta DPCM servono utente, password e PIN RUPAR (V06, 3.1.1) (simulato)',
      };
    return sarShapeProblem(auth);
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
    const decided = this.sar.decideDpcmReceipt?.(input.prescription) ?? 'accepted';
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
        sendType: DPCM_SEND_TYPE,
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
    const acceptedAt = this.sar.now?.() ?? new Date();
    // L'avviso 2090 del manuale dei codici (DPCM 26.3.2008): ricetta ricevuta dopo il giorno di
    // compilazione; non si corregge.
    const late = romeDate(acceptedAt) > input.prescription.compiledAt;
    const result = this.sar.decideDpcm?.(input.prescription) ?? {
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
    if (one('TipoInvio') !== DPCM_SEND_TYPE)
      return `TipoInvio diverso da «${DPCM_SEND_TYPE}» (V06, 4.2.1) (simulato)`;
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
    const pending = this.sar.dpcmPendingChecks ?? 1;
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
}

/**
 * Il SAR simulato come servizio delle ricette della regione (D300). Con `gateway` (le prove, o un
 * adattatore dato dalla configurazione) si usa quello, con le parole e le scelte del SAR.
 */
export function simulatedSarPrescription(
  options: SarSimulatorOptions & { gateway?: PrescriptionGateway } = {},
): RegionalPrescriptionGateway {
  const { gateway, ...simulator } = options;
  return sarPrescription(gateway ?? new SimulatedSar(simulator));
}
