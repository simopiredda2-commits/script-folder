import { randomBytes } from 'node:crypto';

/**
 * Nomi dei database di prova: mmg_test_<istante di creazione in base 36>_<8 cifre esadecimali>.
 * L'istante serve a riconoscere quelli rimasti da un giro interrotto senza toccare quelli di un
 * giro ancora in corso: sulla stessa macchina possono girare più prove insieme (più sessioni o più
 * agenti sullo stesso Postgres).
 */
export const TEST_DB_PATTERN = /^mmg_test_([0-9a-z]+)_[0-9a-f]{8}$/;

/** Oltre questa età un database di prova è certamente avanzato: nessun giro dura tanto. */
export const STALE_TEST_DB_MS = 6 * 3_600_000;

export function newTestDatabaseName(now: Date = new Date()): string {
  return `mmg_test_${now.getTime().toString(36)}_${randomBytes(4).toString('hex')}`;
}

/**
 * I database di prova da cancellare: del formato nuovo, più vecchi di STALE_TEST_DB_MS e senza
 * connessioni attive. Quelli di un altro formato (per esempio i vecchi, senza istante) non si
 * toccano: potrebbero essere di un giro in corso.
 */
export function staleTestDatabases(
  databases: readonly { name: string; connections: number }[],
  now: Date,
): string[] {
  return databases
    .filter((d) => {
      const m = TEST_DB_PATTERN.exec(d.name);
      if (!m) return false;
      const created = parseInt(m[1]!, 36);
      return (
        Number.isFinite(created) &&
        now.getTime() - created > STALE_TEST_DB_MS &&
        d.connections === 0
      );
    })
    .map((d) => d.name);
}
