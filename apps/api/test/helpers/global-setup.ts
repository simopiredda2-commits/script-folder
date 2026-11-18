import pg from 'pg';

/**
 * Prima di ogni giro di prove cancella i database di prova (mmg_test_…) rimasti da un giro
 * interrotto a metà. Le prove li creano e li cancellano da sole quando finiscono normalmente.
 */
export default async function setup(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) return; // le prove stesse falliranno con un messaggio chiaro
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    const { rows } = await c.query<{ datname: string }>(
      "select datname from pg_database where datname ~ '^mmg_test_[0-9a-f]{12}$'",
    );
    for (const { datname } of rows)
      await c.query(`DROP DATABASE IF EXISTS ${datname} WITH (FORCE)`);
  } finally {
    await c.end();
  }
}
