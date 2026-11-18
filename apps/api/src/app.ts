import cookie from '@fastify/cookie';
import { PRODUCT_NAME } from '@mmg/brand';
import { sql } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import { createAuthService, type Actor } from './auth/service';
import type { Config } from './config';
import { createCredentialService } from './credentials/service';
import type { Database } from './db/client';
import { registerAuthRoutes, SESSION_COOKIE } from './http/auth-routes';
import { registerCredentialRoutes } from './http/credentials-routes';
import { HttpError } from './http/errors';
import { registerPatientRoutes } from './http/patient-routes';
import { registerPrescriptionRoutes } from './http/prescription-routes';
import { registerReferenceRoutes } from './http/reference-routes';
import { registerReminderRoutes } from './http/reminder-routes';
import { registerTherapyRoutes } from './http/therapy-routes';
import { registerTodayRoutes } from './http/today-routes';
import { createRulesCheck } from './prescriptions/rules-check';
import { createPrescriptionService, type PrescriptionDeps } from './prescriptions/service';
import type { CredentialService } from '@mmg/domain';
import {
  SimulatedGateway,
  SimulatedReminderSender,
  SimulatedSecondFactor,
  type GatewaySystem,
  type PrescriptionGateway,
  type ReminderSender,
  type SecondFactorGateway,
} from '@mmg/integrations';
import { loadMappings } from '@mmg/reference';
import { ReferenceData } from './reference/lookup';
import { createReminderService } from './reminders/service';

// I messaggi di validazione arrivano all'interfaccia: in italiano, come il resto (D85).
z.config(z.locales.it());

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
  /**
   * SAR e Sistema TS. Per difetto i simulatori, legati ai simulatori del secondo fattore: nessuna
   * chiamata a servizi reali (regola 7).
   */
  gateways?: Record<GatewaySystem, PrescriptionGateway>;
  /** Secondo fattore (Id-Sessione) del Sistema TS e del SIRPED (D102). Per difetto i simulatori. */
  secondFactor?: Record<CredentialService, SecondFactorGateway>;
  /** Controlli prima dell'invio delle ricette (regole di prescrizione). */
  preSendChecks?: PrescriptionDeps['preSendChecks'];
  /** Email e SMS del promemoria. Per difetto il simulatore (regola 7). */
  reminderSender?: ReminderSender;
  /** Tempo massimo di attesa dell'invio delle ricette, in millisecondi (D94). */
  sendTimeoutMs?: number;
}

export function buildApp({
  db,
  config,
  now,
  logger = false,
  secondFactor = {
    sistema_ts: new SimulatedSecondFactor('sistema_ts', { now }),
    rupar_piemonte: new SimulatedSecondFactor('rupar_piemonte', { now }),
  },
  gateways = defaultGateways(secondFactor),
  preSendChecks,
  reminderSender = new SimulatedReminderSender(),
  sendTimeoutMs,
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
  const credentials = createCredentialService({
    db,
    encryptionKey: config.encryptionKey,
    now: now ?? (() => new Date()),
    secondFactor,
  });
  registerCredentialRoutes(app, credentials);
  registerPatientRoutes(app, db);
  registerTodayRoutes(app, db, now ?? (() => new Date()));
  registerTherapyRoutes(app, db, now ?? (() => new Date()));
  // Banche dati pubbliche importate da sync/ (tappa 5), consultate alla data (A5).
  const reference = new ReferenceData(db, loadMappings());
  registerReferenceRoutes(app, reference, now ?? (() => new Date()));
  registerPrescriptionRoutes(
    app,
    createPrescriptionService({
      db,
      gateways,
      credentials,
      now,
      // Per difetto le regole di prescrizione vere (tappa 4), con le banche dati (tappa 5).
      preSendChecks: preSendChecks ?? createRulesCheck({ db, now, reference }),
      sendTimeoutMs,
    }),
    db,
    now ?? (() => new Date()),
  );
  registerReminderRoutes(app, createReminderService({ db, sender: reminderSender, now }));
  return app;
}

/** Simulatori del SAR e del Sistema TS che vogliono l'Id-Sessione dei rispettivi simulatori. */
function defaultGateways(
  secondFactor: Record<CredentialService, SecondFactorGateway>,
): Record<GatewaySystem, PrescriptionGateway> {
  const sessions = (s: SecondFactorGateway) => (s instanceof SimulatedSecondFactor ? s : undefined);
  return {
    sar: new SimulatedGateway('sar', { sessions: sessions(secondFactor.rupar_piemonte) }),
    sistema_ts: new SimulatedGateway('sistema_ts', { sessions: sessions(secondFactor.sistema_ts) }),
  };
}
