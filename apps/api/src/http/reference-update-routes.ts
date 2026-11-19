import { can } from '@mmg/domain';
import type { SyncReport } from '@mmg/reference';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client';
import { appUser } from '../db/schema';
import type { ImportLine } from '../reference/importer';
import { issuesOf, recentRuns, UpdateInProgressError, type UpdateRun } from '../reference/update';
import type { ReferenceUpdates } from '../reference/updates-service';
import { HttpError } from './errors';

const iso = (d: Date | null) => d?.toISOString() ?? null;

/** Un giro come lo vedono le schermate: chi, quando, com'è andato, quanto ha cambiato. */
function summary(run: UpdateRun) {
  const report = run.syncReport as SyncReport | null;
  const lines = (run.importReport as ImportLine[] | null) ?? [];
  const count = (esito: string) => report?.righe.filter((r) => r.esito === esito).length ?? 0;
  return {
    id: run.id,
    avvio: run.trigger,
    chi: run.requestedBy,
    iniziato: iso(run.startedAt),
    finito: iso(run.finishedAt),
    esito: run.running ? 'in_corso' : run.outcome,
    messaggio: run.message,
    fonti: report?.fonti ?? [],
    conteggi: report
      ? {
          invariati: count('invariato'),
          nuovi: count('nuovo') + count('aggiornato'),
          daVerificare: count('da_verificare'),
          errori: count('errore'),
          importati: lines.filter((l) => l.outcome === 'importato').length,
        }
      : null,
  };
}

/**
 * Aggiornamento delle banche dati (D156): tutti vedono com'è andato l'ultimo giro e quando parte il
 * prossimo; l'amministratore dello studio può avviarne uno subito. Le banche dati sono comuni a tutti
 * gli studi del servizio: il giro vale per tutti, come quello di ogni notte (D191, D194).
 */
export function registerReferenceUpdateRoutes(
  app: FastifyInstance,
  db: Database,
  updates: ReferenceUpdates,
) {
  app.get('/api/banche-dati/aggiornamenti', async (req) => {
    const runs = await recentRuns(db, 10);
    const last = runs.find((r) => r.finishedAt);
    const running = runs.find((r) => r.running);
    const next = updates.nextRun();
    return {
      configurato: updates.configured,
      automatico: updates.time ? { ora: updates.time, prossimo: iso(next) } : null,
      puoAvviare: updates.configured && can(req.actor!, 'admin.reference_data').allowed,
      nomiFonti: updates.sourceNames,
      inCorso: running ? summary(running) : null,
      ultimo: last ? { ...summary(last), daControllare: issuesOf(last) } : null,
      giri: runs.map(summary),
    };
  });

  app.post('/api/banche-dati/aggiornamenti', async (req, reply) => {
    const actor = req.actor!;
    const decision = can(actor, 'admin.reference_data');
    if (!decision.allowed) throw new HttpError(403, decision.reason);
    if (!updates.configured) {
      throw new HttpError(
        409,
        'In questa installazione le banche dati non si aggiornano dal programma: manca la cartella dei dati (BANCHE_DATI_DIR)',
      );
    }
    const [user] = await db
      .select({ name: appUser.displayName })
      .from(appUser)
      .where(eq(appUser.id, actor.userId));
    try {
      const { id } = await updates.start('pulsante', user?.name ?? actor.userId);
      return reply.status(202).send({ id });
    } catch (err) {
      if (err instanceof UpdateInProgressError) {
        const since = new Intl.DateTimeFormat('it-IT', {
          timeZone: 'Europe/Rome',
          dateStyle: 'short',
          timeStyle: 'short',
        }).format(err.runningSince);
        throw new HttpError(409, `Un aggiornamento è già in corso, dal ${since}`);
      }
      throw err;
    }
  });
}
