/**
 * `process` di Node per il servizio nel browser (D221). Non dichiara `versions.node`: PGlite e le
 * altre librerie devono capire di non essere in Node.
 */
type Listener = (...args: unknown[]) => void;

const listeners = new Map<string, Set<Listener>>();
const on = (event: string, fn: Listener) => {
  let set = listeners.get(event);
  if (!set) listeners.set(event, (set = new Set()));
  set.add(fn);
  return proc;
};
const off = (event: string, fn: Listener) => {
  listeners.get(event)?.delete(fn);
  return proc;
};

const start = performance.now();

function hrtime(previous?: [number, number]): [number, number] {
  const now = performance.now();
  let seconds = Math.floor(now / 1000);
  let nanos = Math.floor((now % 1000) * 1e6);
  if (previous) {
    seconds -= previous[0];
    nanos -= previous[1];
    if (nanos < 0) {
      seconds -= 1;
      nanos += 1e9;
    }
  }
  return [seconds, nanos];
}
hrtime.bigint = () => BigInt(Math.round(performance.now() * 1e6));

const proc = {
  env: { NODE_ENV: 'production', TZ: 'Europe/Rome' } as Record<string, string | undefined>,
  argv: ['browser'],
  execArgv: [] as string[],
  version: '',
  versions: {} as Record<string, string>,
  platform: 'browser',
  arch: 'wasm',
  pid: 1,
  ppid: 0,
  title: 'browser',
  browser: true,
  release: { name: 'browser' },
  exitCode: undefined as number | undefined,
  cwd: () => '/repo',
  chdir: () => undefined,
  umask: () => 0o022,
  hrtime,
  uptime: () => (performance.now() - start) / 1000,
  memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
  cpuUsage: () => ({ user: 0, system: 0 }),
  nextTick: (fn: Listener, ...args: unknown[]) => queueMicrotask(() => fn(...args)),
  emitWarning: (warning: unknown) => {
    console.warn(warning instanceof Error ? warning.message : String(warning));
  },
  on,
  addListener: on,
  once: (event: string, fn: Listener) => {
    const wrapper: Listener = (...args) => {
      off(event, wrapper);
      fn(...args);
    };
    return on(event, wrapper);
  },
  off,
  removeListener: off,
  removeAllListeners: (event?: string) => {
    if (event) listeners.delete(event);
    else listeners.clear();
    return proc;
  },
  emit: (event: string, ...args: unknown[]) => {
    const set = listeners.get(event);
    for (const fn of set ?? []) fn(...args);
    return !!set?.size;
  },
  listeners: (event: string) => [...(listeners.get(event) ?? [])],
  listenerCount: (event: string) => listeners.get(event)?.size ?? 0,
  binding: () => {
    throw new Error('process.binding non è disponibile nel browser');
  },
  exit: (code?: number) => {
    throw new Error(`process.exit(${code ?? 0}) nel browser`);
  },
  stdout: { write: (s: string) => (console.log(s), true), isTTY: false },
  stderr: { write: (s: string) => (console.error(s), true), isTTY: false },
};

export default proc;
