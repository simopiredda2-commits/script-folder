/** Configurazione del servizio, letta dall'ambiente. Nessun valore segreto ha un default. */
export interface Config {
  databaseUrl: string;
  port: number;
  host: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL mancante: in cloud la imposta scripts/avvio-sessione.sh, in locale copia .env.example in .env',
    );
  }
  return {
    databaseUrl,
    port: Number(env.API_PORT ?? 3001),
    host: env.API_HOST ?? '127.0.0.1',
  };
}
