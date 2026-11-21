/**
 * Lato pagina del ponte (D221): avvia il Worker del servizio e gira al servizio ogni chiamata a
 * /api/… dell'interfaccia, che resta quella di sempre. Nessuna richiesta esce dal browser.
 */
import type {
  AftHints,
  AuraHints,
  DemoUser,
  FromWorker,
  InterruptedHints,
  ToWorker,
  WireRequest,
  WireResponse,
} from './protocol';

export interface Ready {
  users: DemoUser[];
  aura: AuraHints;
  aft: AftHints;
  interrupted: InterruptedHints;
  password: string;
  ms: number;
}

type Pending = { resolve: (r: WireResponse) => void; reject: (e: Error) => void };

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, Pending>();
type CodeMessage = Extract<FromWorker, { type: 'code' }>;
let codeWaiter: ((c: Omit<CodeMessage, 'type'>) => void) | null = null;

const send = (message: ToWorker, transfer: Transferable[] = []) =>
  worker!.postMessage(message, transfer);

/** Avvia il servizio; `onProgress` riceve le fasi da mostrare. */
export function startService(
  workerUrl: string,
  onProgress: (message: string) => void,
): Promise<Ready> {
  return new Promise((resolve, reject) => {
    try {
      worker = new Worker(workerUrl, { type: 'module', name: 'servizio' });
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    let started = false;
    worker.onerror = (e) => {
      if (!started) reject(new Error(e.message || 'Il Worker del servizio non è partito'));
    };
    worker.onmessage = (event: MessageEvent<FromWorker>) => {
      const m = event.data;
      if (m.type === 'progress') onProgress(m.message);
      else if (m.type === 'ready') {
        started = true;
        resolve({
          users: m.users,
          aura: m.aura,
          aft: m.aft,
          interrupted: m.interrupted,
          password: m.password,
          ms: m.ms,
        });
      } else if (m.type === 'failed') reject(new Error(m.message));
      else if (m.type === 'response') {
        pending.get(m.id)?.resolve(m.response);
        pending.delete(m.id);
      } else if (m.type === 'request-failed') {
        pending.get(m.id)?.reject(new Error(m.message));
        pending.delete(m.id);
      } else if (m.type === 'code') {
        codeWaiter?.({ code: m.code, loggedIn: m.loggedIn, sessionSince: m.sessionSince });
        codeWaiter = null;
      }
    };
    const base = new URL('.', new URL(workerUrl, document.baseURI)).href;
    send({ type: 'start', base });
  });
}

/** Il codice del secondo fattore di chi sta entrando, se si conosce. */
export function secondFactorCode(): Promise<Omit<CodeMessage, 'type'>> {
  return new Promise((resolve) => {
    codeWaiter = resolve;
    send({ type: 'code' });
  });
}

const originalFetch = window.fetch.bind(window);

/** Una chiamata al servizio: è una chiamata /api/ dello stesso indirizzo? */
function serviceUrl(input: RequestInfo | URL): URL | null {
  const raw = input instanceof Request ? input.url : String(input);
  const url = new URL(raw, document.baseURI);
  return url.origin === location.origin && url.pathname.startsWith('/api/') ? url : null;
}

export async function callService(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headers[key] = value;
  });
  const body =
    request.method === 'GET' || request.method === 'HEAD' ? null : await request.arrayBuffer();
  const wire: WireRequest = {
    method: request.method,
    url: `${url.pathname}${url.search}`,
    headers,
    body: body && body.byteLength ? body : null,
  };
  const response = await new Promise<WireResponse>((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    send({ type: 'request', id, request: wire }, wire.body ? [wire.body] : []);
  });
  const nullBody = [101, 204, 205, 304].includes(response.status);
  return new Response(nullBody ? null : response.body, {
    status: response.status,
    headers: response.headers,
  });
}

/** Da qui in poi fetch('/api/…') va al servizio nel Worker. */
export function installFetch() {
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = serviceUrl(input);
    if (!url) return originalFetch(input, init);
    const request = new Request(input instanceof Request ? input : url.href, init);
    return callService(request);
  };
}
