import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AdminDeps } from './deps';
import {
  createUserAdminService,
  createUserBody,
  updateUserBody,
  type UserAction,
} from './user-service';

const idParams = z.object({ id: z.uuid() });

/**
 * Utenti e ruoli dello studio (tappa 14): creazione, ruoli, dati del medico, sospensione, password temporanea, azzeramento del secondo fattore, sblocco; cambio della propria password.
 *
 * Tutte per l'amministratore dello studio (`admin.users`): il controllo viene prima dei dati, e ogni
 * rifiuto va nel registro. Il cambio della propria password, per tutti, sta con l'accesso
 * (`POST /api/profilo/password`, http/auth-routes.ts).
 */
export function registerUserAdminRoutes(app: FastifyInstance, deps: AdminDeps): void {
  const users = createUserAdminService({ db: deps.db, now: deps.now });
  const admin = (azione: UserAction) => ({
    preHandler: async (req: FastifyRequest) => users.requireAdmin(req.actor!, azione),
  });
  const idOf = (req: FastifyRequest) => idParams.parse(req.params).id;

  app.get('/api/studio/utenti', admin('elenco'), async (req) => users.list(req.actor!));

  app.post('/api/studio/utenti', admin('creazione'), async (req, reply) =>
    reply.status(201).send(await users.create(req.actor!, createUserBody.parse(req.body))),
  );

  app.patch('/api/studio/utenti/:id', admin('modifica'), async (req) =>
    users.update(req.actor!, idOf(req), updateUserBody.parse(req.body)),
  );

  app.post('/api/studio/utenti/:id/sospendi', admin('sospensione'), async (req) =>
    users.setStatus(req.actor!, idOf(req), false),
  );

  app.post('/api/studio/utenti/:id/riattiva', admin('riattivazione'), async (req) =>
    users.setStatus(req.actor!, idOf(req), true),
  );

  app.post(
    '/api/studio/utenti/:id/password-temporanea',
    admin('password_temporanea'),
    async (req) => users.resetPassword(req.actor!, idOf(req)),
  );

  app.post(
    '/api/studio/utenti/:id/azzera-secondo-fattore',
    admin('azzeramento_secondo_fattore'),
    async (req) => users.resetSecondFactor(req.actor!, idOf(req)),
  );

  app.post('/api/studio/utenti/:id/sblocca', admin('sblocco'), async (req) =>
    users.unlock(req.actor!, idOf(req)),
  );
}
