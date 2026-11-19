import type { SyncReport } from '@mmg/reference';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client';
import type { ImportLine } from '../reference/importer';
import { issuesOf, recentRuns, type UpdateRun } from '../reference/update';
import type { ReferenceUpdates } from '../reference/updates-service';

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
 * prossimo. Le banche dati sono comuni a tutti gli studi del servizio: le aggiorna chi gestisce il
 * servizio, ogni notte e con il comando sul server, mai un utente di uno studio (D192).
 */
export function registerReferenceUpdateRoutes(
  app: FastifyInstance,
  db: Database,
  updates: ReferenceUpdates,
) {
  app.get('/api/banche-dati/aggiornamenti', async () => {
    const runs = await recentRuns(db, 10);
    const last = runs.find((r) => r.finishedAt);
    const running = runs.find((r) => r.running);
    const next = updates.nextRun();
    return {
      configurato: updates.configured,
      automatico: updates.time ? { ora: updates.time, prossimo: iso(next) } : null,
      nomiFonti: updates.sourceNames,
      inCorso: running ? summary(running) : null,
      ultimo: last ? { ...summary(last), daControllare: issuesOf(last) } : null,
      giri: runs.map(summary),
    };
  });
}
