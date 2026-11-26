/**
 * `node:crypto` per il servizio nel browser (D221): solo ciò che il programma usa. Impronte, HMAC,
 * scrypt e HKDF da @noble/hashes, AES-256-GCM da @noble/ciphers, numeri casuali dal browser, RSA
 * in ./rsa. Stesse firme di Node, sincrone dove Node è sincrono.
 */
import { gcm } from '@noble/ciphers/aes.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { md5, sha1 } from '@noble/hashes/legacy.js';
import { scrypt as scryptSyncImpl, scryptAsync } from '@noble/hashes/scrypt.js';
import { sha224, sha256, sha384, sha512 } from '@noble/hashes/sha2.js';
import { Buffer } from 'node:buffer';
import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  KeyObject,
  privateDecrypt,
  publicEncrypt,
  RSA_PKCS1_PADDING,
  sign,
  verify,
  X509Certificate,
} from './rsa';

type Data = string | ArrayBufferView | ArrayBuffer;
type Encoding = string | undefined;

function bytes(data: Data, encoding?: Encoding): Uint8Array {
  if (typeof data === 'string')
    return new Uint8Array(Buffer.from(data, (encoding ?? 'utf8') as 'utf8'));
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}
const out = (b: Uint8Array, encoding?: Encoding) =>
  encoding ? Buffer.from(b).toString(encoding as 'hex') : Buffer.from(b);

const HASHES = { sha1, sha224, sha256, sha384, sha512, md5 } as const;
type HashFn = (typeof HASHES)[keyof typeof HASHES];
function hashOf(name: string): HashFn {
  const h = HASHES[name.toLowerCase().replace(/^rsa-/, '').replace('-', '') as keyof typeof HASHES];
  if (!h) throw new Error(`Impronta ${name} non disponibile nella dimostrazione`);
  return h;
}

interface Incremental {
  update(b: Uint8Array): Incremental;
  digest(): Uint8Array;
  clone(): Incremental;
}

class Hash {
  constructor(private readonly h: Incremental) {}
  update(data: Data, encoding?: Encoding) {
    this.h.update(bytes(data, encoding));
    return this;
  }
  digest(encoding?: Encoding) {
    return out(this.h.digest(), encoding);
  }
  copy() {
    return new Hash(this.h.clone());
  }
}

export const createHash = (algorithm: string) => new Hash(hashOf(algorithm).create());
export const createHmac = (algorithm: string, key: Data) =>
  new Hash(hmac.create(hashOf(algorithm), bytes(key)));
export const getHashes = () => Object.keys(HASHES);

export function getRandomValues<T extends ArrayBufferView>(array: T): T {
  return globalThis.crypto.getRandomValues(
    array as unknown as Uint8Array<ArrayBuffer>,
  ) as unknown as T;
}

export function randomBytes(size: number, callback?: (err: Error | null, buf: Buffer) => void) {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i += 65_536)
    globalThis.crypto.getRandomValues(buf.subarray(i, Math.min(size, i + 65_536)));
  if (callback) {
    queueMicrotask(() => callback(null, buf));
    return undefined as unknown as Buffer;
  }
  return buf;
}

export const randomUUID = () => globalThis.crypto.randomUUID();

export function randomInt(min: number, max?: number): number {
  const [lo, hi] = max === undefined ? [0, min] : [min, max];
  const range = hi - lo;
  const limit = Math.floor(0x1_0000_0000 / range) * range;
  const u = new Uint32Array(1);
  do globalThis.crypto.getRandomValues(u);
  while (u[0]! >= limit);
  return lo + (u[0]! % range);
}

export function timingSafeEqual(a: ArrayBufferView, b: ArrayBufferView): boolean {
  const x = bytes(a);
  const y = bytes(b);
  if (x.length !== y.length) throw new RangeError('Input buffers must have the same byte length');
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

interface ScryptOptions {
  N?: number;
  r?: number;
  p?: number;
  cost?: number;
  blockSize?: number;
  parallelization?: number;
  maxmem?: number;
}
const scryptParams = (o: ScryptOptions, keylen: number) => ({
  N: o.N ?? o.cost ?? 16_384,
  r: o.r ?? o.blockSize ?? 8,
  p: o.p ?? o.parallelization ?? 1,
  dkLen: keylen,
  maxmem: o.maxmem ?? 32 * 1024 * 1024 + 1024,
});

export function scrypt(
  password: Data,
  salt: Data,
  keylen: number,
  options: ScryptOptions | ((err: Error | null, key: Buffer) => void),
  callback?: (err: Error | null, key: Buffer) => void,
) {
  const cb = typeof options === 'function' ? options : callback!;
  const opts = typeof options === 'function' ? {} : options;
  scryptAsync(bytes(password), bytes(salt), scryptParams(opts, keylen)).then(
    (key) => cb(null, Buffer.from(key)),
    (err: Error) => cb(err, Buffer.alloc(0)),
  );
}

export const scryptSync = (
  password: Data,
  salt: Data,
  keylen: number,
  options: ScryptOptions = {},
) => Buffer.from(scryptSyncImpl(bytes(password), bytes(salt), scryptParams(options, keylen)));

export function hkdfSync(digest: string, ikm: Data, salt: Data, info: Data, keylen: number) {
  const key = hkdf(hashOf(digest), bytes(ikm), bytes(salt), bytes(info), keylen);
  return key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength);
}

/** AES-256-GCM con l'interfaccia di Node: il testo si cifra tutto in final(). */
class Gcm {
  private readonly chunks: Uint8Array[] = [];
  private aad?: Uint8Array;
  private tag?: Uint8Array;
  constructor(
    private readonly key: Uint8Array,
    private readonly iv: Uint8Array,
    private readonly decrypting: boolean,
  ) {}
  setAAD(aad: Data) {
    this.aad = bytes(aad);
    return this;
  }
  setAuthTag(tag: Data) {
    this.tag = bytes(tag);
    return this;
  }
  getAuthTag() {
    if (!this.tag) throw new Error('Il tag si legge dopo final()');
    return Buffer.from(this.tag);
  }
  setAutoPadding() {
    return this;
  }
  update(data: Data, inputEncoding?: Encoding, outputEncoding?: Encoding) {
    this.chunks.push(bytes(data, inputEncoding));
    return outputEncoding ? '' : Buffer.alloc(0);
  }
  final(outputEncoding?: Encoding) {
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const input = new Uint8Array(total);
    let o = 0;
    for (const c of this.chunks) {
      input.set(c, o);
      o += c.length;
    }
    const cipher = gcm(this.key, this.iv, this.aad);
    if (this.decrypting) {
      if (!this.tag) throw new Error('Unsupported state or unable to authenticate data');
      const sealed = new Uint8Array(total + this.tag.length);
      sealed.set(input);
      sealed.set(this.tag, total);
      try {
        return out(cipher.decrypt(sealed), outputEncoding);
      } catch {
        throw new Error('Unsupported state or unable to authenticate data');
      }
    }
    const sealed = cipher.encrypt(input);
    this.tag = sealed.slice(sealed.length - 16);
    return out(sealed.subarray(0, sealed.length - 16), outputEncoding);
  }
}

function checkAlgorithm(algorithm: string) {
  if (algorithm.toLowerCase() !== 'aes-256-gcm')
    throw new Error(`Cifratura ${algorithm} non disponibile nella dimostrazione`);
}
export function createCipheriv(algorithm: string, key: Data, iv: Data) {
  checkAlgorithm(algorithm);
  return new Gcm(bytes(key), bytes(iv), false);
}
export function createDecipheriv(algorithm: string, key: Data, iv: Data) {
  checkAlgorithm(algorithm);
  return new Gcm(bytes(key), bytes(iv), true);
}

export const webcrypto = globalThis.crypto;
export const subtle = globalThis.crypto.subtle;
export const constants = { RSA_PKCS1_PADDING };

export {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  KeyObject,
  privateDecrypt,
  publicEncrypt,
  sign,
  verify,
  X509Certificate,
};

export default {
  createHash,
  createHmac,
  getHashes,
  getRandomValues,
  randomBytes,
  randomUUID,
  randomInt,
  timingSafeEqual,
  scrypt,
  scryptSync,
  hkdfSync,
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  KeyObject,
  privateDecrypt,
  publicEncrypt,
  sign,
  verify,
  X509Certificate,
  webcrypto,
  subtle,
  constants,
};
