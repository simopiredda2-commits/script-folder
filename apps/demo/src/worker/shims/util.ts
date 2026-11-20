/** `node:util` nel browser (D221): le funzioni che usano il programma e le sue librerie. */
type Fn = (...args: unknown[]) => unknown;

export function inherits(ctor: Fn & { super_?: unknown }, superCtor: Fn) {
  ctor.super_ = superCtor;
  Object.setPrototypeOf(ctor.prototype, superCtor.prototype as object);
}

const custom = Symbol.for('nodejs.util.inspect.custom');

export function inspect(value: unknown, _options?: unknown): string {
  if (typeof value === 'string') return `'${value}'`;
  if (value instanceof Error) return value.stack ?? value.message;
  if (typeof value === 'function') return `[Function: ${value.name || 'anonymous'}]`;
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'symbol') return value.toString();
  try {
    return (
      JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? `${v}n` : v)) ??
      String(value)
    );
  } catch {
    return String(value);
  }
}
inspect.custom = custom;

export function format(f: unknown, ...args: unknown[]): string {
  if (typeof f !== 'string')
    return [f, ...args].map((a) => (typeof a === 'string' ? a : inspect(a))).join(' ');
  let i = 0;
  const out = f.replace(/%[sdifjoO%]/g, (m) => {
    if (m === '%%') return '%';
    if (i >= args.length) return m;
    const a = args[i++];
    switch (m) {
      case '%s':
        return typeof a === 'string' ? a : inspect(a);
      case '%d':
      case '%i':
        return String(parseInt(String(a), 10));
      case '%f':
        return String(parseFloat(String(a)));
      default:
        return inspect(a);
    }
  });
  return [out, ...args.slice(i).map((a) => (typeof a === 'string' ? a : inspect(a)))].join(' ');
}

export function promisify<T>(fn: Fn & { [promisify.custom]?: Fn }) {
  const own = fn[promisify.custom];
  if (own) return own;
  return (...args: unknown[]) =>
    new Promise<T>((resolve, reject) => {
      fn(...args, (err: unknown, value: T) =>
        err ? reject(err instanceof Error ? err : new Error(inspect(err))) : resolve(value),
      );
    });
}
promisify.custom = Symbol.for('nodejs.util.promisify.custom');

export function callbackify(fn: (...args: unknown[]) => Promise<unknown>) {
  return (...args: unknown[]) => {
    const cb = args.pop() as (err: unknown, value?: unknown) => void;
    fn(...args).then(
      (v) => cb(null, v),
      (e: unknown) => cb(e),
    );
  };
}

export function deprecate<T extends Fn>(fn: T, message: string): T {
  let warned = false;
  return function (this: unknown, ...args: unknown[]) {
    if (!warned) {
      warned = true;
      console.warn(message);
    }
    return fn.apply(this, args);
  } as T;
}

export const debuglog = () => Object.assign(() => undefined, { enabled: false });
export const debug = debuglog;

export const types = {
  isDate: (v: unknown) => v instanceof Date,
  isRegExp: (v: unknown) => v instanceof RegExp,
  isPromise: (v: unknown) => v instanceof Promise,
  isUint8Array: (v: unknown) => v instanceof Uint8Array,
  isArrayBuffer: (v: unknown) => v instanceof ArrayBuffer,
  isAnyArrayBuffer: (v: unknown) => v instanceof ArrayBuffer,
  isArrayBufferView: (v: unknown) => ArrayBuffer.isView(v),
  isTypedArray: (v: unknown) => ArrayBuffer.isView(v) && !(v instanceof DataView),
  isNativeError: (v: unknown) => v instanceof Error,
  isMap: (v: unknown) => v instanceof Map,
  isSet: (v: unknown) => v instanceof Set,
  isAsyncFunction: (v: unknown) =>
    typeof v === 'function' && v.constructor?.name === 'AsyncFunction',
  isGeneratorFunction: (v: unknown) =>
    typeof v === 'function' && /GeneratorFunction/.test(v.constructor?.name ?? ''),
  isBoxedPrimitive: () => false,
  isProxy: () => false,
};

export function isDeepStrictEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    isDeepStrictEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

export const isArray = Array.isArray;
export const isError = (v: unknown) => v instanceof Error;
export const isFunction = (v: unknown) => typeof v === 'function';
export const isString = (v: unknown) => typeof v === 'string';
export const isObject = (v: unknown) => v !== null && typeof v === 'object';
export const isBuffer = (v: unknown) =>
  (globalThis as { Buffer?: { isBuffer(x: unknown): boolean } }).Buffer?.isBuffer(v) ?? false;
const ANSI_COLORS = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
export const stripVTControlCharacters = (s: string) => s.replace(ANSI_COLORS, '');
export const styleText = (_style: unknown, text: string) => text;
export function parseArgs(): never {
  throw new Error('parseArgs non serve nel browser');
}

const TextEncoderClass = globalThis.TextEncoder;
const TextDecoderClass = globalThis.TextDecoder;
export { TextEncoderClass as TextEncoder, TextDecoderClass as TextDecoder };

export default {
  inherits,
  inspect,
  format,
  promisify,
  callbackify,
  deprecate,
  debuglog,
  debug,
  types,
  isDeepStrictEqual,
  isArray,
  isError,
  isFunction,
  isString,
  isObject,
  isBuffer,
  stripVTControlCharacters,
  styleText,
  parseArgs,
  TextEncoder: TextEncoderClass,
  TextDecoder: TextDecoderClass,
};
