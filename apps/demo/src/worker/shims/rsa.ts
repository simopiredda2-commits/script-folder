/**
 * RSA per i simulatori del Fascicolo nel browser (D221): firma e verifica PKCS#1 v1.5, chiavi
 * PKCS#8 e SPKI, lettura dei certificati X.509 di prova. Il browser non ha le funzioni sincrone di
 * Node; queste lavorano con i BigInt. Le chiavi «generate» vengono da una scorta di chiavi di prova
 * create con Node durante la costruzione della dimostrazione (generarle qui costerebbe secondi).
 */
import { sha1 } from '@noble/hashes/legacy.js';
import { sha256, sha384, sha512 } from '@noble/hashes/sha2.js';
import { Buffer } from 'node:buffer';
import KEY_POOL from 'virtual:demo-rsa-keys';

// ---------- DER ----------

interface Der {
  tag: number;
  content: Uint8Array;
  raw: Uint8Array;
  end: number;
}

function readDer(buf: Uint8Array, offset = 0): Der {
  const tag = buf[offset]!;
  let len = buf[offset + 1]!;
  let p = offset + 2;
  if (len & 0x80) {
    const count = len & 0x7f;
    len = 0;
    for (let i = 0; i < count; i++) len = len * 256 + buf[p++]!;
  }
  return {
    tag,
    content: buf.subarray(p, p + len),
    raw: buf.subarray(offset, p + len),
    end: p + len,
  };
}

function childrenOf(node: Der): Der[] {
  const out: Der[] = [];
  for (let o = 0; o < node.content.length;) {
    const child = readDer(node.content, o);
    out.push(child);
    o = child.end;
  }
  return out;
}

const concat = (parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

function derLength(n: number): number[] {
  if (n < 128) return [n];
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return [0x80 | bytes.length, ...bytes];
}
const tlv = (tag: number, content: Uint8Array) =>
  concat([Uint8Array.from([tag, ...derLength(content.length)]), content]);
const sequence = (...parts: Uint8Array[]) => tlv(0x30, concat(parts));

const toBig = (b: Uint8Array) => (b.length ? BigInt(`0x${Buffer.from(b).toString('hex')}`) : 0n);
function fromBig(n: bigint, length?: number): Uint8Array {
  let hex = n.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const b = new Uint8Array(Buffer.from(hex, 'hex'));
  if (length === undefined || b.length >= length) return b;
  const out = new Uint8Array(length);
  out.set(b, length - b.length);
  return out;
}
function derInteger(n: bigint) {
  const b = fromBig(n);
  return tlv(0x02, b[0]! & 0x80 ? concat([Uint8Array.of(0), b]) : b);
}

const RSA_ALGORITHM = sequence(
  Uint8Array.from([0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]),
  Uint8Array.from([0x05, 0x00]),
);

const spkiOf = (n: bigint, e: bigint) =>
  sequence(
    RSA_ALGORITHM,
    tlv(0x03, concat([Uint8Array.of(0), sequence(derInteger(n), derInteger(e))])),
  );

function pemToDer(pem: string): { label: string; der: Uint8Array } {
  const m = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/.exec(pem);
  if (!m) throw new Error('Chiave o certificato PEM non leggibile');
  return { label: m[1]!, der: new Uint8Array(Buffer.from(m[2]!.replace(/\s+/g, ''), 'base64')) };
}
function derToPem(der: Uint8Array, label: string): string {
  const lines = Buffer.from(der)
    .toString('base64')
    .match(/.{1,64}/g)!
    .join('\n');
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`;
}

// ---------- chiavi ----------

interface RsaPublic {
  n: bigint;
  e: bigint;
}
interface RsaPrivate extends RsaPublic {
  d: bigint;
  p: bigint;
  q: bigint;
  dp: bigint;
  dq: bigint;
  qi: bigint;
}

function parsePkcs8(der: Uint8Array): RsaPrivate {
  const [, , key] = childrenOf(readDer(der));
  const [, n, e, d, p, q, dp, dq, qi] = childrenOf(readDer(key!.content)).map((x) =>
    toBig(x.content),
  );
  return { n: n!, e: e!, d: d!, p: p!, q: q!, dp: dp!, dq: dq!, qi: qi! };
}
function parseSpki(der: Uint8Array): RsaPublic {
  const [, bits] = childrenOf(readDer(der));
  const [n, e] = childrenOf(readDer(bits!.content.subarray(1))).map((x) => toBig(x.content));
  return { n: n!, e: e! };
}

const bitLength = (n: bigint) => n.toString(2).length;

type ExportOptions = { type?: string; format?: string };

export class KeyObject {
  readonly asymmetricKeyType = 'rsa';
  constructor(
    readonly type: 'private' | 'public',
    private readonly der: Uint8Array,
    readonly rsa: RsaPublic | RsaPrivate,
  ) {}
  get asymmetricKeyDetails() {
    return { modulusLength: bitLength(this.rsa.n), publicExponent: this.rsa.e };
  }
  export(options: ExportOptions = {}): string | Buffer {
    const pem = options.format !== 'der';
    if (options.type === 'pkcs8' && this.type === 'private')
      return pem ? derToPem(this.der, 'PRIVATE KEY') : Buffer.from(this.der);
    if (options.type === 'spki') {
      const spki = this.type === 'public' ? this.der : spkiOf(this.rsa.n, this.rsa.e);
      return pem ? derToPem(spki, 'PUBLIC KEY') : Buffer.from(spki);
    }
    throw new Error(`Esportazione della chiave non disponibile: ${options.type}/${options.format}`);
  }
  equals(other: KeyObject) {
    return other.rsa.n === this.rsa.n && other.rsa.e === this.rsa.e && other.type === this.type;
  }
}

const privateFromDer = (der: Uint8Array) => new KeyObject('private', der, parsePkcs8(der));
const publicOf = (k: KeyObject) =>
  k.type === 'public'
    ? k
    : new KeyObject('public', spkiOf(k.rsa.n, k.rsa.e), { n: k.rsa.n, e: k.rsa.e });

type KeyInput =
  KeyObject | string | Uint8Array | { key: string | Uint8Array; format?: string; type?: string };

function keyFrom(input: KeyInput): KeyObject {
  if (input instanceof KeyObject) return input;
  const key = typeof input === 'object' && 'key' in input ? input : { key: input };
  if (typeof key.key !== 'string' && 'format' in key && key.format === 'der')
    return key.type === 'spki'
      ? new KeyObject('public', key.key, parseSpki(key.key))
      : privateFromDer(key.key);
  const text = typeof key.key === 'string' ? key.key : Buffer.from(key.key).toString('utf8');
  const { label, der } = pemToDer(text);
  if (label === 'PRIVATE KEY') return privateFromDer(der);
  if (label === 'PUBLIC KEY') return new KeyObject('public', der, parseSpki(der));
  throw new Error(`Tipo di chiave PEM non disponibile: ${label}`);
}

export const createPrivateKey = (input: KeyInput) => keyFrom(input);
export const createPublicKey = (input: KeyInput) => publicOf(keyFrom(input));

let nextKey = 0;
/** Una chiave della scorta, a turno: per i certificati di prova dei simulatori basta. */
export function generateKeyPairSync(
  type: string,
  options: {
    modulusLength?: number;
    publicKeyEncoding?: ExportOptions;
    privateKeyEncoding?: ExportOptions;
  } = {},
) {
  if (type !== 'rsa') throw new Error(`Chiavi ${type} non disponibili nella dimostrazione`);
  const der = new Uint8Array(Buffer.from(KEY_POOL[nextKey++ % KEY_POOL.length]!, 'base64'));
  const privateKey = privateFromDer(der);
  const publicKey = publicOf(privateKey);
  return {
    publicKey: options.publicKeyEncoding ? publicKey.export(options.publicKeyEncoding) : publicKey,
    privateKey: options.privateKeyEncoding
      ? privateKey.export(options.privateKeyEncoding)
      : privateKey,
  };
}

// ---------- firma PKCS#1 v1.5 ----------

const DIGESTS: Record<string, { hash: (m: Uint8Array) => Uint8Array; prefix: number[] }> = {
  sha1: {
    hash: sha1,
    prefix: [
      0x30, 0x21, 0x30, 0x09, 0x06, 0x05, 0x2b, 0x0e, 0x03, 0x02, 0x1a, 0x05, 0x00, 0x04, 0x14,
    ],
  },
  sha256: {
    hash: sha256,
    prefix: [
      0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01,
      0x05, 0x00, 0x04, 0x20,
    ],
  },
  sha384: {
    hash: sha384,
    prefix: [
      0x30, 0x41, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x02,
      0x05, 0x00, 0x04, 0x30,
    ],
  },
  sha512: {
    hash: sha512,
    prefix: [
      0x30, 0x51, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x03,
      0x05, 0x00, 0x04, 0x40,
    ],
  },
};

function digestOf(algorithm: string | null | undefined) {
  const name = (algorithm ?? 'sha256').toLowerCase().replace(/^rsa-/, '').replace('-', '');
  const d = DIGESTS[name];
  if (!d) throw new Error(`Firma con ${algorithm} non disponibile nella dimostrazione`);
  return d;
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = base % modulus;
  for (let e = exponent; e > 0n; e >>= 1n) {
    if (e & 1n) result = (result * b) % modulus;
    b = (b * b) % modulus;
  }
  return result;
}

function encoded(algorithm: string | null | undefined, data: Uint8Array, k: number): Uint8Array {
  const { hash, prefix } = digestOf(algorithm);
  const t = concat([Uint8Array.from(prefix), hash(data)]);
  if (k < t.length + 11) throw new Error('Chiave RSA troppo corta');
  const em = new Uint8Array(k).fill(0xff);
  em[0] = 0;
  em[1] = 1;
  em[k - t.length - 1] = 0;
  em.set(t, k - t.length);
  return em;
}

const bytesOf = (data: ArrayBufferView | ArrayBuffer | string): Uint8Array =>
  typeof data === 'string'
    ? new Uint8Array(Buffer.from(data, 'utf8'))
    : data instanceof ArrayBuffer
      ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

export function sign(
  algorithm: string | null | undefined,
  data: ArrayBufferView | ArrayBuffer | string,
  keyInput: KeyInput,
): Buffer {
  const key = keyFrom(keyInput);
  if (key.type !== 'private') throw new Error('Per firmare serve la chiave privata');
  const r = key.rsa as RsaPrivate;
  const k = Math.ceil(bitLength(r.n) / 8);
  const m = toBig(encoded(algorithm, bytesOf(data), k));
  // Teorema cinese del resto: due potenze a metà lunghezza.
  const s1 = modPow(m, r.dp, r.p);
  const s2 = modPow(m, r.dq, r.q);
  const h = (((s1 - s2) % r.p) + r.p) % r.p;
  const s = s2 + ((r.qi * h) % r.p) * r.q;
  return Buffer.from(fromBig(s, k));
}

export function verify(
  algorithm: string | null | undefined,
  data: ArrayBufferView | ArrayBuffer | string,
  keyInput: KeyInput,
  signature: ArrayBufferView | ArrayBuffer,
): boolean {
  const key = publicOf(keyFrom(keyInput));
  const k = Math.ceil(bitLength(key.rsa.n) / 8);
  const sig = bytesOf(signature);
  if (sig.length !== k) return false;
  const m = fromBig(modPow(toBig(sig), key.rsa.e, key.rsa.n), k);
  const expected = encoded(algorithm, bytesOf(data), k);
  return m.length === expected.length && m.every((b, i) => b === expected[i]);
}

// ---------- certificati ----------

/** Il necessario dei certificati di prova: chiave pubblica, impronte, testo e verifica. */
export class X509Certificate {
  readonly raw: Buffer;
  readonly publicKey: KeyObject;
  readonly serialNumber: string;
  private readonly tbs: Uint8Array;
  private readonly signature: Uint8Array;

  constructor(input: string | ArrayBufferView) {
    const der =
      typeof input === 'string'
        ? pemToDer(input).der
        : /-----BEGIN/.test(Buffer.from(bytesOf(input).subarray(0, 32)).toString('latin1'))
          ? pemToDer(Buffer.from(bytesOf(input)).toString('utf8')).der
          : bytesOf(input);
    const [tbs, , signature] = childrenOf(readDer(der));
    if (!tbs || !signature) throw new Error('Certificato non leggibile');
    const fields = childrenOf(tbs);
    const offset = fields[0]!.tag === 0xa0 ? 1 : 0;
    const spki = fields[offset + 5]!;
    this.raw = Buffer.from(der);
    this.tbs = tbs.raw;
    this.signature = signature.content.subarray(1);
    this.serialNumber = Buffer.from(fields[offset]!.content).toString('hex').toUpperCase();
    this.publicKey = new KeyObject('public', spki.raw, parseSpki(spki.raw));
  }
  private fingerprintWith(hash: (m: Uint8Array) => Uint8Array) {
    return [...hash(this.raw)].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
  }
  get fingerprint() {
    return this.fingerprintWith(sha1);
  }
  get fingerprint256() {
    return this.fingerprintWith(sha256);
  }
  get fingerprint512() {
    return this.fingerprintWith(sha512);
  }
  verify(key: KeyObject): boolean {
    return verify('sha256', this.tbs, key, this.signature);
  }
  checkPrivateKey(key: KeyObject): boolean {
    return key.rsa.n === this.publicKey.rsa.n;
  }
  toString() {
    return derToPem(this.raw, 'CERTIFICATE');
  }
  toJSON() {
    return this.toString();
  }
}
