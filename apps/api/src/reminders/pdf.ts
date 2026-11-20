import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import { printDocumentKind, type PaperSize } from '@mmg/domain';
import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import { code39Bars } from './code39';
import {
  OBSCURED_TEXT,
  OBSCURED_TEXT_2024,
  PRIORITY_TEXT,
  TYPOLOGY_TEXT,
  type PromemoriaData,
  type PromemoriaDataV1,
  type PromemoriaDataV2,
} from './promemoria';

/** Millimetri in punti PDF. */
const MM = 72 / 25.4;
/**
 * Versione 1. Modulo del codice a barre: 4/300 di pollice, 0,339 mm, sopra il minimo di 0,240 mm
 * del decreto. Con una stampante a 300 o 600 punti per pollice stretto e largo (2,5 moduli) cadono
 * su punti interi. Lo spazio tra i caratteri è un modulo, sotto il massimo di 1,2 mm.
 */
export const BARCODE_MODULE_MM = (25.4 * 4) / 300;
/** Versione 1: barre alte 10 mm; il minimo del decreto è 7,5 mm. */
export const BARCODE_HEIGHT_MM = 10;
/**
 * Versione 2 (specifiche di stampa del 28/02/2024, D217). Modulo di 1/100 di pollice, 0,254 mm:
 * sopra il minimo di 0,240 mm del DM 2/11/2011 e abbastanza stretto perché il codice fiscale stia
 * nello spazio che il modello gli dà accanto al nome (66 mm). A 600 punti per pollice stretto e
 * largo (2,5 moduli) cadono su punti interi (6 e 15); a 300 lo stretto è di 3 punti.
 */
export const BARCODE_MODULE_MM_2024 = 25.4 / 100;
/** Versione 2: l'altezza del codice deve essere di 8 mm (campi 2 e 9). */
export const BARCODE_HEIGHT_MM_2024 = 8;
/**
 * Il promemoria deve avere formato pari alla metà di un foglio A4: una pagina A5 orizzontale
 * oppure, per le stampanti senza A5, la metà alta di una pagina A4 (D222).
 */
export const HALF_A4_MM = 297 / 2;

const A4: [number, number] = [595.28, 841.89];
/** A5 orizzontale (ISO 216): 210 × 148 mm. Il modello del 2024 finisce a 146 mm dall'alto. */
const A5_LANDSCAPE: [number, number] = [595.28, 419.53];
/** Carta del promemoria senza preferenza: quella dei tipi di documento da stampare (A5, D222). */
export const DEFAULT_REMINDER_PAPER: PaperSize = printDocumentKind('promemoria').defaultPaper!;
const LEFT = 40;
const RIGHT = A4[0] - 40;

interface Fonts {
  regular: PDFFont;
  /** NRE e codice fiscale in chiaro sotto i codici a barre: OCR-A, come chiede il decreto (D211). */
  code: PDFFont;
}
/** Versione 1: etichette in grassetto. */
interface FontsV1 extends Fonts {
  bold: PDFFont;
}
/** Versione 2: la dicitura in corsivo, come nel facsimile. */
interface Fonts2024 extends Fonts {
  italic: PDFFont;
}

/**
 * Carattere OCR-A (ANSI X3.17-1977) di John Sauter, di pubblico dominio, dal pacchetto Debian
 * `fonts-ocr-a` 1.0-10: file, impronta e provenienza in `apps/api/caratteri/ocr-a/` (D211). Si
 * incorpora nel PDF, solo con i caratteri usati; niente si scarica da fuori (regola 8).
 */
export const OCR_A_FILE = join(import.meta.dirname, '..', '..', 'caratteri', 'ocr-a', 'OCRA.ttf');
let ocrA: Uint8Array | undefined;
const ocrABytes = () => (ocrA ??= readFileSync(OCR_A_FILE));

/** Testo che il carattere sa scrivere: i simboli fuori dal suo insieme diventano «?». */
function safe(font: PDFFont, text: string): string {
  const set = new Set(font.getCharacterSet());
  return [...text].map((c) => (set.has(c.codePointAt(0)!) ? c : '?')).join('');
}

/** Righe che stanno nella larghezza data, spezzate tra le parole. */
function wrap(font: PDFFont, text: string, size: number, width: number): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of safe(font, text).split(/\s+/)) {
    const next = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(next, size) <= width || !current) current = next;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

/** La riga tagliata con «…» perché stia nella larghezza data. */
function clip(font: PDFFont, text: string, size: number, width: number): string {
  const t = safe(font, text);
  if (font.widthOfTextAtSize(t, size) <= width) return t;
  let out = t;
  while (out && font.widthOfTextAtSize(`${out}…`, size) > width) out = out.slice(0, -1);
  return `${out.trimEnd()}…`;
}

async function newDocument(title: string, created: string, size: [number, number] = A4) {
  const doc = await PDFDocument.create();
  const when = new Date(`${created}T12:00:00Z`);
  doc.setTitle(title);
  doc.setCreationDate(when);
  doc.setModificationDate(when);
  doc.setProducer('Cartella clinica');
  const page = doc.addPage(size);
  doc.registerFontkit(fontkit);
  return { doc, page };
}

/** I caratteri nell'ordine di sempre: con gli stessi dati, lo stesso PDF byte per byte. */
async function fontsV1(doc: PDFDocument): Promise<FontsV1> {
  return {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    code: await doc.embedFont(ocrABytes(), { subset: true }),
  };
}

async function fonts2024(doc: PDFDocument): Promise<Fonts2024> {
  return {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    italic: await doc.embedFont(StandardFonts.HelveticaOblique),
    code: await doc.embedFont(ocrABytes(), { subset: true }),
  };
}

const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/**
 * Il promemoria completo della ricetta SSN, dai dati fissati all'invio, nella loro versione. La
 * carta vale per il modello del 2024; la versione 1 si ristampa com'era, su A4.
 */
export async function renderPromemoria(
  d: PromemoriaData,
  paper: PaperSize = DEFAULT_REMINDER_PAPER,
): Promise<Uint8Array> {
  return d.versione === 1 ? renderPromemoriaV1(d) : renderPromemoria2024(d, paper);
}

/**
 * Il foglio con il solo numero di ricetta: NRE e codice fiscale, a barre e in chiaro, con il
 * codice di autenticazione, che va su ogni documento consegnato al paziente.
 */
export async function renderSoloNre(
  d: PromemoriaData,
  paper: PaperSize = DEFAULT_REMINDER_PAPER,
): Promise<Uint8Array> {
  return d.versione === 1 ? renderSoloNreV1(d) : renderSoloNre2024(d, paper);
}

/** La pagina del modello del 2024 per la carta scelta. */
const pageFor = (paper: PaperSize): [number, number] => (paper === 'A5' ? A5_LANDSCAPE : A4);

// ---------------------------------------------------------------------------------------------
// Versione 2: specifiche di stampa del promemoria del Sistema TS, 28/02/2024 (D217).
// ---------------------------------------------------------------------------------------------

/** Margini e colonne del modello, in millimetri dal bordo sinistro della pagina. */
const M = {
  left: 8,
  right: 202,
  /** Fine del riquadro 1 (Regione), inizio del riquadro 2 (NRE). */
  box1: 66,
  /** Colonne QTA e NOTA della tabella delle prescrizioni. */
  qty: 172,
  note: 187,
} as const;

/** Righe del modello, in millimetri dal bordo alto: le posizioni non cambiano mai (2.1). */
const ROW = {
  header: 7,
  boxTop: 8.2,
  boxBottom: 22.7,
  name: 26.6,
  address: 34.6,
  foreign: 38.3,
  rule: 39.9,
  exemption: 42.8,
  typology: 46.2,
  tableTop: 47.6,
  tableHead: 52,
  /** Fine dell'area delle prescrizioni: la massima estensione del facsimile nr. 0. */
  tableBottom: 123.5,
  diagnosis: 127,
  totals: 134,
  auth: 137.6,
  release: 141.2,
  regional: 144.8,
} as const;

const LABEL = 7;
const VALUE = 8;
/** Carattere più piccolo per far stare un valore lungo: sotto non si legge più. */
const MIN_SIZE = 6;
/** NRE e codice fiscale in chiaro sotto le barre: OCR-A a 10 punti, come dal 20/11/2026 (D211). */
const CODE_TEXT = 10;

class Sheet {
  constructor(
    readonly page: PDFPage,
    readonly fonts: Fonts2024,
  ) {}

  /** Larghezza del testo in millimetri. */
  width(text: string, size: number, font = this.fonts.regular) {
    return font.widthOfTextAtSize(safe(font, text), size) / MM;
  }

  /** Testo con la base a `baseline` mm dall'alto; `x` è il bordo sinistro, il centro o il destro. */
  text(
    value: string,
    x: number,
    baseline: number,
    opts: { size?: number; font?: PDFFont; align?: 'left' | 'center' | 'right' } = {},
  ) {
    const size = opts.size ?? VALUE;
    const font = opts.font ?? this.fonts.regular;
    const t = safe(font, value);
    const w = font.widthOfTextAtSize(t, size) / MM;
    const left = opts.align === 'center' ? x - w / 2 : opts.align === 'right' ? x - w : x;
    this.page.drawText(t, {
      x: left * MM,
      y: this.page.getHeight() - baseline * MM,
      size,
      font,
      color: rgb(0, 0, 0),
    });
    return left + w;
  }

  /**
   * Il valore più grande che sta tra `x` e `right`, fino a MIN_SIZE; oltre, su più righe (al più
   * `lines`), e l'ultima tagliata con «…».
   */
  fitted(value: string, x: number, baseline: number, right: number, lines = 1, gap = 3) {
    const width = (right - x) * MM;
    const font = this.fonts.regular;
    for (let size: number = VALUE; size >= MIN_SIZE; size -= 0.25) {
      const rows = lines === 1 ? [safe(font, value)] : wrap(font, value, size, width);
      if (rows.length <= lines && rows.every((r) => font.widthOfTextAtSize(r, size) <= width)) {
        rows.forEach((r, i) => this.text(r, x, baseline + i * gap, { size }));
        return;
      }
    }
    const rows = wrap(font, value, MIN_SIZE, width);
    rows.slice(0, lines).forEach((r, i) => {
      const last = i === lines - 1 && rows.length > lines ? `${r} ${rows[lines]}` : r;
      this.text(clip(font, last, MIN_SIZE, width), x, baseline + i * gap, { size: MIN_SIZE });
    });
  }

  /** Etichetta del modello e, dopo, il valore; il valore resta vuoto se non c'è. */
  field(label: string, value: string | null, x: number, baseline: number, right: number) {
    const end = this.text(label, x, baseline, { size: LABEL });
    if (value) this.fitted(value, end + 1.2, baseline, right);
  }

  line(x1: number, y1: number, x2: number, y2: number, thickness = 0.6) {
    this.page.drawLine({
      start: { x: x1 * MM, y: this.page.getHeight() - y1 * MM },
      end: { x: x2 * MM, y: this.page.getHeight() - y2 * MM },
      thickness,
      color: rgb(0, 0, 0),
    });
  }

  box(x1: number, top: number, x2: number, bottom: number) {
    this.line(x1, top, x2, top);
    this.line(x1, bottom, x2, bottom);
    this.line(x1, top, x1, bottom);
    this.line(x2, top, x2, bottom);
  }

  /** Codice 39 alto 8 mm con il valore tra asterischi in OCR-A, centrato sotto. */
  barcode(value: string, x: number, top: number) {
    const height = BARCODE_HEIGHT_MM_2024;
    const { bars, width } = code39Bars(value, BARCODE_MODULE_MM_2024);
    for (const b of bars) {
      this.page.drawRectangle({
        x: (x + b.x) * MM,
        y: this.page.getHeight() - (top + height) * MM,
        width: b.width * MM,
        height: height * MM,
        color: rgb(0, 0, 0),
      });
    }
    this.text(`*${value}*`, x + width / 2, top + height + 3.4, {
      size: CODE_TEXT,
      font: this.fonts.code,
      align: 'center',
    });
    return width;
  }
}

/** Larghezza di un codice 39 del modello, in millimetri. */
const barcodeWidth = (value: string) => code39Bars(value, BARCODE_MODULE_MM_2024).width;

/**
 * Campo 2: l'NRE in due codici separati, il primo con la Regione (3 cifre) e il raggruppamento del
 * lotto (2), il secondo con il resto (identificativo del lotto, lotto e progressivo).
 */
export function nreParts(nre: string): [string, string] {
  return [nre.slice(0, 5), nre.slice(5)];
}

/** Intestazione, riquadri 1 e 2 e codice fiscale a barre (campo 9): comuni ai due fogli. */
function heading(s: Sheet, d: PromemoriaDataV2, title: string) {
  s.text('SERVIZIO SANITARIO NAZIONALE', M.left, ROW.header, { size: 9.5 });
  s.text(title, M.right, ROW.header, { size: 9.5, align: 'right' });
  s.box(M.left, ROW.boxTop, M.right, ROW.boxBottom);
  s.line(M.box1, ROW.boxTop, M.box1, ROW.boxBottom);
  // Campo 1: la Regione, in alto a sinistra nel riquadro.
  s.fitted(d.regione, M.left + 1.5, ROW.boxTop + 4, M.box1 - 1.5, 2, 3.6);
  // Campo 2: i due codici dell'NRE, centrati nel riquadro con 8 mm tra l'uno e l'altro.
  const [first, second] = nreParts(d.nre);
  const gap = 8;
  const total = barcodeWidth(first) + gap + barcodeWidth(second);
  const start = M.box1 + (M.right - M.box1 - total) / 2;
  const top = ROW.boxTop + 1.4;
  s.barcode(second, start + s.barcode(first, start, top) + gap, top);
  // Campo 9: il codice fiscale a barre, a destra delle righe 3–8, con il margine di quiete.
  const cf = d.assistito.codiceFiscale;
  const cfLeft = M.right - 2.6 - barcodeWidth(cf);
  s.barcode(cf, cfLeft, ROW.name - 2.4);
  return cfLeft - 2.6;
}

/** Il promemoria della ricetta SSN, modello del Sistema TS del 28/02/2024 (facsimile nr. 0). */
async function renderPromemoria2024(d: PromemoriaDataV2, paper: PaperSize): Promise<Uint8Array> {
  const { doc, page } = await newDocument(
    `Promemoria della ricetta ${d.nre}`,
    d.data,
    pageFor(paper),
  );
  const fonts = await fonts2024(doc);
  const s = new Sheet(page, fonts);
  const leftOfCf = heading(s, d, 'RICETTA ELETTRONICA – PROMEMORIA PER L’ASSISTITO');

  // Campi 3–8: se il paziente ha chiesto l'oscuramento, al loro posto la dicitura.
  const a = d.assistito;
  const nameLabel = 'COGNOME E NOME /INIZIALI DELL’ASSISTITO:';
  const nameEnd = s.text(nameLabel, M.left, ROW.name, { size: LABEL });
  if (a.oscurato) s.fitted(OBSCURED_TEXT_2024, nameEnd + 1.2, ROW.name, leftOfCf, 2, 3.4);
  else if (a.cognomeNome) s.fitted(a.cognomeNome, nameEnd + 1.2, ROW.name, leftOfCf);
  // Indirizzo, CAP, città e provincia in fila, ognuno nello spazio che gli serve.
  const parts: [string, string | null, number][] = [
    ['INDIRIZZO:', a.indirizzo, 0.39],
    ['CAP:', a.cap, 0.15],
    ['CITTA’:', a.citta, 0.32],
    ['PROV:', a.provincia, 0.14],
  ];
  let x: number = M.left;
  for (const [label, value, share] of parts) {
    const right = x + (leftOfCf - M.left) * share;
    s.field(label, value, x, ROW.address, right - 1.5);
    x = right;
  }
  if (d.esteri) {
    // Sotto il codice fiscale in chiaro: la riga ha tutta la larghezza.
    s.field('CODICE ISTITUZIONE COMPETENTE:', d.esteri.istituzione, M.left, ROW.foreign, 104);
    s.field('N. IDENTIFICAZIONE DELLA TESSERA:', d.esteri.tessera, 105, ROW.foreign, M.right);
  }
  s.line(M.left, ROW.rule, M.right, ROW.rule);

  // Campi 10–16.
  s.field('ESENZIONE:', d.esenzione, M.left, ROW.exemption, 62);
  s.field('SIGLA PROVINCIA:', a.siglaProvincia, 63, ROW.exemption, 103);
  s.field('CODICE ASL:', a.codiceAsl, 104, ROW.exemption, 143);
  s.field('DISPOSIZIONI REGIONALI:', d.disposizioniRegionali, 144, ROW.exemption, M.right);
  s.field(
    'TIPOLOGIA PRESCRIZIONE(S,H):',
    d.tipologia ? TYPOLOGY_TEXT[d.tipologia] : null,
    M.left,
    ROW.typology,
    62,
  );
  s.field('ALTRO:', d.altro, 63, ROW.typology, 78);
  s.field(
    'PRIORITA’PRESCRIZIONE(U,B,D,P):',
    d.priorita ? PRIORITY_TEXT[d.priorita] : null,
    79,
    ROW.typology,
    M.right,
  );

  prescriptionTable(s, d);

  // Campi 21–28: sempre nella stessa posizione, come se le prescrizioni fossero tutte compilate.
  const diagnosisEnd = s.text('QUESITO DIAGNOSTICO:', M.left, ROW.diagnosis, { size: LABEL });
  if (d.quesitoDiagnostico)
    s.fitted(d.quesitoDiagnostico, diagnosisEnd + 1.2, ROW.diagnosis, M.right, 2, 3.2);
  s.field(
    'N.CONFEZIONI/PRESTAZIONI:',
    String(d.numeroConfezioniPrestazioni),
    M.left,
    ROW.totals,
    46,
  );
  s.field('TIPO RICETTA:', d.tipoRicetta, 47, ROW.totals, 86);
  s.field('DATA:', ddmmyyyy(d.data), 87, ROW.totals, 126);
  s.field('CODICE FISCALE DEL MEDICO:', d.medico.codiceFiscale, 127, ROW.totals, M.right);
  s.field('CODICE AUTENTICAZIONE:', d.codiceAutenticazione, M.left, ROW.auth, 86);
  s.field('COGNOME E NOME DEL MEDICO:', doctorName(d), 87, ROW.auth, M.right);
  s.text(d.dicitura, (M.left + M.right) / 2, ROW.release, {
    size: LABEL,
    font: fonts.italic,
    align: 'center',
  });
  if (d.fraseRegionale) s.fitted(d.fraseRegionale, M.left, ROW.regional, M.right);
  return doc.save();
}

/**
 * Campo 27, con il codice regionale davanti al nome dove la Regione lo chiede (Piemonte, SIRPE,
 * «Cartelle cliniche MMG e PLS», 4.4.3: «codice regionale – nominativo del medico»).
 */
function doctorName(d: PromemoriaDataV2) {
  return [d.medico.codiceRegionale, d.medico.nominativo.toUpperCase()].filter(Boolean).join(' - ');
}

/**
 * Area delle prescrizioni (2.1): si disegnano solo le righe usate, l'area resta grande quanto nel
 * facsimile nr. 0. Se le righe non ci stanno, il carattere si rimpicciolisce fino a MIN_SIZE.
 */
function prescriptionTable(s: Sheet, d: PromemoriaDataV2) {
  const font = s.fonts.regular;
  const head =
    d.tipo === 'specialist_ssn' && d.validitaGiorni
      ? `PRESCRIZIONE VALIDA ${d.validitaGiorni} GIORNI AI FINI DELLA PRENOTAZIONE`
      : 'PRESCRIZIONE';
  s.box(M.left, ROW.tableTop, M.right, ROW.tableHead);
  s.line(M.qty, ROW.tableTop, M.qty, ROW.tableHead);
  s.line(M.note, ROW.tableTop, M.note, ROW.tableHead);
  const headBase = ROW.tableHead - 1.3;
  s.text(head, (M.left + M.qty) / 2, headBase, { size: LABEL, align: 'center' });
  s.text('QTA', (M.qty + M.note) / 2, headBase, { size: LABEL, align: 'center' });
  s.text('NOTA', (M.note + M.right) / 2, headBase, { size: LABEL, align: 'center' });

  const textWidth = (M.qty - M.left - 3) * MM;
  const pad = 0.6;
  const layout = (size: number) => {
    const line = (size * 1.15) / MM;
    const rows = d.righe.map((r) => {
      const lines = [
        ...r.prescrizione.flatMap((p) => wrap(font, p, size, textWidth)),
        ...(r.dettagli ? wrap(font, r.dettagli, size, textWidth) : []),
      ];
      return { r, lines, height: lines.length * line + 2 * pad };
    });
    // Una riga in più per la frase sui farmaci in DPC, sotto l'ultima prescrizione.
    const total = rows.reduce((sum, x) => sum + x.height, 0) + (d.fraseDpc ? line + 1 : 0);
    return { rows, line, total };
  };
  const room = ROW.tableBottom - ROW.tableHead;
  let size: number = VALUE;
  let plan = layout(size);
  while (plan.total > room && size > MIN_SIZE) {
    size -= 0.25;
    plan = layout(size);
  }
  let y: number = ROW.tableHead;
  for (const { r, lines, height } of plan.rows) {
    const bottom = Math.min(y + height, ROW.tableBottom);
    s.box(M.left, y, M.right, bottom);
    s.line(M.qty, y, M.qty, bottom);
    s.line(M.note, y, M.note, bottom);
    const first = y + pad + plan.line * 0.82;
    lines.forEach((l, i) => {
      const base = first + i * plan.line;
      if (base <= bottom - 0.3)
        s.text(clip(font, l, size, textWidth), M.left + 1.5, base, { size });
    });
    s.text(String(r.quantita), (M.qty + M.note) / 2, first, { size, align: 'center' });
    s.text(clip(font, r.nota, size, (M.right - M.note - 1) * MM), (M.note + M.right) / 2, first, {
      size,
      align: 'center',
    });
    y = bottom;
  }
  // Farmaci in DPC: la frase della ricevuta nella riga dopo l'ultima prescrizione, fuori dalla
  // tabella, centrata nella pagina.
  if (d.fraseDpc && y + plan.line + 0.6 <= ROW.tableBottom)
    s.text(
      clip(font, d.fraseDpc, size, (M.right - M.left) * MM),
      (M.left + M.right) / 2,
      y + plan.line + 0.6,
      { size, align: 'center' },
    );
}

/** Il foglio «solo NRE» con le misure del modello del 2024: numero, codice fiscale e medico. */
async function renderSoloNre2024(d: PromemoriaDataV2, paper: PaperSize): Promise<Uint8Array> {
  const { doc, page } = await newDocument(`Numero della ricetta ${d.nre}`, d.data, pageFor(paper));
  const fonts = await fonts2024(doc);
  const s = new Sheet(page, fonts);
  const leftOfCf = heading(s, d, 'RICETTA ELETTRONICA – NUMERO DELLA RICETTA');
  s.fitted(
    'In farmacia o allo sportello bastano il numero di ricetta e il codice fiscale.',
    M.left,
    ROW.name,
    leftOfCf,
    2,
    3.4,
  );
  s.line(M.left, ROW.rule, M.right, ROW.rule);
  s.field('DATA:', ddmmyyyy(d.data), M.left, ROW.exemption, 86);
  s.field('CODICE FISCALE DEL MEDICO:', d.medico.codiceFiscale, 87, ROW.exemption, M.right);
  s.field('CODICE AUTENTICAZIONE:', d.codiceAutenticazione, M.left, ROW.typology, 86);
  s.field('COGNOME E NOME DEL MEDICO:', doctorName(d), 87, ROW.typology, M.right);
  s.text(d.dicitura, (M.left + M.right) / 2, ROW.typology + 4.4, {
    size: LABEL,
    font: fonts.italic,
    align: 'center',
  });
  return doc.save();
}

// ---------------------------------------------------------------------------------------------
// Versione 1: DM 2 novembre 2011, allegato 2. Invariata: ristampa i promemoria fissati prima.
// ---------------------------------------------------------------------------------------------

class Writer {
  y: number;
  constructor(
    readonly page: PDFPage,
    readonly fonts: FontsV1,
    top: number,
  ) {
    this.y = top;
  }

  text(value: string, opts: { x?: number; size?: number; bold?: boolean; font?: PDFFont } = {}) {
    const size = opts.size ?? 9;
    const font = opts.font ?? (opts.bold ? this.fonts.bold : this.fonts.regular);
    this.page.drawText(safe(font, value), {
      x: opts.x ?? LEFT,
      y: this.y,
      size,
      font,
      color: rgb(0, 0, 0),
    });
  }

  /** Etichetta e valore sulla stessa riga; il valore va a capo se è lungo. */
  field(label: string, value: string | null, opts: { x?: number; labelWidth?: number } = {}) {
    const x = opts.x ?? LEFT;
    const labelWidth = opts.labelWidth ?? 150;
    this.text(label, { x, bold: true });
    const lines = wrap(this.fonts.regular, value ?? '—', 9, RIGHT - x - labelWidth);
    lines.forEach((l, i) => {
      if (i > 0) this.y -= 12;
      this.text(l, { x: x + labelWidth });
    });
    this.y -= 14;
  }

  section(title: string) {
    this.y -= 4;
    this.page.drawLine({
      start: { x: LEFT, y: this.y + 11 },
      end: { x: RIGHT, y: this.y + 11 },
      thickness: 0.5,
      color: rgb(0, 0, 0),
    });
    this.text(title, { size: 9, bold: true });
    this.y -= 15;
  }

  /** Codice a barre 3-of-9 con il testo sotto (DM 2 novembre 2011, campi 2 e 3 bis). */
  barcode(value: string, label: string) {
    const height = BARCODE_HEIGHT_MM * MM;
    const { bars } = code39Bars(value, BARCODE_MODULE_MM * MM);
    const bottom = this.y - height;
    for (const b of bars) {
      this.page.drawRectangle({
        x: LEFT + b.x,
        y: bottom,
        width: b.width,
        height,
        color: rgb(0, 0, 0),
      });
    }
    this.y = bottom - 12;
    this.text(`${label} ${value}`, { font: this.fonts.code, size: 10 });
    this.y -= 18;
  }
}

/** Piede comune: data, medico (riga piemontese sotto il codice fiscale), codice, dicitura. */
function footerV1(w: Writer, d: PromemoriaDataV1) {
  w.section('MEDICO');
  w.field('Data', ddmmyyyy(d.data));
  w.field('Codice fiscale del medico', d.medico.codiceFiscale);
  // Regione Piemonte: sotto il codice fiscale, allineati, senza etichetta, separati da «-».
  w.text(
    [d.medico.codiceRegionale, d.medico.nominativo.toUpperCase()].filter(Boolean).join(' - '),
    { x: LEFT + 150 },
  );
  w.y -= 14;
  w.field('Codice di autenticazione', d.codiceAutenticazione);
  w.y -= 6;
  w.text(d.dicitura, { size: 8 });
}

async function renderPromemoriaV1(d: PromemoriaDataV1): Promise<Uint8Array> {
  const { doc, page } = await newDocument(`Promemoria della ricetta ${d.nre}`, d.data);
  const fonts = await fontsV1(doc);
  const w = new Writer(page, fonts, A4[1] - 50);
  w.text(d.intestazione, { size: 11, bold: true });
  w.y -= 18;
  w.barcode(d.nre, 'NRE');

  w.section('DATI DELL’ASSISTITO');
  w.field('Codice fiscale', d.assistito.codiceFiscale);
  w.barcode(d.assistito.codiceFiscale, 'CF');
  w.field(
    'Cognome e nome / Iniziali',
    d.assistito.oscurato ? OBSCURED_TEXT : d.assistito.cognomeNome,
  );
  w.field('Indirizzo', d.assistito.oscurato ? OBSCURED_TEXT : d.assistito.indirizzo);
  w.field(
    'ASL di competenza',
    `Sigla provincia ${d.assistito.siglaProvincia ?? '—'}   Codice ASL ${d.assistito.codiceAsl ?? '—'}`,
  );
  w.field('Esenzione', d.esenzione);

  w.section('ULTERIORI INFORMAZIONI');
  w.field('Disposizioni regionali', d.disposizioniRegionali);
  w.field('Tipo ricetta', d.tipoRicetta);
  if (d.tipoAccesso) w.field('Tipo di accesso', d.tipoAccesso);

  w.section('PRESCRIZIONE');
  const cols = { quantita: 330, nota: 390, tipologia: 450, priorita: 510 };
  w.text('Descrizione', { bold: true });
  w.text('Quantità', { x: cols.quantita, bold: true });
  w.text('Nota AIFA', { x: cols.nota, bold: true });
  w.text('Tipologia', { x: cols.tipologia, bold: true });
  w.text('Priorità', { x: cols.priorita, bold: true });
  w.y -= 14;
  for (const r of d.righe) {
    const lines = wrap(fonts.regular, r.descrizione, 9, cols.quantita - LEFT - 10);
    const top = w.y;
    lines.forEach((l, i) => {
      if (i > 0) w.y -= 12;
      w.text(l);
    });
    const after = w.y;
    w.y = top;
    w.text(String(r.quantita), { x: cols.quantita });
    w.text(r.notaAifa ?? '', { x: cols.nota });
    w.text(r.tipologia ?? '', { x: cols.tipologia });
    w.text(r.priorita ?? '', { x: cols.priorita });
    w.y = after - 14;
  }
  w.field('Numero confezioni / Prestazioni', String(d.numeroConfezioniPrestazioni));

  w.section('DATI DIAGNOSI');
  w.field('Codice nosologico', d.diagnosi.codice);
  w.field('Descrizione', d.diagnosi.descrizione);

  if (d.esteri) {
    w.section('SOGGETTI ASSICURATI DA ISTITUZIONI ESTERE');
    w.field('Numero di identificazione della tessera', d.esteri.tessera);
    w.field('Istituzione competente', d.esteri.istituzione);
  }
  footerV1(w, d);
  return doc.save();
}

async function renderSoloNreV1(d: PromemoriaDataV1): Promise<Uint8Array> {
  const { doc, page } = await newDocument(`Numero della ricetta ${d.nre}`, d.data);
  const fonts = await fontsV1(doc);
  const w = new Writer(page, fonts, A4[1] - 50);
  w.text(d.intestazione, { size: 11, bold: true });
  w.y -= 18;
  w.barcode(d.nre, 'NRE');
  w.barcode(d.assistito.codiceFiscale, 'CF');
  w.text('In farmacia o allo sportello bastano il numero di ricetta e il codice fiscale.');
  w.y -= 16;
  footerV1(w, d);
  return doc.save();
}
