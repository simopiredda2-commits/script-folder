/**
 * Stampa della ricetta rossa sul modulo SSN del Poligrafico (D270).
 *
 * - Modulo di 250 × 152,4 mm: matrice di 53 mm a sinistra e ricetta di 197 mm (disciplinare
 *   tecnico del DM 17/3/2008, comma 2, 2.1).
 * - Caselle per la lettura ottica: un carattere per casella, in nero; codici in OCR-A, tipo 1
 *   (2.3.1.3).
 * - NRE in chiaro e a barre, del tipo del numero del Poligrafico (3-of-9, barre alte almeno 7,5 mm,
 *   modulo di almeno 0,240 mm, largo 2,5 volte lo stretto), accanto alla denominazione dell'ente,
 *   dove la regione vuole la ricetta rossa in DPCM (D300). In due parti come il numero del
 *   Poligrafico: 5 e 10 caratteri.
 * - Casella «STAMPA PC» biffata: stampa con il sistema informatico del medico (elemento 25).
 *
 * Le posizioni sono misurate sul facsimile dell'Allegato 2 del disciplinare, che per la parte della
 * ricetta è in scala (2,78 punti dell'immagine per millimetro in larghezza e in altezza). Sono da
 * controllare con un modulo vero e la stampante dello studio: lo spostamento della stampa si regola
 * con `offset`. La posizione dell'NRE le specifiche della regione non la danno al millimetro: è da
 * confermare con chi gestisce il suo servizio delle ricette.
 */

import fontkit from '@pdf-lib/fontkit';
import { readFileSync } from 'node:fs';
import { degrees, PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import { code39Bars } from '../reminders/code39';
import { OCR_A_FILE } from '../reminders/pdf';
import type { RedFormData } from './dpcm';

const MM = 72 / 25.4;
/** Il modulo intero: 250 × 152,4 mm (2.1). */
export const RED_FORM_SIZE_MM = { width: 250, height: 152.4 } as const;
/** Codice 3-of-9 dell'NRE: modulo di 0,254 mm e barre alte 7,5 mm, i minimi del disciplinare. */
export const RED_FORM_BARCODE = { moduleMm: 0.254, heightMm: 7.5 } as const;

/** Una fila di caselle: sinistra della prima, larghezza di ciascuna, alto e basso. */
interface Boxes {
  x: number;
  y: number;
  width: number;
  count: number;
  height: number;
}

/**
 * Posizioni in millimetri dall'angolo in alto a sinistra del modulo, misurate sul facsimile
 * dell'Allegato 2 (D270): da controllare con un modulo vero.
 */
export const RED_FORM_LAYOUT = {
  /** Elemento 25: casella «STAMPA PC». */
  stampaPc: { x: 240.3, y: 3.6, size: 5.4 },
  /** Cognome e nome dell'assistito e indirizzo: righe a sinistra in alto. */
  patientName: { x: 61, y: 8.6, width: 87 },
  patientAddress: { x: 61, y: 18.6, width: 87 },
  /** Codice fiscale dell'assistito: 16 caselle. */
  fiscalCode: { x: 153.5, y: 24.4, width: 5.58, count: 16, height: 6.5 } satisfies Boxes,
  /** NRE a barre: fascia libera sopra le caselle del codice fiscale. */
  nreBarcode: { x: 153, y: 14.6 },
  /** NRE in chiaro, nel riquadro della denominazione dell'ente, a destra della scritta. */
  nreText: { x: 119.8, y: 30.2 },
  /** Esenzione: «N», 6 caselle del codice, «R». */
  notExempt: { x: 62.0, y: 37.4, size: 6.1 },
  exemption: { x: 72.1, y: 37.4, width: 5.65, count: 6, height: 5.7 } satisfies Boxes,
  /** Sigla della provincia (2) e codice dell'ASL (3) dell'assistito. */
  residence: { x: 160.0, y: 37.4, width: 5.6, count: 5, height: 5.7 } satisfies Boxes,
  /** Otto spazi della prescrizione (4 righe in 2 colonne) e la riga della diagnosi. */
  lines: {
    columns: [65.6, 128.3],
    width: 60,
    rows: [54.3, 61.8, 69.7, 77.6],
  },
  diagnosis: { x: 65.6, y: 84.8, width: 123 },
  /** Numero confezioni o prestazioni (3), tipo ricetta (2), data (6). */
  pieces: { x: 69.9, y: 86.3, width: 5.77, count: 3, height: 6.8 } satisfies Boxes,
  date: { x: 154.2, y: 86.3, width: 5.63, count: 6, height: 6.8 } satisfies Boxes,
  /** Note AIFA: due gruppi di tre caselle. */
  notes: [
    { x: 191.6, y: 50.0, width: 5.77, count: 3, height: 6.4 },
    { x: 191.6, y: 59.0, width: 5.77, count: 3, height: 6.4 },
  ] satisfies Boxes[],
  /** Priorità: U, B, D, P. */
  priority: { U: 213.2, B: 222.2, D: 231.2, P: 239.1, y: 59.3, size: 6.1 },
  /** Riquadro del timbro e della firma del medico: nome e codici in alto, piccoli. */
  doctor: { x: 192, y: 72, width: 54 },
  /** Matrice: data, codice fiscale e nome dell'assistito, in verticale. */
  matrix: { x: 8, y: 145, lineGap: 7 },
} as const;

/** Spostamento della stampa, in millimetri: per tarare la stampante sul modulo vero. */
export interface RedFormOffset {
  x: number;
  y: number;
}

class Sheet {
  constructor(
    private readonly page: PDFPage,
    private readonly fonts: { regular: PDFFont; code: PDFFont },
    private readonly offset: RedFormOffset,
  ) {}

  private px(x: number) {
    return (x + this.offset.x) * MM;
  }
  private py(y: number) {
    return this.page.getHeight() - (y + this.offset.y) * MM;
  }

  text(value: string, x: number, baseline: number, size = 8, font = this.fonts.regular) {
    this.page.drawText(value, {
      x: this.px(x),
      y: this.py(baseline),
      size,
      font,
      color: rgb(0, 0, 0),
    });
  }

  /** Testo che sta nella larghezza: si accorcia se serve. */
  fitted(value: string, x: number, baseline: number, width: number, size = 8) {
    let out = value;
    while (out && this.fonts.regular.widthOfTextAtSize(out, size) > width * MM)
      out = out.slice(0, -1);
    this.text(out, x, baseline, size);
  }

  /** Un carattere per casella, centrato, in OCR-A (2.3.1.3). */
  boxes(b: Boxes, value: string) {
    const size = 10;
    [...value.slice(0, b.count)].forEach((c, i) => {
      const w = this.fonts.code.widthOfTextAtSize(c, size) / MM;
      this.text(
        c,
        b.x + i * b.width + (b.width - w) / 2,
        b.y + b.height - 1.4,
        size,
        this.fonts.code,
      );
    });
  }

  /** Biffatura di una casella: una «X» che la riempie. */
  tick(x: number, y: number, size: number) {
    const m = size * 0.2;
    for (const [a, b] of [
      [
        [x + m, y + m],
        [x + size - m, y + size - m],
      ],
      [
        [x + size - m, y + m],
        [x + m, y + size - m],
      ],
    ] as const)
      this.page.drawLine({
        start: { x: this.px(a[0]), y: this.py(a[1]) },
        end: { x: this.px(b[0]), y: this.py(b[1]) },
        thickness: 1.2,
        color: rgb(0, 0, 0),
      });
  }

  /** Codice 3-of-9 con il valore tra asterischi in OCR-A sotto. */
  barcode(value: string, x: number, top: number) {
    const { moduleMm, heightMm } = RED_FORM_BARCODE;
    const { bars, width } = code39Bars(value, moduleMm);
    for (const b of bars)
      this.page.drawRectangle({
        x: this.px(x + b.x),
        y: this.py(top + heightMm),
        width: b.width * MM,
        height: heightMm * MM,
        color: rgb(0, 0, 0),
      });
    return width;
  }
}

/** Data della ricetta in sei caselle: ggmmaa (2.3.1.1, elemento 18). */
const ddmmyy = (iso: string) => `${iso.slice(8, 10)}${iso.slice(5, 7)}${iso.slice(2, 4)}`;

/** Il PDF della ricetta rossa, da stampare sul modulo del Poligrafico. */
export async function renderRedForm(
  d: RedFormData,
  offset: RedFormOffset = { x: 0, y: 0 },
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const when = new Date(`${d.compiledAt}T12:00:00Z`);
  doc.setTitle(`Ricetta rossa ${d.poligrafico}`);
  doc.setCreationDate(when);
  doc.setModificationDate(when);
  doc.setProducer('Cartella clinica');
  const page = doc.addPage([RED_FORM_SIZE_MM.width * MM, RED_FORM_SIZE_MM.height * MM]);
  const fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    code: await doc.embedFont(readFileSync(OCR_A_FILE), { subset: true }),
  };
  const s = new Sheet(page, fonts, offset);
  const L = RED_FORM_LAYOUT;

  s.tick(L.stampaPc.x, L.stampaPc.y, L.stampaPc.size);
  s.fitted(d.patientName, L.patientName.x, L.patientName.y, L.patientName.width, 9);
  if (d.patientAddress)
    s.fitted(d.patientAddress, L.patientAddress.x, L.patientAddress.y, L.patientAddress.width);
  s.boxes(L.fiscalCode, d.patientFiscalCode);

  // NRE: due codici come il numero del Poligrafico (5 e 10 caratteri), e in chiaro (V06, 4.2.2).
  const first = s.barcode(d.nre.slice(0, 5), L.nreBarcode.x, L.nreBarcode.y);
  s.barcode(d.nre.slice(5), L.nreBarcode.x + first + 3, L.nreBarcode.y);
  s.text(`NRE ${d.nre}`, L.nreText.x, L.nreText.y, 7, fonts.code);

  if (d.notExempt) s.tick(L.notExempt.x, L.notExempt.y, L.notExempt.size);
  if (d.exemptionCode) s.boxes(L.exemption, d.exemptionCode);
  if (d.province && d.asl) s.boxes(L.residence, `${d.province}${d.asl}`);

  d.lines.slice(0, 8).forEach((line, i) => {
    const column = L.lines.columns[i % 2]!;
    const row = L.lines.rows[Math.floor(i / 2)]!;
    s.fitted(`${line.quantity} x ${line.text}`, column, row - 0.8, L.lines.width);
  });
  if (d.diagnosis) s.fitted(d.diagnosis, L.diagnosis.x, L.diagnosis.y - 0.8, L.diagnosis.width);
  s.boxes(L.pieces, String(d.totalPieces).padStart(3, '0'));
  s.boxes(L.date, ddmmyy(d.compiledAt));
  d.aifaNotes.forEach((note, i) => s.boxes(L.notes[i]!, note.padStart(3, '0')));
  const p = d.priority as keyof typeof L.priority | null;
  if (p === 'U' || p === 'B' || p === 'D' || p === 'P')
    s.tick(L.priority[p], L.priority.y, L.priority.size);

  s.fitted(d.doctorName, L.doctor.x, L.doctor.y, L.doctor.width, 7);
  s.fitted(
    [d.doctorRegionalCode, d.doctorFiscalCode].filter(Boolean).join(' - '),
    L.doctor.x,
    L.doctor.y + 3.4,
    L.doctor.width,
    6,
  );

  // Matrice: in verticale, dal basso, data, codice fiscale e nome dell'assistito.
  [ddmmyy(d.compiledAt), d.patientFiscalCode, d.patientName].forEach((value, i) => {
    page.drawText(value.slice(0, 40), {
      x: (L.matrix.x + i * L.matrix.lineGap + offset.x) * MM,
      y: page.getHeight() - (L.matrix.y + offset.y) * MM,
      size: 7,
      font: fonts.regular,
      rotate: degrees(90),
      color: rgb(0, 0, 0),
    });
  });
  return doc.save({ useObjectStreams: false });
}
