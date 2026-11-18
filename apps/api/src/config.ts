import { parseTime } from './reference/scheduler';
import { parseKey } from './security/secrets';

/** Aggiornamento delle banche dati dal servizio (D156). */
export interface ReferenceUpdateConfig {
  /** Cartella dei dati di sync (il suo --dest). */
  dataDir: string;
  /** Cartella delle trascrizioni dei PDF. */
  transcriptionsDir?: string;
  /** «pubbliche» (sync/fonti.json), «esempio» (sito d'esempio in locale) o un file di fonti. */
  sources: string;
  /** Ora dell'aggiornamento di ogni notte, «HH:MM»; assente = solo a comando. */
  time?: string;
}

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
  /** Aggiornamento delle banche dati; null = il servizio non le aggiorna (sviluppo, prove). */
  referenceUpdate: ReferenceUpdateConfig | null;
}

/**
 * BANCHE_DATI_DIR (cartella di sync) accende l'aggiornamento; BANCHE_DATI_AGGIORNAMENTO («03:30»)
 * l'avvio di ogni notte; BANCHE_DATI_FONTI sceglie le fonti; BANCHE_DATI_TRASCRIZIONI la cartella
 * delle trascrizioni. Senza BANCHE_DATI_DIR nessun aggiornamento parte dal servizio.
 */
function referenceUpdateConfig(env: NodeJS.ProcessEnv): ReferenceUpdateConfig | null {
  const dataDir = env.BANCHE_DATI_DIR?.trim();
  const time = env.BANCHE_DATI_AGGIORNAMENTO?.trim();
  if (!dataDir) {
    if (time) throw new Error('BANCHE_DATI_AGGIORNAMENTO senza BANCHE_DATI_DIR: manca la cartella');
    return null;
  }
  if (time) parseTime(time);
  return {
    dataDir,
    sources: env.BANCHE_DATI_FONTI?.trim() || 'pubbliche',
    ...(env.BANCHE_DATI_TRASCRIZIONI?.trim()
      ? { transcriptionsDir: env.BANCHE_DATI_TRASCRIZIONI.trim() }
      : {}),
    ...(time ? { time } : {}),
  };
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
    referenceUpdate: referenceUpdateConfig(env),
  };
}
