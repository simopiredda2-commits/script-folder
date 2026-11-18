import type { FastifyInstance } from 'fastify';
import type { Actor } from '../auth/service';
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
  opts: {
    /** Medico collegato dal cookie, per il ritorno dalla Regione (rotta senza guardia comune). */
    actorOf: (token: string | undefined) => Promise<Actor | null>;
    sessionCookie: string;
  },
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

  // Accesso regionale con SPID o CIE (D109): avvio e ritorno dalla pagina della Regione.
  app.post('/api/profilo/credenziali/rupar/accesso-regionale', async (req) =>
    service.startRegionalAccess(req.actor!),
  );

  const back = (q: Record<string, string>) =>
    `/profilo/credenziali?${new URLSearchParams(q).toString()}`;
  app.get(
    '/api/profilo/credenziali/rupar/accesso-regionale/ritorno',
    { config: { public: true } },
    async (req, reply) => {
      // Il ritorno è una navigazione del browser: errori come pagina, non come risposta tecnica.
      const actor = await opts.actorOf(req.cookies[opts.sessionCookie]);
      if (!actor)
        return reply.redirect(
          back({
            accesso: 'errore',
            motivo:
              'Accesso al programma scaduto o bloccato: entra di nuovo e ripeti l’accesso regionale',
          }),
        );
      const r = await service.completeRegionalAccess(actor, req.query);
      return reply.redirect(
        r.esito === 'ok' ? back({ accesso: 'ok' }) : back({ accesso: 'errore', motivo: r.motivo }),
      );
    },
  );
}
