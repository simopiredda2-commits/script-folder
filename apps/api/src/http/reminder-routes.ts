import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { createReminderService } from '../reminders/service';

const params = z.object({ id: z.uuid() });

/** Promemoria della ricetta: stampa (completo o solo NRE), invio, consegne. */
export function registerReminderRoutes(
  app: FastifyInstance,
  service: ReturnType<typeof createReminderService>,
) {
  const scoped = { config: { patientScoped: true } };

  app.get('/api/ricette/:id/promemoria', scoped, async (req, reply) => {
    const { id } = params.parse(req.params);
    const pdf = await service.print(req.actor!, id, req.query);
    reply.header('content-type', 'application/pdf');
    reply.header('content-disposition', `inline; filename="${pdf.name}"`);
    reply.header('cache-control', 'no-store');
    return reply.send(Buffer.from(pdf.bytes));
  });

  // Anteprima prima della firma (D253): «BOZZA – NON VALIDA» al posto dell'NRE.
  app.get('/api/ricette/:id/promemoria/anteprima', scoped, async (req, reply) => {
    const { id } = params.parse(req.params);
    const pdf = await service.preview(req.actor!, id);
    reply.header('content-type', 'application/pdf');
    reply.header('content-disposition', `inline; filename="${pdf.name}"`);
    reply.header('cache-control', 'no-store');
    return reply.send(Buffer.from(pdf.bytes));
  });

  app.post('/api/ricette/:id/promemoria/invio', scoped, async (req) => {
    const { id } = params.parse(req.params);
    return service.send(req.actor!, id, req.body);
  });

  app.get('/api/ricette/:id/promemoria/consegne', scoped, async (req) => {
    const { id } = params.parse(req.params);
    return service.deliveries(req.actor!, id);
  });

  app.get('/api/pazienti/:id/recapiti-promemoria', scoped, async (req) => {
    const { id } = params.parse(req.params);
    return service.contacts(req.actor!, id);
  });
}
