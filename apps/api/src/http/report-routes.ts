import { can } from '@mmg/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { logAccess, logAccessForPatients, type AccessAction } from '../audit/access-log';
import type { Actor } from '../auth/service';
import type { Database } from '../db/client';
import { loadArchiveContext } from '../patients/access';
import { parsePeriod, patientsOf, periodRows, reportCsv, summarize } from '../reports/period';
import { HttpError } from './errors';

const archiveParams = z.object({ id: z.uuid() });

const ONLY_OWNER = 'I riepiloghi dell’archivio li legge ed esporta solo il medico titolare';

/**
 * Riepiloghi dell'archivio per periodo (D201): conteggi a video, righe in CSV. Solo il titolare,
 * come l'esportazione completa: i dati sono suoi (regola 4). I conteggi non hanno nomi di
 * pazienti e lasciano una riga nel registro; il CSV ne ha, e lascia una riga per paziente.
 */
export function registerReportRoutes(
  app: FastifyInstance,
  deps: { db: Database; now: () => Date },
): void {
  const { db, now } = deps;

  /** Prima il permesso, anche per una richiesta sbagliata: un no resta nel registro. */
  async function guard(actor: Actor, archiveId: string, action: AccessAction) {
    const ctx = await loadArchiveContext(db, archiveId);
    const decision = can(actor, 'reports.read', { ...ctx, now: now() });
    if (decision.allowed) return;
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

  app.get('/api/archivi/:id/riepiloghi', async (req) => {
    const actor = req.actor!;
    const { id } = archiveParams.parse(req.params);
    await guard(actor, id, 'lettura_riepiloghi');
    const period = parsePeriod(req.query);
    const summary = summarize(await periodRows(db, id, period), period);
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
    await guard(actor, id, 'esportazione_riepiloghi');
    const period = parsePeriod(req.query);
    const rows = await periodRows(db, id, period);
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
