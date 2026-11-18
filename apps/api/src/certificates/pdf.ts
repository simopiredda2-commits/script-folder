import {
  BENEFIT_LABELS,
  SICK_LEAVE_TYPE_LABELS,
  SICK_LEAVE_TYPES,
  VISIT_TYPE_LABELS,
  VISIT_TYPES,
  type Benefit,
  type SickLeaveType,
  type VisitType,
} from '@mmg/domain';
import { PDFDocument, rgb, StandardFonts, type PDFFont, type PDFPage } from 'pdf-lib';

/**
 * Copia cartacea del certificato per il lavoratore (allegato A) e attestato per il datore di
 * lavoro (allegato B), dai fac-simile del DM 26 febbraio 2010, disciplinare tecnico, 6 (GU n. 65
 * del 19/3/2010). La copia contiene «tutti i dati inviati» con «DataRicezione» e «IdCertificato»;
 * l'attestato non ha diagnosi né tipo di visita. Nel fac-simile del 2010 le visite sono due; le
 * specifiche 3.2 aggiungono il pronto soccorso, che qui si stampa con le altre.
 */

export interface CertificateAddress {
  street: string;
  number: string;
  postalCode: string;
  town: string;
  province: string;
}

export interface CertificatePrintData {
  protocol: string;
  releaseDate: string;
  place: string | null;
  receivedAt: string;
  /** Protocollo del certificato rettificato da questo. */
  rectifiedProtocol: string | null;
  doctor: { name: string; regionalCode: string | null; asl: string | null };
  type: SickLeaveType;
  visit: VisitType;
  startDate: string;
  endDate: string;
  diagnosisCode: string | null;
  diagnosisNotes: string | null;
  workedDay: boolean;
  trauma: boolean;
  benefits: Benefit | null;
  worker: {
    lastName: string;
    firstName: string;
    fiscalCode: string;
    birthDate: string;
    birthPlace: string | null;
    birthProvince: string | null;
  };
  residence: CertificateAddress;
  availability: { name: string | null; address: CertificateAddress | null } | null;
}

/** Dicitura in fondo ai due fac-simile (nell'allegato A della GU manca uno spazio: «marzo2008»). */
export const RELEASE_FOOTER = 'Rilasciato ai sensi del DPCM 26 marzo 2008 e del Dlgs n.150/2009';

const A4: [number, number] = [595.28, 841.89];
const LEFT = 40;
const RIGHT = A4[0] - 40;

const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const romeDateTime = (iso: string) =>
  new Intl.DateTimeFormat('it-IT', {
    timeZone: 'Europe/Rome',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));

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

class Sheet {
  y = A4[1] - 50;
  constructor(
    readonly page: PDFPage,
    readonly regular: PDFFont,
    readonly bold: PDFFont,
  ) {}

  text(value: string, x: number, opts: { size?: number; bold?: boolean } = {}) {
    const font = opts.bold ? this.bold : this.regular;
    this.page.drawText(safe(font, value), {
      x,
      y: this.y,
      size: opts.size ?? 9,
      font,
      color: rgb(0, 0, 0),
    });
  }

  /** Coppie etichetta e valore sulla stessa riga, in colonne. */
  row(cells: [label: string, value: string | null, x: number][]) {
    for (const [label, value, x] of cells) {
      this.text(`${label}`, x, { bold: true });
      const lw = this.bold.widthOfTextAtSize(safe(this.bold, label), 9);
      this.text(value && value.trim() ? value : '—', x + lw + 4);
    }
    this.y -= 15;
  }

  /** Etichetta e valore lungo, che va a capo. */
  long(label: string, value: string | null, x = LEFT, right = RIGHT) {
    this.text(label, x, { bold: true });
    const lw = this.bold.widthOfTextAtSize(safe(this.bold, label), 9) + 4;
    const lines = wrap(this.regular, value && value.trim() ? value : '—', 9, right - x - lw);
    lines.forEach((l, i) => {
      if (i > 0) this.y -= 12;
      this.text(l, x + lw);
    });
    this.y -= 15;
  }

  section(title: string) {
    this.y -= 4;
    this.page.drawLine({
      start: { x: LEFT, y: this.y + 11 },
      end: { x: RIGHT, y: this.y + 11 },
      thickness: 0.5,
      color: rgb(0, 0, 0),
    });
    this.text(title, LEFT, { bold: true });
    this.y -= 15;
  }

  /** Scelte del modello con quella vera segnata: [X] Inizio  [ ] Continuazione … */
  choices(label: string, options: string[], chosen: string) {
    this.text(label, LEFT, { bold: true });
    let x = LEFT + 70;
    for (const o of options) {
      const t = `[${o === chosen ? 'X' : ' '}] ${o}`;
      this.text(t, x);
      x += this.regular.widthOfTextAtSize(safe(this.regular, t), 9) + 18;
    }
    this.y -= 15;
  }

  address(a: CertificateAddress | null) {
    this.row([
      ['In via/piazza', a?.street ?? null, LEFT],
      ['n.', a?.number ?? null, 420],
    ]);
    this.row([
      ['Comune', a?.town ?? null, LEFT],
      ['CAP', a?.postalCode ?? null, 300],
      ['Provincia', a?.province ?? null, 420],
    ]);
  }
}

async function render(d: CertificatePrintData, kind: 'A' | 'B'): Promise<Uint8Array> {
  const worker = kind === 'A';
  const doc = await PDFDocument.create();
  const when = new Date(d.receivedAt);
  doc.setTitle(
    worker
      ? `Certificato di malattia telematico ${d.protocol}`
      : `Attestato di malattia telematico ${d.protocol}`,
  );
  doc.setCreationDate(when);
  doc.setModificationDate(when);
  doc.setProducer('Cartella clinica');
  const page = doc.addPage(A4);
  const s = new Sheet(
    page,
    await doc.embedFont(StandardFonts.Helvetica),
    await doc.embedFont(StandardFonts.HelveticaBold),
  );

  const corner = worker
    ? 'Copia cartacea per il lavoratore'
    : 'Copia cartacea per il datore di lavoro';
  s.text(corner, RIGHT - s.regular.widthOfTextAtSize(corner, 9), { size: 9 });
  s.y -= 22;
  s.text(worker ? 'Certificato di malattia telematico' : 'Attestato di malattia telematico', LEFT, {
    size: 14,
    bold: true,
  });
  s.y -= 22;
  s.row([
    ['Protocollo', d.protocol, LEFT],
    ['Data rilascio', ddmmyyyy(d.releaseDate), 230],
    ['Luogo', d.place, 380],
  ]);
  if (d.rectifiedProtocol)
    s.row([['Rettifica del certificato protocollo', d.rectifiedProtocol, LEFT]]);

  s.section('DATI DEL MEDICO');
  s.row([
    ['Cognome e nome', d.doctor.name, LEFT],
    ['Cod. Reg.', d.doctor.regionalCode, 330],
    ['ASL', d.doctor.asl, 450],
  ]);

  s.section(
    worker
      ? 'DATI PROGNOSI                                                         DATI DIAGNOSI'
      : 'DATI PROGNOSI',
  );
  const top = s.y;
  s.row([['Il lavoratore dichiara di essere ammalato dal', ddmmyyyy(d.startDate), LEFT]]);
  s.row([['Viene assegnata prognosi clinica a tutto il', ddmmyyyy(d.endDate), LEFT]]);
  s.choices(
    'Trattasi di:',
    SICK_LEAVE_TYPES.map((t) => SICK_LEAVE_TYPE_LABELS[t]),
    SICK_LEAVE_TYPE_LABELS[d.type],
  );
  if (worker) {
    s.choices(
      'Visita:',
      VISIT_TYPES.map((v) => VISIT_TYPE_LABELS[v]),
      VISIT_TYPE_LABELS[d.visit],
    );
    const after = s.y;
    // Diagnosi nella colonna di destra, come nel fac-simile.
    s.y = top;
    s.row([['Cod. Nosologico', d.diagnosisCode, 330]]);
    s.long('Diagnosi', d.diagnosisNotes, 330, RIGHT);
    s.y = Math.min(s.y, after);
  }

  s.section('DATI DEL LAVORATORE');
  s.text('ANAGRAFICI', LEFT, { bold: true });
  s.y -= 15;
  s.row([
    ['Cognome', d.worker.lastName, LEFT],
    ['Nome', d.worker.firstName, 230],
    ['C.F.', d.worker.fiscalCode, 380],
  ]);
  s.row([
    ['Nato/a il', ddmmyyyy(d.worker.birthDate), LEFT],
    ['a (Comune o Stato estero)', d.worker.birthPlace, 160],
    ['Provincia', d.worker.birthProvince, 420],
  ]);
  s.text('RESIDENZA O DOMICILIO ABITUALE', LEFT, { bold: true });
  s.y -= 15;
  s.address(d.residence);
  s.text(
    'REPERIBILITÀ DURANTE LA MALATTIA (dati da indicare solo se diversi da quelli di residenza riportati sopra)',
    LEFT,
    { bold: true, size: 8 },
  );
  s.y -= 15;
  s.long(
    'Nominativo indicato presso l’abitazione (se diverso dal proprio)',
    d.availability?.name ?? null,
  );
  s.address(d.availability?.address ?? null);

  if (worker) {
    s.section('ALTRI DATI INVIATI');
    s.row([
      ['Giornata lavorata', d.workedDay ? 'sì' : 'no', LEFT],
      ['Trauma', d.trauma ? 'sì' : 'no', 230],
    ]);
    s.long('Agevolazioni', d.benefits ? BENEFIT_LABELS[d.benefits] : 'nessuna');
    s.row([
      ['DataRicezione', romeDateTime(d.receivedAt), LEFT],
      ['IdCertificato', d.protocol, 330],
    ]);
  }

  s.y = 60;
  s.text(RELEASE_FOOTER, (A4[0] - s.regular.widthOfTextAtSize(RELEASE_FOOTER, 8)) / 2, { size: 8 });
  return doc.save();
}

/** Allegato A: copia per il lavoratore, con tutti i dati inviati. */
export function renderWorkerCopy(d: CertificatePrintData): Promise<Uint8Array> {
  return render(d, 'A');
}

/** Allegato B: attestato per il datore di lavoro, senza diagnosi e senza tipo di visita. */
export function renderEmployerCertificate(d: CertificatePrintData): Promise<Uint8Array> {
  return render(d, 'B');
}
