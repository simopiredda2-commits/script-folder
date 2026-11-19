import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { createTemplateService } from '../templates/service';

const patientParams = z.object({ id: z.uuid() });
const templateParams = z.object({ modelloId: z.uuid() });

/**
 * Prima il paziente, per la guardia (che registra l'accesso); l'identificativo del certificato lo
 * controlla il servizio dopo la guardia, così anche una richiesta sbagliata resta nel registro.
 */
const ids = (params: unknown) => ({
  id: patientParams.parse(params).id,
  certificatoId: (() => {
    const v = (params as { certificatoId?: unknown }).certificatoId;
    return typeof v === 'string' ? v : '';
  })(),
});

const pdfReply = (name: string) => ({
  'content-type': 'application/pdf',
  'content-disposition': `inline; filename="${name}.pdf"`,
  'cache-control': 'no-store',
});

/**
 * Modelli dei certificati (tappa 13): catalogo, modelli dello studio, impaginazione del medico,
 * certificati rilasciati ai pazienti (dalla guardia: registro degli accessi).
 */
export function registerTemplateRoutes(
  app: FastifyInstance,
  service: ReturnType<typeof createTemplateService>,
) {
  app.get('/api/modelli', async (req) => service.catalog(req.actor!));
  app.post('/api/modelli/studio', async (req, reply) =>
    reply.status(201).send(await service.createStudioTemplate(req.actor!, req.body)),
  );
  app.put('/api/modelli/studio/:modelloId', async (req) =>
    service.updateStudioTemplate(req.actor!, templateParams.parse(req.params).modelloId, req.body),
  );
  app.post('/api/modelli/studio/:modelloId/archivia', async (req, reply) => {
    await service.archiveStudioTemplate(req.actor!, templateParams.parse(req.params).modelloId);
    return reply.status(204).send();
  });

  app.get('/api/profilo/impaginazione', async (req) => service.layout(req.actor!));
  app.put('/api/profilo/impaginazione', async (req) => service.saveLayout(req.actor!, req.body));
  app.post('/api/profilo/impaginazione/anteprima', async (req, reply) =>
    reply
      .headers(pdfReply('prova-di-impaginazione'))
      .send(Buffer.from(await service.layoutPreview(req.actor!, req.body))),
  );

  const scoped = { config: { patientScoped: true } };
  const base = '/api/pazienti/:id/certificati-modelli';
  app.get(base, scoped, async (req) =>
    service.overview(req.actor!, patientParams.parse(req.params).id),
  );
  app.post(`${base}/anteprima`, scoped, async (req, reply) =>
    reply
      .headers(pdfReply('anteprima-certificato'))
      .send(
        Buffer.from(
          await service.preview(req.actor!, patientParams.parse(req.params).id, req.body),
        ),
      ),
  );
  app.post(base, scoped, async (req, reply) =>
    reply
      .status(201)
      .send(await service.issue(req.actor!, patientParams.parse(req.params).id, req.body)),
  );
  app.get(`${base}/:certificatoId/pdf`, scoped, async (req, reply) => {
    const p = ids(req.params);
    return reply
      .headers(pdfReply('certificato'))
      .send(Buffer.from(await service.pdf(req.actor!, p.id, p.certificatoId)));
  });
  app.post(`${base}/:certificatoId/annulla`, scoped, async (req) => {
    const p = ids(req.params);
    return service.annul(req.actor!, p.id, p.certificatoId, req.body);
  });
}
