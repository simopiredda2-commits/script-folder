import { can, type AccessContext, type Action, type ArchiveGrant } from '@mmg/domain';
import { and, eq } from 'drizzle-orm';
import { logAccess, type AccessAction } from '../audit/access-log';
import type { Actor } from '../auth/service';
import type { Database } from '../db/client';
import { archive, archiveGrant, patient, studio } from '../db/schema';
import { HttpError } from '../http/errors';

export interface ArchiveContext {
  archive: { id: string; studioId: string; ownerUserId: string };
  grants: ArchiveGrant[];
  settings: { secretaryCanReadDiary: boolean; secretaryCanReadSummary: boolean };
}

export async function loadArchiveContext(db: Database, archiveId: string): Promise<ArchiveContext> {
  const [a] = await db
    .select({ archive, studio })
    .from(archive)
    .innerJoin(studio, eq(studio.id, archive.studioId))
    .where(eq(archive.id, archiveId));
  if (!a) throw new HttpError(404, 'Archivio non trovato');
  const grants = await db.select().from(archiveGrant).where(eq(archiveGrant.archiveId, archiveId));
  return {
    archive: { id: a.archive.id, studioId: a.archive.studioId, ownerUserId: a.archive.ownerUserId },
    grants: grants.map((g) => ({
      archiveId: g.archiveId,
      granteeUserId: g.granteeUserId,
      kind: g.kind,
      validFrom: g.validFrom,
      validTo: g.validTo,
      revokedAt: g.revokedAt,
    })),
    settings: {
      secretaryCanReadDiary: a.archive.secretaryCanReadDiary,
      secretaryCanReadSummary: a.archive.secretaryCanReadSummary,
    },
  };
}

/**
 * Le autorizzazioni di un medico sugli archivi del suo studio, per le azioni sullo studio che le
 * vogliono (D181: il sostituto scrive gli elenchi dello studio solo mentre sostituisce). Tutte,
 * anche scadute o revocate: quali valgono adesso lo decide `can()`.
 */
export async function studioGrantsOf(db: Database, actor: Actor): Promise<ArchiveGrant[]> {
  const rows = await db
    .select({ g: archiveGrant })
    .from(archiveGrant)
    .innerJoin(archive, eq(archive.id, archiveGrant.archiveId))
    .where(and(eq(archiveGrant.granteeUserId, actor.userId), eq(archive.studioId, actor.studioId)));
  return rows.map(({ g }) => ({
    archiveId: g.archiveId,
    granteeUserId: g.granteeUserId,
    kind: g.kind,
    validFrom: g.validFrom,
    validTo: g.validTo,
    revokedAt: g.revokedAt,
  }));
}

/**
 * Unico passaggio per accedere ai dati di un paziente: decide con le regole dei permessi e
 * registra l'accesso, consentito o negato, prima di restituire qualsiasi dato.
 */
export async function guardPatient(
  db: Database,
  actor: Actor,
  patientId: string,
  action: Action,
  logAction: AccessAction,
  resource?: AccessContext['resource'],
) {
  const [p] = await db
    .select()
    .from(patient)
    .where(and(eq(patient.id, patientId), eq(patient.studioId, actor.studioId)));
  if (!p) {
    await logAccess(db, {
      studioId: actor.studioId,
      userId: actor.userId,
      action: logAction,
      outcome: 'negato',
      workstation: actor.workstation,
      details: {
        permesso: action,
        motivo: 'paziente non trovato nello studio',
        paziente: patientId,
      },
    });
    throw new HttpError(404, 'Paziente non trovato');
  }
  const ctx = await loadArchiveContext(db, p.archiveId);
  const decision = can(actor, action, { ...ctx, resource, now: new Date() });
  await logAccess(db, {
    studioId: actor.studioId,
    userId: actor.userId,
    patientId: p.id,
    action: logAction,
    outcome: decision.allowed ? 'consentito' : 'negato',
    workstation: actor.workstation,
    details: { permesso: action, motivo: decision.reason },
  });
  if (!decision.allowed) throw new HttpError(403, decision.reason);
  return { patient: p, context: ctx };
}

/** Archivi su cui l'utente può fare `action` (per gli elenchi). */
export async function visibleArchives(
  db: Database,
  actor: Actor,
  action: Action,
): Promise<string[]> {
  const archives = await db.select().from(archive).where(eq(archive.studioId, actor.studioId));
  const visible: string[] = [];
  for (const a of archives) {
    const ctx = await loadArchiveContext(db, a.id);
    if (can(actor, action, { ...ctx, now: new Date() }).allowed) visible.push(a.id);
  }
  return visible;
}
