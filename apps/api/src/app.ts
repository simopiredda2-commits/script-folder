import cookie from '@fastify/cookie';
import { PRODUCT_NAME } from '@mmg/brand';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { createAuthService, type Actor } from './auth/service';
import type { Config } from './config';
import type { Database } from './db/client';
import { registerAuthRoutes, SESSION_COOKIE } from './http/auth-routes';
import { HttpError } from './http/errors';
import { registerPatientRoutes } from './http/patient-routes';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Rotta raggiungibile senza sessione. */
    public?: boolean;
    /** Rotta sui dati di un paziente: deve passare dalla guardia e scrivere il registro. */
    patientScoped?: boolean;
  }
  interface FastifyRequest {
    actor?: Actor;
  }
  interface FastifyInstance {
    patientScopedRoutes: { method: string; url: string }[];
  }
}

export interface AppDeps {
  db: Database;
  config: Pick<Config, 'encryptionKey' | 'sessionMaxHours' | 'cookieSecure'>;
  now?: () => Date;
  logger?: boolean;
}

export function buildApp({ db, config, now, logger = false }: AppDeps): FastifyInstance {
  const app = Fastify({ logger });
  const auth = createAuthService({
    db,
    encryptionKey: config.encryptionKey,
    sessionMaxHours: config.sessionMaxHours,
    issuer: PRODUCT_NAME,
    now,
  });

  app.decorate('patientScopedRoutes', [] as { method: string; url: string }[]);
  app.addHook('onRoute', (route) => {
    if (route.config?.patientScoped) {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      for (const m of methods) app.patientScopedRoutes.push({ method: m, url: route.url });
    }
  });

  void app.register(cookie);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.status(err.statusCode).send({ errore: err.message });
    if (err instanceof ZodError) {
      return reply.status(400).send({ errore: 'Dati non validi', dettagli: err.issues });
    }
    req.log.error(err);
    return reply.status(500).send({ errore: 'Errore interno' });
  });

  // Ogni rotta non pubblica richiede una sessione valida e non bloccata.
  app.addHook('preHandler', async (req) => {
    if (req.routeOptions.config?.public) return;
    const token = req.cookies[SESSION_COOKIE];
    if (!token) throw new HttpError(401, 'Accesso necessario');
    const r = await auth.authenticate(token);
    if (r.status === 'invalid') throw new HttpError(401, 'Sessione non valida o scaduta');
    if (r.status === 'locked') {
      throw new HttpError(423, 'Sessione bloccata per inattività: inserisci la password');
    }
    req.actor = r.actor;
  });

  app.get('/api/salute', { config: { public: true } }, async () => {
    await db.execute(sql`select 1`);
    return { stato: 'ok' };
  });

  registerAuthRoutes(app, auth, { cookieSecure: config.cookieSecure });
  registerPatientRoutes(app, db);
  return app;
}
