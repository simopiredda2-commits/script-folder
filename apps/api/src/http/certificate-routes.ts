import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { createCertificateService } from '../certificates/service';

const params = z.object({ id: z.uuid() });

/** Certificati di malattia: tutte le rotte passano dalla guardia sui dati del paziente. */
export function registerCertificateRoutes(
  app: FastifyInstance,
  service: ReturnType<typeof createCertificateService>,
) {
  const scoped = { config: { patientScoped: true } };
  const id = (p: unknown) => params.parse(p).id;

  app.get('/api/pazienti/:id/certificati', scoped, async (req) =>
    service.list(req.actor!, id(req.params)),
  );
  app.post('/api/pazienti/:id/certificati', scoped, async (req, reply) =>
    reply.status(201).send(await service.create(req.actor!, id(req.params), req.body)),
  );
  app.get('/api/certificati/:id', scoped, async (req) => service.get(req.actor!, id(req.params)));
  app.put('/api/certificati/:id', scoped, async (req) =>
    service.update(req.actor!, id(req.params), req.body),
  );
  app.post('/api/certificati/:id/controlla', scoped, async (req) =>
    service.checkOnly(req.actor!, id(req.params)),
  );
  app.post('/api/certificati/:id/invia', scoped, async (req) =>
    service.send(req.actor!, id(req.params)),
  );
  app.post('/api/certificati/:id/rettifica', scoped, async (req) =>
    service.rectify(req.actor!, id(req.params), req.body),
  );
  app.post('/api/certificati/:id/annulla', scoped, async (req) =>
    service.cancel(req.actor!, id(req.params), req.body),
  );
  for (const which of ['copia', 'attestato'] as const) {
    app.get(`/api/certificati/:id/${which}`, scoped, async (req, reply) => {
      const pdf = await service.pdf(req.actor!, id(req.params), which);
      reply.header('content-type', 'application/pdf');
      reply.header('content-disposition', `inline; filename="${pdf.name}"`);
      reply.header('cache-control', 'no-store');
      return reply.send(Buffer.from(pdf.bytes));
    });
  }
  app.post('/api/certificati/:id/consegna', scoped, async (req) =>
    service.deliver(req.actor!, id(req.params), req.body),
  );
  app.get('/api/certificati/:id/consegne', scoped, async (req) =>
    service.deliveries(req.actor!, id(req.params)),
  );
}
