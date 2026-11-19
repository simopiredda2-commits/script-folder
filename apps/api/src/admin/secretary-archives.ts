import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/client';
import { archive, archiveSecretary } from '../db/schema';
import type { Tx } from '../db/tx';

/**
 * Segreteria e archivio (D181): in medicina di gruppo ogni titolare conferma la segreteria per il
 * suo archivio, e finché non la conferma la segreteria non lo vede. Le decisioni si aggiungono e
 * non si cambiano (migrazione 0028): vale l'ultima per archivio e utente.
 */
export type SecretaryDecision = 'confermata' | 'rifiutata' | 'da_confermare';

export interface DecisionRow {
  archiveId: string;
  userId: string;
  decision: SecretaryDecision;
  decidedBy: string | null;
  decidedAt: Date;
}

const key = (archiveId: string, userId: string) => `${archiveId}:${userId}`;

/** L'ultima decisione per ogni coppia archivio e utente, tra quelle indicate. */
export async function latestSecretaryDecisions(
  q: Database | Tx,
  where: { archiveIds?: readonly string[]; userIds?: readonly string[] },
): Promise<Map<string, DecisionRow>> {
  if (where.archiveIds?.length === 0 || where.userIds?.length === 0) return new Map();
  const rows = await q
    .selectDistinctOn([archiveSecretary.archiveId, archiveSecretary.userId], {
      archiveId: archiveSecretary.archiveId,
      userId: archiveSecretary.userId,
      decision: archiveSecretary.decision,
      decidedBy: archiveSecretary.decidedBy,
      decidedAt: archiveSecretary.decidedAt,
    })
    .from(archiveSecretary)
    .where(
      and(
        where.archiveIds ? inArray(archiveSecretary.archiveId, [...where.archiveIds]) : undefined,
        where.userIds ? inArray(archiveSecretary.userId, [...where.userIds]) : undefined,
      ),
    )
    .orderBy(archiveSecretary.archiveId, archiveSecretary.userId, desc(archiveSecretary.seq));
  return new Map(rows.map((r) => [key(r.archiveId, r.userId), r]));
}

/** La decisione che vale adesso per la segreteria su quell'archivio; senza righe, da confermare. */
export const decisionOf = (
  decisions: Map<string, DecisionRow>,
  archiveId: string,
  userId: string,
): SecretaryDecision => decisions.get(key(archiveId, userId))?.decision ?? 'da_confermare';

/** Le segreterie che il titolare ha confermato per l'archivio (l'ultima decisione è «confermata»). */
export async function confirmedSecretaries(q: Database | Tx, archiveId: string): Promise<string[]> {
  const decisions = await latestSecretaryDecisions(q, { archiveIds: [archiveId] });
  return [...decisions.values()].filter((d) => d.decision === 'confermata').map((d) => d.userId);
}

export async function recordSecretaryDecision(
  tx: Tx,
  d: {
    archiveId: string;
    userId: string;
    decision: SecretaryDecision;
    by: string | null;
    at: Date;
  },
): Promise<void> {
  await tx.insert(archiveSecretary).values({
    archiveId: d.archiveId,
    userId: d.userId,
    decision: d.decision,
    decidedBy: d.by,
    decidedAt: d.at,
  });
}

/**
 * Il ruolo di segreteria cambia (tolto, o ridato): le conferme di prima non valgono più, e ogni
 * titolare decide di nuovo per il suo archivio. Restituisce quanti archivi tornano da confermare.
 */
export async function resetSecretaryDecisions(
  tx: Tx,
  d: { studioId: string; userId: string; by: string; at: Date },
): Promise<number> {
  const archives = await tx
    .select({ id: archive.id })
    .from(archive)
    .where(eq(archive.studioId, d.studioId));
  const decisions = await latestSecretaryDecisions(tx, {
    archiveIds: archives.map((a) => a.id),
    userIds: [d.userId],
  });
  const toReset = archives.filter((a) => decisionOf(decisions, a.id, d.userId) !== 'da_confermare');
  for (const a of toReset)
    await recordSecretaryDecision(tx, {
      archiveId: a.id,
      userId: d.userId,
      decision: 'da_confermare',
      by: d.by,
      at: d.at,
    });
  return toReset.length;
}
