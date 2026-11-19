/**
 * Ripristino delle credenziali di un utente, sul server, da chi gestisce il servizio (tappa 14):
 *
 *   pnpm utente:ripristina -- --utente NOME                      password temporanea nuova
 *   pnpm utente:ripristina -- --utente NOME --secondo-fattore    … e secondo fattore da riattivare
 *   pnpm utente:ripristina -- --utente NOME --riattiva           riattiva, con una password nuova
 *   pnpm utente:ripristina -- --utente NOME --sospendi           sospende, senza password nuova
 *   pnpm utente:ripristina -- --utente NOME --sblocca            toglie il blocco dei tentativi
 *   pnpm utente:ripristina -- --utente NOME --mostra             stampa la richiesta di conferma
 *   pnpm utente:ripristina -- --utente NOME --conferma --richiesta-il DATA
 *                                                                conferma la richiesta letta, quando
 *                                                                nessun titolare può farlo
 *   pnpm utente:ripristina -- --utente NOME --rifiuta            rifiuta la richiesta: l'utente
 *                                                                resta in attesa, sospeso
 *
 * Per medici e segreteria è l'unica strada: l'amministratore dello studio non dà loro password
 * temporanee, non azzera il loro secondo fattore e non toglie il loro blocco. La conferma dal
 * server serve quando nello studio non c'è un medico titolare attivo e confermato (per esempio il
 * primo titolare di uno studio nuovo) e si fa in due passi (seconda revisione dei poteri
 * dell'amministratore, problema nuovo 1): --mostra stampa la richiesta, senza cambiare nulla (nome
 * utente, nome, ruoli, dati del medico, chi l'ha fatta e quando, con la data esatta, stato); chi
 * gestisce il servizio la controlla di persona con l'interessato, poi conferma con --conferma e
 * --richiesta-il, la data stampata. Se nel frattempo l'amministratore ha cambiato la richiesta, la
 * data è diversa e la conferma si rifiuta: si rilegge con --mostra. Con --riattiva conferma anche
 * un utente sospeso. --rifiuta lascia l'utente in attesa e lo sospende. Chi è sospeso dal server
 * (--sospendi, --rifiuta) dal programma non si riattiva: lo riattiva --riattiva.
 *
 * La password temporanea si vede solo qui, una volta: si consegna di persona. Le sessioni
 * dell'utente si chiudono (non con --sblocca né con --mostra); ogni azione, anche --mostra, va nel
 * registro delle azioni di amministrazione con «tramite: comando del server». Non applica
 * migrazioni.
 */
import { parseArgs } from 'node:util';
import { z, ZodError } from 'zod';
import { loadConfig } from '../config';
import { createDatabase, createPool } from './client';
import {
  restoreInput,
  restoreUser,
  showRequest,
  type RequestView,
  type RestoreAction,
} from './user-restore';

// Messaggi di controllo in italiano, come nel servizio (D85).
z.config(z.locales.it());

const COMMAND = 'pnpm utente:ripristina --';

const USAGE = [
  `Uso: ${COMMAND} --utente NOME [--secondo-fattore] [--sospendi | --riattiva]`,
  `     ${COMMAND} --utente NOME --sblocca`,
  `     ${COMMAND} --utente NOME --mostra`,
  `     ${COMMAND} --utente NOME --conferma --richiesta-il DATA [--riattiva]`,
  `     ${COMMAND} --utente NOME --rifiuta`,
].join('\n');

/** Nomi delle opzioni del comando per i campi dei dati. */
const FLAGS: Record<string, string> = {
  utente: 'utente',
  secondoFattore: 'secondo-fattore',
  sospendi: 'sospendi',
  riattiva: 'riattiva',
  sblocca: 'sblocca',
  conferma: 'conferma',
  rifiuta: 'rifiuta',
  mostra: 'mostra',
  richiestaIl: 'richiesta-il',
};

const DONE: Record<RestoreAction, string> = {
  password_temporanea: 'password temporanea nuova',
  azzeramento_secondo_fattore: 'secondo fattore azzerato: si riattiva al prossimo accesso',
  sospensione:
    'utente sospeso da chi gestisce il servizio: dal programma non si riattiva (lo riattiva --riattiva)',
  riattivazione: 'utente riattivato',
  sblocco: 'blocco tolto: tentativi falliti a zero, password e secondo fattore come prima',
  conferma:
    'utente confermato: password temporanea nuova e secondo fattore da riattivare al primo accesso',
  rifiuto:
    'richiesta rifiutata: l’utente resta in attesa di conferma, sospeso da chi gestisce il servizio; dal programma non si riattiva (lo riattiva --riattiva)',
};

const orMissing = (v: string | null) => v ?? 'da completare';

/** La richiesta di conferma come la legge chi gestisce il servizio, prima di confermare. */
function printRequest(r: RequestView) {
  const line = (label: string, value: string) => console.log(`  ${label.padEnd(17)}${value}`);
  console.log(`Utente ${r.username}, studio «${r.studioName}».`);
  line('nome mostrato:', r.displayName);
  line('ruoli:', r.roleNames.join(', ') || 'nessuno');
  line(
    'dati del medico:',
    r.doctor
      ? [
          `nome ${orMissing(r.doctor.firstName)}`,
          `cognome ${orMissing(r.doctor.lastName)}`,
          `codice fiscale ${orMissing(r.doctor.fiscalCode)}`,
          `codice regionale ${orMissing(r.doctor.regionalCode)}`,
          `ASL ${orMissing(r.doctor.asl)}`,
        ].join(', ')
      : 'nessuno (non è un medico)',
  );
  const state = [
    r.status === 'active'
      ? 'attivo'
      : r.suspendedByService
        ? 'sospeso da chi gestisce il servizio'
        : 'sospeso',
    r.awaitingConfirmation ? 'in attesa di conferma' : 'non in attesa di conferma',
  ].join(', ');
  line('stato:', state);
  if (!r.awaitingConfirmation) {
    console.log('Niente da confermare: l’utente non è in attesa di conferma.');
    return;
  }
  line(
    'richiesta di:',
    r.requestedBy
      ? `${r.requestedBy.username} (${r.requestedBy.displayName})`
      : 'chi gestisce il servizio, sul server',
  );
  line('richiesta il:', r.requestedAt ?? 'data non registrata');
  line('alla conferma:', 'password temporanea nuova e secondo fattore da riattivare');
  if (r.ownerCanConfirm) {
    console.log(
      'Nello studio c’è un medico titolare attivo e confermato: la conferma la fa lui, dal programma (Strumenti › Utenti da confermare).',
    );
    return;
  }
  console.log(
    'Prima di confermare, controlla di persona con l’interessato che nome, ruoli e dati del medico siano i suoi.',
  );
  if (r.requestedAt) {
    console.log('Per confermare questa richiesta, e solo questa:');
    console.log(
      `  ${COMMAND} --utente ${r.username} --conferma --richiesta-il ${r.requestedAt}${r.status === 'suspended' ? ' --riattiva' : ''}`,
    );
  }
  console.log('Per rifiutarla:');
  console.log(`  ${COMMAND} --utente ${r.username} --rifiuta`);
}

let values: {
  utente?: string;
  'secondo-fattore'?: boolean;
  sospendi?: boolean;
  riattiva?: boolean;
  sblocca?: boolean;
  conferma?: boolean;
  rifiuta?: boolean;
  mostra?: boolean;
  'richiesta-il'?: string;
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
      sblocca: { type: 'boolean' },
      conferma: { type: 'boolean' },
      rifiuta: { type: 'boolean' },
      mostra: { type: 'boolean' },
      'richiesta-il': { type: 'string' },
    },
  }));
} catch (err) {
  // Gli errori di parseArgs sono in inglese: si dice in italiano che cosa non va.
  const code = (err as { code?: string }).code;
  console.error(
    code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION'
      ? 'Opzione sconosciuta.'
      : code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE'
        ? 'Valore non valido per un’opzione (per --utente serve il nome utente, per --richiesta-il la data che stampa --mostra).'
        : 'Opzioni non valide.',
  );
  console.error(USAGE);
  process.exit(1);
}

const config = loadConfig();
const pool = createPool(config.databaseUrl);
try {
  const db = createDatabase(pool);
  const input = {
    utente: values.utente ?? '',
    secondoFattore: values['secondo-fattore'] ?? false,
    sospendi: values.sospendi ?? false,
    riattiva: values.riattiva ?? false,
    sblocca: values.sblocca ?? false,
    conferma: values.conferma ?? false,
    rifiuta: values.rifiuta ?? false,
    mostra: values.mostra ?? false,
    ...(values['richiesta-il'] !== undefined ? { richiestaIl: values['richiesta-il'] } : {}),
  };
  if (input.mostra) {
    // Le stesse regole delle altre opzioni: --mostra va da solo.
    restoreInput.parse(input);
    printRequest(await showRequest(db, { utente: input.utente }));
  } else {
    const r = await restoreUser(db, input);
    console.log(`Utente ${r.username} (${r.displayName}), studio «${r.studioName}».`);
    for (const a of r.actions) console.log(`  ${DONE[a]}`);
    if (r.secondFactorWasInactive)
      console.log('  secondo fattore: non era attivo, si attiva al prossimo accesso');
    console.log(
      r.actions.includes('sblocco')
        ? '  sessioni: restano aperte, lo sblocco non cambia le credenziali'
        : `  sessioni chiuse: ${r.closedSessions}`,
    );
    if (r.temporaryPassword) {
      console.log(`  password temporanea:  ${r.temporaryPassword}`);
      console.log(
        'La password si vede solo ora: consegnala di persona. Al prossimo accesso va cambiata.',
      );
    }
    if (r.awaitingConfirmation && !r.actions.includes('rifiuto'))
      console.log(
        'L’utente è in attesa della conferma di un medico titolare dello studio: entra solo dopo la conferma.',
      );
    if (
      r.status === 'suspended' &&
      !r.actions.includes('sospensione') &&
      !r.actions.includes('rifiuto')
    )
      console.log('L’utente è sospeso: entra solo dopo la riattivazione (--riattiva).');
  }
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
