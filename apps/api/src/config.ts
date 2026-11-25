import { isIP } from 'node:net';
import { REGIONAL_SOFTWARE_CODE } from '@mmg/integrations';
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

/**
 * Ambiente dell'installazione (D170). In «prova» (il valore per difetto) il programma accetta solo
 * pazienti inventati dove può controllarlo (regola 1, D12) e i dati dimostrativi; in «produzione»
 * il seed dimostrativo non parte.
 */
export type AppEnvironment = 'produzione' | 'prova';
export const APP_ENVIRONMENTS: readonly AppEnvironment[] = ['produzione', 'prova'];

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
  /** Ora del controllo di ogni notte su AURA («02:30»); assente = nessun controllo notturno (D197). */
  auraTime?: string | null;
  /** Ambiente dell'installazione, da APP_AMBIENTE (D170). */
  environment: AppEnvironment;
  /**
   * Proxy inversi fidati, da APP_PROXY_FIDATI: indirizzi IP o reti CIDR. Vuoto (per difetto):
   * nessun proxy fidato, l'intestazione X-Forwarded-For si ignora e l'indirizzo della richiesta è
   * quello della connessione. Con un proxy fidato vale l'indirizzo del cliente che il proxy scrive.
   */
  trustedProxies: string[];
  /**
   * Codice del gestionale assegnato dalla Regione Piemonte all'avvio dell'autocertificazione, da
   * APP_CODICE_GESTIONALE (D266, D267). Il programma ci aggiunge «_» e il codice ASL del medico
   * (`client_id`, `X-Gestionale`, REL-STC-01 V08). Per difetto «SIMULATORE»: vale solo con i
   * simulatori.
   */
  regionalSoftwareCode?: string;
}

/** APP_CODICE_GESTIONALE: lettere, cifre, «-» e «_»; vuoto vale «SIMULATORE» (D267). */
export function regionalSoftwareCodeOf(raw: string | undefined): string {
  const code = raw?.trim() || 'SIMULATORE';
  if (!REGIONAL_SOFTWARE_CODE.test(code))
    throw new Error(
      `APP_CODICE_GESTIONALE=${raw}: il codice del gestionale assegnato dalla Regione ha solo lettere, cifre, «-» e «_» (per esempio MIOAPPLICATIVO)`,
    );
  return code;
}

function environmentOf(raw: string | undefined): AppEnvironment {
  const v = (raw ?? 'prova').trim().toLowerCase();
  if (!(APP_ENVIRONMENTS as readonly string[]).includes(v))
    throw new Error(`APP_AMBIENTE=${raw}: valori ammessi «produzione» o «prova»`);
  return v as AppEnvironment;
}

/**
 * APP_PROXY_FIDATI: indirizzi IPv4 o IPv6, o reti CIDR (indirizzo/prefisso), separati da virgole.
 * L'indirizzo della richiesta va nel registro dei tentativi d'accesso falliti (tappa 14): dietro un
 * proxy, senza questa variabile, sarebbe sempre quello del proxy; fidarsi di qualunque mittente lo
 * farebbe scegliere a chi accede. Un valore non valido ferma l'avvio invece di essere indovinato.
 */
export function trustedProxiesOf(raw: string | undefined): string[] {
  const items = (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const item of items) {
    const [address = '', prefix, ...rest] = item.split('/');
    const family = isIP(address);
    const maxPrefix = family === 6 ? 128 : 32;
    const prefixOk =
      prefix === undefined || (/^\d{1,3}$/.test(prefix) && Number(prefix) <= maxPrefix);
    // Una rete /0 è tutti: fidarsi di tutti farebbe scegliere l'indirizzo a chi accede (terza
    // revisione). Si rifiuta qui, in italiano, prima che lo rifiuti Fastify all'avvio.
    if (family !== 0 && prefix !== undefined && prefixOk && Number(prefix) === 0)
      throw new Error(
        `APP_PROXY_FIDATI=${raw}: «${item}» vorrebbe dire fidarsi di qualunque mittente. Indica l'indirizzo del proxy, o la sua rete, per esempio 10.0.0.0/24.`,
      );
    if (family === 0 || rest.length > 0 || !prefixOk)
      throw new Error(
        `APP_PROXY_FIDATI=${raw}: «${item}» non è un indirizzo IP né una rete CIDR. Valori ammessi: indirizzi o reti separati da virgole, per esempio 127.0.0.1 oppure 10.0.0.0/24; vuoto, nessun proxy fidato.`,
      );
  }
  return items;
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

/** AURA_AGGIORNAMENTO («02:30»): l'ora del controllo di ogni notte su AURA (D197). */
function auraTimeOf(value: string | undefined): string | null {
  const time = value?.trim();
  if (!time) return null;
  parseTime(time);
  return time;
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
    auraTime: auraTimeOf(env.AURA_AGGIORNAMENTO),
    environment: environmentOf(env.APP_AMBIENTE),
    trustedProxies: trustedProxiesOf(env.APP_PROXY_FIDATI),
    regionalSoftwareCode: regionalSoftwareCodeOf(env.APP_CODICE_GESTIONALE),
  };
}
