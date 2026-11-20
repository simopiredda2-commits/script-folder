/**
 * `node:async_hooks` nel browser (D221). AsyncLocalStorage tiene il valore solo durante la parte
 * sincrona di run(): basta alle librerie che lo usano per contesti facoltativi.
 */
export class AsyncLocalStorage<T> {
  private store: T | undefined;
  getStore(): T | undefined {
    return this.store;
  }
  run<R>(store: T, fn: (...args: unknown[]) => R, ...args: unknown[]): R {
    const previous = this.store;
    this.store = store;
    try {
      return fn(...args);
    } finally {
      this.store = previous;
    }
  }
  exit<R>(fn: (...args: unknown[]) => R, ...args: unknown[]): R {
    const previous = this.store;
    this.store = undefined;
    try {
      return fn(...args);
    } finally {
      this.store = previous;
    }
  }
  enterWith(store: T) {
    this.store = store;
  }
  disable() {
    this.store = undefined;
  }
  static bind<F>(fn: F): F {
    return fn;
  }
  static snapshot() {
    return <R>(fn: (...args: unknown[]) => R, ...args: unknown[]) => fn(...args);
  }
}

export class AsyncResource {
  constructor(readonly type: string) {}
  runInAsyncScope<R>(fn: (...args: unknown[]) => R, thisArg?: unknown, ...args: unknown[]): R {
    return fn.apply(thisArg, args);
  }
  bind<F>(fn: F): F {
    return fn;
  }
  emitDestroy() {
    return this;
  }
  asyncId() {
    return 0;
  }
  triggerAsyncId() {
    return 0;
  }
  static bind<F>(fn: F): F {
    return fn;
  }
}

export const executionAsyncId = () => 0;
export const triggerAsyncId = () => 0;
export const createHook = () => ({ enable: () => undefined, disable: () => undefined });

export default { AsyncLocalStorage, AsyncResource, executionAsyncId, triggerAsyncId, createHook };
