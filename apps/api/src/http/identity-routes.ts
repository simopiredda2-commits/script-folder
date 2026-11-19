import type { FastifyInstance, FastifyReply } from 'fastify';
import { RECOVERY_MINUTES, type IdentityService } from '../auth/identity-service';
import type { Actor } from '../auth/service';

/** Cookie del ripristino: il passaggio per la password nuova, solo per le rotte del ripristino. */
export const RECOVERY_COOKIE = 'ripristino';
const RECOVERY_PATH = '/api/ripristino';

/**
 * Ripristino delle credenziali con SPID o CIE (D189), pubblico: avvio, ritorno dal gestore
 * dell'identità, stato, password nuova. Collegamento dell'identità della segreteria, a sessione
 * aperta. I ritorni sono navigazioni del browser: gli errori diventano pagine dell'interfaccia.
 */
export function registerIdentityRoutes(
  app: FastifyInstance,
  identity: IdentityService,
  opts: {
    cookieSecure: boolean;
    sessionCookie: string;
    actorOf: (token: string | undefined) => Promise<Actor | null>;
  },
) {
  const pub = { config: { public: true } };
  const clearRecovery = (reply: FastifyReply) =>
    reply.clearCookie(RECOVERY_COOKIE, { path: RECOVERY_PATH });

  app.post('/api/ripristino', pub, async (req) => identity.startRecovery(req.body, req.ip));

  app.get('/api/ripristino/ritorno', pub, async (req, reply) => {
    const r = await identity.completeRecovery(req.query);
    if (r.esito === 'errore') {
      clearRecovery(reply);
      return reply.redirect(
        `/ripristino?${new URLSearchParams({ esito: 'errore', motivo: r.motivo }).toString()}`,
      );
    }
    reply.setCookie(RECOVERY_COOKIE, r.passaggio, {
      httpOnly: true,
      sameSite: 'strict',
      secure: opts.cookieSecure,
      path: RECOVERY_PATH,
      maxAge: RECOVERY_MINUTES * 60,
    });
    return reply.redirect('/ripristino');
  });

  app.get('/api/ripristino/stato', pub, async (req) =>
    identity.recoveryState(req.cookies[RECOVERY_COOKIE]),
  );

  app.post('/api/ripristino/password', pub, async (req, reply) => {
    const r = await identity.finishRecovery(req.cookies[RECOVERY_COOKIE], req.body);
    clearRecovery(reply);
    return r;
  });

  app.get('/api/profilo/identita', async (req) => identity.linkState(req.actor!));

  app.post('/api/profilo/identita', async (req) =>
    identity.startLink(req.actor!, req.body, req.ip),
  );

  app.delete('/api/profilo/identita', async (req) => identity.unlink(req.actor!));

  const back = (q: Record<string, string>) =>
    `/profilo/identita?${new URLSearchParams(q).toString()}`;
  app.get('/api/profilo/identita/ritorno', pub, async (req, reply) => {
    const actor = await opts.actorOf(req.cookies[opts.sessionCookie]);
    if (!actor)
      return reply.redirect(
        back({
          collegamento: 'errore',
          motivo: 'Accesso al programma scaduto o bloccato: entra di nuovo e ricomincia',
        }),
      );
    const r = await identity.completeLink(actor, req.query);
    return reply.redirect(
      r.esito === 'ok'
        ? back({ collegamento: 'ok' })
        : back({ collegamento: 'errore', motivo: r.motivo }),
    );
  });
}
