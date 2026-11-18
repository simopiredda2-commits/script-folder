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
  options: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH'; body?: unknown } = {},
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
