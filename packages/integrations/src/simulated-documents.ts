import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { PrescriptionLineMessage } from './prescription-gateway';

/**
 * PDF del promemoria della ricetta bianca come lo restituirebbe il SAC, ma del simulatore:
 * dichiara su ogni riga di non essere valido. Il PDF vero lo produce solo il SAC (Disciplinare
 * tecnico della ricetta bianca, 1/12/2022): il programma lo conserva e lo consegna così com'è.
 */
export async function simulatedWhiteReminderPdf(input: {
  nrbe: string;
  pinNrbe: string;
  patientFiscalCode: string;
  compiledAt: string;
  lines: PrescriptionLineMessage[];
}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  // Date fisse: lo stesso invio dà sempre lo stesso file.
  const when = new Date(`${input.compiledAt}T12:00:00Z`);
  doc.setCreationDate(when);
  doc.setModificationDate(when);
  doc.setTitle('Promemoria della ricetta bianca elettronica (simulatore)');
  doc.setProducer('Simulatore del Sistema TS');
  const page = doc.addPage([595.28, 841.89]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let y = 800;
  const line = (text: string, size = 11, f = font) => {
    page.drawText(text, { x: 40, y, size, font: f, color: rgb(0, 0, 0) });
    y -= size + 8;
  };
  line("SIMULATORE - NON VALIDO PER L'EROGAZIONE", 14, bold);
  line('Promemoria della ricetta bianca elettronica, come lo produrrebbe il SAC');
  line(`NRBE ${input.nrbe}    PIN-NRBE ${input.pinNrbe}`, 12, bold);
  line(`Codice fiscale dell'assistito ${input.patientFiscalCode}`);
  line(`Data ${input.compiledAt}`);
  for (const l of input.lines) {
    const repeat =
      l.repeatCount != null
        ? ` - ripetibile ${l.repeatCount} volte${l.validityMonths != null ? ` entro ${l.validityMonths} mesi` : ''}`
        : '';
    line(`${l.drugName ?? l.activeIngredient ?? ''} - confezioni ${l.quantity}${repeat}`);
  }
  line("SIMULATORE - NON VALIDO PER L'EROGAZIONE", 14, bold);
  return doc.save();
}
