import { and, count, desc, eq, inArray, notExists, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { logAccess } from '../audit/access-log';
import type { Database } from '../db/client';
import { accessLog, accountLock, accountLockSeen, appUser } from '../db/schema';
import type { Tx } from '../db/tx';
import type { Actor } from './service';

/**
 * Blocchi del conto e loro avvisi (D181, D188): ogni blocco va all'utente bloccato e ai medici
 * titolari dello studio, finché ognuno non lo segna come visto. Un avviso fuori dal programma
 * (email) non c'è: nessun canale è deciso, e le integrazioni sono solo simulate (regola 7).
 */

export type LockKind = 'password' | 'code';

/** Quanti indirizzi e quante postazioni si tengono per blocco, i più recenti. */
export const LOCK_SOURCES_KEPT = 10;

/** Quanti avvisi si mostrano al più, i più recenti; gli altri si contano. */
export const LOCK_NOTICES_SHOWN = 100;

/** I tentativi che ogni soglia conta, come sono nel registro degli accessi. */
function countedAttempts(kind: LockKind) {
  const motivo = sql`${accessLog.details} ->> 'motivo'`;
  return kind === 'password'
    ? and(eq(accessLog.action, 'accesso_fallito'), sql`${motivo} = 'password errata'`)
    : or(
        and(
          eq(accessLog.action, 'secondo_fattore_fallito'),
          sql`${motivo} in ('codice errato', 'codice errato allo sblocco')`,
        ),
        and(eq(accessLog.action, 'cambio_password'), sql`${motivo} = 'password attuale errata'`),
      );
}

/** Senza ripetizioni, nell'ordine, al più `max`. */
function distinct(values: (string | null | undefined)[], max: number): string[] {
  const out: string[] = [];
  for (const v of values) {
    const x = v?.trim();
    if (x && !out.includes(x)) out.push(x);
    if (out.length === max) break;
  }
  return out;
}

/**
 * Registra il blocco appena scattato, nella transazione che l'ha fatto scattare: le provenienze
 * sono quella del tentativo di adesso e quelle degli altri tentativi contati, dal registro degli
 * accessi (il tentativo di adesso ci va dopo).
 */
export async function recordLock(
  tx: Tx,
  input: {
    studioId: string;
    userId: string;
    kind: LockKind;
    failures: number;
    lockedAt: Date;
    lockedUntil: Date;
    minutes: number;
    address: string | null;
    workstation: string;
  },
): Promise<void> {
  const earlier =
    input.failures > 1
      ? await tx
          .select({ workstation: accessLog.workstation, details: accessLog.details })
          .from(accessLog)
          .where(and(eq(accessLog.userId, input.userId), countedAttempts(input.kind)))
          .orderBy(desc(accessLog.at), desc(accessLog.seq))
          .limit(input.failures - 1)
      : [];
  const addressOf = (d: unknown) => {
    const v = (d as { indirizzo?: unknown } | null)?.indirizzo;
    return typeof v === 'string' ? v : null;
  };
  await tx.insert(accountLock).values({
    studioId: input.studioId,
    userId: input.userId,
    reason: input.kind === 'password' ? 'passwords' : 'codes',
    failures: input.failures,
    lockedAt: input.lockedAt,
    lockedUntil: input.lockedUntil,
    addresses: distinct(
      [input.address, ...earlier.map((e) => addressOf(e.details))],
      LOCK_SOURCES_KEPT,
    ),
    workstations: distinct(
      [input.workstation, ...earlier.map((e) => e.workstation)],
      LOCK_SOURCES_KEPT,
    ),
  });
  await logAccess(tx, {
    studioId: input.studioId,
    userId: input.userId,
    action: 'conto_bloccato',
    outcome: 'riuscito',
    workstation: input.workstation,
    details: {
      motivo: input.kind === 'password' ? 'password sbagliate' : 'codici sbagliati',
      tentativi: input.failures,
      minuti: input.minutes,
      indirizzo: input.address,
    },
  });
}

/** Chi vede quali blocchi: i propri; un medico titolare anche quelli degli utenti dello studio. */
const visibleTo = (actor: Actor) =>
  and(
    eq(accountLock.studioId, actor.studioId),
    actor.roles.includes('owner_doctor') ? undefined : eq(accountLock.userId, actor.userId),
  );

const unseenBy = (db: Database, actor: Actor) =>
  notExists(
    db
      .select({ one: sql`1` })
      .from(accountLockSeen)
      .where(
        and(eq(accountLockSeen.lockId, accountLock.id), eq(accountLockSeen.userId, actor.userId)),
      ),
  );

/** Quanti blocchi l'utente deve ancora vedere: per l'avviso nella cornice. */
export async function unseenLockCount(db: Database, actor: Actor): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(accountLock)
    .where(and(visibleTo(actor), unseenBy(db, actor)));
  return row?.n ?? 0;
}

const REASON_LABELS = {
  passwords: 'password sbagliate',
  codes: 'codici sbagliati',
} as const;

/**
 * I blocchi da vedere, i più recenti per primi. Ogni lettura va nel registro degli accessi: dice
 * da dove si è provato a entrare.
 */
export async function unseenLocks(db: Database, actor: Actor) {
  const where = and(visibleTo(actor), unseenBy(db, actor));
  const rows = await db
    .select({ lock: accountLock, name: appUser.displayName, username: appUser.username })
    .from(accountLock)
    .innerJoin(appUser, eq(appUser.id, accountLock.userId))
    .where(where)
    .orderBy(desc(accountLock.lockedAt), desc(accountLock.id))
    .limit(LOCK_NOTICES_SHOWN);
  const [total] = await db.select({ n: count() }).from(accountLock).where(where);
  await logAccess(db, {
    studioId: actor.studioId,
    userId: actor.userId,
    action: 'lettura_blocchi',
    outcome: 'consentito',
    workstation: actor.workstation,
    details: { blocchi: rows.length },
  });
  return {
    totale: total?.n ?? 0,
    blocchi: rows.map(({ lock: l, name, username }) => ({
      id: l.id,
      utente: { id: l.userId, nome: name, nomeUtente: username },
      proprio: l.userId === actor.userId,
      motivo: l.reason,
      motivoTesto: REASON_LABELS[l.reason],
      tentativi: l.failures,
      bloccatoIl: l.lockedAt.toISOString(),
      bloccatoFinoA: l.lockedUntil.toISOString(),
      indirizzi: l.addresses,
      postazioni: l.workstations,
    })),
  };
}

export const seenBody = z
  .object({
    blocchi: z
      .array(z.uuid({ error: 'Blocco: un identificativo' }))
      .min(1, 'Nessun blocco da segnare')
      .max(LOCK_NOTICES_SHOWN, 'Troppi blocchi insieme'),
  })
  .strict();

/**
 * Segna come visti i blocchi indicati, solo quelli che l'utente vede: gli altri si ignorano, e
 * quelli arrivati dopo la lettura restano da vedere. Dice quanti ne ha segnati.
 */
export async function markLocksSeen(
  db: Database,
  actor: Actor,
  body: unknown,
  t: Date,
): Promise<number> {
  const { blocchi } = seenBody.parse(body);
  const visible = await db
    .select({ id: accountLock.id })
    .from(accountLock)
    .where(and(visibleTo(actor), inArray(accountLock.id, blocchi)));
  if (visible.length === 0) return 0;
  const added = await db
    .insert(accountLockSeen)
    .values(visible.map((v) => ({ lockId: v.id, userId: actor.userId, seenAt: t })))
    .onConflictDoNothing()
    .returning({ id: accountLockSeen.lockId });
  return added.length;
}
