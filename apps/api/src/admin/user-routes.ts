import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AdminDeps } from './deps';
import {
  confirmBody,
  createUserAdminService,
  createUserBody,
  updateUserBody,
  type UserAction,
} from './user-service';

const idParams = z.object({ id: z.uuid() });

/**
 * Utenti e ruoli dello studio (tappa 14): creazione, ruoli, dati del medico, sospensione, password temporanea, azzeramento del secondo fattore, sblocco; cambio della propria password.
 *
 * Le rotte di gestione sono dell'amministratore dello studio (`admin.users`); quelle della
 * conferma degli utenti in attesa dei medici titolari (`studio.confirm_users`). In tutte il
 * controllo viene prima dei dati, e ogni rifiuto va nel registro. Il cambio della propria password,
 * per tutti, sta con l'accesso (`POST /api/profilo/password`, http/auth-routes.ts). Password e
 * secondo fattore di medici e segreteria li ripristina chi gestisce il servizio, sul server
 * (`pnpm utente:ripristina`, db/user-restore-cli.ts).
 */
export function registerUserAdminRoutes(app: FastifyInstance, deps: AdminDeps): void {
  const users = createUserAdminService({ db: deps.db, now: deps.now });
  const admin = (azione: UserAction) => ({
    preHandler: async (req: FastifyRequest) => users.requireAdmin(req.actor!, azione),
  });
  const confirmer = (azione: UserAction) => ({
    preHandler: async (req: FastifyRequest) => users.requireConfirmer(req.actor!, azione),
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

  // Conferma dei medici titolari: utenti con i dati dei pazienti creati o cambiati
  // dall'amministratore.
  app.get('/api/studio/utenti/da-confermare', confirmer('elenco_da_confermare'), async (req) =>
    users.pending(req.actor!),
  );

  app.post('/api/studio/utenti/:id/conferma', confirmer('conferma'), async (req) =>
    users.confirm(req.actor!, idOf(req), confirmBody.parse(req.body ?? {})),
  );

  app.post('/api/studio/utenti/:id/rifiuta', confirmer('rifiuto'), async (req) =>
    users.refuse(req.actor!, idOf(req)),
  );
}
