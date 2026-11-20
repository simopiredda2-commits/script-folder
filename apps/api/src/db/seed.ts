/**
 * Dati dimostrativi per lo sviluppo: uno studio inventato, i suoi utenti e pazienti inventati.
 *
 *   pnpm db:seed
 *
 * Idempotente: se gli utenti dimostrativi esistono già, non fa nulla. Le password sono casuali
 * e si leggono solo qui, una volta: nessuna credenziale sta nel repository. Il secondo fattore
 * si attiva al primo accesso.
 */
import { loadConfig } from '../config';
import { createDatabase, createPool } from './client';
import { DEMO_USERS, seedDemo } from './demo-seed';
import { runMigrations } from './migrate';

const config = loadConfig();
// I dati dimostrativi non vanno mai in un'installazione vera (regola 1, D170).
if (config.environment === 'produzione') {
  console.error('APP_AMBIENTE=produzione: i dati dimostrativi non si creano in produzione.');
  process.exit(1);
}
const pool = createPool(config.databaseUrl);
const db = createDatabase(pool);

try {
  await runMigrations(pool);
  const seeded = await seedDemo(db, { encryptionKey: config.encryptionKey });
  if (!seeded) {
    console.log('Dati dimostrativi già presenti: niente da fare.');
    process.exit(0);
  }
  console.log(
    `Dati dimostrativi creati: studio, 4 utenti, 40 pazienti inventati, ${seeded.appointmentsToday} appuntamenti oggi, ${seeded.toSign} ricette da firmare.`,
  );
  console.log('Banche dati d’esempio: pnpm banche-dati:importa -- --esempio\n');
  console.log('Credenziali (mostrate solo ora; il secondo fattore si attiva al primo accesso):');
  for (const u of DEMO_USERS)
    console.log(`  ${u.username.padEnd(15)} ${seeded.passwords.get(u.username)}`);
} finally {
  await pool.end();
}
