/** `node:assert` nel browser (D221). */
import { isDeepStrictEqual } from './util';

export class AssertionError extends Error {
  readonly code = 'ERR_ASSERTION';
  constructor(options: { message?: string } | string = {}) {
    super(typeof options === 'string' ? options : (options.message ?? 'Assertion failed'));
    this.name = 'AssertionError';
  }
}

function fail(message?: string | Error): never {
  if (message instanceof Error) throw message;
  throw new AssertionError({ message: message ?? 'Assertion failed' });
}

function assert(value: unknown, message?: string | Error): asserts value {
  if (!value) fail(message);
}
assert.ok = assert;
assert.fail = fail;
assert.equal = (a: unknown, b: unknown, m?: string) => {
  if (a != b) fail(m ?? `${String(a)} == ${String(b)}`);
};
assert.notEqual = (a: unknown, b: unknown, m?: string) => {
  if (a == b) fail(m ?? `${String(a)} != ${String(b)}`);
};
assert.strictEqual = (a: unknown, b: unknown, m?: string) => {
  if (!Object.is(a, b)) fail(m ?? `${String(a)} === ${String(b)}`);
};
assert.notStrictEqual = (a: unknown, b: unknown, m?: string) => {
  if (Object.is(a, b)) fail(m ?? `${String(a)} !== ${String(b)}`);
};
assert.deepEqual = (a: unknown, b: unknown, m?: string) => {
  if (!isDeepStrictEqual(a, b)) fail(m ?? 'deepEqual');
};
assert.deepStrictEqual = assert.deepEqual;
assert.notDeepStrictEqual = (a: unknown, b: unknown, m?: string) => {
  if (isDeepStrictEqual(a, b)) fail(m ?? 'notDeepStrictEqual');
};
assert.throws = (fn: () => unknown, _expected?: unknown, m?: string) => {
  try {
    fn();
  } catch {
    return;
  }
  fail(m ?? 'Missing expected exception');
};
assert.ifError = (v: unknown) => {
  if (v !== null && v !== undefined) throw v as Error;
};
assert.match = (s: string, re: RegExp, m?: string) => {
  if (!re.test(s)) fail(m ?? `${s} non corrisponde a ${String(re)}`);
};
assert.AssertionError = AssertionError;
assert.strict = assert;

export default assert;
export const {
  ok,
  equal,
  strictEqual,
  deepEqual,
  deepStrictEqual,
  notEqual,
  notStrictEqual,
  throws,
  ifError,
  match,
} = assert;
export { fail };
