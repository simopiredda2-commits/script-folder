import { parseKey } from './security/secrets';

/** Configurazione del servizio, letta dall'ambiente. Nessun valore segreto ha un default. */
export interface Config {
  databaseUrl: string;
  port: number;
  host: string;
  /** Chiave per cifrare i segreti a riposo (32 byte). */
  encryptionKey: Buffer;
  /** Durata massima di una sessione, anche se attiva (decisione D19). */
  sessionMaxHours: number;
  /** Cookie solo su HTTPS: sempre, tranne in sviluppo locale. */
  cookieSecure: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL mancante: in cloud la imposta scripts/avvio-sessione.sh, in locale copia .env.example in .env',
    );
  }
  const key = env.APP_ENCRYPTION_KEY;
  if (!key) {
    throw new Error(
      'APP_ENCRYPTION_KEY mancante: in cloud la crea scripts/avvio-sessione.sh; in locale: openssl rand -base64 32',
    );
  }
  return {
    databaseUrl,
    port: Number(env.API_PORT ?? 3001),
    host: env.API_HOST ?? '127.0.0.1',
    encryptionKey: parseKey(key),
    sessionMaxHours: Number(env.SESSION_MAX_HOURS ?? 12),
    cookieSecure: env.COOKIE_SECURE !== 'false',
  };
}
