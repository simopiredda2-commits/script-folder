import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createArchiveAdminService } from './archive-service';
import type { AdminDeps } from './deps';

const archiveParams = z.object({ id: z.uuid() });
const grantParams = z.object({ id: z.uuid(), gid: z.uuid() });

/**
 * Archivio del titolare (tappa 14): autorizzazioni a sostituti e colleghi di gruppo, avvisi sugli accessi anomali; registro delle azioni di amministrazione.
 */
export function registerArchiveAdminRoutes(app: FastifyInstance, deps: AdminDeps): void {
  const service = createArchiveAdminService(deps);

  // Autorizzazioni sull'archivio: le vede e le dà solo il titolare (archive.grants).
  app.get('/api/archivi/:id/autorizzazioni', async (req) => ({
    autorizzazioni: await service.listGrants(req.actor!, archiveParams.parse(req.params).id),
  }));

  app.get('/api/archivi/:id/medici-autorizzabili', async (req) =>
    service.grantableDoctors(req.actor!, archiveParams.parse(req.params).id),
  );

  app.post('/api/archivi/:id/autorizzazioni', async (req, reply) => {
    const { id } = archiveParams.parse(req.params);
    const autorizzazione = await service.createGrant(req.actor!, id, req.body);
    return reply.status(201).send({ autorizzazione });
  });

  app.post('/api/archivi/:id/autorizzazioni/:gid/revoca', async (req) => {
    const { id, gid } = grantParams.parse(req.params);
    return { autorizzazione: await service.revokeGrant(req.actor!, id, gid) };
  });

  // Avvisi sugli accessi anomali alle cartelle dell'archivio: li legge il titolare.
  app.get('/api/archivi/:id/avvisi-accessi', async (req) =>
    service.accessAlerts(req.actor!, archiveParams.parse(req.params).id, req.query),
  );

  // Registro delle azioni di amministrazione dello studio: titolari e amministratore.
  app.get('/api/studio/registro-amministrazione', async (req) =>
    service.adminLog(req.actor!, req.query),
  );
}
