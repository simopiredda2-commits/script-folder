import { and, eq, isNull, lt, lte, or } from 'drizzle-orm';
import type { Database } from '../db/client';
import { withLockTimeout } from '../db/locks';
import { loginSource } from '../db/schema';
import type { Tx } from '../db/tx';

/**
 * Attese crescenti dopo le password sbagliate, per indirizzo e per postazione (D181, D188).
 *
 * Il problema (D179, problema 4): chi conosce il nome utente di un medico lo teneva fuori un'ora
 * alla volta con qualche password sbagliata, perché il blocco era sul conto. Ora le password
 * sbagliate rallentano la loro provenienza: dopo le prime, ogni password aspetta un'attesa che
 * raddoppia, e intanto da lì nessuna password si guarda. Il medico, da un altro computer, non
 * aspetta; il conto si blocca solo alla soglia alta dello studio.
 *
 * Due provenienze per ogni tentativo: la postazione scritta a quell'indirizzo (chi riprova dallo
 * stesso browser) e l'indirizzo, con tutte le sue postazioni (chi cambia il nome della postazione a
 * ogni tentativo). La postazione da sola non basta e non si usa: la scrive chi accede, e chi
 * scrivesse «Ambulatorio» da fuori farebbe aspettare l'ambulatorio vero.
 *
 * Ogni password si conta prima di guardarla, in una transazione con le righe bloccate: con molte
 * richieste insieme dalla stessa provenienza se ne guardano al più quante ne ammette la soglia, più
 * una. Una password giusta toglie le righe della sua provenienza.
 */
export interface LoginSourceLimits {
  /** Password sbagliate di seguito da una postazione, a quell'indirizzo, prima delle attese. */
  workstationFree: number;
  /** Password sbagliate di seguito da un indirizzo, da tutte le sue postazioni, prima delle attese. */
  addressFree: number;
  /** La prima attesa, in secondi; poi raddoppia a ogni password sbagliata. */
  firstWaitSeconds: number;
  /** L'attesa più lunga, in secondi. */
  maxWaitSeconds: number;
  /** Dopo tante ore senza password sbagliate, la provenienza ricomincia da capo. */
  forgetAfterHours: number;
}

/**
 * Valori di buon senso e non di una norma (D188), confermati da Simone alla fermata dopo la tappa 17
 * (D191): si riguardano se in studio danno fastidio. Cinque password come
 * la soglia di prima (D29); venti dallo stesso indirizzo, perché uno studio esce su internet con un
 * indirizzo solo per tutti i computer; da 2 secondi a 15 minuti, la durata del blocco di prima.
 */
export const LOGIN_SOURCE_LIMITS: Readonly<LoginSourceLimits> = {
  workstationFree: 5,
  addressFree: 20,
  firstWaitSeconds: 2,
  maxWaitSeconds: 900,
  forgetAfterHours: 24,
};

export type SourceKind = (typeof loginSource.$inferSelect)['kind'];

export interface Source {
  kind: SourceKind;
  key: string;
  free: number;
}

/**
 * Le provenienze di un tentativo: l'indirizzo, poi la postazione a quell'indirizzo (nome senza
 * maiuscole e spazi ai lati). Senza indirizzo nessuna: lo dà sempre la rotta (`req.ip`).
 */
export function sourcesOf(
  address: string | null | undefined,
  workstation: string,
  limits: LoginSourceLimits,
): Source[] {
  if (!address) return [];
  return [
    { kind: 'address', key: address, free: limits.addressFree },
    {
      kind: 'workstation',
      key: `${address} ${workstation.trim().toLowerCase()}`,
      free: limits.workstationFree,
    },
  ];
}

/** Secondi di attesa dopo la `n`-esima password sbagliata di seguito, con `free` ammesse. */
export function waitAfter(n: number, free: number, limits: LoginSourceLimits): number {
  if (n <= free) return 0;
  return Math.min(limits.maxWaitSeconds, limits.firstWaitSeconds * 2 ** (n - free - 1));
}

/** «1 secondo», «40 secondi», «2 minuti»: i minuti si arrotondano in su. */
export function waitText(seconds: number): string {
  if (seconds < 60) return seconds === 1 ? '1 secondo' : `${seconds} secondi`;
  const m = Math.ceil(seconds / 60);
  return m === 1 ? '1 minuto' : `${m} minuti`;
}

export function sourceWaitMessage(kind: SourceKind, seconds: number): string {
  const from = kind === 'address' ? 'questo indirizzo' : 'questa postazione';
  return `Troppe password sbagliate da ${from}: riprova tra ${waitText(seconds)}`;
}

/**
 * Esito della prenotazione: la password si guarda, ed era già contata come sbagliata (`wait`: i
 * secondi che la provenienza aspetterà se lo è davvero); oppure la provenienza aspetta, e la
 * password non si guarda né si conta.
 */
export type Reservation =
  { ok: true; wait: number } | { ok: false; kind: SourceKind; wait: number };

const whereSource = (s: Source) =>
  and(eq(loginSource.kind, s.kind), eq(loginSource.sourceKey, s.key));

/**
 * Conta il tentativo sulle sue provenienze prima di guardare la password, se nessuna aspetta.
 * Le righe si bloccano sempre nello stesso ordine (indirizzo, poi postazione): due richieste non
 * si aspettano a vicenda. Una riga occupata oltre `lockTimeout` fa scadere l'attesa (55P03).
 */
export async function reserveAttempt(
  db: Database,
  sources: Source[],
  t: Date,
  limits: LoginSourceLimits,
  lockTimeout: string,
): Promise<Reservation> {
  if (sources.length === 0) return { ok: true, wait: 0 };
  const forgetBefore = new Date(t.getTime() - limits.forgetAfterHours * 3_600_000);
  return db.transaction((tx: Tx) =>
    withLockTimeout(tx, lockTimeout, async () => {
      const rows: { s: Source; failures: number; last: Date; until: Date | null }[] = [];
      for (const s of sources) {
        await tx
          .insert(loginSource)
          .values({ kind: s.kind, sourceKey: s.key, failures: 0, lastFailureAt: t })
          .onConflictDoNothing();
        const [row] = await tx.select().from(loginSource).where(whereSource(s)).for('update');
        rows.push({
          s,
          failures: row!.failures,
          last: row!.lastFailureAt,
          until: row!.waitUntil,
        });
      }
      // Una provenienza che aspetta: la password non si guarda e niente si conta.
      const waiting = rows
        .filter((r) => r.until && r.until > t)
        .sort((a, b) => b.until!.getTime() - a.until!.getTime())[0];
      if (waiting)
        return {
          ok: false as const,
          kind: waiting.s.kind,
          wait: Math.ceil((waiting.until!.getTime() - t.getTime()) / 1000),
        };
      let wait = 0;
      for (const r of rows) {
        // Nessuna password sbagliata da un giorno: si ricomincia da capo.
        const n = (r.last < forgetBefore ? 0 : r.failures) + 1;
        const w = waitAfter(n, r.s.free, limits);
        wait = Math.max(wait, w);
        await tx
          .update(loginSource)
          .set({
            failures: n,
            lastFailureAt: t,
            waitUntil: w > 0 ? new Date(t.getTime() + w * 1000) : null,
          })
          .where(whereSource(r.s));
      }
      return { ok: true as const, wait };
    }),
  );
}

/**
 * Password giusta: la sua provenienza ricomincia da capo, e le provenienze ferme da un giorno si
 * dimenticano (con il loro indirizzo).
 */
export async function forgetSources(
  db: Database,
  sources: Source[],
  t: Date,
  limits: LoginSourceLimits,
): Promise<void> {
  const forgetBefore = new Date(t.getTime() - limits.forgetAfterHours * 3_600_000);
  const stale = and(
    lt(loginSource.lastFailureAt, forgetBefore),
    or(isNull(loginSource.waitUntil), lte(loginSource.waitUntil, t)),
  );
  await db.delete(loginSource).where(or(stale, ...sources.map(whereSource)));
}
