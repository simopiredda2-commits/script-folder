import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { logAccess } from '../audit/access-log';
import type { Actor } from '../auth/service';
import type { Database } from '../db/client';
import {
  clinicalEntry,
  historicalPrescription,
  importBatch,
  importOrigin,
  patient,
} from '../db/schema';
import { withActor } from '../db/tx';
import { HttpError } from '../http/errors';

/**
 * Annullamento di un'importazione, con un motivo (tappa 15). Niente si cancella: le voci cliniche
 * e le ricette passate scritte dall'importazione si annullano come quelle scritte a mano, e lo
 * storico resta. Si può solo finché nessuna di esse è stata modificata dopo l'importazione.
 *
 * Pazienti creati o completati, esenzioni, scelte del medico, nuclei familiari e terapie non hanno
 * ancora uno stato «annullato» (serve una migrazione): un'importazione che li ha scritti non si
 * annulla da qui, e il messaggio lo dice.
 *
 * Nemmeno se ha scritto dati di pazienti passati poi nell'archivio di un altro medico dello studio
 * (D200): il titolare dell'archivio di prima non tocca più quelle cartelle.
 */

/** Tabelle che si annullano con un motivo. */
const UNDOABLE = new Set(['clinical_entry', 'historical_prescription']);

const TABLE_LABELS: Record<string, string> = {
  patient: 'pazienti creati o completati',
  exemption: 'esenzioni',
  patient_choice: 'scelte del medico',
  family: 'nuclei familiari',
  therapy: 'terapie',
};

export async function undoBatch(
  db: Database,
  actor: Actor,
  batch: typeof importBatch.$inferSelect,
  reason: string,
  now: Date,
): Promise<{ voci: number; ricette: number; pazienti: number }> {
  if (batch.status !== 'importato')
    throw new HttpError(409, 'Si annulla solo un’importazione scritta e non ancora annullata.');
  const origins = await db.select().from(importOrigin).where(eq(importOrigin.batchId, batch.id));
  const blocking = [...new Set(origins.map((o) => o.tableName))].filter((t) => !UNDOABLE.has(t));
  if (blocking.length)
    throw new HttpError(
      409,
      `Questa importazione ha scritto ${blocking.map((t) => TABLE_LABELS[t] ?? t).join(', ')}: per questi dati non c’è ancora l’annullamento con un motivo, quindi l’importazione non si annulla da qui.`,
    );
  const ids = origins.map((o) => o.rowId);
  if (!ids.length)
    throw new HttpError(409, 'Questa importazione non ha scritto nulla da annullare.');
  // Modificata dopo l'importazione: una modifica nello storico più recente della scrittura (la
  // scrittura stessa, per esempio l'allergia non più attiva, ha l'ora della sua transazione).
  const changed = await db.execute<{ n: string }>(sql`
    select count(distinct h.row_id) as n
    from change_history h
    where h.row_id = any(${`{${ids.join(',')}}`}::text[])
      and h.operation = 'UPDATE'
      and h.at > (
        select max(i.at) from change_history i
        where i.row_id = h.row_id and i.operation = 'INSERT'
      )`);
  const modified = Number(changed.rows[0]?.n ?? 0);
  if (modified)
    throw new HttpError(
      409,
      `${modified} voci importate sono state modificate o annullate dopo l’importazione: l’importazione non si annulla più per intero.`,
    );
  const entryIds = origins.filter((o) => o.tableName === 'clinical_entry').map((o) => o.rowId);
  const pastIds = origins
    .filter((o) => o.tableName === 'historical_prescription')
    .map((o) => o.rowId);
  const touched = [
    ...(entryIds.length
      ? await db
          .select({ id: clinicalEntry.patientId })
          .from(clinicalEntry)
          .where(inArray(clinicalEntry.id, entryIds))
      : []),
    ...(pastIds.length
      ? await db
          .select({ id: historicalPrescription.patientId })
          .from(historicalPrescription)
          .where(inArray(historicalPrescription.id, pastIds))
      : []),
  ];
  const patientIds = [...new Set(touched.map((r) => r.id))];
  const moved = patientIds.length
    ? await db
        .select({ id: patient.id })
        .from(patient)
        .where(and(inArray(patient.id, patientIds), ne(patient.archiveId, batch.archiveId)))
    : [];
  if (moved.length)
    throw new HttpError(
      409,
      `${moved.length === 1 ? 'Un paziente di questa importazione è passato' : `${moved.length} pazienti di questa importazione sono passati`} nell’archivio di un altro medico: l’importazione non si annulla più per intero.`,
    );
  return withActor(db, actor.userId, async (tx) => {
    const entries = entryIds.length
      ? await tx
          .update(clinicalEntry)
          .set({
            status: 'annulled',
            annulledAt: now,
            annulledBy: actor.userId,
            annulReason: reason,
          })
          .where(and(inArray(clinicalEntry.id, entryIds), eq(clinicalEntry.status, 'active')))
          .returning({ id: clinicalEntry.id, patientId: clinicalEntry.patientId })
      : [];
    const past = pastIds.length
      ? await tx
          .update(historicalPrescription)
          .set({ annulledAt: now, annulReason: reason })
          .where(inArray(historicalPrescription.id, pastIds))
          .returning({ id: historicalPrescription.id, patientId: historicalPrescription.patientId })
      : [];
    await tx
      .update(importBatch)
      .set({
        status: 'annullato',
        options: {
          ...batch.options,
          annullamento: { motivo: reason, il: now.toISOString(), chi: actor.userId },
        },
      })
      .where(eq(importBatch.id, batch.id));
    // Registro in fondo, come nella scrittura: una riga per paziente, una per l'importazione.
    const patients = [...new Set([...entries, ...past].map((r) => r.patientId))];
    for (const patientId of patients)
      await logAccess(tx, {
        studioId: actor.studioId,
        userId: actor.userId,
        patientId,
        action: 'importazione',
        outcome: 'consentito',
        workstation: actor.workstation,
        details: { permesso: 'data.import', fase: 'annullamento', importazione: batch.id },
      });
    await logAccess(tx, {
      studioId: actor.studioId,
      userId: actor.userId,
      action: 'importazione',
      outcome: 'riuscito',
      workstation: actor.workstation,
      details: {
        permesso: 'data.import',
        fase: 'annullamento',
        importazione: batch.id,
        voci: entries.length,
        ricette: past.length,
      },
    });
    return { voci: entries.length, ricette: past.length, pazienti: patients.length };
  });
}
