/**
 * Il Web Worker del servizio (D221). I globali di Node vanno prima di tutto il resto: l'ordine
 * degli import qui sotto conta.
 */
import './shims/globals';
import type { FromWorker, ToWorker } from '../protocol';
import { currentCode, DEMO_PASSWORD, handle, loggedIn, start } from './server';

const post = (message: FromWorker, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(message, transfer);

self.onmessage = (event: MessageEvent<ToWorker>) => {
  const m = event.data;
  if (m.type === 'start') {
    const t0 = performance.now();
    start(m.base, (message) => post({ type: 'progress', message })).then(
      ({ users, aura }) =>
        post({
          type: 'ready',
          users,
          aura,
          password: DEMO_PASSWORD,
          ms: Math.round(performance.now() - t0),
        }),
      (err: unknown) => {
        console.error(err);
        post({ type: 'failed', message: err instanceof Error ? err.message : String(err) });
      },
    );
  } else if (m.type === 'request') {
    handle(m.request).then(
      (response) => post({ type: 'response', id: m.id, response }, [response.body]),
      (err: unknown) => {
        console.error(err);
        post({
          type: 'request-failed',
          id: m.id,
          message: err instanceof Error ? err.message : String(err),
        });
      },
    );
  } else if (m.type === 'code') {
    post({ type: 'code', code: currentCode(), loggedIn: loggedIn() });
  }
};
