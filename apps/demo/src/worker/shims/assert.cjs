'use strict';
/**
 * `node:assert` nel browser (D221), in CommonJS: chi fa require('assert') riceve proprio la
 * funzione, come in Node (il router di Fastify la chiama così).
 */
class AssertionError extends Error {
  constructor(options) {
    super(
      typeof options === 'string' ? options : (options && options.message) || 'Assertion failed',
    );
    this.name = 'AssertionError';
    this.code = 'ERR_ASSERTION';
  }
}

function fail(message) {
  if (message instanceof Error) throw message;
  throw new AssertionError({ message: message || 'Assertion failed' });
}

function deepEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
}

function assert(value, message) {
  if (!value) fail(message);
}
assert.ok = assert;
assert.fail = fail;
assert.equal = (a, b, m) => {
  if (a != b) fail(m || `${String(a)} == ${String(b)}`);
};
assert.notEqual = (a, b, m) => {
  if (a == b) fail(m || `${String(a)} != ${String(b)}`);
};
assert.strictEqual = (a, b, m) => {
  if (!Object.is(a, b)) fail(m || `${String(a)} === ${String(b)}`);
};
assert.notStrictEqual = (a, b, m) => {
  if (Object.is(a, b)) fail(m || `${String(a)} !== ${String(b)}`);
};
assert.deepEqual = (a, b, m) => {
  if (!deepEqual(a, b)) fail(m || 'deepEqual');
};
assert.deepStrictEqual = assert.deepEqual;
assert.notDeepStrictEqual = (a, b, m) => {
  if (deepEqual(a, b)) fail(m || 'notDeepStrictEqual');
};
assert.throws = (fn, _expected, m) => {
  try {
    fn();
  } catch {
    return;
  }
  fail(m || 'Missing expected exception');
};
assert.ifError = (v) => {
  if (v !== null && v !== undefined) throw v;
};
assert.match = (s, re, m) => {
  if (!re.test(s)) fail(m || `${s} non corrisponde a ${String(re)}`);
};
assert.AssertionError = AssertionError;
assert.strict = assert;
assert.default = assert;

module.exports = assert;
