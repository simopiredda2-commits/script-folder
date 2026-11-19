import { buildApp } from './app';
import { loadConfig } from './config';
import { createDatabase, createPool } from './db/client';
import { referenceUpdatesFromConfig } from './reference/updates-service';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const db = createDatabase(pool);
// Aggiornamento delle banche dati (D156): solo se la configurazione lo chiede (BANCHE_DATI_DIR).
const referenceUpdates = referenceUpdatesFromConfig(db, config.referenceUpdate, {
  log: (message, err) => console.error(message, err),
});
// AURA (D197): il simulatore finché non ci sono le credenziali del CSI; AURA_AGGIORNAMENTO accende la notte.
const app = buildApp({
  db,
  config,
  logger: true,
  referenceUpdates,
  aura: { time: config.auraTime ?? null },
});

const shutdown = async () => {
  await app.close();
  await pool.end();
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

await app.listen({ port: config.port, host: config.host });
await referenceUpdates.startScheduler();
if (referenceUpdates.time) {
  app.log.info(
    `Aggiornamento delle banche dati ogni notte alle ${referenceUpdates.time}; prossimo: ${referenceUpdates.nextRun()?.toISOString()}`,
  );
}
