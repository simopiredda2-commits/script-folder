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
  /** Dove lavora, per chi non è dello studio dimostrativo o è un collega (D227). */
  note?: string;
}

/** Che cosa ha mandato AURA simulata all'avvio (D223): i nomi dei pazienti inventati. */
export interface AuraHints {
  exemption: string | null;
  registry: string | null;
  deceased: string | null;
  revoked: string | null;
  newPatient: string;
  /**
   * I pazienti che hanno scelto la collega dello studio: i cambi di medico in «Oggi» (D227). Due, per
   * provare «Sposta» e «Non spostare» (D229).
   */
  doctorChanges: string[];
  colleague: string;
}

/** L'AFT della dimostrazione (D227): il medico dell'altro studio e il suo paziente con il consenso. */
export interface AftHints {
  name: string;
  colleague: string;
  studio: string;
  patient: string;
  fiscalCode: string;
}

/**
 * Gli invii rimasti senza risposta (D233): il paziente della ricetta e del certificato «in invio»,
 * e il medico che li aveva firmati.
 */
export interface InterruptedHints {
  patient: string;
  doctor: string;
}

export type ToWorker =
  | { type: 'start'; base: string }
  | { type: 'request'; id: number; request: WireRequest }
  | { type: 'code' };

export type FromWorker =
  | { type: 'progress'; message: string }
  | {
      type: 'ready';
      users: DemoUser[];
      aura: AuraHints;
      aft: AftHints;
      interrupted: InterruptedHints;
      password: string;
      ms: number;
    }
  | { type: 'failed'; message: string }
  | { type: 'response'; id: number; response: WireResponse }
  | { type: 'request-failed'; id: number; message: string }
  | {
      type: 'code';
      code: { username: string; code: string; secondsLeft: number } | null;
      loggedIn: boolean;
    };
