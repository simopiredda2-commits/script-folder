import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PrescriptionService } from '../prescriptions/service';

const idParams = z.object({ id: z.uuid() });

/** Rotte delle ricette. Quelle con :id passano dalla guardia sul paziente e scrivono il registro. */
export function registerPrescriptionRoutes(app: FastifyInstance, service: PrescriptionService) {
  const scoped = { config: { patientScoped: true } };

  app.get('/api/pazienti/:id/ricette', scoped, async (req) => {
    const { id } = idParams.parse(req.params);
    return { ricette: await service.listForPatient(req.actor!, id) };
  });

  app.post('/api/pazienti/:id/ricette', scoped, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    // Il corpo si valida nel servizio, dopo la guardia: anche una richiesta sbagliata è registrata.
    const created = await service.createDraft(req.actor!, id, req.body);
    return reply.status(201).send({ id: created });
  });

  app.post('/api/pazienti/:id/ricette/ripeti', scoped, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    // Anche qui il corpo si valida nel servizio, dopo la guardia.
    return reply
      .status(201)
      .send({ ricette: await service.prepareRepeat(req.actor!, id, req.body) });
  });

  app.post('/api/ricette/:id/da-firmare', scoped, async (req) => {
    await service.submitForSigning(req.actor!, idParams.parse(req.params).id);
    return { stato: 'to_sign' };
  });

  app.post('/api/ricette/:id/bozza', scoped, async (req) => {
    await service.backToDraft(req.actor!, idParams.parse(req.params).id);
    return { stato: 'draft' };
  });

  app.post('/api/ricette/:id/controlla', scoped, async (req) => {
    return service.checkOnly(req.actor!, idParams.parse(req.params).id, req.body);
  });

  app.post('/api/ricette/:id/firma-e-invia', scoped, async (req) => {
    const r = await service.signAndSend(req.actor!, idParams.parse(req.params).id, req.body);
    return { esito: r.outcome, nre: r.nre };
  });

  app.post('/api/ricette/:id/annulla', scoped, async (req) => {
    const { id } = idParams.parse(req.params);
    return { esito: (await service.cancel(req.actor!, id, req.body)).outcome };
  });

  app.post('/api/ricette/:id/ricetta-rossa', scoped, async (req) => {
    return service.printPaper(req.actor!, idParams.parse(req.params).id);
  });

  app.get('/api/ricette/da-firmare', async (req) => ({
    pazienti: await service.toSignQueue(req.actor!),
  }));

  app.get('/api/ricette/non-inviate', async (req) => ({
    pazienti: await service.failedQueue(req.actor!),
  }));
}
