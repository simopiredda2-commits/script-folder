/**
 * Primo avvio di uno studio vero (tappa 14, D172):
 *
 *   pnpm studio:crea -- --nome "Studio medico …" --tipo singolo --regione PIEMONTE \
 *     --amministratore nome.cognome --nome-amministratore "Nome Cognome" [--email …]
 *
 * Applica le migrazioni, crea lo studio e il primo amministratore, e mostra una sola volta la
 * password temporanea: al primo accesso si attiva il secondo fattore e si cambia la password. Gli
 * altri utenti (medici, segreteria) li crea l'amministratore da Strumenti › Utenti e ruoli.
 */
import { parseArgs } from 'node:util';
import { z, ZodError } from 'zod';
import { loadConfig } from '../config';
import { createDatabase, createPool } from './client';
import { createFirstStudio } from './first-studio';
import { runMigrations } from './migrate';

// Messaggi di controllo in italiano, come nel servizio (D85).
z.config(z.locales.it());

/** Nomi delle opzioni del comando per i campi dei dati. */
const FLAGS: Record<string, string> = { nomeAmministratore: 'nome-amministratore' };

const { values } = parseArgs({
  // pnpm passa anche il «--» che separa i suoi argomenti da quelli del comando.
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    nome: { type: 'string' },
    tipo: { type: 'string' },
    regione: { type: 'string' },
    amministratore: { type: 'string' },
    'nome-amministratore': { type: 'string' },
    email: { type: 'string' },
  },
});

const config = loadConfig();
const pool = createPool(config.databaseUrl);
try {
  await runMigrations(pool);
  const r = await createFirstStudio(createDatabase(pool), {
    nome: values.nome ?? '',
    tipo: (values.tipo ?? '') as 'singolo' | 'gruppo',
    regione: values.regione ?? '',
    amministratore: values.amministratore ?? '',
    nomeAmministratore: values['nome-amministratore'] ?? '',
    ...(values.email ? { email: values.email } : {}),
  });
  console.log('Studio creato, con il suo primo amministratore.');
  console.log(`  utente:               ${values.amministratore}`);
  console.log(`  password temporanea:  ${r.temporaryPassword}`);
  console.log(
    'La password si vede solo ora: consegnala di persona. Al primo accesso si attiva il secondo fattore e si cambia la password.',
  );
} catch (err) {
  if (err instanceof ZodError) {
    console.error('Dati non validi:');
    for (const i of err.issues) {
      const field = String(i.path[0] ?? '');
      console.error(`  --${FLAGS[field] ?? field}: ${i.message}`);
    }
  } else console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
