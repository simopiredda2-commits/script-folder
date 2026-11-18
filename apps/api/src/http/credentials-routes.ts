import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SERVICE_SLUGS, type createCredentialService } from '../credentials/service';

const params = z.object({
  servizio: z.enum(Object.keys(SERVICE_SLUGS) as ['sistema-ts', 'rupar']),
});
const serviceOf = (p: unknown) => SERVICE_SLUGS[params.parse(p).servizio];

/** Credenziali dei servizi del medico collegato e codice di sessione (D100–D102). */
export function registerCredentialRoutes(
  app: FastifyInstance,
  service: ReturnType<typeof createCredentialService>,
) {
  app.get('/api/profilo/credenziali', async (req) => service.status(req.actor!));

  app.put('/api/profilo/credenziali/:servizio', async (req) =>
    service.save(req.actor!, serviceOf(req.params), req.body),
  );

  app.delete('/api/profilo/credenziali/:servizio', async (req) =>
    service.remove(req.actor!, serviceOf(req.params)),
  );

  app.post('/api/profilo/credenziali/:servizio/sessione/richiesta', async (req) =>
    service.requestSession(req.actor!, serviceOf(req.params)),
  );

  app.post('/api/profilo/credenziali/:servizio/sessione', async (req) =>
    service.confirmSession(req.actor!, serviceOf(req.params), req.body),
  );

  app.delete('/api/profilo/credenziali/:servizio/sessione', async (req) =>
    service.revokeSession(req.actor!, serviceOf(req.params)),
  );
}
