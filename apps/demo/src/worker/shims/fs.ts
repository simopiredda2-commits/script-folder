/**
 * `node:fs` per il servizio nel browser (D221): un disco in memoria con i file che il programma
 * legge mentre lavora (caratteri dei PDF, modelli, formati, dizionari, regole, mappature), messi
 * nel pacchetto durante la costruzione sotto /repo. Si può anche scrivere: resta in memoria.
 */
import { Buffer } from 'node:buffer';
import FILES from 'virtual:demo-fs';
import { posix as path } from 'node:path';

const files = new Map<string, Uint8Array>();
const dirs = new Set<string>(['/']);
const touched = new Map<string, number>();

function addDirs(p: string) {
  for (let d = path.dirname(p); !dirs.has(d); d = path.dirname(d)) dirs.add(d);
}
for (const [name, { text, base64 }] of Object.entries(FILES)) {
  files.set(
    name,
    base64 ? new Uint8Array(Buffer.from(base64, 'base64')) : new TextEncoder().encode(text ?? ''),
  );
  addDirs(name);
}

type PathLike = string | URL | Uint8Array;

function toPath(p: PathLike): string {
  if (p instanceof URL || (typeof p === 'string' && p.startsWith('file:'))) {
    const url = p instanceof URL ? p : new URL(p);
    return decodeURIComponent(url.pathname);
  }
  const s = typeof p === 'string' ? p : Buffer.from(p).toString('utf8');
  return path.resolve('/repo', s);
}

function notFound(p: string, syscall: string): Error {
  console.warn(`[disco della dimostrazione] file mancante: ${p}`);
  return Object.assign(new Error(`ENOENT: no such file or directory, ${syscall} '${p}'`), {
    code: 'ENOENT',
    errno: -2,
    syscall,
    path: p,
  });
}

const encodingOf = (options: unknown): string | undefined =>
  typeof options === 'string' ? options : (options as { encoding?: string } | undefined)?.encoding;

export function readFileSync(p: PathLike, options?: unknown): string | Buffer {
  const name = toPath(p);
  const data = files.get(name);
  if (!data) throw notFound(name, 'open');
  const encoding = encodingOf(options);
  const buf = Buffer.from(data);
  return encoding ? buf.toString(encoding as 'utf8') : buf;
}

export function existsSync(p: PathLike): boolean {
  try {
    const name = toPath(p);
    return files.has(name) || dirs.has(name);
  } catch {
    return false;
  }
}

class Stats {
  constructor(
    private readonly file: boolean,
    readonly size: number,
    readonly mtimeMs: number,
  ) {}
  get mtime() {
    return new Date(this.mtimeMs);
  }
  get ctime() {
    return this.mtime;
  }
  get birthtime() {
    return this.mtime;
  }
  isFile() {
    return this.file;
  }
  isDirectory() {
    return !this.file;
  }
  isSymbolicLink() {
    return false;
  }
}

const BUILT = Date.now();

export function statSync(p: PathLike, options?: { throwIfNoEntry?: boolean }) {
  const name = toPath(p);
  const data = files.get(name);
  if (data) return new Stats(true, data.length, touched.get(name) ?? BUILT);
  if (dirs.has(name)) return new Stats(false, 0, BUILT);
  if (options?.throwIfNoEntry === false) return undefined;
  throw notFound(name, 'stat');
}
export const lstatSync = statSync;

class Dirent {
  constructor(
    readonly name: string,
    private readonly file: boolean,
    readonly parentPath: string,
  ) {}
  isFile() {
    return this.file;
  }
  isDirectory() {
    return !this.file;
  }
  isSymbolicLink() {
    return false;
  }
}

export function readdirSync(p: PathLike, options?: { withFileTypes?: boolean }) {
  const name = toPath(p);
  if (!dirs.has(name)) throw notFound(name, 'scandir');
  const prefix = name.endsWith('/') ? name : `${name}/`;
  const entries = new Map<string, boolean>();
  for (const f of files.keys())
    if (f.startsWith(prefix)) {
      const rest = f.slice(prefix.length);
      const i = rest.indexOf('/');
      entries.set(i < 0 ? rest : rest.slice(0, i), i < 0);
    }
  for (const d of dirs)
    if (d.startsWith(prefix) && !d.slice(prefix.length).includes('/') && d !== name)
      entries.set(d.slice(prefix.length), false);
  const names = [...entries.keys()].sort();
  return options?.withFileTypes ? names.map((n) => new Dirent(n, entries.get(n)!, name)) : names;
}

export function writeFileSync(p: PathLike, data: string | ArrayBufferView, options?: unknown) {
  const name = toPath(p);
  const encoding = encodingOf(options) ?? 'utf8';
  const bytes =
    typeof data === 'string'
      ? new Uint8Array(Buffer.from(data, encoding as 'utf8'))
      : new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  files.set(name, bytes);
  touched.set(name, Date.now());
  addDirs(name);
}

export function appendFileSync(p: PathLike, data: string | ArrayBufferView, options?: unknown) {
  const name = toPath(p);
  const before = files.get(name) ?? new Uint8Array();
  const add =
    typeof data === 'string'
      ? new Uint8Array(Buffer.from(data, (encodingOf(options) ?? 'utf8') as 'utf8'))
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const merged = new Uint8Array(before.length + add.length);
  merged.set(before);
  merged.set(add, before.length);
  writeFileSync(name, merged);
}

export function mkdirSync(p: PathLike) {
  const name = toPath(p);
  dirs.add(name);
  addDirs(name);
  return undefined;
}

let temp = 0;
export function mkdtempSync(prefix: string) {
  const name = toPath(`${prefix}${(++temp).toString(36).padStart(6, '0')}`);
  mkdirSync(name);
  return name;
}

export function rmSync(p: PathLike) {
  const name = toPath(p);
  files.delete(name);
  const prefix = `${name}/`;
  for (const f of [...files.keys()]) if (f.startsWith(prefix)) files.delete(f);
  for (const d of [...dirs]) if (d === name || d.startsWith(prefix)) dirs.delete(d);
}
export const unlinkSync = rmSync;
export const rmdirSync = rmSync;

export function renameSync(from: PathLike, to: PathLike) {
  const a = toPath(from);
  const data = files.get(a);
  if (!data) throw notFound(a, 'rename');
  files.delete(a);
  writeFileSync(to, data);
}

export function copyFileSync(from: PathLike, to: PathLike) {
  writeFileSync(to, readFileSync(from));
}

export function accessSync(p: PathLike) {
  if (!existsSync(p)) throw notFound(toPath(p), 'access');
}

const asPromise =
  <A extends unknown[], R>(fn: (...args: A) => R) =>
  (...args: A): Promise<R> => {
    try {
      return Promise.resolve(fn(...args));
    } catch (err) {
      return Promise.reject(err instanceof Error ? err : new Error(String(err)));
    }
  };

export const promises = {
  readFile: asPromise(readFileSync),
  writeFile: asPromise(writeFileSync),
  appendFile: asPromise(appendFileSync),
  readdir: asPromise(readdirSync),
  stat: asPromise(statSync),
  lstat: asPromise(statSync),
  mkdir: asPromise(mkdirSync),
  mkdtemp: asPromise(mkdtempSync),
  rm: asPromise(rmSync),
  unlink: asPromise(rmSync),
  rename: asPromise(renameSync),
  copyFile: asPromise(copyFileSync),
  access: asPromise(accessSync),
};

function callbackOf<A extends unknown[], R>(fn: (...args: A) => R) {
  return (...args: [...A, (err: Error | null, value?: R) => void]) => {
    const cb = args.pop() as (err: Error | null, value?: R) => void;
    try {
      const value = fn(...(args as unknown as A));
      queueMicrotask(() => cb(null, value));
    } catch (err) {
      queueMicrotask(() => cb(err as Error));
    }
  };
}

export const readFile = callbackOf(readFileSync);
export const writeFile = callbackOf(writeFileSync);
export const stat = callbackOf(statSync);
export const readdir = callbackOf(readdirSync);

export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 };

export function createReadStream(): never {
  throw new Error('createReadStream non è disponibile nella dimostrazione');
}
export function createWriteStream(): never {
  throw new Error('createWriteStream non è disponibile nella dimostrazione');
}
export function watch(): never {
  throw new Error('watch non è disponibile nella dimostrazione');
}

export default {
  readFileSync,
  existsSync,
  statSync,
  lstatSync,
  readdirSync,
  writeFileSync,
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  rmdirSync,
  renameSync,
  copyFileSync,
  accessSync,
  promises,
  readFile,
  writeFile,
  stat,
  readdir,
  constants,
  createReadStream,
  createWriteStream,
  watch,
};
