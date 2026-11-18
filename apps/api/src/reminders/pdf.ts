import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import { code39Bars } from './code39';
import { OBSCURED_TEXT, type PromemoriaData } from './promemoria';

/** Millimetri in punti PDF. */
const MM = 72 / 25.4;
/**
 * Modulo del codice a barre: 4/300 di pollice, 0,339 mm, sopra il minimo di 0,240 mm del decreto.
 * Con una stampante a 300 o 600 punti per pollice stretto e largo (2,5 moduli) cadono su punti
 * interi. Lo spazio tra i caratteri è un modulo, sotto il massimo di 1,2 mm.
 */
export const BARCODE_MODULE_MM = (25.4 * 4) / 300;
/** Barre alte 10 mm: il minimo del decreto è 7,5 mm. */
export const BARCODE_HEIGHT_MM = 10;

const A4: [number, number] = [595.28, 841.89];
const LEFT = 40;
const RIGHT = A4[0] - 40;

interface Fonts {
  regular: PDFFont;
  bold: PDFFont;
  /** NRE in chiaro. Il decreto chiede l'OCR-A (ECMA, tipo 1): carattere da completare. */
  code: PDFFont;
}

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

class Writer {
  y: number;
  constructor(
    readonly page: PDFPage,
    readonly fonts: Fonts,
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

async function newDocument(title: string, created: string) {
  const doc = await PDFDocument.create();
  const when = new Date(`${created}T12:00:00Z`);
  doc.setTitle(title);
  doc.setCreationDate(when);
  doc.setModificationDate(when);
  doc.setProducer('Cartella clinica');
  const page = doc.addPage(A4);
  const fonts: Fonts = {
    regular: await doc.embedFont(StandardFonts.Helvetica),
    bold: await doc.embedFont(StandardFonts.HelveticaBold),
    code: await doc.embedFont(StandardFonts.Courier),
  };
  return { doc, page, fonts };
}

const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/** Piede comune: data, medico (riga piemontese sotto il codice fiscale), codice, dicitura. */
function footer(w: Writer, d: PromemoriaData) {
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

/** Il promemoria completo della ricetta SSN, dai dati fissati all'invio. */
export async function renderPromemoria(d: PromemoriaData): Promise<Uint8Array> {
  const { doc, page, fonts } = await newDocument(`Promemoria della ricetta ${d.nre}`, d.data);
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
  footer(w, d);
  return doc.save();
}

/**
 * Il foglio con il solo numero di ricetta: NRE e codice fiscale, a barre e in chiaro, con il
 * codice di autenticazione, che va su ogni documento consegnato al paziente.
 */
export async function renderSoloNre(d: PromemoriaData): Promise<Uint8Array> {
  const { doc, page, fonts } = await newDocument(`Numero della ricetta ${d.nre}`, d.data);
  const w = new Writer(page, fonts, A4[1] - 50);
  w.text(d.intestazione, { size: 11, bold: true });
  w.y -= 18;
  w.barcode(d.nre, 'NRE');
  w.barcode(d.assistito.codiceFiscale, 'CF');
  w.text('In farmacia o allo sportello bastano il numero di ricetta e il codice fiscale.');
  w.y -= 16;
  footer(w, d);
  return doc.save();
}
