import { loadConfig } from '../config';
import { createPool } from './client';
import { runMigrations } from './migrate';

const pool = createPool(loadConfig().databaseUrl);
try {
  const applied = await runMigrations(pool);
  console.log(
    applied.length ? `Migrazioni applicate: ${applied.join(', ')}` : 'Nessuna migrazione da applicare.',
  );
} finally {
  await pool.end();
}
