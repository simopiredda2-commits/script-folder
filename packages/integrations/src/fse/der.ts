/**
 * Codifica DER (ASN.1) minima, per i certificati di prova e la firma CMS del simulatore. Solo
 * i tipi che servono; ogni struttura prodotta è controllata nelle prove con Node e con OpenSSL.
 */

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export const tlv = (tag: number, content: Buffer) =>
  Buffer.concat([Buffer.from([tag]), length(content.length), content]);

/** Il contenuto di un elemento DER, senza etichetta e lunghezza. */
export function contentOf(b: Buffer): Buffer {
  const l = b[1]!;
  return b.subarray(l & 0x80 ? 2 + (l & 0x7f) : 2);
}

/** Lunghezza totale (etichetta, lunghezza, contenuto) del primo elemento DER del buffer. */
export function elementLength(b: Buffer): number {
  const l = b[1]!;
  if (!(l & 0x80)) return 2 + l;
  const n = l & 0x7f;
  return 2 + n + b.subarray(2, 2 + n).readUIntBE(0, n);
}

export const sequence = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
export const set = (...items: Buffer[]) => {
  // DER: gli elementi di un SET OF in ordine di codifica.
  const sorted = [...items].sort((a, b) => Buffer.compare(a, b));
  return tlv(0x31, Buffer.concat(sorted));
};
export const nullValue = () => Buffer.from([0x05, 0x00]);
export const octetString = (b: Buffer) => tlv(0x04, b);
export const bitString = (b: Buffer) => tlv(0x03, Buffer.concat([Buffer.from([0]), b]));
export const utf8String = (s: string) => tlv(0x0c, Buffer.from(s, 'utf8'));
export const printableString = (s: string) => tlv(0x13, Buffer.from(s, 'ascii'));
/** Contesto esplicito [n]. */
export const explicit = (n: number, content: Buffer) => tlv(0xa0 | n, content);
/** Contesto implicito [n] costruito (per i campi di CMS). */
export const implicitConstructed = (n: number, content: Buffer) => tlv(0xa0 | n, content);

export function integer(value: bigint | number | Buffer): Buffer {
  let b: Buffer;
  if (Buffer.isBuffer(value)) b = value;
  else {
    let hex = BigInt(value).toString(16);
    if (hex.length % 2) hex = `0${hex}`;
    b = Buffer.from(hex, 'hex');
  }
  // Senza zeri inutili in testa, e con uno zero se il primo bit è 1 (numero positivo).
  let i = 0;
  while (i < b.length - 1 && b[i] === 0 && (b[i + 1]! & 0x80) === 0) i++;
  b = b.subarray(i);
  if (b[0]! & 0x80) b = Buffer.concat([Buffer.from([0]), b]);
  return tlv(0x02, b);
}

export function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map((p) => BigInt(p));
  const bytes: number[] = [Number(parts[0]! * 40n + parts[1]!)];
  for (const p of parts.slice(2)) {
    const chunk: number[] = [];
    let v = p;
    do {
      chunk.unshift(Number(v & 0x7fn));
      v >>= 7n;
    } while (v > 0n);
    for (let i = 0; i < chunk.length - 1; i++) chunk[i]! |= 0x80;
    bytes.push(...chunk);
  }
  return tlv(0x06, Buffer.from(bytes));
}

const two = (n: number) => String(n).padStart(2, '0');

/** UTCTime (AAMMGGhhmmssZ), per le date fino al 2049. */
export function utcTime(d: Date): Buffer {
  const s = `${two(d.getUTCFullYear() % 100)}${two(d.getUTCMonth() + 1)}${two(d.getUTCDate())}${two(
    d.getUTCHours(),
  )}${two(d.getUTCMinutes())}${two(d.getUTCSeconds())}Z`;
  return tlv(0x17, Buffer.from(s, 'ascii'));
}

/** Identificatori degli algoritmi e degli attributi usati (RFC 5280, RFC 5652, RFC 5035). */
export const OIDS = {
  rsaEncryption: '1.2.840.113549.1.1.1',
  sha256WithRSAEncryption: '1.2.840.113549.1.1.11',
  sha256: '2.16.840.1.101.3.4.2.1',
  commonName: '2.5.4.3',
  organizationName: '2.5.4.10',
  countryName: '2.5.4.6',
  serialNumber: '2.5.4.5',
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
} as const;
