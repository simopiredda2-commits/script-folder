import { CREDENTIAL_SERVICE_SLUG } from '@mmg/domain';
import type { FastifyInstance } from 'fastify';
import type { Actor } from '../auth/service';
import { z } from 'zod';
import type { createCredentialService, RegionalFailure } from '../credentials/service';
import { HttpError } from './errors';

/** Il servizio nelle rotte: il nome corto del Sistema TS o del servizio di una regione (D301). */
const params = z.object({ servizio: z.string().regex(CREDENTIAL_SERVICE_SLUG) });
const slugOf = (p: unknown) => params.parse(p).servizio;

/** Credenziali dei servizi del medico collegato e codice di sessione (D100–D102, D301). */
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
    service.save(req.actor!, slugOf(req.params), req.body),
  );

  app.delete('/api/profilo/credenziali/:servizio', async (req) =>
    service.remove(req.actor!, slugOf(req.params)),
  );

  app.post('/api/profilo/credenziali/:servizio/sessione/richiesta', async (req) =>
    service.requestSession(req.actor!, slugOf(req.params)),
  );

  app.post('/api/profilo/credenziali/:servizio/sessione', async (req) =>
    service.confirmSession(req.actor!, slugOf(req.params), req.body),
  );

  app.delete('/api/profilo/credenziali/:servizio/sessione', async (req) =>
    service.revokeSession(req.actor!, slugOf(req.params)),
  );

  // Accesso con SPID o CIE della regione (D109): avvio e ritorno dalla pagina della Regione.
  app.post('/api/profilo/credenziali/:servizio/accesso-regionale', async (req) =>
    service.startRegionalAccess(req.actor!, slugOf(req.params)),
  );

  // Nell'indirizzo del ritorno solo un codice, mai un testo (D193).
  const back = (q: { accesso: 'ok' } | { accesso: 'errore'; motivo: RegionalFailure }) =>
    `/profilo/credenziali?${new URLSearchParams(q).toString()}`;
  app.get(
    '/api/profilo/credenziali/:servizio/accesso-regionale/ritorno',
    { config: { public: true } },
    async (req, reply) => {
      // Il ritorno è una navigazione del browser: errori come pagina, non come risposta tecnica.
      const actor = await opts.actorOf(req.cookies[opts.sessionCookie]);
      if (!actor) return reply.redirect(back({ accesso: 'errore', motivo: 'sessione' }));
      const parsed = params.safeParse(req.params);
      if (!parsed.success)
        return reply.redirect(back({ accesso: 'errore', motivo: 'non-riconosciuta' }));
      try {
        const r = await service.completeRegionalAccess(actor, parsed.data.servizio, req.query);
        return reply.redirect(
          r.esito === 'ok'
            ? back({ accesso: 'ok' })
            : back({ accesso: 'errore', motivo: r.motivo }),
        );
      } catch (err) {
        // Un servizio che non è della regione dello studio, o senza accesso: come uno state ignoto.
        if (err instanceof HttpError && err.statusCode === 404)
          return reply.redirect(back({ accesso: 'errore', motivo: 'non-riconosciuta' }));
        throw err;
      }
    },
  );
}
