/** Moduli di Node che nel browser non servono (D221): chi li usa davvero riceve un errore chiaro. */
const unavailable = (name: string) => () => {
  throw new Error(`${name} non è disponibile nella dimostrazione`);
};
export const lookup = unavailable('dns.lookup');
export const resolve = unavailable('dns.resolve');
export const promises = {};
export const createGzip = unavailable('zlib');
export const createGunzip = unavailable('zlib');
export const gzipSync = unavailable('zlib');
export const gunzipSync = unavailable('zlib');
export const inflateSync = unavailable('zlib');
export const deflateSync = unavailable('zlib');
export const constants = {};
export const Worker = unavailable('worker_threads');
export const isMainThread = true;
export const parentPort = null;
export const workerData = null;
export const createRequire = () => unavailable('require');
export default {};
