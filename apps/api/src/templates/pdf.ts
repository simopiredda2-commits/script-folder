import type { FilledParts, PaperSize, PrintFont, PrintLayout } from '@mmg/domain';
import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';

/**
 * Il PDF di un certificato da un modello (tappa 13), con l'impaginazione scelta dal medico:
 * intestazione, carattere, dimensione, margini, timbro. Caratteri standard del PDF (Helvetica,
 * Times, Courier): non si incorporano e non hanno licenze da rispettare (D142).
 */

export interface TemplatePrintData {
  title: string;
  paragraphs: string[];
  signature: string;
  layout: PrintLayout;
  /** Quando è stato rilasciato: data del documento PDF, così lo stesso certificato dà lo stesso file. */
  createdAt: Date;
  /** Certificato annullato: si stampa la dicitura in testa. */
  annulled?: { on: string; reason: string } | null;
  /**
   * Struttura comune (D158): riferimento normativo sotto il titolo, note dopo il testo, luogo e
   * data, altre firme a sinistra. Assente per i certificati rilasciati prima.
   */
  parts?: FilledParts | null;
  /**
   * Carta della postazione per i certificati dai modelli (tappa 14): A4 per difetto, A5 se è la
   * preferenza di stampa. Cambiano solo le pagine: testo, impaginazione del medico e firme restano.
   */
  paper?: PaperSize;
}

/** Pagine in punti PDF, in verticale (ISO 216): A4 è quella usata da sempre. */
const PAGES: Record<PaperSize, [number, number]> = {
  A4: [595.28, 841.89],
  A5: [419.53, 595.28],
};
const MM = 72 / 25.4;

const FONTS: Record<PrintFont, { regular: StandardFonts; bold: StandardFonts }> = {
  sans: { regular: StandardFonts.Helvetica, bold: StandardFonts.HelveticaBold },
  serif: { regular: StandardFonts.TimesRoman, bold: StandardFonts.TimesRomanBold },
  mono: { regular: StandardFonts.Courier, bold: StandardFonts.CourierBold },
};

/** Solo i caratteri che il carattere standard sa scrivere; gli altri diventano «?». */
function safe(font: PDFFont, text: string): string {
  const set = new Set(font.getCharacterSet());
  return [...text].map((c) => (set.has(c.codePointAt(0)!) ? c : '?')).join('');
}

function wrap(font: PDFFont, text: string, size: number, width: number): string[] {
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    let line = '';
    for (const word of safe(font, raw).split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width || !line) line = next;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out;
}

export async function renderTemplatePdf(d: TemplatePrintData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(d.title);
  doc.setCreationDate(d.createdAt);
  doc.setModificationDate(d.createdAt);
  doc.setProducer('');
  doc.setCreator('');
  const regular = await doc.embedFont(FONTS[d.layout.font].regular);
  const bold = await doc.embedFont(FONTS[d.layout.font].bold);
  const size = d.layout.fontSize;
  const lead = size * 1.45;
  const margin = d.layout.marginMm * MM;
  const sheet = PAGES[d.paper ?? 'A4'];
  const width = sheet[0] - 2 * margin;
  let page: PDFPage = doc.addPage(sheet);
  let y = sheet[1] - margin;

  const ensure = (needed: number) => {
    if (y - needed < margin) {
      page = doc.addPage(sheet);
      y = sheet[1] - margin;
    }
  };
  const text = (
    line: string,
    opts: { font?: PDFFont; size?: number; align?: 'left' | 'center' | 'right' } = {},
  ) => {
    const f = opts.font ?? regular;
    const s = opts.size ?? size;
    const w = f.widthOfTextAtSize(line, s);
    const x =
      opts.align === 'center'
        ? margin + (width - w) / 2
        : opts.align === 'right'
          ? margin + width - w
          : margin;
    page.drawText(line, { x, y, size: s, font: f, color: rgb(0, 0, 0) });
  };

  if (d.annulled) {
    const note = `ANNULLATO il ${d.annulled.on}: ${d.annulled.reason}`;
    for (const l of wrap(bold, note, size, width)) {
      ensure(lead);
      page.drawText(l, { x: margin, y, size, font: bold, color: rgb(0.7, 0, 0) });
      y -= lead;
    }
    y -= lead / 2;
  }

  // Intestazione del medico: la prima riga in neretto, poi una linea.
  const header = d.layout.header.filter((l) => l.trim());
  if (header.length) {
    header.forEach((l, i) => {
      const f = i === 0 ? bold : regular;
      for (const part of wrap(f, l, size, width)) {
        ensure(lead);
        text(part, { font: f, align: d.layout.headerAlign });
        y -= lead;
      }
    });
    page.drawLine({
      start: { x: margin, y: y + lead / 3 },
      end: { x: margin + width, y: y + lead / 3 },
      thickness: 0.6,
      color: rgb(0.3, 0.3, 0.3),
    });
    y -= lead;
  }

  // Titolo.
  for (const l of wrap(bold, d.title, size + 3, width)) {
    ensure(lead * 1.3);
    text(l, { font: bold, size: size + 3, align: 'center' });
    y -= lead * 1.3;
  }
  // Riferimento normativo, sotto il titolo.
  const small = Math.max(8, size - 2);
  const smallLead = small * 1.4;
  if (d.parts?.reference) {
    for (const l of wrap(regular, d.parts.reference, small, width)) {
      ensure(smallLead);
      text(l, { size: small, align: 'center' });
      y -= smallLead;
    }
  }
  y -= lead / 2;

  // Testo: un paragrafo dopo l'altro. Un paragrafo che sta in una pagina non si spezza: se non
  // c'è posto va alla pagina dopo, così una dichiarazione resta intera accanto alla sua firma.
  const usable = sheet[1] - 2 * margin;
  // L'ultimo paragrafo resta sulla pagina di luogo, data e firme: la dichiarazione finale va con
  // chi la firma.
  const stamp = d.layout.stamp
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const others = d.parts?.otherSignatures ?? [];
  const signatures = lead * (4 + Math.max(stamp.length, others.length * 3));
  const closing = signatures + (d.parts?.placeDate ? lead : 0);
  d.paragraphs.forEach((p, i) => {
    const lines = wrap(regular, p, size, width);
    const block = lines.length * lead + (i === d.paragraphs.length - 1 ? closing : 0);
    if (block <= usable) ensure(block);
    else if (lines.length * lead <= usable) ensure(lines.length * lead);
    for (const l of lines) {
      ensure(lead);
      text(l);
      y -= lead;
    }
    y -= lead / 2;
  });

  // Luogo e data, sulla stessa pagina delle firme.
  if (d.parts?.placeDate) {
    ensure(lead + signatures);
    text(safe(regular, d.parts.placeDate));
    y -= lead;
  }

  // Firme: il medico a destra, con il timbro; le altre firme a sinistra, alla stessa altezza.
  ensure(signatures);
  y -= lead * 2;
  const signWidth = Math.min(220, width / 2 - 10);
  const line = (x: number, at: number) =>
    page.drawLine({
      start: { x, y: at },
      end: { x: x + signWidth, y: at },
      thickness: 0.6,
      color: rgb(0, 0, 0),
    });
  const top = y;
  let left = top;
  for (const label of others) {
    line(margin, left);
    page.drawText(safe(regular, label), {
      x: margin,
      y: left - lead,
      size,
      font: regular,
      color: rgb(0, 0, 0),
    });
    left -= lead * 3;
  }
  line(margin + width - signWidth, top);
  y = top - lead;
  text(safe(regular, d.signature), { align: 'right' });
  y -= lead;
  for (const l of stamp) {
    text(safe(regular, l), { align: 'right', size: size - 1 });
    y -= lead;
  }
  y = Math.min(y, left);

  // Note del modello, in fondo e in corpo più piccolo, come nei modelli cartacei.
  if (d.parts?.notes.length) y -= lead;
  // Le note restano insieme, se stanno in una pagina.
  const noteLines = (d.parts?.notes ?? []).map((n) => wrap(regular, n, small, width));
  const notesHeight = noteLines.flat().length * smallLead;
  if (notesHeight <= usable) ensure(notesHeight);
  for (const lines of noteLines) {
    for (const l of lines) {
      ensure(smallLead);
      text(l, { size: small });
      y -= smallLead;
    }
  }

  const pages = doc.getPages();
  if (pages.length > 1)
    pages.forEach((p, i) =>
      p.drawText(`pagina ${i + 1} di ${pages.length}`, {
        x: margin,
        y: margin / 2,
        size: 8,
        font: regular,
        color: rgb(0.35, 0.35, 0.35),
      }),
    );
  return doc.save();
}
