/** Messaggi fra la pagina e il Worker del servizio (D221). */
export interface WireRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: ArrayBuffer | null;
}

export interface WireResponse {
  status: number;
  headers: [string, string][];
  body: ArrayBuffer;
}

export interface DemoUser {
  username: string;
  name: string;
  roles: string[];
}

/** Che cosa ha mandato AURA simulata all'avvio (D223): i nomi dei pazienti inventati. */
export interface AuraHints {
  exemption: string | null;
  registry: string | null;
  deceased: string | null;
  revoked: string | null;
  newPatient: string;
}

export type ToWorker =
  | { type: 'start'; base: string }
  | { type: 'request'; id: number; request: WireRequest }
  | { type: 'code' };

export type FromWorker =
  | { type: 'progress'; message: string }
  | { type: 'ready'; users: DemoUser[]; aura: AuraHints; password: string; ms: number }
  | { type: 'failed'; message: string }
  | { type: 'response'; id: number; response: WireResponse }
  | { type: 'request-failed'; id: number; message: string }
  | {
      type: 'code';
      code: { username: string; code: string; secondsLeft: number } | null;
      loggedIn: boolean;
    };
