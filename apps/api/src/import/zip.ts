import { inflateSync } from 'fflate';
import { MAX_UNCOMPRESSED_BYTES, MAX_ZIP_ENTRIES } from './limits';
import type { Deadline } from './table';
import { FileRejected } from './table';

/**
 * Lettura di un archivio ZIP non fidato (gli XLSX sono archivi ZIP). La struttura delle
 * intestazioni è quella che legge e scrive fflate 0.8.3 (`unzipSync`, `zh`, `slzh`, `wzh` nel suo
 * sorgente): qui si legge l'indice centrale per avere anche il CRC-32, che fflate non controlla.
 * Prima di decomprimere si controllano numero di voci e dimensioni dichiarate; dopo, che la
 * dimensione e il CRC tornino. Con una dimensione dichiarata falsa fflate restituisce un contenuto
 * troncato senza errore (provato il 19/11/2026): il CRC lo scopre.
 */

export interface ZipEntry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const BAD = 'Il file XLSX è danneggiato o non è un foglio di calcolo';

const u16 = (d: Uint8Array, o: number) => d[o]! | (d[o + 1]! << 8);
const u32 = (d: Uint8Array, o: number) =>
  (d[o]! | (d[o + 1]! << 8) | (d[o + 2]! << 16) | (d[o + 3]! << 24)) >>> 0;

/** Firma della voce locale di un archivio ZIP (la stessa che fflate scrive: 0x04034B50). */
export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && u32(bytes, 0) === 0x04034b50;
}

const CRC_TABLE = (() => {
  // Lo stesso polinomio di fflate (`crct`): -306674912, cioè 0xEDB88320.
  const t = new Int32Array(256);
  for (let i = 0; i < 256; ++i) {
    let c = i;
    for (let k = 0; k < 8; ++k) c = c & 1 ? -306674912 ^ (c >>> 1) : c >>> 1;
    t[i] = c;
  }
  return t;
})();

/** CRC-32 dei byte, come fflate. */
export function crc32(bytes: Uint8Array): number {
  let c = -1;
  for (let i = 0; i < bytes.length; ++i) c = CRC_TABLE[(c & 255) ^ bytes[i]!]! ^ (c >>> 8);
  return ~c >>> 0;
}

/** Indice centrale dell'archivio: nomi, dimensioni dichiarate, CRC, posizione dei dati. */
export function listZip(bytes: Uint8Array): ZipEntry[] {
  if (bytes.length < 22) throw new FileRejected(BAD);
  let e = bytes.length - 22;
  // Fine dell'indice centrale, eventualmente seguita da un commento (al più 65535 byte).
  while (u32(bytes, e) !== 0x06054b50) {
    if (e === 0 || bytes.length - e > 65557) throw new FileRejected(BAD);
    e--;
  }
  if (e >= 20 && u32(bytes, e - 20) === 0x07064b50)
    throw new FileRejected(`${BAD} (archivio ZIP64: troppo grande per l’importazione)`);
  const count = u16(bytes, e + 8);
  if (count > MAX_ZIP_ENTRIES)
    throw new FileRejected(`${BAD}: contiene troppe parti (${count}, al più ${MAX_ZIP_ENTRIES})`);
  let o = u32(bytes, e + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (o + 46 > bytes.length || u32(bytes, o) !== 0x02014b50) throw new FileRejected(BAD);
    const flags = u16(bytes, o + 8);
    const nameLength = u16(bytes, o + 28);
    const extraLength = u16(bytes, o + 30);
    const commentLength = u16(bytes, o + 32);
    const nameEnd = o + 46 + nameLength;
    if (nameEnd > bytes.length) throw new FileRejected(BAD);
    const rawName = bytes.subarray(o + 46, nameEnd);
    // Come fflate: UTF-8 se il bit 11 dei flag è acceso, altrimenti un byte per carattere.
    const name =
      flags & 2048
        ? new TextDecoder('utf-8').decode(rawName)
        : String.fromCharCode(...rawName.slice(0, 1024));
    const entry: ZipEntry = {
      name,
      flags,
      method: u16(bytes, o + 10),
      crc: u32(bytes, o + 16),
      compressedSize: u32(bytes, o + 20),
      size: u32(bytes, o + 24),
      localOffset: u32(bytes, o + 42),
    };
    if (
      entry.compressedSize === 0xffffffff ||
      entry.size === 0xffffffff ||
      entry.localOffset === 0xffffffff
    )
      throw new FileRejected(`${BAD} (archivio ZIP64: troppo grande per l’importazione)`);
    entries.push(entry);
    o = nameEnd + extraLength + commentLength;
  }
  return entries;
}

/**
 * Decomprime le voci scelte, con i tetti: somma delle dimensioni dichiarate, cifratura, metodo.
 * Il contenuto torna solo se dimensione e CRC sono quelli dichiarati.
 */
export function readZipEntries(
  bytes: Uint8Array,
  entries: ZipEntry[],
  wanted: (name: string) => boolean,
  deadline: Deadline,
): Map<string, Uint8Array> {
  const chosen = entries.filter((x) => wanted(x.name));
  const declared = chosen.reduce((n, x) => n + x.size, 0);
  if (declared > MAX_UNCOMPRESSED_BYTES)
    throw new FileRejected(
      `Il foglio di calcolo, decompresso, supera ${Math.round(MAX_UNCOMPRESSED_BYTES / 1048576)} MB: dividilo in file più piccoli.`,
      413,
    );
  const out = new Map<string, Uint8Array>();
  for (const x of chosen) {
    deadline.check();
    if (x.flags & 1) throw new FileRejected(`${BAD}: è protetto da una password`);
    if (x.method !== 0 && x.method !== 8)
      throw new FileRejected(`${BAD}: usa una compressione non prevista`);
    const lh = x.localOffset;
    if (lh + 30 > bytes.length || u32(bytes, lh) !== 0x04034b50) throw new FileRejected(BAD);
    const start = lh + 30 + u16(bytes, lh + 26) + u16(bytes, lh + 28);
    const end = start + x.compressedSize;
    if (end > bytes.length) throw new FileRejected(BAD);
    let data: Uint8Array;
    try {
      data =
        x.method === 0
          ? bytes.slice(start, end)
          : inflateSync(bytes.subarray(start, end), { out: new Uint8Array(x.size) });
    } catch {
      throw new FileRejected(BAD);
    }
    if (data.length !== x.size || crc32(data) !== x.crc)
      throw new FileRejected(`${BAD}: una parte non corrisponde al suo controllo (CRC)`);
    out.set(x.name, data);
  }
  return out;
}
