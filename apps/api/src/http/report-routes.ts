import { can } from '@mmg/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { logAccess, logAccessForPatients, type AccessAction } from '../audit/access-log';
import type { Actor } from '../auth/service';
import type { Database } from '../db/client';
import { loadArchiveContext, visibleArchives } from '../patients/access';
import { archive } from '../db/schema';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { parsePeriod, patientsOf, periodRows, reportCsv, summarize } from '../reports/period';
import { HttpError } from './errors';

const archiveParams = z.object({ id: z.uuid() });

const ONLY_OWNER =
  'I riepiloghi dell’archivio li leggono ed esportano il medico titolare e la segreteria che ha confermato';

/**
 * Riepiloghi dell'archivio per periodo (D201): conteggi a video, righe in CSV. Il titolare, e la
 * segreteria sugli archivi che l'hanno confermata (D204). I conteggi non hanno nomi di pazienti e
 * lasciano una riga nel registro; il CSV ne ha, e lascia una riga per paziente.
 */
export function registerReportRoutes(
  app: FastifyInstance,
  deps: { db: Database; now: () => Date },
): void {
  const { db, now } = deps;

  /**
   * Prima il permesso, anche per una richiesta sbagliata: un no resta nel registro. Dice anche se
   * chi guarda legge le voci riservate dell'archivio: la segreteria no (D209).
   */
  async function guard(actor: Actor, archiveId: string, action: AccessAction) {
    const ctx = await loadArchiveContext(db, archiveId);
    const decision = can(actor, 'reports.read', { ...ctx, now: now() });
    if (decision.allowed)
      return { includeReserved: can(actor, 'reserved.read', { ...ctx, now: now() }).allowed };
    await logAccess(db, {
      studioId: actor.studioId,
      userId: actor.userId,
      action,
      outcome: 'negato',
      workstation: actor.workstation,
      details: { archivio: archiveId, permesso: 'reports.read', motivo: decision.reason },
    });
    throw new HttpError(403, ONLY_OWNER);
  }

  /** Gli archivi di cui chi guarda legge i riepiloghi: il suo, o quelli che l'hanno confermata. */
  app.get('/api/riepiloghi/archivi', async (req) => {
    const actor = req.actor!;
    const ids = await visibleArchives(db, actor, 'reports.read');
    const rows = ids.length
      ? await db
          .select({ id: archive.id, nome: archive.name })
          .from(archive)
          .where(and(eq(archive.studioId, actor.studioId), inArray(archive.id, ids)))
          .orderBy(asc(archive.name))
      : [];
    return { archivi: rows };
  });

  app.get('/api/archivi/:id/riepiloghi', async (req) => {
    const actor = req.actor!;
    const { id } = archiveParams.parse(req.params);
    const { includeReserved } = await guard(actor, id, 'lettura_riepiloghi');
    const period = parsePeriod(req.query);
    const summary = summarize(await periodRows(db, id, period, includeReserved), period);
    await logAccess(db, {
      studioId: actor.studioId,
      userId: actor.userId,
      action: 'lettura_riepiloghi',
      outcome: 'consentito',
      workstation: actor.workstation,
      details: { archivio: id, dal: period.from, al: period.to },
    });
    return summary;
  });

  app.get('/api/archivi/:id/riepiloghi/esportazione', async (req, reply) => {
    const actor = req.actor!;
    const { id } = archiveParams.parse(req.params);
    const { includeReserved } = await guard(actor, id, 'esportazione_riepiloghi');
    const period = parsePeriod(req.query);
    const rows = await periodRows(db, id, period, includeReserved);
    const details = { archivio: id, dal: period.from, al: period.to };
    // Il CSV ha i nomi: una riga per paziente, poi una per l'esportazione.
    await logAccessForPatients(db, patientsOf(rows), {
      studioId: actor.studioId,
      userId: actor.userId,
      action: 'esportazione_riepiloghi',
      outcome: 'consentito',
      workstation: actor.workstation,
      details,
    });
    await logAccess(db, {
      studioId: actor.studioId,
      userId: actor.userId,
      action: 'esportazione_riepiloghi',
      outcome: 'riuscito',
      workstation: actor.workstation,
      details: {
        ...details,
        righe: rows.contacts.length + rows.prescriptions.length + rows.vaccinations.length,
      },
    });
    void reply.header('content-type', 'text/csv; charset=utf-8');
    void reply.header(
      'content-disposition',
      `attachment; filename="riepilogo-${period.from}-${period.to}.csv"`,
    );
    return reportCsv(rows);
  });
}
