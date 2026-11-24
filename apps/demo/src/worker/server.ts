/**
 * Il servizio vero nel browser (D221): PGlite parte dal database preparato durante la costruzione
 * (migrazioni e banche dati d'esempio), i dati dimostrativi si creano con le date di oggi, poi
 * buildApp con i simulatori di sempre. Le richieste dell'interfaccia arrivano qui come messaggi.
 */
import { randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { ROLE_LABELS } from '@mmg/domain';
import { drizzle } from 'drizzle-orm/pglite';
import { buildApp } from '../../../api/src/app';
import type { Database } from '../../../api/src/db/client';
import { DEMO_USERS, seedDemo } from '../../../api/src/db/demo-seed';
import * as schema from '../../../api/src/db/schema';
import { base32Decode } from '../../../api/src/security/base32';
import { totp, TOTP_STEP_SECONDS } from '../../../api/src/security/totp';
import { createAuraDemo } from './aura';
import { COLLEAGUE_USERS, prepareColleagues } from './colleghi';
import { singleSession, type SingleSession } from './database';
import { prepareInterruptedSends } from './invii';
import { prepareSentPrescriptions } from './ricette-inviate';
import { getRequestHandler, IncomingMessage, ServerResponse } from './shims/http';
import type {
  AftHints,
  AuraHints,
  DemoUser,
  InterruptedHints,
  WireRequest,
  WireResponse,
} from '../protocol';

/** Password di tutti gli utenti dimostrativi: la mostra la pagina, non è un segreto. */
export const DEMO_PASSWORD = 'dimostrazione';

const SESSION_COOKIE_NAME = 'sessione';

/** Il barattolo dei cookie: uno solo, come un solo browser. */
const cookies = new Map<string, string>();
/** Segreti del secondo fattore, letti all'attivazione: per mostrare il codice a chi prova. */
const secrets = new Map<string, string>();
let pendingUser: string | null = null;
/**
 * Da quando c'è la sessione di adesso (D241), per il riquadro della dimostrazione: si riduce da sé
 * una volta per sessione, dopo l'accesso.
 */
let sessionSince: number | null = null;
/** La sessione unica con il database (D223): le richieste passano una alla volta. */
let session: SingleSession | null = null;

async function download(base: string, name: string): Promise<Response> {
  const res = await fetch(new URL(name, base));
  if (!res.ok) throw new Error(`File ${name} non scaricato (${res.status})`);
  return res;
}
const fetchBytes = async (base: string, name: string) => (await download(base, name)).arrayBuffer();

/** I dati binari arrivano come testo in base64 (l'artifact serve solo tipi noti), forse compressi. */
async function fetchBase64(base: string, name: string, gunzip: boolean): Promise<ArrayBuffer> {
  return decodeBase64(await (await download(base, name)).text(), gunzip);
}

/**
 * Il database arriva in parti di testo in base64, perché l'artifact accetta file di testo fino a
 * 16 MB (D256, D260): database.txt dice quali, in ordine, e unite ridanno il testo intero.
 */
async function fetchDatabase(base: string): Promise<ArrayBuffer> {
  const names = (await (await download(base, 'database.txt')).text()).split('\n').filter(Boolean);
  const parts = await Promise.all(names.map(async (n) => (await download(base, n)).text()));
  return decodeBase64(parts.join(''), false);
}

async function decodeBase64(text: string, gunzip: boolean): Promise<ArrayBuffer> {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  if (!gunzip) return bytes.buffer;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

export async function start(
  base: string,
  progress: (message: string) => void,
): Promise<{
  users: DemoUser[];
  aura: AuraHints;
  aft: AftHints;
  interrupted: InterruptedHints;
}> {
  progress(
    'Scarico il database e il programma (circa 28 MB, solo la prima volta che il browser li vede)…',
  );
  const [wasm, initdb, data, dump] = await Promise.all([
    fetchBytes(base, 'pglite.wasm'),
    fetchBytes(base, 'initdb.wasm'),
    fetchBase64(base, 'pglite-dati.txt', true),
    fetchDatabase(base),
  ]);
  progress('Avvio il database nel browser…');
  const [pgliteWasmModule, initdbWasmModule] = await Promise.all([
    WebAssembly.compile(wasm),
    WebAssembly.compile(initdb),
  ]);
  const head = new Uint8Array(dump, 0, 2);
  const gzip = head[0] === 0x1f && head[1] === 0x8b;
  const pg = await PGlite.create({
    pgliteWasmModule,
    initdbWasmModule,
    fsBundle: new Blob([data]),
    loadDataDir: new Blob([dump], { type: gzip ? 'application/gzip' : 'application/x-tar' }),
  });
  session = singleSession(pg);
  const db = drizzle(session.client, { schema, casing: 'snake_case' }) as unknown as Database;

  progress('Creo lo studio dimostrativo e i pazienti inventati…');
  const encryptionKey = randomBytes(32);
  await seedDemo(db, { encryptionKey, passwordFor: () => DEMO_PASSWORD });
  // Una collega nello studio e un altro studio dell'AFT (D227), prima di AURA: la collega serve
  // al cambio di medico che AURA manda.
  progress('Preparo la collega dello studio e l’AFT…');
  const colleagues = await prepareColleagues(db, DEMO_PASSWORD);
  // Una ricetta e un certificato rimasti «in invio» (D233), prima di AURA: il loro paziente non
  // riceve il cambio di medico.
  progress('Preparo gli invii rimasti senza risposta…');
  const interrupted = await prepareInterruptedSends(db);
  // Ricette già inviate e archiviate (D256): i farmaci prescritti con l'ultima ricetta.
  progress('Preparo le ricette già inviate…');
  await prepareSentPrescriptions(db);

  // AURA simulata con i pazienti dimostrativi (D223): collegati e con le loro variazioni prima che
  // il servizio la ascolti; il nuovo assistito arriva dopo, come una notifica.
  progress('Collego i pazienti con AURA simulata…');
  const auraDemo = createAuraDemo();
  const before = await auraDemo.beforeStart(db, colleagues);
  progress('Avvio il servizio…');
  const app = buildApp({
    db,
    config: { encryptionKey, sessionMaxHours: 12, cookieSecure: false, environment: 'prova' },
    aura: { gateway: auraDemo.gateway },
  });
  await app.ready();
  const after = await auraDemo.afterStart(db, () => session!.idle());
  const aura: AuraHints = { ...before, ...after };
  const users: DemoUser[] = [
    ...DEMO_USERS.map((u) => ({
      username: u.username,
      name: u.displayName,
      roles: u.roles.map((r) => ROLE_LABELS[r]),
    })),
    ...COLLEAGUE_USERS.map((u) => ({
      username: u.username,
      name: u.displayName,
      roles: u.roles.map((r) => ROLE_LABELS[r]),
      note: u.note,
    })),
  ];
  return { users, aura, aft: colleagues.aft, interrupted };
}

function remember(setCookie: string) {
  const [pair, ...attributes] = setCookie.split(';');
  const eq = pair!.indexOf('=');
  const name = pair!.slice(0, eq).trim();
  const value = pair!.slice(eq + 1).trim();
  const expired = attributes.some((a) => {
    const [k, v] = a.split('=').map((s) => s.trim().toLowerCase());
    return (
      (k === 'max-age' && Number(v) <= 0) || (k === 'expires' && Date.parse(v ?? '') <= Date.now())
    );
  });
  if (name === SESSION_COOKIE_NAME && (expired || value === '' || value !== cookies.get(name)))
    sessionSince = expired || value === '' ? null : Date.now();
  if (expired || value === '') cookies.delete(name);
  else cookies.set(name, value);
}

/** Una richiesta dell'interfaccia passa dal gestore di Fastify, con i cookie del barattolo. */
export function handle(request: WireRequest): Promise<WireResponse> {
  if (!session) return Promise.reject(new Error('Il servizio non è ancora avviato'));
  return session.queue(() => handleNow(request));
}

function handleNow(request: WireRequest): Promise<WireResponse> {
  const handler = getRequestHandler();
  if (!handler) return Promise.reject(new Error('Il servizio non è ancora avviato'));
  const headers: Record<string, string> = { host: 'dimostrazione.invalid', ...request.headers };
  if (cookies.size) headers.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  const body = request.body ? new Uint8Array(request.body) : null;
  if (body) headers['content-length'] = String(body.length);
  const loginBody = request.url === '/api/accesso' && body ? safeJson(body) : null;
  return new Promise((resolve, reject) => {
    const req = new IncomingMessage(request.method, request.url, headers, body);
    const res = new ServerResponse(req);
    res.once('finish', () => {
      const out: [string, string][] = [];
      for (const [name, value] of Object.entries(res.getHeaders())) {
        const values = Array.isArray(value) ? value : [String(value)];
        if (name === 'set-cookie') values.forEach(remember);
        else for (const v of values) out.push([name, v]);
      }
      const total = res.chunks.reduce((n, c) => n + c.length, 0);
      const bytes = new Uint8Array(total);
      let o = 0;
      for (const c of res.chunks) {
        bytes.set(c, o);
        o += c.length;
      }
      if (loginBody && res.statusCode === 200) watchLogin(loginBody, bytes);
      if (request.url === '/api/uscita') {
        cookies.delete(SESSION_COOKIE_NAME);
        sessionSince = null;
      }
      resolve({ status: res.statusCode, headers: out, body: bytes.buffer });
    });
    res.once('error', (err: Error) => reject(err));
    try {
      handler(req, res);
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function safeJson(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Dopo la password: chi sta entrando e, se attiva il secondo fattore ora, il suo segreto. */
function watchLogin(body: Record<string, unknown>, response: Uint8Array) {
  // Come lo legge il servizio (auth/service.ts): senza spazi e in minuscolo, così «Medico» e
  // «medico» sono lo stesso utente anche qui (D232).
  const username = typeof body.username === 'string' ? body.username.trim().toLowerCase() : null;
  const r = safeJson(response);
  if (!username || !r) return;
  pendingUser = username;
  if (typeof r.segreto === 'string') secrets.set(username, r.segreto);
}

/** C'è una sessione aperta nel barattolo dei cookie. */
export const loggedIn = () => cookies.has(SESSION_COOKIE_NAME);

/** Da quando c'è la sessione aperta, in millisecondi; nessuna sessione, null. */
export const currentSessionSince = () => (cookies.has(SESSION_COOKIE_NAME) ? sessionSince : null);

/** Il codice del secondo fattore di chi sta entrando, come lo mostrerebbe la sua app. */
export function currentCode(): { username: string; code: string; secondsLeft: number } | null {
  if (!pendingUser) return null;
  const secret = secrets.get(pendingUser);
  if (!secret) return null;
  const now = Date.now();
  return {
    username: pendingUser,
    code: totp(base32Decode(secret), now),
    secondsLeft: TOTP_STEP_SECONDS - (Math.floor(now / 1000) % TOTP_STEP_SECONDS),
  };
}
