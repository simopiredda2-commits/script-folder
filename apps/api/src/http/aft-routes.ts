import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { type AftService, consultBody, createBody, inviteBody, sharingBody } from '../aft/service';

const aftParams = z.object({ id: z.uuid() });

/**
 * Condivisione tra i medici dell'AFT (tappa 12, D161). La consultazione non ha l'id del
 * paziente nell'indirizzo: si cerca con il codice fiscale, e ogni tentativo va nel registro.
 */
export function registerAftRoutes(app: FastifyInstance, service: AftService) {
  app.get('/api/aft', async (req) => service.overview(req.actor!));

  app.post('/api/aft', async (req, reply) => {
    const id = await service.create(req.actor!, createBody.parse(req.body));
    return reply.status(201).send({ id });
  });

  app.post('/api/aft/:id/inviti', async (req, reply) => {
    const { id } = aftParams.parse(req.params);
    await service.invite(req.actor!, id, inviteBody.parse(req.body));
    return reply.status(201).send({ ok: true });
  });

  app.post('/api/aft/inviti/:id/accetta', async (req) => {
    const { id } = aftParams.parse(req.params);
    await service.respond(req.actor!, id, true);
    return { ok: true };
  });

  app.post('/api/aft/inviti/:id/rifiuta', async (req) => {
    const { id } = aftParams.parse(req.params);
    await service.respond(req.actor!, id, false);
    return { ok: true };
  });

  app.post('/api/aft/:id/condivisione', async (req) => {
    const { id } = aftParams.parse(req.params);
    await service.setSharing(req.actor!, id, sharingBody.parse(req.body).condivide);
    return { ok: true };
  });

  app.post('/api/aft/:id/esci', async (req) => {
    const { id } = aftParams.parse(req.params);
    await service.leave(req.actor!, id);
    return { ok: true };
  });

  app.post('/api/aft/consultazione', async (req) =>
    service.consult(req.actor!, consultBody.parse(req.body)),
  );

  app.get('/api/aft/consultazioni', async (req) => ({
    consultazioni: await service.consultationsOf(req.actor!),
  }));
}
