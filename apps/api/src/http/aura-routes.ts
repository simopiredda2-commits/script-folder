import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuraService } from '../aura/service';
import { logAccessForPatients } from '../audit/access-log';
import type { Database } from '../db/client';
import { guardPatient, visibleArchives } from '../patients/access';
import { HttpError } from './errors';

const idParams = z.object({ id: z.uuid() });
const changesQuery = z.object({ giorni: z.coerce.number().int().min(1).max(90).default(7) });

/**
 * AURA, l'anagrafe regionale degli assistiti (D197): stato del collegamento e variazioni di un
 * paziente, controllo subito («Aggiorna da AURA»), variazioni recenti dello studio. Ogni rotta su un
 * paziente passa dalla guardia dell'archivio e lascia la sua riga nel registro.
 */
export function registerAuraRoutes(
  app: FastifyInstance,
  deps: { db: Database; aura: AuraService },
): void {
  const { db, aura } = deps;
  const scoped = { config: { patientScoped: true } };

  app.get('/api/pazienti/:id/aura', scoped, async (req) => {
    const { id } = idParams.parse(req.params);
    await guardPatient(db, req.actor!, id, 'registry.read', 'lettura_dati_amministrativi');
    return aura.patientState(id);
  });

  app.post('/api/pazienti/:id/aura', scoped, async (req) => {
    const actor = req.actor!;
    const { id } = idParams.parse(req.params);
    await guardPatient(db, actor, id, 'registry.write', 'aggiornamento_aura');
    if (!aura.available()) throw new HttpError(409, 'AURA non è ancora collegata al servizio vero');
    const r = await aura.syncPatient(id, 'manuale', actor.userId);
    return {
      esito: r.outcome,
      messaggio: r.message,
      variazioni: r.changes,
      stato: await aura.patientState(id),
    };
  });

  /** Variazioni arrivate da AURA negli ultimi giorni, dei pazienti che l'utente può vedere. */
  app.get('/api/aura/variazioni', async (req) => {
    const actor = req.actor!;
    const { giorni } = changesQuery.parse(req.query);
    const archives = await visibleArchives(db, actor, 'registry.read');
    const rows = await aura.recentChanges(actor.studioId, archives, giorni);
    await logAccessForPatients(db, [...new Set(rows.map((r) => r.pazienteId))], {
      studioId: actor.studioId,
      userId: actor.userId,
      action: 'lettura_variazioni_aura',
      outcome: 'consentito',
      workstation: actor.workstation,
      details: { giorni },
    });
    return {
      disponibile: aura.available(),
      giorni,
      variazioni: rows.map((r) => ({
        quando: r.quando.toISOString(),
        tipo: r.tipo,
        variazione: r.variazione,
        descrizione: r.descrizione,
        paziente: { id: r.pazienteId, cognome: r.cognome, nome: r.nome },
      })),
    };
  });
}
