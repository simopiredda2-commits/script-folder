import { sniffAttachmentType } from '@mmg/domain';
import { readCsvStrict } from './csv';
import { readJsonFile } from './json';
import { MAX_FILE_BYTES } from './limits';
import { Deadline, FileRejected, type ReadFile } from './table';
import { readXlsxStrict } from './xlsx';
import { isZip } from './zip';

/**
 * Riconosce il tipo di un file caricato dal suo contenuto, mai dal nome, e lo legge in modalità
 * «file non fidato». Si leggono CSV e TSV (testo delimitato), XLSX, JSON (un elenco di oggetti,
 * oppure la nostra esportazione completa). Gli altri formati hanno un messaggio che dice che cosa
 * fare.
 */
export function readImportFile(
  bytes: Uint8Array,
  options: { separator?: string | null } = {},
  deadline = new Deadline(),
): ReadFile {
  if (bytes.length === 0) throw new FileRejected('Il file è vuoto.');
  if (bytes.length > MAX_FILE_BYTES)
    throw new FileRejected(
      `Il file supera ${MAX_FILE_BYTES / 1048576} MB: dividilo in file più piccoli (per esempio un file per menu, o per anni).`,
      413,
    );
  if (isZip(bytes)) {
    const x = readXlsxStrict(bytes, deadline);
    return { format: 'xlsx', tables: x.tables, date1904: x.date1904, notes: x.notes };
  }
  const media = sniffAttachmentType(bytes);
  if (media)
    throw new FileRejected(
      media === 'application/pdf'
        ? 'È un documento PDF: i dati di un PDF non si importano. Un referto si allega alla cartella del paziente.'
        : 'È un’immagine: le immagini non si importano come dati. Un referto si allega alla cartella del paziente.',
    );
  // JSON: il primo carattere visibile (dopo un eventuale BOM) apre un elenco o un oggetto.
  let k = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
  while (
    k < bytes.length &&
    (bytes[k] === 0x20 || bytes[k] === 0x09 || bytes[k] === 0x0a || bytes[k] === 0x0d)
  )
    k++;
  if (bytes[k] === 0x5b /* [ */ || bytes[k] === 0x7b /* { */) return readJsonFile(bytes, deadline);
  const csv = readCsvStrict(bytes, options, deadline);
  return {
    format: 'csv',
    tables: [csv.table],
    encoding: csv.encoding,
    separator: csv.separator,
    notes: csv.notes,
  };
}
