import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AdminDeps } from './deps';
import { createStudioListService } from './list-service';

const idParams = z.object({ id: z.string() });

/**
 * Elenchi dello studio (tappa 14): medici suggeritori, posologie, pacchetti di prestazioni, contatti utili.
 */
export function registerStudioListRoutes(app: FastifyInstance, deps: AdminDeps): void {
  const service = createStudioListService(deps);

  // Li legge ogni utente dello studio, segreteria compresa: li usa nelle schede e nelle ricette.
  app.get('/api/studio/elenchi', async (req) => service.list(req.actor!, req.query));

  // Li scrivono i titolari, l'amministratore e il sostituto mentre sostituisce (D181). Una voce
  // non si cancella: si archivia.
  app.post('/api/studio/elenchi', async (req, reply) =>
    reply.status(201).send(await service.create(req.actor!, req.body)),
  );
  app.patch('/api/studio/elenchi/:id', async (req) =>
    service.update(req.actor!, idParams.parse(req.params).id, req.body),
  );
  app.post('/api/studio/elenchi/:id/archivia', async (req) =>
    service.archive(req.actor!, idParams.parse(req.params).id),
  );
}
