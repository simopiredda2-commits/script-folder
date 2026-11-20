import cookie from '@fastify/cookie';
import { PRODUCT_NAME } from '@mmg/brand';
import { eq, sql } from 'drizzle-orm';
import { prescription } from './db/schema';
import Fastify, { type FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import {
  type Actor,
  allowedBeforePasswordChange,
  createAuthService,
  MUST_CHANGE_PASSWORD_ERROR,
  SERVICE_BUSY_ERROR,
} from './auth/service';
import { createIdentityService } from './auth/identity-service';
import { LOGIN_SOURCE_LIMITS, type LoginSourceLimits } from './auth/login-sources';
import { createCertificateService } from './certificates/service';
import type { Config } from './config';
import { createCredentialService } from './credentials/service';
import { isPoolTimeout, type Database } from './db/client';
import { registerAuthRoutes, SESSION_COOKIE } from './http/auth-routes';
import { registerIdentityRoutes } from './http/identity-routes';
import { registerAuraRoutes } from './http/aura-routes';
import { registerReportRoutes } from './http/report-routes';
import { createAuraService } from './aura/service';
import { ReferenceUpdateScheduler } from './reference/scheduler';
import { registerIdentitySimulatorRoutes } from './http/identity-simulator-routes';
import { registerLockRoutes } from './http/lock-routes';
import { registerCertificateRoutes } from './http/certificate-routes';
import { registerClinicalRoutes } from './http/clinical-routes';
import { registerFollowUpRoutes } from './http/followup-routes';
import { registerFseRoutes } from './http/fse-routes';
import { createPssService } from './fse/service';
import { registerPrivacyRoutes } from './http/privacy-routes';
import { registerAftRoutes } from './http/aft-routes';
import { createAftService } from './aft/service';
import { registerCredentialRoutes } from './http/credentials-routes';
import { registerDoctorProfileRoutes } from './http/doctor-profile-routes';
import { registerRegionalSimulatorRoutes } from './http/regional-simulator-routes';
import { HttpError } from './http/errors';
import { registerPatientRoutes } from './http/patient-routes';
import { registerPrescriptionRoutes } from './http/prescription-routes';
import { registerReferenceRoutes } from './http/reference-routes';
import { registerReferenceUpdateRoutes } from './http/reference-update-routes';
import { registerReminderRoutes } from './http/reminder-routes';
import { registerTherapyRoutes } from './http/therapy-routes';
import { registerTodayRoutes } from './http/today-routes';
import { registerTemplateRoutes } from './http/template-routes';
import { registerArchiveAdminRoutes } from './admin/archive-routes';
import { registerStudioListRoutes } from './admin/list-routes';
import { registerPrintRoutes } from './admin/print-routes';
import { registerStudioAdminRoutes } from './admin/studio-routes';
import { registerUserAdminRoutes } from './admin/user-routes';
import { registerPatientAdminRoutes } from './http/patient-admin-routes';
import { registerImportRoutes } from './import/routes';
import { createTemplateService } from './templates/service';
import { createRulesCheck } from './prescriptions/rules-check';
import { createPrescriptionService, type PrescriptionDeps } from './prescriptions/service';
import type { CredentialService } from '@mmg/domain';
import {
  FseGatewayClient,
  SIMULATED_FSE_AUDIENCE,
  SimulatedDocumentSigner,
  SimulatedFseGateway,
  SimulatedGateway,
  SimulatedDigitalIdentity,
  SimulatedReminderSender,
  SimulatedRegionalAuthorization,
  SimulatedSecondFactor,
  SimulatedSickLeaveGateway,
  type DigitalIdentityGateway,
  type DocumentSigner,
  type GatewaySystem,
  type PrescriptionGateway,
  type ReminderSender,
  type RegionalAuthorizationGateway,
  type SecondFactorGateway,
  type SickLeaveGateway,
  SimulatedAura,
  type AuraGateway,
} from '@mmg/integrations';
import { loadMappings } from '@mmg/reference';
import { ReferenceData } from './reference/lookup';
import { ReferenceUpdates } from './reference/updates-service';
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
  config: Pick<Config, 'encryptionKey' | 'sessionMaxHours' | 'cookieSecure'> &
    Partial<Pick<Config, 'environment' | 'trustedProxies'>>;
  now?: () => Date;
  logger?: boolean;
  /**
   * SAR e Sistema TS. Per difetto i simulatori, legati ai simulatori del secondo fattore: nessuna
   * chiamata a servizi reali (regola 7).
   */
  gateways?: Record<GatewaySystem, PrescriptionGateway>;
  /** Secondo fattore (Id-Sessione) del Sistema TS e del SIRPED (D102). Per difetto i simulatori. */
  secondFactor?: Record<CredentialService, SecondFactorGateway>;
  /** Certificati di malattia all'INPS tramite il Sistema TS. Per difetto il simulatore. */
  sickLeaveGateway?: SickLeaveGateway;
  /**
   * Accesso regionale con SPID o CIE (D109). Per difetto il simulatore, con un codice del
   * gestionale di prova e il ritorno interno al programma: quelli veri li assegna e li registra la
   * Regione (D103).
   */
  regional?: { gateway: RegionalAuthorizationGateway; clientId: string; redirectUri: string };
  /** Controlli prima dell'invio delle ricette (regole di prescrizione). */
  preSendChecks?: PrescriptionDeps['preSendChecks'];
  /** Email e SMS del promemoria. Per difetto il simulatore (regola 7). */
  reminderSender?: ReminderSender;
  /** Tempo massimo di attesa dell'invio delle ricette, in millisecondi (D94). */
  sendTimeoutMs?: number;
  /**
   * Gateway del Fascicolo e firma PAdES del medico (tappa 11). Per difetto i simulatori: il
   * simulatore rilascia i certificati del programma all'avvio, solo in memoria (regola 7).
   */
  fse?: { gateway: FseGatewayClient; audience: string; signer: DocumentSigner };
  /**
   * Aggiornamento delle banche dati (D156). Per difetto nessuno: in sviluppo e nelle prove il
   * servizio non scarica nulla (regola 7); in produzione lo prepara server.ts dalla configurazione.
   */
  referenceUpdates?: ReferenceUpdates;
  /**
   * Attese dopo le password sbagliate, per indirizzo e postazione (D188). Per difetto i valori
   * del servizio (LOGIN_SOURCE_LIMITS); `null` le spegne, solo nelle prove che guardano il conto.
   */
  loginSources?: LoginSourceLimits | null;
  /**
   * Accesso con SPID o CIE al programma, per il ripristino delle credenziali (D189). Per difetto il
   * simulatore, con un codice del programma di prova e i ritorni interni: quelli veri li assegna
   * l'accreditamento come fornitore di servizi (da completare). Con il simulatore, in produzione, il
   * ripristino è spento.
   */
  identity?: { gateway: DigitalIdentityGateway; clientId: string };
  /**
   * AURA, l'anagrafe regionale degli assistiti (D197): esenzioni e scelte del medico. Per difetto il
   * simulatore, senza assistiti; `time` («02:30») accende il controllo di ogni notte. Con il
   * simulatore, in produzione, AURA è spenta.
   */
  aura?: { gateway?: AuraGateway; time?: string | null };
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
  regional = {
    gateway: new SimulatedRegionalAuthorization({ now }),
    clientId: 'SIMULATORE_000',
    redirectUri: '/api/profilo/credenziali/rupar/accesso-regionale/ritorno',
  },
  gateways = defaultGateways(secondFactor, regional.gateway),
  sickLeaveGateway = new SimulatedSickLeaveGateway({ now }),
  preSendChecks,
  reminderSender = new SimulatedReminderSender(),
  sendTimeoutMs,
  fse = defaultFse(now),
  referenceUpdates = new ReferenceUpdates(db, null, now ? { now } : {}),
  loginSources,
  identity = { gateway: new SimulatedDigitalIdentity({ now }), clientId: 'SIMULATORE_IDENTITA' },
  aura = {},
}: AppDeps): FastifyInstance {
  // Indirizzo della richiesta (`req.ip`, nel registro dei tentativi falliti): senza proxy fidati
  // è quello della connessione e X-Forwarded-For non conta; con APP_PROXY_FIDATI è quello del
  // cliente, scritto dal proxy fidato (tappa 14, revisione dei poteri dell'amministratore).
  const trusted = config.trustedProxies ?? [];
  const app = Fastify({ logger, trustProxy: trusted.length > 0 ? [...trusted] : false });
  const auth = createAuthService({
    db,
    encryptionKey: config.encryptionKey,
    sessionMaxHours: config.sessionMaxHours,
    issuer: PRODUCT_NAME,
    now,
    loginSources,
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
    // Tutte le connessioni del database occupate oltre l'attesa massima (db/client.ts): il servizio
    // è occupato, non rotto. Chi chiede riprova; nei log solo il fatto.
    if (isPoolTimeout(err)) {
      req.log.warn('nessuna connessione libera al database entro l’attesa massima');
      return reply.status(503).send({ errore: SERVICE_BUSY_ERROR });
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
    // Password temporanea (tappa 14): prima di ogni altra cosa, la password nuova.
    if (
      r.actor.mustChangePassword &&
      !allowedBeforePasswordChange(req.method, req.routeOptions.url)
    ) {
      throw new HttpError(403, MUST_CHANGE_PASSWORD_ERROR, { devoCambiarePassword: true });
    }
    req.actor = r.actor;
  });

  app.get('/api/salute', { config: { public: true } }, async () => {
    await db.execute(sql`select 1`);
    return { stato: 'ok' };
  });

  registerAuthRoutes(app, auth, {
    cookieSecure: config.cookieSecure,
    now: now ?? (() => new Date()),
  });
  registerLockRoutes(app, db, now ?? (() => new Date()));
  const credentials = createCredentialService({
    db,
    encryptionKey: config.encryptionKey,
    now: now ?? (() => new Date()),
    secondFactor,
    regional,
  });
  registerCredentialRoutes(app, credentials, {
    sessionCookie: SESSION_COOKIE,
    actorOf: async (token) => {
      if (!token) return null;
      const r = await auth.authenticate(token);
      return r.status === 'ok' ? r.actor : null;
    },
  });
  if (regional.gateway instanceof SimulatedRegionalAuthorization)
    registerRegionalSimulatorRoutes(app, regional.gateway, [regional.redirectUri]);
  // Ripristino delle credenziali con SPID o CIE (D189).
  const identityReturns = ['/api/ripristino/ritorno', '/api/profilo/identita/ritorno'] as const;
  const identityService = createIdentityService({
    db,
    encryptionKey: config.encryptionKey,
    gateway: identity.gateway,
    clientId: identity.clientId,
    recoveryRedirectUri: identityReturns[0],
    linkRedirectUri: identityReturns[1],
    environment: config.environment ?? 'prova',
    now: now ?? (() => new Date()),
    loginSources: loginSources === undefined ? LOGIN_SOURCE_LIMITS : loginSources,
    confirmCode: (actor, code, address) => auth.confirmCode(actor, code, address),
  });
  registerIdentityRoutes(app, identityService, {
    cookieSecure: config.cookieSecure,
    sessionCookie: SESSION_COOKIE,
    actorOf: async (token) => {
      if (!token) return null;
      const r = await auth.authenticate(token);
      return r.status === 'ok' ? r.actor : null;
    },
  });
  if (identity.gateway instanceof SimulatedDigitalIdentity)
    registerIdentitySimulatorRoutes(app, identity.gateway, identityReturns);
  // Banche dati pubbliche importate da sync/ (tappa 5), consultate alla data (A5): anche le
  // terapie e la pagina Oggi le guardano, per i farmaci carenti (D202).
  const reference = new ReferenceData(db, loadMappings(), {
    now: now ?? (() => new Date()),
    expectedSince: (at) => referenceUpdates.expectedSince(at),
  });
  registerPatientRoutes(app, db, { reference, now: now ?? (() => new Date()) });
  registerDoctorProfileRoutes(app, db, now ?? (() => new Date()));
  registerTodayRoutes(app, db, now ?? (() => new Date()), reference);
  registerTherapyRoutes(app, db, now ?? (() => new Date()), reference);
  registerClinicalRoutes(app, db, now ?? (() => new Date()));
  registerPrivacyRoutes(app, db, now ?? (() => new Date()));
  registerAftRoutes(app, createAftService({ db, now: now ?? (() => new Date()) }));
  // AURA, l'anagrafe regionale (D197): variazioni ascoltate subito, controllo di ogni notte se c'è l'ora.
  const auraService = createAuraService({
    db,
    gateway: aura.gateway ?? new SimulatedAura(now ? { now } : {}),
    environment: config.environment ?? 'prova',
    now: now ?? (() => new Date()),
  });
  const stopAuraListener = auraService.listen((err) =>
    app.log.error({ err }, 'Variazione di AURA non applicata'),
  );
  const auraScheduler = aura.time
    ? new ReferenceUpdateScheduler({
        time: aura.time,
        now: now ?? (() => new Date()),
        run: () => auraService.syncAll('notte'),
        lastStartedAt: async () => (await auraService.lastRun())?.startedAt ?? null,
        log: (message, err) => app.log.error({ err }, message),
      })
    : null;
  if (auraScheduler) app.addHook('onReady', async () => auraScheduler.start());
  app.addHook('onClose', async () => {
    stopAuraListener();
    await auraScheduler?.stop();
  });
  // Ricetta con esenzione: prima dei controlli, esenzioni rilette da AURA se non sono di adesso.
  const withAuraRefresh =
    (check: NonNullable<PrescriptionDeps['preSendChecks']>): PrescriptionDeps['preSendChecks'] =>
    async (id, actor, input) => {
      const [row] = await db
        .select({ patientId: prescription.patientId, exemptionCode: prescription.exemptionCode })
        .from(prescription)
        .where(eq(prescription.id, id));
      if (row?.exemptionCode)
        await auraService
          .refreshIfStale(row.patientId, actor.userId)
          .catch((err: unknown) =>
            app.log.error({ err }, 'Controllo su AURA prima della ricetta non riuscito'),
          );
      return check(id, actor, input);
    };
  // Strumenti e amministrazione dello studio (tappa 14).
  const adminDeps = {
    db,
    now: now ?? (() => new Date()),
    sessionMaxHours: config.sessionMaxHours,
    referenceUpdates,
    environment: config.environment ?? 'prova',
    aura: auraService,
    auraNextRun: () => auraScheduler?.next ?? null,
  };
  registerStudioAdminRoutes(app, adminDeps);
  registerUserAdminRoutes(app, adminDeps);
  registerPrintRoutes(app, adminDeps);
  registerArchiveAdminRoutes(app, adminDeps);
  registerReportRoutes(app, { db, now: now ?? (() => new Date()) });
  registerStudioListRoutes(app, adminDeps);
  // Pannello amministrativo del paziente e importazione da altri programmi (tappa 15).
  registerPatientAdminRoutes(app, adminDeps);
  registerImportRoutes(app, adminDeps);
  registerFollowUpRoutes(app, db, now ?? (() => new Date()));
  registerReferenceRoutes(app, reference, now ?? (() => new Date()));
  // AURA (D197–D199): con le banche dati, per il nome del luogo di nascita dei nuovi assistiti.
  registerAuraRoutes(app, { db, aura: auraService, now: now ?? (() => new Date()), reference });
  registerReferenceUpdateRoutes(app, db, referenceUpdates);
  // Alla chiusura si ferma l'orologio e il download in corso (il giro resta «interrotto»).
  app.addHook('onClose', async () => referenceUpdates.stop());
  registerPrescriptionRoutes(
    app,
    createPrescriptionService({
      db,
      gateways,
      credentials,
      now,
      // Per difetto le regole di prescrizione vere (tappa 4), con le banche dati (tappa 5).
      preSendChecks: withAuraRefresh(preSendChecks ?? createRulesCheck({ db, now, reference })),
      sendTimeoutMs,
      serviceCatalog: (date) => reference.serviceLookup(date),
    }),
    db,
    now ?? (() => new Date()),
  );
  registerReminderRoutes(app, createReminderService({ db, sender: reminderSender, now }));
  // Modelli dei certificati (tappa 13): modelli ufficiali dagli atti, modelli dello studio.
  registerTemplateRoutes(app, createTemplateService({ db, now }));
  registerCertificateRoutes(
    app,
    createCertificateService({
      db,
      gateway: sickLeaveGateway,
      sender: reminderSender,
      credentials,
      reference,
      now,
    }),
  );
  registerFseRoutes(
    app,
    db,
    createPssService({
      db,
      gateway: fse.gateway,
      gatewayAudience: fse.audience,
      signer: fse.signer,
      reference,
      now,
    }),
  );
  return app;
}

/** Simulatori del Gateway del Fascicolo e della firma, con i certificati di prova in memoria. */
function defaultFse(now?: () => Date): NonNullable<AppDeps['fse']> {
  const simulator = new SimulatedFseGateway({ now });
  return {
    gateway: new FseGatewayClient(simulator, simulator.issueCredentials('Programma'), now),
    audience: SIMULATED_FSE_AUDIENCE,
    signer: new SimulatedDocumentSigner({ now }),
  };
}

/** Simulatori del SAR e del Sistema TS che vogliono l'Id-Sessione dei rispettivi simulatori. */
function defaultGateways(
  secondFactor: Record<CredentialService, SecondFactorGateway>,
  regional: RegionalAuthorizationGateway,
): Record<GatewaySystem, PrescriptionGateway> {
  const oauth = regional instanceof SimulatedRegionalAuthorization ? regional : undefined;
  const sessions = (s: SecondFactorGateway) => (s instanceof SimulatedSecondFactor ? s : undefined);
  return {
    sar: new SimulatedGateway('sar', { sessions: sessions(secondFactor.rupar_piemonte), oauth }),
    sistema_ts: new SimulatedGateway('sistema_ts', { sessions: sessions(secondFactor.sistema_ts) }),
  };
}
