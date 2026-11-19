import pg from 'pg';
import { staleTestDatabases } from './test-db-names';

/**
 * Prima di ogni giro di prove cancella i database di prova (mmg_test_…) rimasti da un giro
 * interrotto a metà: solo quelli vecchi di ore e senza connessioni, mai quelli di un giro ancora in
 * corso (test-db-names.ts). Le prove li creano e li cancellano da sole quando finiscono normalmente.
 */
export default async function setup(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return; // le prove stesse falliranno con un messaggio chiaro
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const { rows } = await c.query<{ name: string; connections: number }>(
      `select d.datname as name,
              (select count(*)::int from pg_stat_activity a where a.datname = d.datname) as connections
         from pg_database d
        where d.datname like 'mmg\\_test\\_%'`,
    );
    for (const name of staleTestDatabases(rows, new Date()))
      await c.query(`DROP DATABASE IF EXISTS ${name}`);
  } finally {
    await c.end();
  }
}
