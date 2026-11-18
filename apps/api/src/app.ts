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
import { registerPrescriptionRoutes } from './http/prescription-routes';
import { registerReferenceRoutes } from './http/reference-routes';
import { createRulesCheck } from './prescriptions/rules-check';
import { createPrescriptionService, type PrescriptionDeps } from './prescriptions/service';
import { SimulatedGateway, type GatewaySystem, type PrescriptionGateway } from '@mmg/integrations';
import { loadMappings } from '@mmg/reference';
import { ReferenceData } from './reference/lookup';

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
    allRoutes: { method: string; url: string }[];
  }
}

export interface AppDeps {
  db: Database;
  config: Pick<Config, 'encryptionKey' | 'sessionMaxHours' | 'cookieSecure'>;
  now?: () => Date;
  logger?: boolean;
  /** SAR e Sistema TS. Per difetto i simulatori: nessuna chiamata a servizi reali (regola 7). */
  gateways?: Record<GatewaySystem, PrescriptionGateway>;
  /** Controlli prima dell'invio delle ricette (regole di prescrizione). */
  preSendChecks?: PrescriptionDeps['preSendChecks'];
}

export function buildApp({
  db,
  config,
  now,
  logger = false,
  gateways = { sar: new SimulatedGateway('sar'), sistema_ts: new SimulatedGateway('sistema_ts') },
  preSendChecks,
}: AppDeps): FastifyInstance {
  const app = Fastify({ logger });
  const auth = createAuthService({
    db,
    encryptionKey: config.encryptionKey,
    sessionMaxHours: config.sessionMaxHours,
    issuer: PRODUCT_NAME,
    now,
  });

  app.decorate('patientScopedRoutes', [] as { method: string; url: string }[]);
  app.decorate('allRoutes', [] as { method: string; url: string }[]);
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const m of methods) {
      if (m === 'HEAD') continue;
      app.allRoutes.push({ method: m, url: route.url });
      if (route.config?.patientScoped) app.patientScopedRoutes.push({ method: m, url: route.url });
    }
  });

  void app.register(cookie);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply
        .status(err.statusCode)
        .send(
          err.details === undefined
            ? { errore: err.message }
            : { errore: err.message, dettagli: err.details },
        );
    }
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
      throw new HttpError(423, 'Sessione bloccata per inattività: inserisci il codice a 6 cifre');
    }
    req.actor = r.actor;
  });

  app.get('/api/salute', { config: { public: true } }, async () => {
    await db.execute(sql`select 1`);
    return { stato: 'ok' };
  });

  registerAuthRoutes(app, auth, { cookieSecure: config.cookieSecure });
  registerPatientRoutes(app, db);
  // Banche dati pubbliche importate da sync/ (tappa 5), consultate alla data (A5).
  const reference = new ReferenceData(db, loadMappings());
  registerReferenceRoutes(app, reference, now ?? (() => new Date()));
  registerPrescriptionRoutes(
    app,
    createPrescriptionService({
      db,
      gateways,
      now,
      // Per difetto le regole di prescrizione vere (tappa 4), con le banche dati (tappa 5).
      preSendChecks: preSendChecks ?? createRulesCheck({ db, now, reference }),
    }),
  );
  return app;
}
