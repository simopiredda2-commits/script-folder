/**
 * Una sessione sola (D223). PGlite ha una sola sessione con il database: mentre una transazione è
 * aperta, una query che arriva da fuori aspetta che finisca. Il servizio è scritto per Postgres,
 * con più connessioni, e in qualche punto usa `db` dentro una transazione: per esempio «Registra»
 * un nuovo assistito da AURA, che crea il paziente e cerca il comune di nascita con `db`. Con
 * PGlite la query aspetterebbe la transazione, e la transazione la query: tutto fermo.
 *
 * Qui ciò che arriva mentre una transazione è aperta entra in quella transazione: le query
 * direttamente, le transazioni come punti di salvataggio. Perché sia giusto, la transazione aperta
 * deve essere di chi chiede: le richieste dell'interfaccia passano una alla volta (`queue`), e i
 * lavori dell'avvio aspettano che il database sia libero (`idle`).
 */
import type { PGlite, Transaction } from '@electric-sql/pglite';

type Query = PGlite['query'];

export interface SingleSession {
  /** Da dare a drizzle al posto di PGlite. */
  client: PGlite;
  /** Una richiesta alla volta: la prossima parte quando la precedente ha finito. */
  queue<T>(work: () => Promise<T>): Promise<T>;
  /** Si risolve quando nessuna transazione è aperta. */
  idle(): Promise<void>;
}

export function singleSession(pg: PGlite): SingleSession {
  let active: Transaction | null = null;
  let savepoints = 0;
  let waiting: (() => void)[] = [];
  let tail: Promise<unknown> = Promise.resolve();

  const query = ((sql: string, params?: unknown[], options?: Parameters<Query>[2]) =>
    active ? active.query(sql, params, options) : pg.query(sql, params, options)) as Query;

  async function transaction<T>(callback: (tx: Transaction) => Promise<T>): Promise<T> {
    if (active) {
      // Dentro la transazione aperta: un punto di salvataggio, come una transazione annidata.
      const tx = active;
      const name = `annidata_${++savepoints}`;
      await tx.exec(`savepoint ${name}`);
      try {
        const result = await callback(tx);
        await tx.exec(`release savepoint ${name}`);
        return result;
      } catch (err) {
        await tx.exec(`rollback to savepoint ${name}`);
        throw err;
      }
    }
    return pg.transaction(async (tx) => {
      active = tx;
      try {
        return await callback(tx);
      } finally {
        active = null;
        const done = waiting;
        waiting = [];
        for (const resolve of done) resolve();
      }
    });
  }

  const client = new Proxy(pg, {
    get(target, prop) {
      if (prop === 'query') return query;
      if (prop === 'transaction') return transaction;
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });

  return {
    client,
    queue<T>(work: () => Promise<T>) {
      const run = tail.then(work, work);
      tail = run.catch(() => undefined);
      return run;
    },
    idle() {
      return active ? new Promise<void>((resolve) => waiting.push(resolve)) : Promise.resolve();
    },
  };
}
