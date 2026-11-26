/**
 * Ricetta rossa in modalità DPCM (D270): il file che la cartella manda al servizio della regione
 * con «invioTelematicoSanita», e gli esiti che legge con «elencoSintetico» ed «elencoAnalitico».
 *
 * Fonti:
 * - Sistema TS, «Collegamento telematico in rete dei medici», versione 11 del 1/3/2016, 6.1 (invio
 *   e ricevuta), 6.1.2 (schema dati della ricetta), 6.4 e 6.5 (elenchi degli esiti);
 * - Sistema TS, «WSDL e schemi XSD» del 5/9/2011, 3.1 (RicettaMIR.xsd, versione 2.1) e 3.2
 *   (TipiDatiMIR.xsd, versione 1.0.7): ordine degli elementi, lunghezze e valori ammessi.
 *
 * Come la regione vuole i campi (tipo di invio, Bar1 e Bar2 con il numero del Poligrafico,
 * Ricetta1 con l'NRE, PinCode e codice fiscale dell'assistito cifrati con il certificato del suo
 * servizio, Prescrizione2 con catalogo e tipo di accesso) lo dice il pacchetto della regione, che
 * attua i servizi e il loro simulatore (regola 7). Qui il file e le interfacce.
 */

import { strToU8, zipSync } from 'fflate';
import type { ServiceAuth, AuthProblem } from './service-auth';

/** Una riga della ricetta (elemento Prescrizione, al più 20 per ricetta). */
export interface DpcmLine {
  /** CodProdPrest: AIC del farmaco o codice della prestazione del tariffario regionale (≤ 9). */
  productCode?: string | null;
  /**
   * DescrProdPrest: per la farmaceutica il codice del gruppo di equivalenza, per la specialistica
   * la descrizione della prestazione (6.1.2).
   */
  description?: string | null;
  /** NotaProd: nota AIFA, solo farmaceutica (≤ 3). */
  aifaNote?: string | null;
  /** Quantita: confezioni o prestazioni (1–999). */
  quantity: number;
  /**
   * Prescrizione1: per il farmaco il codice della motivazione di non sostituibilità; per la
   * specialistica le indicazioni di appropriatezza «#nota-condizione-appropriatezza-patologia#».
   */
  prescription1?: string | null;
  /** Prescrizione2: «CODCATPRESCR=<codice>$TIPOACC=<tipo>$» per la specialistica (V06, 4.2.1). */
  prescription2?: string | null;
}

/** La ricetta da mandare in inserimento (RicettaI). I dati in chiaro: la cifratura è a parte. */
export interface DpcmPrescription {
  /** Bar1 e Bar2: il numero del Poligrafico del modulo stampato (V06, 4.2.1). */
  bar1: string;
  bar2: string;
  /** CodiceAss: codice fiscale dell'assistito, da cifrare. */
  patientFiscalCode: string;
  /** TipoPrescrizione: F farmaceutica, P specialistica. */
  kind: 'F' | 'P';
  /** CodEsenzione (≤ 6). */
  exemptionCode?: string | null;
  /** NonEsente: casella «N» biffata. */
  notExempt?: boolean;
  /** Reddito: casella «R» biffata. */
  incomeExempt?: boolean;
  /** CodiceDiagnosi (ICD-9-CM, ≤ 7) o DescrizioneDiagnosi: per la specialistica uno dei due. */
  diagnosisCode?: string | null;
  diagnosisText?: string | null;
  /** DataCompilazione, aaaa-mm-gg. */
  compiledAt: string;
  /** TipoVisita: A ambulatoriale, D domiciliare. */
  visitType: 'A' | 'D';
  /** ProvAssistito (2) e AslAssistito (3), insieme o nessuno dei due. */
  patientProvince?: string | null;
  patientAsl?: string | null;
  /** IndicazionePrescr: S suggerita, H ricovero, A altro. */
  indication?: 'S' | 'H' | 'A' | null;
  /** ClassePriorita: U, B, D, P. */
  priority?: 'U' | 'B' | 'D' | 'P' | null;
  /** Ricetta1: l'NRE preso dal lotto del medico (V06, 4.2.1). */
  nre: string;
  /** Ricetta2: codice fiscale del medico, in chiaro (6.1.2). */
  doctorFiscalCode: string;
  lines: DpcmLine[];
}

/** Come si cifrano PinCode e codice fiscale dell'assistito (V06, 3.1.2). */
export interface DpcmCrypto {
  encrypt(value: string): string;
}

/**
 * Cifratura del simulatore: il valore in base64 con un prefisso che lo dice. La cifratura vera usa
 * la chiave pubblica del certificato che la Regione dà ai fornitori; non c'è ancora (V06, 3.1.2).
 */
export const SIMULATED_DPCM_CRYPTO: DpcmCrypto = {
  encrypt: (value) => `SIM-CIFRATO:${btoa(value)}`,
};

/** Il valore cifrato dal simulatore, in chiaro; null se non lo è. */
export function decryptSimulated(value: string): string | null {
  const m = /^SIM-CIFRATO:(.+)$/.exec(value);
  if (!m) return null;
  try {
    return atob(m[1]!);
  } catch {
    return null;
  }
}

/**
 * Solo caratteri «BasicLatin» (da U+0000 a U+007F): è il dominio di quasi tutti i tipi dello schema
 * (TipiDatiMIR.xsd, `\p{IsBasicLatin}`). Le lettere accentate perdono l'accento, gli apostrofi e le
 * virgolette tipografiche diventano quelli semplici; a capo e tabulazioni diventano uno spazio, così
 * le parole restano separate; il resto si toglie.
 */
export function toBasicLatin(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\s+/g, ' ')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”«»]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[^ -~]/g, '');
}

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Un elemento con il testo ripulito e tagliato alla lunghezza massima; vuoto non si scrive. */
function element(name: string, value: string | number | null | undefined, max: number): string {
  if (value === null || value === undefined) return '';
  const text = toBasicLatin(String(value)).slice(0, max);
  if (text === '') return '';
  return `<${name}>${escapeXml(text)}</${name}>`;
}

/** Che cosa non va nella ricetta per lo schema, o null: controlli prima di comporre il file. */
export function dpcmPrescriptionProblem(p: DpcmPrescription): string | null {
  if (!/^\d{5}$/.test(p.bar1) || !/^\d{10}$/.test(p.bar2))
    return 'Il numero del Poligrafico non è nella forma di Bar1 (5 cifre) e Bar2 (10 cifre)';
  if (p.lines.length === 0) return 'La ricetta non ha righe';
  if (p.lines.length > 20) return 'Una ricetta ha al più 20 righe (RicettaMIR.xsd)';
  for (const l of p.lines)
    if (!Number.isInteger(l.quantity) || l.quantity < 1 || l.quantity > 999)
      return `Quantità ${l.quantity}: va da 1 a 999 (TipiDatiMIR.xsd, integer3)`;
  const total = p.lines.reduce((n, l) => n + l.quantity, 0);
  if (total > 999) return `Totale di ${total} pezzi: al più 999 (TotPezzi, integer3)`;
  if (p.kind === 'P' && !p.diagnosisCode?.trim() && !p.diagnosisText?.trim())
    return 'Per la specialistica servono il codice o la descrizione della diagnosi o del sospetto diagnostico (6.1.2)';
  if (p.kind === 'P' && p.lines.some((l) => !l.productCode?.trim()))
    return 'Per la specialistica il codice della prestazione è sempre obbligatorio (6.1.2)';
  if (!!p.patientProvince !== !!p.patientAsl)
    return 'Provincia e ASL dell’assistito vanno insieme (6.1.2)';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.compiledAt)) return 'Data di compilazione non valida';
  return null;
}

/** La riga Prescrizione, nell'ordine dello schema. */
function lineXml(l: DpcmLine): string {
  return [
    '<Prescrizione>',
    element('CodProdPrest', l.productCode, 9),
    element('DescrProdPrest', l.description, 256),
    element('NotaProd', l.aifaNote, 3),
    element('Quantita', l.quantity, 3),
    element('Prescrizione1', l.prescription1, 256),
    element('Prescrizione2', l.prescription2, 256),
    '</Prescrizione>',
  ].join('');
}

/**
 * Il file XML con una ricetta in inserimento (RicetteMIR, Testata e RicettaI), nell'ordine degli
 * elementi di RicettaMIR.xsd v2.1. PinCode e codice fiscale dell'assistito passano da `crypto`.
 */
export function dpcmInsertXml(
  p: DpcmPrescription,
  input: { pinCode: string; crypto: DpcmCrypto; sendType: string },
): string {
  const problem = dpcmPrescriptionProblem(p);
  if (problem) throw new Error(problem);
  const total = p.lines.reduce((n, l) => n + l.quantity, 0);
  const ricetta = [
    '<RicettaI>',
    element('Bar1', p.bar1, 5),
    element('Bar2', p.bar2, 10),
    element('CodiceAss', input.crypto.encrypt(p.patientFiscalCode), 256),
    element('TipoPrescrizione', p.kind, 1),
    element('CodEsenzione', p.exemptionCode, 6),
    p.notExempt ? element('NonEsente', '1', 1) : '',
    p.incomeExempt ? element('Reddito', '1', 1) : '',
    element('CodiceDiagnosi', p.diagnosisCode, 7),
    element('DescrizioneDiagnosi', p.diagnosisText, 256),
    element('TotPezzi', total, 3),
    element('DataCompilazione', p.compiledAt, 10),
    element('TipoVisita', p.visitType, 1),
    element('ProvAssistito', p.patientProvince, 2),
    element('AslAssistito', p.patientAsl, 3),
    element('IndicazionePrescr', p.indication, 1),
    element('ClassePriorita', p.priority, 1),
    element('Ricetta1', p.nre, 256),
    element('Ricetta2', p.doctorFiscalCode, 256),
    ...p.lines.map(lineXml),
    '</RicettaI>',
  ].join('');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<RicetteMIR>',
    '<Testata>',
    element('PinCode', input.crypto.encrypt(input.pinCode), 256),
    element('TipoInvio', input.sendType, 3),
    '</Testata>',
    ricetta,
    '</RicetteMIR>',
  ].join('');
}

/**
 * Nome del file allegato: da 6 a 60 lettere e cifre, con la denominazione di chi produce il
 * programma (al più 10 caratteri) dopo «_» e prima di «.zip» (6.1.1). Per esempio
 * «fileperilmef02ago2011_SOCIETAPIPPO4.zip».
 */
export function dpcmFileName(base: string, producer: string): string {
  const clean = (s: string) => toBasicLatin(s).replace(/[^A-Za-z0-9]/g, '');
  const who = clean(producer).toUpperCase().slice(0, 10);
  const stem = clean(base).slice(0, 60 - who.length - 5);
  return `${stem}_${who}.zip`;
}

/**
 * Il pacchetto da allegare (6.1): un solo file compresso in formato zip, al più 1 MB per i medici,
 * con il file XML della ricetta. Data fissa nello zip: lo stesso contenuto dà gli stessi byte.
 */
export function dpcmPackage(
  p: DpcmPrescription,
  input: { pinCode: string; crypto: DpcmCrypto; sendType: string; xmlName: string },
): { xml: string; zip: Uint8Array } {
  const xml = dpcmInsertXml(p, input);
  const zip = zipSync(
    { [input.xmlName]: [strToU8(xml), { mtime: new Date('2001-01-01T00:00:00Z') }] },
    { level: 9 },
  );
  if (zip.length > DPCM_MAX_BYTES) throw new Error('Il file della ricetta supera 1 MB (6.1.1)');
  return { xml, zip };
}

/** Dimensione massima del file allegato per i medici: 1 MB (6.1.1; V06, 3.4.2). */
export const DPCM_MAX_BYTES = 1024 * 1024;

/** Ricevuta di accoglienza (6.1.1): protocollo di 23 cifre e codice 000, o il motivo. */
export type DpcmReceipt =
  | { outcome: 'accepted'; protocol: string; acceptedAt: string; size: number; raw: unknown }
  | {
      outcome: 'rejected';
      /** 101, 102, 103, 200 (6.1.1) o, per le credenziali, quelli del servizio. */
      code: string;
      message: string;
      authProblem?: AuthProblem;
      raw: unknown;
    }
  | { outcome: 'unreachable'; message: string }
  | { outcome: 'timeout'; message: string };

/** Stato dell'invio nell'elenco sintetico (6.4). */
export type DpcmSendState =
  /** File in attesa di elaborazione. */
  | 1
  /** Elaborato correttamente, senza errori. */
  | 2
  /** Elaborato con avvisi. */
  | 3
  /** Elaborato con errori scartanti. */
  | 4
  /** Completamente scartato. */
  | 5;

export type DpcmSummaryResult =
  | { outcome: 'ok'; state: DpcmSendState; raw: unknown }
  | { outcome: 'rejected'; code: string; message: string; authProblem?: AuthProblem; raw: unknown }
  | { outcome: 'unreachable'; message: string }
  | { outcome: 'timeout'; message: string };

/** Esito dei controlli di una ricetta (6.5): codice a barre e messaggi. */
export interface DpcmAnalyticRecord {
  protocol: string;
  acceptedAt: string;
  /** codRicetta: il codice a barre della ricetta. */
  barcode: string;
  errors: { code: string; description: string }[];
}

export type DpcmAnalyticResult =
  | { outcome: 'ok'; records: DpcmAnalyticRecord[]; raw: unknown }
  | { outcome: 'rejected'; code: string; message: string; authProblem?: AuthProblem; raw: unknown }
  | { outcome: 'unreachable'; message: string }
  | { outcome: 'timeout'; message: string };

/**
 * I servizi DPCM del servizio della regione: invio del file e lettura degli esiti per protocollo,
 * con le credenziali che vuole la regione.
 */
export interface DpcmServices {
  /**
   * Compone il file della ricetta (con la cifratura del servizio e il PIN delle credenziali) e lo
   * manda. Una ricetta per file.
   */
  sendDpcm(
    input: { prescription: DpcmPrescription; fileName: string },
    auth: ServiceAuth,
  ): Promise<DpcmReceipt>;
  dpcmSummary(input: { protocol: string }, auth: ServiceAuth): Promise<DpcmSummaryResult>;
  dpcmAnalytic(input: { protocol: string }, auth: ServiceAuth): Promise<DpcmAnalyticResult>;
}

/** Il servizio sa anche ricevere le ricette DPCM? */
export function isDpcmServices(gateway: unknown): gateway is DpcmServices {
  const g = gateway as Partial<DpcmServices> | null;
  return (
    typeof g?.sendDpcm === 'function' &&
    typeof g.dpcmSummary === 'function' &&
    typeof g.dpcmAnalytic === 'function'
  );
}
