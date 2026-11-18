import { buildApp } from './app';
import { loadConfig } from './config';
import { createDatabase, createPool } from './db/client';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const app = buildApp({ db: createDatabase(pool), logger: true });

const shutdown = async () => {
  await app.close();
  await pool.end();
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

await app.listen({ port: config.port, host: config.host });
