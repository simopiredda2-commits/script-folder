import { PDFDict, PDFDocument, PDFName } from 'pdf-lib';

/** Nomi dei caratteri di un PDF (`BaseFont`), letti anche dentro i flussi di oggetti. */
export async function pdfFontNames(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  const names = new Set<string>();
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    if (obj.get(PDFName.of('Type'))?.toString() !== '/Font') continue;
    const base = obj.get(PDFName.of('BaseFont'));
    if (base) names.add(base.toString().replace(/^\//, ''));
  }
  return [...names].sort();
}
