/**
 * Ripristino delle credenziali di un utente, sul server, da chi gestisce il servizio (tappa 14):
 *
 *   pnpm utente:ripristina -- --utente NOME                      password temporanea nuova
 *   pnpm utente:ripristina -- --utente NOME --secondo-fattore    … e secondo fattore da riattivare
 *   pnpm utente:ripristina -- --utente NOME --riattiva           riattiva, con una password nuova
 *   pnpm utente:ripristina -- --utente NOME --sospendi           sospende, senza password nuova
 *
 * Per medici e segreteria è l'unica strada: l'amministratore dello studio non dà loro password
 * temporanee e non azzera il loro secondo fattore. La password temporanea si vede solo qui, una
 * volta: si consegna di persona. Le sessioni dell'utente si chiudono; ogni azione va nel registro
 * delle azioni di amministrazione con «tramite: comando del server». Non applica migrazioni.
 */
import { parseArgs } from 'node:util';
import { z, ZodError } from 'zod';
import { loadConfig } from '../config';
import { createDatabase, createPool } from './client';
import { restoreUser, type RestoreAction } from './user-restore';

// Messaggi di controllo in italiano, come nel servizio (D85).
z.config(z.locales.it());

const USAGE =
  'Uso: pnpm utente:ripristina -- --utente NOME [--secondo-fattore] [--sospendi | --riattiva]';

/** Nomi delle opzioni del comando per i campi dei dati. */
const FLAGS: Record<string, string> = {
  utente: 'utente',
  secondoFattore: 'secondo-fattore',
  sospendi: 'sospendi',
  riattiva: 'riattiva',
};

const DONE: Record<RestoreAction, string> = {
  password_temporanea: 'password temporanea nuova',
  azzeramento_secondo_fattore: 'secondo fattore azzerato: si riattiva al prossimo accesso',
  sospensione: 'utente sospeso',
  riattivazione: 'utente riattivato',
};

let values: {
  utente?: string;
  'secondo-fattore'?: boolean;
  sospendi?: boolean;
  riattiva?: boolean;
};
try {
  ({ values } = parseArgs({
    // pnpm passa anche il «--» che separa i suoi argomenti da quelli del comando.
    args: process.argv.slice(2).filter((a) => a !== '--'),
    options: {
      utente: { type: 'string' },
      'secondo-fattore': { type: 'boolean' },
      sospendi: { type: 'boolean' },
      riattiva: { type: 'boolean' },
    },
  }));
} catch (err) {
  // Gli errori di parseArgs sono in inglese: si dice in italiano che cosa non va.
  const code = (err as { code?: string }).code;
  console.error(
    code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION'
      ? 'Opzione sconosciuta.'
      : code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE'
        ? 'Valore non valido per un’opzione (per --utente serve il nome utente).'
        : 'Opzioni non valide.',
  );
  console.error(USAGE);
  process.exit(1);
}

const config = loadConfig();
const pool = createPool(config.databaseUrl);
try {
  const r = await restoreUser(createDatabase(pool), {
    utente: values.utente ?? '',
    secondoFattore: values['secondo-fattore'] ?? false,
    sospendi: values.sospendi ?? false,
    riattiva: values.riattiva ?? false,
  });
  console.log(`Utente ${r.username} (${r.displayName}), studio «${r.studioName}».`);
  for (const a of r.actions) console.log(`  ${DONE[a]}`);
  if (r.secondFactorWasInactive)
    console.log('  secondo fattore: non era attivo, si attiva al prossimo accesso');
  console.log(`  sessioni chiuse: ${r.closedSessions}`);
  if (r.temporaryPassword) {
    console.log(`  password temporanea:  ${r.temporaryPassword}`);
    console.log(
      'La password si vede solo ora: consegnala di persona. Al prossimo accesso va cambiata.',
    );
  }
  if (r.awaitingConfirmation)
    console.log(
      'L’utente è in attesa della conferma di un medico titolare dello studio: entra solo dopo la conferma.',
    );
  if (r.status === 'suspended' && !r.actions.includes('sospensione'))
    console.log('L’utente è sospeso: entra solo dopo la riattivazione (--riattiva).');
} catch (err) {
  if (err instanceof ZodError) {
    console.error('Dati non validi:');
    for (const i of err.issues) {
      const field = String(i.path[0] ?? '');
      console.error(`  --${FLAGS[field] ?? field}: ${i.message}`);
    }
    console.error(USAGE);
  } else console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
