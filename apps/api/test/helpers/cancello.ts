import type pg from 'pg';

/** Il blocco consultivo del cancello: diverso da quello della catena del registro (4620119). */
const GATE = 4620229;

/** Le richieste ferme al cancello, adesso. */
async function atTheGate(monitor: pg.Client): Promise<number> {
  const { rows } = await monitor.query<{ n: number }>(
    `select count(*)::int as n from pg_locks
      where locktype = 'advisory' and not granted and classid = $1 and objsubid = 2
        and database = (select oid from pg_database where datname = current_database())`,
    [GATE],
  );
  return rows[0]!.n;
}

/**
 * Un cancello per le richieste in gara sullo stesso codice fiscale (D229). Un trigger ferma la
 * scrittura di quel codice fiscale sul blocco consultivo dell'utente della transazione
 * (`app.user_id`, scritto da `withActor`), che la prova tiene. Quando le richieste sono ferme
 * tutte, hanno già passato il controllo del doppione. La prova apre a una richiesta per volta,
 * nell'ordine dato, e la seguente scrive quando la precedente ha finito: chi arriva dopo trova la
 * riga del primo, che il suo controllo non aveva visto. Il cancello si toglie comunque.
 *
 * Un utente per richiesta; `monitor` è un client fuori dal gruppo di connessioni del servizio.
 */
export async function inOrderAtTheGate<T>(
  monitor: pg.Client,
  fiscalCode: string,
  steps: { userId: string; send: () => Promise<T> }[],
): Promise<T[]> {
  const users = steps.map((st) => st.userId);
  if (new Set(users).size !== users.length) throw new Error('Un utente per richiesta');
  const code = fiscalCode.replace(/[^A-Z0-9]/g, '');
  const held = new Set<string>();
  try {
    for (const id of users) {
      await monitor.query('select pg_advisory_lock($1, hashtext($2))', [GATE, id]);
      held.add(id);
    }
    await monitor.query(
      `create function cancello_di_prova() returns trigger language plpgsql as $$ begin
         perform pg_advisory_xact_lock_shared(${GATE}, hashtext(current_setting('app.user_id', true)));
         return new;
       end $$`,
    );
    await monitor.query(
      `create trigger cancello_di_prova before insert or update of fiscal_code on patient
         for each row when (new.fiscal_code = '${code}') execute function cancello_di_prova()`,
    );
    const running = steps.map((st) => st.send());
    for (let i = 0; (await atTheGate(monitor)) < steps.length; i++) {
      if (i >= 400) throw new Error(`Non ci sono ${steps.length} richieste ferme al cancello`);
      await new Promise((r) => setTimeout(r, 25));
    }
    const results: T[] = [];
    for (const [i, id] of users.entries()) {
      await monitor.query('select pg_advisory_unlock($1, hashtext($2))', [GATE, id]);
      held.delete(id);
      results.push(await running[i]!);
    }
    return results;
  } finally {
    for (const id of held)
      await monitor.query('select pg_advisory_unlock($1, hashtext($2))', [GATE, id]);
    await monitor.query('drop trigger if exists cancello_di_prova on patient');
    await monitor.query('drop function if exists cancello_di_prova()');
  }
}
