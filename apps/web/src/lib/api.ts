/** Errore del servizio, con il messaggio in italiano e gli eventuali dettagli. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

type Listener = (status: number) => void;
const listeners = new Set<Listener>();

/** Avvisa la sessione quando il servizio risponde 401 (accesso) o 423 (sessione bloccata). */
export function onAuthProblem(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Chiamata al servizio: stesso dominio, cookie di sessione, JSON. */
export async function api<T>(
  path: string,
  options: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown } = {},
): Promise<T> {
  const res = await fetch(path, {
    method: options.method ?? 'GET',
    credentials: 'same-origin',
    headers: options.body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  const data: unknown = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = (data ?? {}) as { errore?: string; dettagli?: unknown };
    if (res.status === 401 || res.status === 423) for (const l of listeners) l(res.status);
    throw new ApiError(res.status, err.errore ?? `Errore ${res.status}`, err.dettagli);
  }
  return data as T;
}

/** Parametri di ricerca senza i valori vuoti. */
export function query(params: Record<string, string | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : '';
}

/**
 * PDF dal servizio (anteprime, prove di stampa): lo stesso errore in chiaro di `api` se qualcosa
 * non va, altrimenti il file da aprire.
 */
export async function apiPdf(path: string, body?: unknown): Promise<Blob> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    const err = (text ? JSON.parse(text) : {}) as { errore?: string; dettagli?: unknown };
    if (res.status === 401 || res.status === 423) for (const l of listeners) l(res.status);
    throw new ApiError(res.status, err.errore ?? `Errore ${res.status}`, err.dettagli);
  }
  return res.blob();
}

/** Apre un PDF in una scheda nuova del browser. */
export function openPdf(blob: Blob) {
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener');
  // Il browser ha già aperto il file: l'indirizzo temporaneo si libera dopo un po'.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
