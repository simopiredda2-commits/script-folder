/** `node:child_process` nel browser (D221): nessun programma esterno, per esempio sync/ in Python. */
const unavailable = () => new Error('Nella dimostrazione non si lanciano programmi esterni');

export function execFile(...args: unknown[]) {
  const cb = args.find((a) => typeof a === 'function') as
    ((err: Error, out: string, errOut: string) => void) | undefined;
  queueMicrotask(() => cb?.(unavailable(), '', ''));
  return { kill() {}, on() {}, stdout: null, stderr: null };
}
export const exec = execFile;
export function spawn(): never {
  throw unavailable();
}
export function execFileSync(): never {
  throw unavailable();
}
export const execSync = execFileSync;
export const spawnSync = execFileSync;
export const fork = spawn;

export default { execFile, exec, spawn, execFileSync, execSync, spawnSync, fork };
