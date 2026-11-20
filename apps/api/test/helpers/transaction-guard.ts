/**
 * Controllo delle transazioni (D226), in ogni prova del servizio.
 *
 * Mentre una transazione è aperta, il servizio deve lavorare con la sua connessione (`tx`), non con
 * il database (`db`):
 *
 * - una scrittura fatta con `db` resta anche se la transazione poi torna indietro;
 * - una lettura fatta con `db` non vede ciò che la transazione ha già scritto;
 * - ogni richiesta così tiene occupate due connessioni del gruppo, e con il gruppo pieno aspetta
 *   una connessione che nessuno libera.
 *
 * Qui ogni transazione aperta con `db.transaction` (anche da `withActor`) segna il suo contesto
 * asincrono. Se da quel contesto, mentre la transazione è aperta, il codice del servizio chiama il
 * database (`db.select`, `db.insert`, `db.query.…`, `db.transaction`…), la chiamata si annota con il
 * suo punto nel codice: dopo la prova le annotazioni la fanno fallire, tranne quelle in `ALLOWED`,
 * ognuna con il suo motivo. Si guarda la chiamata e non la query: drizzle manda la query più tardi,
 * quando la catena delle chiamate non dice più chi l'ha chiesta.
 *
 * Con `CONTROLLO_TRANSAZIONI=annota` le annotazioni non fanno fallire nulla: si scrivono, una per
 * riga in JSON, nel file `CONTROLLO_TRANSAZIONI_FILE`.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { appendFileSync } from 'node:fs';
import { PgDatabase } from 'drizzle-orm/pg-core';
import { RelationalQueryBuilder } from 'drizzle-orm/pg-core/query-builders/query';
import pg from 'pg';
import { afterEach, beforeEach, expect } from 'vitest';

export interface OutsideCall {
  /** Il punto del servizio che chiama il database: `src/…/file.ts:riga`. */
  where: string;
  /** Che cosa ha chiamato: `db.select`, `db.query.findFirst`, `db.transaction`… */
  what: string;
  /** Dove si è aperta la transazione. */
  opened: string;
  /** La catena delle chiamate, solo i punti del servizio e delle prove. */
  stack: string[];
}

/** Uscite volute dalla transazione aperta, ognuna con il motivo. */
export const ALLOWED: { where: RegExp; what?: RegExp; reason: string }[] = [];

interface OpenTransaction {
  open: boolean;
  opened: string;
}

interface Guard {
  context: AsyncLocalStorage<OpenTransaction>;
  /** Le annotazioni della prova in corso (fuori da una prova non si annota nulla). */
  found: OutsideCall[] | null;
}

const KEY = Symbol.for('mmg.transaction-guard');
const ROOT = new URL('../../', import.meta.url).pathname;

/** Le righe della catena che sono del servizio o delle prove, con il percorso da `apps/api`. */
function ownFrames(stack: string): string[] {
  return stack
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.includes(ROOT) && !line.includes('/node_modules/'))
    .filter((line) => !line.includes('/test/helpers/transaction-guard.ts'))
    .map((line) => line.replace(ROOT, ''));
}

function location(frame: string | undefined): string {
  if (!frame) return '(fuori dal servizio)';
  const m = /((?:src|test)\/[^:()\s]+:\d+)(?::\d+)?\)?$/.exec(frame);
  return m ? m[1]! : frame;
}

/** La query andrebbe al gruppo di connessioni, non alla connessione di una transazione. */
function onPool(session: unknown): boolean {
  return (session as { client?: unknown } | undefined)?.client instanceof pg.Pool;
}

function install(): Guard {
  const g = globalThis as typeof globalThis & { [KEY]?: Guard };
  if (g[KEY]) return g[KEY];
  const guard: Guard = { context: new AsyncLocalStorage(), found: null };
  g[KEY] = guard;
  // Le catene delle chiamate sono lunghe: senza questo il punto del servizio cade fuori dalle
  // dieci righe di Node.
  Error.stackTraceLimit = Math.max(Error.stackTraceLimit, 60);

  const note = (what: string) => {
    const open = guard.context.getStore();
    if (!open?.open || !guard.found) return;
    const frames = ownFrames(new Error().stack ?? '');
    const call: OutsideCall = {
      where: location(frames.find((f) => f.includes('src/'))),
      what,
      opened: open.opened,
      stack: frames,
    };
    if (ALLOWED.some((a) => a.where.test(call.where) && (!a.what || a.what.test(call.what))))
      return;
    guard.found.push(call);
  };

  type Method = (this: { session?: unknown }, ...args: unknown[]) => unknown;
  const db = PgDatabase.prototype as unknown as Record<string, Method>;
  for (const name of [
    'select',
    'selectDistinct',
    'selectDistinctOn',
    'insert',
    'update',
    'delete',
    'execute',
    '$count',
    'with',
    'refreshMaterializedView',
  ]) {
    const original = db[name]!;
    db[name] = function (...args) {
      if (onPool(this.session)) note(`db.${name}`);
      return original.apply(this, args);
    };
  }

  // Una transazione del database: dentro una aperta è una seconda connessione; poi segna il suo
  // contesto. (Le transazioni dentro `tx` sono punti di salvataggio di drizzle, su `tx`.)
  const transaction = db.transaction!;
  db.transaction = function (fn, ...rest) {
    if (!onPool(this.session)) return transaction.call(this, fn, ...rest);
    note('db.transaction');
    const opened = location(
      ownFrames(new Error().stack ?? '').find((f) => !f.includes('src/db/tx.ts')),
    );
    return transaction.call(
      this,
      (tx: unknown) => {
        const marker: OpenTransaction = { open: true, opened };
        return guard.context.run(marker, async () => {
          try {
            return await (fn as (tx: unknown) => Promise<unknown>)(tx);
          } finally {
            marker.open = false;
          }
        });
      },
      ...rest,
    );
  };

  const relational = RelationalQueryBuilder.prototype as unknown as Record<string, Method>;
  for (const name of ['findMany', 'findFirst']) {
    const original = relational[name]!;
    relational[name] = function (...args) {
      if (onPool(this.session)) note(`db.query.${name}`);
      return original.apply(this, args);
    };
  }
  return guard;
}

const guard = install();
const record = process.env.CONTROLLO_TRANSAZIONI === 'annota';
const recordFile = process.env.CONTROLLO_TRANSAZIONI_FILE;

/** Per la prova del controllo stesso: le annotazioni della prova in corso, tolte dal controllo. */
export function takeOutsideCalls(): OutsideCall[] {
  const taken = guard.found ?? [];
  if (guard.found) guard.found = [];
  return taken;
}

beforeEach(() => {
  guard.found = [];
});

afterEach((ctx) => {
  const seen = guard.found ?? [];
  guard.found = null;
  if (record) {
    if (recordFile)
      for (const call of seen)
        appendFileSync(
          recordFile,
          `${JSON.stringify({ test: `${ctx.task.file.name} > ${ctx.task.name}`, ...call })}\n`,
        );
    return;
  }
  // Solo il codice del servizio: una prova può usare il database come vuole.
  const service = seen.filter((c) => c.where.startsWith('src/'));
  const unique = [...new Map(service.map((c) => [`${c.where} ${c.what}`, c])).values()];
  expect(
    unique.map(
      (c) =>
        `${c.where} – ${c.what} dentro la transazione aperta in ${c.opened}\n    ${c.stack.slice(0, 6).join('\n    ')}`,
    ),
    'il database usato fuori dalla transazione aperta (test/helpers/transaction-guard.ts)',
  ).toEqual([]);
});
