/**
 * `node:http` nel browser (D221). Nessuna rete: createServer restituisce un server finto che tiene
 * il gestore delle richieste di Fastify; il ponte (../bridge.ts) gli passa richieste e risposte
 * costruite in memoria, con le classi qui sotto.
 */
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

export const METHODS = ['DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT'];

export const STATUS_CODES: Record<number, string> = {
  100: 'Continue',
  101: 'Switching Protocols',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  204: 'No Content',
  206: 'Partial Content',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  411: 'Length Required',
  412: 'Precondition Failed',
  413: 'Payload Too Large',
  414: 'URI Too Long',
  415: 'Unsupported Media Type',
  416: 'Range Not Satisfiable',
  422: 'Unprocessable Entity',
  423: 'Locked',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** Il gestore che Fastify registra: uno solo, nel Worker. */
export let requestHandler: Handler | null = null;

class FakeServer extends EventEmitter {
  listening = false;
  keepAliveTimeout = 0;
  requestTimeout = 0;
  headersTimeout = 0;
  timeout = 0;
  maxHeadersCount = null;
  constructor(handler?: Handler) {
    super();
    if (handler) requestHandler = handler;
    this.on('request', (req: IncomingMessage, res: ServerResponse) => requestHandler?.(req, res));
  }
  listen(...args: unknown[]) {
    this.listening = true;
    const cb = args.find((a) => typeof a === 'function') as (() => void) | undefined;
    queueMicrotask(() => {
      this.emit('listening');
      cb?.();
    });
    return this;
  }
  close(cb?: (err?: Error) => void) {
    this.listening = false;
    queueMicrotask(() => {
      this.emit('close');
      cb?.();
    });
    return this;
  }
  address() {
    return { address: '127.0.0.1', family: 'IPv4', port: 0 };
  }
  setTimeout() {
    return this;
  }
  closeAllConnections() {}
  closeIdleConnections() {}
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}

export function createServer(...args: unknown[]) {
  const handler = args.find((a) => typeof a === 'function') as Handler | undefined;
  return new FakeServer(handler);
}

/** La connessione finta: l'indirizzo della postazione è sempre quello locale. */
class FakeSocket extends EventEmitter {
  remoteAddress = '127.0.0.1';
  remotePort = 0;
  remoteFamily = 'IPv4';
  localAddress = '127.0.0.1';
  localPort = 0;
  encrypted = false;
  readable = true;
  writable = true;
  destroyed = false;
  setTimeout() {
    return this;
  }
  setNoDelay() {
    return this;
  }
  setKeepAlive() {
    return this;
  }
  destroy() {
    this.destroyed = true;
    return this;
  }
  end() {
    return this;
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}

/** La richiesta, come la vede Fastify: un flusso leggibile con metodo, indirizzo e intestazioni. */
export class IncomingMessage extends Readable {
  readonly httpVersion = '1.1';
  readonly httpVersionMajor = 1;
  readonly httpVersionMinor = 1;
  readonly socket = new FakeSocket();
  readonly connection = this.socket;
  readonly rawHeaders: string[];
  complete = false;
  aborted = false;
  constructor(
    readonly method: string,
    readonly url: string,
    readonly headers: Record<string, string>,
    body: Uint8Array | null,
  ) {
    super({ read() {} });
    this.rawHeaders = Object.entries(headers).flat();
    queueMicrotask(() => {
      if (body?.length) this.push(Buffer.from(body));
      this.push(null);
      this.complete = true;
    });
  }
  setTimeout() {
    return this;
  }
}

type HeaderValue = string | number | string[];

/** La risposta: raccoglie stato, intestazioni e corpo, poi avvisa chi aspetta con «finish». */
export class ServerResponse extends EventEmitter {
  statusCode = 200;
  statusMessage = '';
  headersSent = false;
  finished = false;
  writableEnded = false;
  writableFinished = false;
  destroyed = false;
  sendDate = true;
  writable = true;
  readonly socket: FakeSocket;
  readonly connection: FakeSocket;
  private readonly headers = new Map<string, { name: string; value: HeaderValue }>();
  readonly chunks: Uint8Array[] = [];
  constructor(readonly req: IncomingMessage) {
    super();
    this.socket = req.socket;
    this.connection = req.socket;
  }
  setHeader(name: string, value: HeaderValue) {
    this.headers.set(name.toLowerCase(), { name, value });
    return this;
  }
  getHeader(name: string) {
    return this.headers.get(name.toLowerCase())?.value;
  }
  getHeaders() {
    const out: Record<string, HeaderValue> = {};
    for (const [k, { value }] of this.headers) out[k] = value;
    return out;
  }
  getHeaderNames() {
    return [...this.headers.keys()];
  }
  hasHeader(name: string) {
    return this.headers.has(name.toLowerCase());
  }
  removeHeader(name: string) {
    this.headers.delete(name.toLowerCase());
  }
  appendHeader(name: string, value: HeaderValue) {
    const prev = this.getHeader(name);
    const list = [prev, value]
      .flat()
      .filter((v) => v !== undefined)
      .map(String);
    return this.setHeader(name, list);
  }
  writeHead(statusCode: number, reasonOrHeaders?: unknown, maybeHeaders?: unknown) {
    this.statusCode = statusCode;
    const headers = (typeof reasonOrHeaders === 'string' ? maybeHeaders : reasonOrHeaders) as
      Record<string, HeaderValue> | HeaderValue[] | undefined;
    if (typeof reasonOrHeaders === 'string') this.statusMessage = reasonOrHeaders;
    if (Array.isArray(headers)) {
      for (let i = 0; i + 1 < headers.length; i += 2)
        this.setHeader(String(headers[i]), headers[i + 1] as HeaderValue);
    } else if (headers) {
      for (const [k, v] of Object.entries(headers)) if (v !== undefined) this.setHeader(k, v);
    }
    this.headersSent = true;
    return this;
  }
  flushHeaders() {
    this.headersSent = true;
  }
  write(chunk: unknown, encoding?: unknown, cb?: unknown) {
    if (!this.headersSent) this.headersSent = true;
    if (
      chunk !== undefined &&
      chunk !== null &&
      (typeof chunk === 'string' || ArrayBuffer.isView(chunk))
    )
      this.chunks.push(
        typeof chunk === 'string'
          ? Buffer.from(chunk, (typeof encoding === 'string' ? encoding : 'utf8') as 'utf8')
          : new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength),
      );
    const done = typeof encoding === 'function' ? encoding : cb;
    if (typeof done === 'function') queueMicrotask(() => (done as () => void)());
    return true;
  }
  end(chunk?: unknown, encoding?: unknown, cb?: unknown) {
    if (this.writableEnded) return this;
    if (typeof chunk === 'function') {
      cb = chunk;
      chunk = undefined;
    } else if (typeof encoding === 'function') {
      cb = encoding;
      encoding = undefined;
    }
    if (chunk !== undefined && chunk !== null) this.write(chunk, encoding);
    this.headersSent = true;
    this.finished = true;
    this.writableEnded = true;
    queueMicrotask(() => {
      this.writableFinished = true;
      this.emit('prefinish');
      this.emit('finish');
      if (typeof cb === 'function') (cb as () => void)();
      this.emit('close');
    });
    return this;
  }
  destroy(err?: Error) {
    if (this.destroyed) return this;
    this.destroyed = true;
    queueMicrotask(() => {
      if (err) this.emit('error', err);
      this.emit('close');
    });
    return this;
  }
  setTimeout() {
    return this;
  }
  cork() {}
  uncork() {}
  addTrailers() {}
  writeContinue() {}
  writeEarlyHints() {}
  assignSocket() {}
  detachSocket() {}
}

export class Agent {}
export const globalAgent = new Agent();
export function request(): never {
  throw new Error('Nella dimostrazione il servizio non chiama nessun sito');
}
export const get = request;
export const Server = FakeServer;
export const OutgoingMessage = ServerResponse;

export default {
  METHODS,
  STATUS_CODES,
  createServer,
  IncomingMessage,
  ServerResponse,
  OutgoingMessage,
  Server,
  Agent,
  globalAgent,
  request,
  get,
};

/** Il gestore delle richieste registrato da Fastify (null prima di buildApp). */
export const getRequestHandler = () => requestHandler;
