import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

/** Il testo di un PDF, pagina per pagina, per controllare che cosa c'è davvero stampato. */
export async function pdfText(bytes: Uint8Array): Promise<string> {
  const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false });
  const doc = await task.promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    pages.push(content.items.map((it) => ('str' in it ? it.str : '')).join(' '));
  }
  await task.destroy();
  return pages.join('\n');
}
