/** `node:diagnostics_channel` nel browser (D221): canali senza ascoltatori. */
class Channel {
  readonly hasSubscribers = false;
  constructor(readonly name: string) {}
  publish() {}
  subscribe() {}
  unsubscribe() {
    return false;
  }
  bindStore() {}
  unbindStore() {
    return false;
  }
  runStores<T>(
    _data: unknown,
    fn: (...a: unknown[]) => T,
    thisArg?: unknown,
    ...args: unknown[]
  ): T {
    return fn.apply(thisArg, args);
  }
}

const channels = new Map<string, Channel>();
export function channel(name: string): Channel {
  let c = channels.get(name);
  if (!c) channels.set(name, (c = new Channel(name)));
  return c;
}
export const hasSubscribers = () => false;
export const subscribe = () => undefined;
export const unsubscribe = () => false;

export function tracingChannel(name: string) {
  const sub = (event: string) => channel(`tracing:${name}:${event}`);
  return {
    start: sub('start'),
    end: sub('end'),
    asyncStart: sub('asyncStart'),
    asyncEnd: sub('asyncEnd'),
    error: sub('error'),
    hasSubscribers: false,
    subscribe() {},
    unsubscribe() {
      return false;
    },
    traceSync<T>(
      fn: (...a: unknown[]) => T,
      _ctx?: unknown,
      thisArg?: unknown,
      ...args: unknown[]
    ): T {
      return fn.apply(thisArg, args);
    },
    tracePromise<T>(
      fn: (...a: unknown[]) => T,
      _ctx?: unknown,
      thisArg?: unknown,
      ...args: unknown[]
    ): T {
      return fn.apply(thisArg, args);
    },
    traceCallback<T>(
      fn: (...a: unknown[]) => T,
      _pos?: number,
      _ctx?: unknown,
      thisArg?: unknown,
      ...args: unknown[]
    ): T {
      return fn.apply(thisArg, args);
    },
  };
}

export { Channel };
export default { channel, hasSubscribers, subscribe, unsubscribe, tracingChannel, Channel };
