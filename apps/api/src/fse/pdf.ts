import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';
import type { PssAbsences, PssContent } from './compose';

/**
 * Il PDF leggibile del Profilo Sanitario Sintetico (tappa 11): lo stesso contenuto del documento
 * CDA2, che va allegato a questo PDF come «cda.xml». Una pagina A4 per volta, sezione per
 * sezione; solo le voci che il medico ha lasciato nel Profilo.
 */

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 50;
const ABSENT: Record<string, string> = {
  'no-known-allergies': 'Nessuna allergia nota.',
  'no-allergy-info': 'Nessuna informazione sulle allergie.',
  'no-known-medications': 'Nessuna terapia nota.',
  'no-medication-info': 'Nessuna informazione sulle terapie.',
  'no-known-problems': 'Nessun problema noto.',
  'no-problem-info': 'Nessuna informazione.',
};

export interface PssPrintData {
  content: PssContent;
  version: number;
  documentId: string;
  createdAt: Date;
  doctor: {
    name: string;
    fiscalCode: string;
    phone: string | null;
    email: string | null;
    pec: string | null;
  };
}

function safe(font: PDFFont, text: string): string {
  const set = new Set(font.getCharacterSet());
  return [...text].map((c) => (set.has(c.codePointAt(0)!) ? c : '?')).join('');
}

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

const it = (iso: string | null | undefined) =>
  iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '';
const when = (d: Date) =>
  new Intl.DateTimeFormat('it-IT', {
    timeZone: 'Europe/Rome',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);

class Writer {
  private page!: PDFPage;
  private y = 0;
  readonly pages: PDFPage[] = [];
  constructor(
    private readonly doc: PDFDocument,
    private readonly regular: PDFFont,
    private readonly bold: PDFFont,
  ) {
    this.newPage();
  }
  private newPage() {
    this.page = this.doc.addPage(A4);
    this.pages.push(this.page);
    this.y = A4[1] - MARGIN;
  }
  private room(h: number) {
    if (this.y - h < MARGIN + 20) this.newPage();
  }
  line(text: string, opts: { size?: number; bold?: boolean; gap?: number; indent?: number } = {}) {
    const size = opts.size ?? 10;
    const font = opts.bold ? this.bold : this.regular;
    const indent = opts.indent ?? 0;
    for (const l of wrap(font, text, size, A4[0] - 2 * MARGIN - indent)) {
      this.room(size + 4);
      this.page.drawText(l, {
        x: MARGIN + indent,
        y: this.y - size,
        size,
        font,
        color: rgb(0, 0, 0),
      });
      this.y -= size + 4;
    }
    this.y -= opts.gap ?? 0;
  }
  heading(text: string) {
    this.y -= 6;
    this.room(30);
    this.line(text, { size: 12, bold: true, gap: 2 });
  }
  footer(text: string) {
    this.pages.forEach((p, i) =>
      p.drawText(safe(this.regular, `${text} – pagina ${i + 1} di ${this.pages.length}`), {
        x: MARGIN,
        y: MARGIN - 20,
        size: 8,
        font: this.regular,
        color: rgb(0.25, 0.25, 0.25),
      }),
    );
  }
}

/** Il PDF del Profilo, senza il CDA allegato (lo aggiunge `withEmbeddedCda`). */
export async function renderPssPdf(data: PssPrintData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle('Profilo Sanitario Sintetico');
  doc.setLanguage('it-IT');
  doc.setCreationDate(data.createdAt);
  doc.setModificationDate(data.createdAt);
  const w = new Writer(
    doc,
    await doc.embedFont(StandardFonts.Helvetica),
    await doc.embedFont(StandardFonts.HelveticaBold),
  );
  const { content: c } = data;
  const p = c.paziente;
  w.line('Profilo Sanitario Sintetico', { size: 16, bold: true, gap: 2 });
  w.line(`Versione ${data.version} del ${when(data.createdAt)} – documento ${data.documentId}`, {
    size: 9,
    gap: 8,
  });
  w.heading('Paziente');
  w.line(`${p.cognome} ${p.nome} – codice fiscale ${p.cf}`);
  w.line(
    `Nato/a il ${it(p.nascita)}${p.luogoNascita ? ` a ${p.luogoNascita.city}` : ''}${
      p.sesso ? ` – sesso ${p.sesso}` : ''
    }`,
    { gap: 4 },
  );
  w.heading('Medico');
  w.line(`${data.doctor.name} – codice fiscale ${data.doctor.fiscalCode}`);
  const contacts = [
    data.doctor.phone && `telefono ${data.doctor.phone}`,
    data.doctor.email && `email ${data.doctor.email}`,
    data.doctor.pec && `PEC ${data.doctor.pec}`,
  ].filter(Boolean);
  if (contacts.length) w.line(contacts.join(' – '), { gap: 4 });

  const s = c.sezioni;
  const included = <T>(items: { incluso: boolean; dati: T }[]) =>
    items.filter((i) => i.incluso).map((i) => i.dati);
  const absent = (key: keyof PssAbsences) => w.line(ABSENT[c.assenze[key]]!, { indent: 10 });

  w.heading('Allergie e intolleranze');
  const allergies = included(s.allergie);
  if (!allergies.length) absent('allergie');
  for (const a of allergies)
    w.line(
      `${'text' in a.agent ? a.agent.text : a.agent.display} – ${a.type.display}${
        a.status === 'inactive' ? ' (non più attiva)' : ''
      }${a.criticality ? ` – criticità ${a.criticality}` : ''}${a.comment ? ` – ${a.comment}` : ''}`,
      { indent: 10 },
    );
  w.heading('Terapie farmacologiche');
  const therapies = included(s.terapie);
  if (!therapies.length) absent('terapie');
  for (const t of therapies)
    w.line(
      `${t.drug.name}${t.drug.aic ? ` (AIC ${t.drug.aic})` : ''}${t.dosage ? ` – ${t.dosage}` : ''} – ${t.route.display} – dal ${it(t.startOn)}`,
      { indent: 10 },
    );
  w.heading('Problemi e patologie croniche');
  const problems = included(s.problemi);
  if (!problems.length) absent('problemi');
  for (const pr of problems)
    w.line(
      `${pr.text} (${pr.code.code}) – ${pr.state === 'active' ? 'attivo' : 'risolto'}${
        pr.chronic ? ', cronico' : ''
      }${pr.onsetOn ? ` – dal ${it(pr.onsetOn)}` : ''}`,
      { indent: 10 },
    );
  w.heading('Anamnesi familiare');
  const family = included(s.anamnesiFamiliare);
  if (!family.length) absent('anamnesiFamiliare');
  for (const f of family)
    w.line(
      `${f.relative.display}: ${f.text} (${f.code.code})${f.onsetAge != null ? ` – esordio a ${f.onsetAge} anni` : ''}`,
      { indent: 10 },
    );
  const vitals = included(s.parametri);
  if (vitals.length) {
    w.heading('Parametri');
    for (const v of vitals)
      w.line(`${v.label}: ${v.value} ${v.unit} (${it(v.measuredOn)})`, { indent: 10 });
  }
  const lifestyle = included(s.stiliDiVita);
  if (lifestyle.length) {
    w.heading('Stili di vita');
    for (const l of lifestyle)
      w.line(`${l.label}: ${l.text} (${it(l.recordedOn)})`, { indent: 10 });
  }
  const motor = included(s.capacitaMotoria);
  if (motor.length) {
    w.heading('Capacità motoria');
    for (const m of motor) w.line(`${m.display} (dal ${it(m.since)})`, { indent: 10 });
  }
  w.footer(`Profilo Sanitario Sintetico di ${p.cognome} ${p.nome} – versione ${data.version}`);
  return doc.save({ useObjectStreams: false });
}
