/**
 * Globali di Node nel Web Worker del servizio (D221): `process`, `Buffer` con la codifica
 * `base64url` che il pacchetto `buffer` non ha, `global`, `setImmediate`. Si importa per primo.
 */
import { Buffer } from 'node:buffer';
import proc from './process';

const isBase64Url = (e: unknown) => typeof e === 'string' && e.toLowerCase() === 'base64url';
const toUrl = (b64: string) => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

// Il decodificatore del pacchetto accetta già «-» e «_»: basta il nome della codifica.
const from = Buffer.from.bind(Buffer) as (...args: unknown[]) => Buffer;
Buffer.from = ((value: unknown, encodingOrOffset?: unknown, length?: unknown) =>
  typeof value === 'string' && isBase64Url(encodingOrOffset)
    ? from(value, 'base64')
    : from(value, encodingOrOffset, length)) as typeof Buffer.from;

type ToString = (this: Buffer, ...args: unknown[]) => string;
const proto = Buffer.prototype as unknown as { toString: ToString };
const toString = proto.toString;
proto.toString = function (this: Buffer, encoding?: unknown, ...rest: unknown[]) {
  return isBase64Url(encoding)
    ? toUrl(toString.call(this, 'base64', ...rest))
    : toString.call(this, encoding, ...rest);
};

const byteLength = Buffer.byteLength.bind(Buffer) as (...args: unknown[]) => number;
Buffer.byteLength = (value: unknown, encoding?: unknown) =>
  byteLength(value, isBase64Url(encoding) ? 'base64' : encoding);

const isEncoding = Buffer.isEncoding.bind(Buffer);
Buffer.isEncoding = (encoding: string): encoding is BufferEncoding =>
  isBase64Url(encoding) || isEncoding(encoding);

// setImmediate con un MessageChannel: senza il ritardo minimo di setTimeout.
const channel = new MessageChannel();
const queue = new Map<number, () => void>();
let next = 0;
channel.port1.onmessage = (e: MessageEvent<number>) => {
  const fn = queue.get(e.data);
  queue.delete(e.data);
  fn?.();
};
function setImmediate(fn: (...args: unknown[]) => void, ...args: unknown[]) {
  const id = ++next;
  queue.set(id, () => fn(...args));
  channel.port2.postMessage(id);
  return id;
}
function clearImmediate(id: number) {
  queue.delete(id);
}

const g = globalThis as unknown as Record<string, unknown>;
g.process = proc;
g.Buffer = Buffer;
g.global = globalThis;
g.setImmediate = setImmediate;
g.clearImmediate = clearImmediate;
