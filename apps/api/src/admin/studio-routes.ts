import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AdminDeps } from './deps';
import { createStudioAdminService } from './studio-service';

const idParams = z.object({ id: z.string() });

/**
 * Dati e impostazioni dello studio (tappa 14): dati, intestazione, regione, sicurezza, tempo di attesa degli invii, postazioni, avvisi sugli accessi anomali, stato del servizio in sola lettura.
 */
export function registerStudioAdminRoutes(app: FastifyInstance, deps: AdminDeps): void {
  const service = createStudioAdminService(deps);

  // Ogni utente dello studio legge dati e impostazioni; li cambia l'amministratore.
  app.get('/api/studio', async (req) => service.read(req.actor!));
  app.put('/api/studio', async (req) => service.update(req.actor!, req.body));

  // Postazioni: il nome che ognuno scrive all'accesso. Non si cancellano: si archiviano.
  app.get('/api/studio/postazioni', async (req) => service.workstations(req.actor!));
  app.post('/api/studio/postazioni', async (req, reply) =>
    reply.status(201).send(await service.createWorkstation(req.actor!, req.body)),
  );
  app.patch('/api/studio/postazioni/:id', async (req) =>
    service.updateWorkstation(req.actor!, idParams.parse(req.params).id, req.body),
  );
  app.post('/api/studio/postazioni/:id/archivia', async (req) =>
    service.archiveWorkstation(req.actor!, idParams.parse(req.params).id),
  );

  // Stato del servizio, in sola lettura, per l'amministratore.
  app.get('/api/studio/servizio', async (req) => service.serviceStatus(req.actor!));
}
