'use strict';
/**
 * `node:process` per chi lo chiede con require (D221): lo stesso oggetto che globals.ts mette in
 * globalThis.process prima di ogni altro modulo.
 */
module.exports = globalThis.process;
