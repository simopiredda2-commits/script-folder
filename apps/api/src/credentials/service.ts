import {
  CREDENTIAL_SERVICE_LABELS,
  CREDENTIAL_SERVICE_USES,
  CREDENTIAL_SERVICES,
  NEEDS_SECOND_FACTOR,
  passwordExpiry,
  passwordState,
  SERVICE_FOR_USE,
  SERVICE_USES,
  usernameHint,
  type CredentialService,
  type Role,
  type ServiceUse,
} from '@mmg/domain';
import {
  newPkceVerifier,
  pkceChallenge,
  PRESCRIBER_SCOPE,
  type AuthProblem,
  type RegionalAuthorizationGateway,
  type SecondFactorGateway,
  type ServiceAuth,
} from '@mmg/integrations';
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { Actor } from '../auth/service';
import type { Database } from '../db/client';
import type { Tx } from '../db/tx';
import {
  doctorProfile,
  regionalAuthorizationRequest,
  serviceCredential,
  serviceCredentialEvent,
  serviceSession,
} from '../db/schema';
import { HttpError } from '../http/errors';
import { studioDate } from '../prescriptions/rules-check';
import { decryptSecret, deriveKey, encryptSecret } from '../security/secrets';

/**
 * Credenziali dei servizi esterni del medico e secondo fattore (D100–D102).
 *
 * Utente, password e PIN si cifrano insieme con una chiave derivata solo per questo uso e legata
 * a medico e servizio: copiati su un'altra riga non si aprono. Le rotte non li restituiscono mai.
 * Li gestisce solo il medico a cui appartengono (regola 5). Ogni evento resta in
 * `service_credential_event`, senza valori segreti.
 */

/** Il servizio nelle rotte: corto e leggibile. */
export const SERVICE_SLUGS = { 'sistema-ts': 'sistema_ts', rupar: 'rupar_piemonte' } as const;
export type ServiceSlug = keyof typeof SERVICE_SLUGS;
const slugOf = (service: CredentialService): ServiceSlug =>
  service === 'sistema_ts' ? 'sistema-ts' : 'rupar';

/** Codici d'errore che portano il medico alla pagina delle credenziali. */
export const CREDENTIAL_ERROR_CODES = [
  'CREDENZIALI_MANCANTI',
  'CREDENZIALI_RIFIUTATE',
  'SESSIONE_MANCANTE',
  'SESSIONE_SCADUTA',
] as const;

interface Secret {
  username: string;
  password: string;
  pin: string;
}

export interface CredentialDeps {
  db: Database;
  /** Chiave dell'applicazione: se ne deriva una solo per le credenziali. */
  encryptionKey: Buffer;
  now: () => Date;
  secondFactor: Record<CredentialService, SecondFactorGateway>;
  /**
   * Accesso regionale con SPID o CIE per le ricette in Piemonte (D109): servizio OAuth2 del
   * SIRPED, codice del gestionale (client_id, da completare con la Regione, D103) e indirizzo di
   * ritorno registrato presso la Regione.
   */
  regional?: {
    gateway: RegionalAuthorizationGateway;
    clientId: string;
    redirectUri: string;
  };
}

/** Minuti entro cui il medico deve tornare dalla pagina regionale (la Regione: «qualche minuto»). */
export const REGIONAL_REQUEST_MINUTES = 10;

const isDoctor = (roles: readonly Role[]) =>
  roles.includes('owner_doctor') || roles.includes('substitute_doctor');

const credentialKey = (appKey: Buffer) => deriveKey(appKey, 'credenziali-dei-servizi');
const aad = (kind: 'credenziali' | 'sessione', userId: string, service: CredentialService) =>
  Buffer.from(`${kind}:${userId}:${service}`);

function seal(key: Buffer, userId: string, service: CredentialService, secret: Secret): Buffer {
  return encryptSecret(
    key,
    Buffer.from(JSON.stringify(secret)),
    aad('credenziali', userId, service),
  );
}

function open(key: Buffer, userId: string, service: CredentialService, data: Buffer): Secret {
  try {
    return JSON.parse(
      decryptSecret(key, data, aad('credenziali', userId, service)).toString(),
    ) as Secret;
  } catch {
    // Testo cifrato copiato da un'altra riga, o chiave cambiata: non si apre, si reinseriscono.
    throw new HttpError(
      422,
      'Le credenziali salvate non si possono leggere: inseriscile di nuovo in «Credenziali dei servizi»',
      { codice: 'CREDENZIALI_MANCANTI' },
    );
  }
}

/** Scrive le credenziali senza passare dalle rotte: dati dimostrativi e prove. */
export async function storeCredentials(
  db: Database,
  appKey: Buffer,
  input: { userId: string; service: CredentialService; secret: Secret; passwordChangedOn: string },
) {
  const values = {
    userId: input.userId,
    service: input.service,
    secretEnc: seal(credentialKey(appKey), input.userId, input.service, input.secret),
    usernameHint: usernameHint(input.secret.username),
    passwordChangedOn: input.passwordChangedOn,
    updatedAt: new Date(),
  };
  await db
    .insert(serviceCredential)
    .values(values)
    .onConflictDoUpdate({
      target: [serviceCredential.userId, serviceCredential.service],
      set: values,
    });
}

/** Due codici fiscali uguali, senza badare alle maiuscole; un codice mancante non è uguale a nulla. */
const sameFiscalCode = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.trim().toUpperCase() === b.trim().toUpperCase();

/** Codice fiscale del medico com'è adesso nel profilo, o null. */
async function profileFiscalCode(q: Database, userId: string): Promise<string | null> {
  const [p] = await q
    .select({ cf: doctorProfile.fiscalCode })
    .from(doctorProfile)
    .where(eq(doctorProfile.userId, userId));
  return p?.cf ?? null;
}

/**
 * Scrive una sessione del secondo fattore (D102) o dell'accesso con SPID o CIE (D109), con il
 * codice fiscale con cui è stata aperta (`subject`): la sessione vale solo finché il profilo del
 * medico ha quel codice fiscale (regola 4, D111). Il servizio lo passa sempre; nelle prove, senza,
 * vale il codice fiscale che il medico ha adesso.
 */
export async function storeSession(
  db: Database,
  appKey: Buffer,
  input: {
    userId: string;
    service: CredentialService;
    token: string;
    validUntil: Date;
    mode?: 'email' | 'spid_cie';
    subject?: string | null;
  },
) {
  const subject =
    input.subject !== undefined ? input.subject : await profileFiscalCode(db, input.userId);
  const values = {
    userId: input.userId,
    service: input.service,
    tokenEnc: encryptSecret(
      credentialKey(appKey),
      Buffer.from(input.token),
      aad('sessione', input.userId, input.service),
    ),
    validUntil: input.validUntil,
    activatedAt: new Date(),
    mode: input.mode ?? 'email',
    subject,
  };
  await db
    .insert(serviceSession)
    .values(values)
    .onConflictDoUpdate({ target: [serviceSession.userId, serviceSession.service], set: values });
}

/**
 * Chiude le sessioni dei servizi di un medico (Id-Sessione del secondo fattore, accesso regionale
 * con SPID o CIE) e le sue richieste di accesso regionale ancora aperte. Serve quando
 * l'amministratore corregge il codice fiscale o il codice regionale del medico, a cui le sessioni
 * sono legate (D102, D111): il medico le riattiva da «Credenziali dei servizi». Le credenziali
 * (utente, password, PIN) restano. Solo nel programma: la revoca presso il servizio non parte da
 * qui. Ogni sessione chiusa resta tra gli eventi delle credenziali, senza valori segreti.
 */
export async function closeServiceSessions(
  q: Database | Tx,
  input: {
    userId: string;
    services: readonly CredentialService[];
    at: Date;
    workstation: string | null;
    detail: string;
  },
): Promise<CredentialService[]> {
  if (input.services.length === 0) return [];
  const gone = await q
    .delete(serviceSession)
    .where(
      and(
        eq(serviceSession.userId, input.userId),
        inArray(serviceSession.service, [...input.services]),
      ),
    )
    .returning({ service: serviceSession.service });
  if (input.services.includes('rupar_piemonte'))
    await q
      .update(regionalAuthorizationRequest)
      .set({ usedAt: input.at })
      .where(
        and(
          eq(regionalAuthorizationRequest.userId, input.userId),
          isNull(regionalAuthorizationRequest.usedAt),
        ),
      );
  const closed = CREDENTIAL_SERVICES.filter((s) => gone.some((g) => g.service === s));
  for (const service of closed)
    await q.insert(serviceCredentialEvent).values({
      userId: input.userId,
      service,
      event: 'sessione_chiusa',
      at: input.at,
      workstation: input.workstation,
      detail: input.detail,
    });
  return closed;
}

const saveBody = z
  .object({
    utente: z.string().trim().min(1).max(100).optional(),
    password: z.string().min(1).max(200).optional(),
    pin: z.string().trim().min(1).max(20).optional(),
    passwordCambiataIl: z.iso.date().optional(),
  })
  .strict();

const codeBody = z.object({ codice: z.string().trim().min(1).max(100) }).strict();

export function createCredentialService(deps: CredentialDeps) {
  const { db, now } = deps;
  const key = credentialKey(deps.encryptionKey);
  const label = (s: CredentialService) => CREDENTIAL_SERVICE_LABELS[s];
  const where = (userId: string, service: CredentialService) => ({
    credential: and(eq(serviceCredential.userId, userId), eq(serviceCredential.service, service)),
    session: and(eq(serviceSession.userId, userId), eq(serviceSession.service, service)),
  });

  function requireDoctor(actor: Actor) {
    if (!isDoctor(actor.roles))
      throw new HttpError(
        403,
        'Le credenziali dei servizi sono personali del medico: la segreteria e l’amministratore non le vedono e non le usano',
      );
  }

  async function event(
    who: { userId: string; workstation?: string | null },
    service: CredentialService,
    name: string,
    detail?: string | null,
  ) {
    await db.insert(serviceCredentialEvent).values({
      userId: who.userId,
      service,
      event: name,
      workstation: who.workstation ?? null,
      detail: detail ?? null,
    });
  }

  async function loadSecret(userId: string, service: CredentialService): Promise<Secret | null> {
    const [row] = await db
      .select({ secretEnc: serviceCredential.secretEnc })
      .from(serviceCredential)
      .where(where(userId, service).credential);
    return row ? open(key, userId, service, row.secretEnc) : null;
  }

  async function fiscalCodeOf(userId: string): Promise<string> {
    const [p] = await db
      .select({ cf: doctorProfile.fiscalCode })
      .from(doctorProfile)
      .where(eq(doctorProfile.userId, userId));
    if (!p?.cf)
      throw new HttpError(
        422,
        'Manca il codice fiscale del medico nel profilo: serve per il codice di sessione',
      );
    return p.cf;
  }

  const needsSecondFactor = (service: CredentialService) =>
    SERVICE_USES.some((u) => SERVICE_FOR_USE[u] === service && NEEDS_SECOND_FACTOR[u]);

  async function status(actor: Actor) {
    requireDoctor(actor);
    const today = studioDate(now());
    const creds = await db
      .select()
      .from(serviceCredential)
      .where(eq(serviceCredential.userId, actor.userId));
    const sessions = await db
      .select({
        service: serviceSession.service,
        validUntil: serviceSession.validUntil,
        activatedAt: serviceSession.activatedAt,
        mode: serviceSession.mode,
        subject: serviceSession.subject,
      })
      .from(serviceSession)
      .where(eq(serviceSession.userId, actor.userId));
    const fiscalCode = await profileFiscalCode(db, actor.userId);
    return {
      servizi: CREDENTIAL_SERVICES.map((service) => {
        const c = creds.find((r) => r.service === service);
        const s = sessions.find((r) => r.service === service);
        // Aperta con un altro codice fiscale: non vale (regola 4), come in authFor.
        const active = !!s && s.validUntil > now() && sameFiscalCode(s.subject, fiscalCode);
        return {
          servizio: slugOf(service),
          nome: label(service),
          uso: CREDENTIAL_SERVICE_USES[service],
          impostate: !!c,
          utente: c?.usernameHint ?? null,
          passwordCambiataIl: c?.passwordChangedOn ?? null,
          scadenzaPassword: c ? passwordExpiry(service, c.passwordChangedOn) : null,
          statoPassword: c ? passwordState(service, c.passwordChangedOn, today) : null,
          aggiornateIl: c?.updatedAt ?? null,
          secondoFattore: needsSecondFactor(service),
          sessione: {
            attiva: active,
            scadeIl: active ? s.validUntil : null,
            modalita: active ? s.mode : null,
          },
          /** Ricette SSN in Piemonte: si può entrare con SPID o CIE (D109). */
          accessoRegionale: service === 'rupar_piemonte' && !!deps.regional,
          ambiente: deps.secondFactor[service].environment,
        };
      }),
    };
  }

  async function save(actor: Actor, service: CredentialService, body: unknown) {
    requireDoctor(actor);
    const b = saveBody.parse(body ?? {});
    if (!b.utente && !b.password && !b.pin && !b.passwordCambiataIl)
      throw new HttpError(400, 'Niente da cambiare');
    const [existing] = await db
      .select()
      .from(serviceCredential)
      .where(where(actor.userId, service).credential);
    // Con utente, password e PIN insieme si sostituisce tutto, anche una riga illeggibile.
    const full = !!(b.utente && b.password && b.pin);
    const old = existing && !full ? open(key, actor.userId, service, existing.secretEnc) : null;
    let secret: Secret;
    if (full) {
      secret = { username: b.utente!, password: b.password!, pin: b.pin! };
    } else if (old) {
      secret = {
        username: b.utente ?? old.username,
        password: b.password ?? old.password,
        pin: b.pin ?? old.pin,
      };
    } else {
      throw new HttpError(400, `Per ${label(service)} servono utente, password e PIN`);
    }
    const today = studioDate(now());
    const changedOn =
      b.passwordCambiataIl ?? (b.password || !existing ? today : existing.passwordChangedOn);
    if (changedOn > today)
      throw new HttpError(400, 'La data del cambio della password non può essere nel futuro');
    // Un utente diverso non può usare la sessione dell'utente di prima (se non si sa, si toglie).
    let previousUsername: string | null = old?.username ?? null;
    if (existing && full) {
      try {
        previousUsername = open(key, actor.userId, service, existing.secretEnc).username;
      } catch {
        previousUsername = null;
      }
    }
    await storeCredentials(db, deps.encryptionKey, {
      userId: actor.userId,
      service,
      secret,
      passwordChangedOn: changedOn,
    });
    if (existing && secret.username !== previousUsername)
      await db.delete(serviceSession).where(where(actor.userId, service).session);
    const changed = [
      b.utente && 'utente',
      b.password && 'password',
      b.pin && 'PIN',
      b.passwordCambiataIl && 'data del cambio della password',
    ].filter(Boolean);
    await event(actor, service, existing ? 'cambiate' : 'impostate', changed.join(', '));
    return status(actor);
  }

  async function remove(actor: Actor, service: CredentialService) {
    requireDoctor(actor);
    const w = where(actor.userId, service);
    await db.delete(serviceSession).where(w.session);
    const gone = await db.delete(serviceCredential).where(w.credential).returning();
    if (gone.length > 0) await event(actor, service, 'cancellate');
    return status(actor);
  }

  async function requireSecret(userId: string, service: CredentialService): Promise<Secret> {
    const secret = await loadSecret(userId, service);
    if (!secret)
      throw new HttpError(
        422,
        `Mancano le credenziali ${label(service)} del medico: inseriscile in «Credenziali dei servizi»`,
        { codice: 'CREDENZIALI_MANCANTI', servizio: slugOf(service) },
      );
    return secret;
  }

  /** Chiede l'Id-Sessione: il servizio lo manda all'email certificata del medico. */
  async function requestSession(actor: Actor, service: CredentialService) {
    requireDoctor(actor);
    const secret = await requireSecret(actor.userId, service);
    const fiscalCode = await fiscalCodeOf(actor.userId);
    const gateway = deps.secondFactor[service];
    const r = await gateway.requestCode({ auth: secret, fiscalCode });
    if (r.outcome === 'unreachable') {
      await event(actor, service, 'codice_non_richiesto', r.message);
      throw new HttpError(502, `${label(service)}: ${r.message}. Riprova tra poco.`);
    }
    if (r.outcome === 'rejected') {
      await event(actor, service, 'codice_rifiutato', `${r.code}: ${r.message}`);
      throw new HttpError(
        422,
        `${label(service)} ha rifiutato la richiesta del codice: ${r.message}. Controlla utente, password e PIN.`,
        { codice: 'CREDENZIALI_RIFIUTATE', servizio: slugOf(service) },
      );
    }
    await event(actor, service, 'codice_richiesto');
    return {
      inviato: true,
      // Come nell'ambiente di prova del SIRPED (4.2.1): mai in produzione.
      codiceDiProva: gateway.environment === 'production' ? null : r.testCode,
    };
  }

  /** Il medico inserisce il codice ricevuto: si verifica col servizio e vale fino alla scadenza. */
  async function confirmSession(actor: Actor, service: CredentialService, body: unknown) {
    requireDoctor(actor);
    const { codice } = codeBody.parse(body ?? {});
    const secret = await requireSecret(actor.userId, service);
    const fiscalCode = await fiscalCodeOf(actor.userId);
    const r = await deps.secondFactor[service].check({
      auth: secret,
      fiscalCode,
      sessionId: codice,
    });
    if (r.outcome === 'unreachable')
      throw new HttpError(502, `${label(service)}: ${r.message}. Riprova tra poco.`);
    if (r.outcome === 'invalid') {
      await event(actor, service, 'sessione_rifiutata', r.message);
      throw new HttpError(422, 'Il codice non è valido o è scaduto: chiedine uno nuovo');
    }
    // Il codice fiscale con cui la sessione si è aperta: se nel frattempo l'amministratore lo ha
    // corretto, la sessione non vale (authFor).
    await storeSession(db, deps.encryptionKey, {
      userId: actor.userId,
      service,
      token: codice,
      validUntil: new Date(r.validUntil),
      subject: fiscalCode,
    });
    await event(actor, service, 'sessione_attivata', `fino a ${r.validUntil}`);
    return status(actor);
  }

  async function revokeSession(actor: Actor, service: CredentialService) {
    requireDoctor(actor);
    const w = where(actor.userId, service);
    const [s] = await db.select().from(serviceSession).where(w.session);
    if (!s) return status(actor);
    const token = decryptSecret(key, s.tokenEnc, aad('sessione', actor.userId, service)).toString();
    let detail: string | null = null;
    if (s.mode === 'spid_cie' && deps.regional) {
      const r = await deps.regional.gateway.revoke({
        clientId: deps.regional.clientId,
        fiscalCode: s.subject ?? '',
        accessToken: token,
      });
      if (r.outcome === 'unreachable') detail = `revoca solo locale: ${r.message}`;
      await db.delete(serviceSession).where(w.session);
      await event(actor, service, 'sessione_revocata', detail ?? 'SPID o CIE');
      return status(actor);
    }
    const secret = await loadSecret(actor.userId, service);
    if (secret) {
      const r = await deps.secondFactor[service].revoke({
        auth: secret,
        fiscalCode: await fiscalCodeOf(actor.userId),
        sessionId: token,
      });
      if (r.outcome === 'unreachable') detail = `revoca solo locale: ${r.message}`;
    }
    await db.delete(serviceSession).where(w.session);
    await event(actor, service, 'sessione_revocata', detail);
    return status(actor);
  }

  const stateHash = (state: string) => createHash('sha256').update(state).digest('hex');
  const pkceAad = (userId: string) => Buffer.from(`pkce:${userId}`);

  /**
   * Avvio dell'accesso regionale con SPID o CIE (D109): state casuale (se ne conserva
   * l'impronta) e code_verifier cifrato; il medico va alla pagina di autorizzazione regionale.
   */
  async function startRegionalAccess(actor: Actor) {
    requireDoctor(actor);
    if (!deps.regional) throw new HttpError(404, 'Accesso regionale non disponibile');
    const fiscalCode = await fiscalCodeOf(actor.userId);
    const state = randomBytes(32).toString('base64url');
    const verifier = newPkceVerifier();
    await db.insert(regionalAuthorizationRequest).values({
      userId: actor.userId,
      stateHash: stateHash(state),
      verifierEnc: encryptSecret(key, Buffer.from(verifier), pkceAad(actor.userId)),
      redirectUri: deps.regional.redirectUri,
      expiresAt: new Date(now().getTime() + REGIONAL_REQUEST_MINUTES * 60_000),
    });
    await event(actor, 'rupar_piemonte', 'accesso_regionale_avviato');
    return {
      indirizzo: deps.regional.gateway.authorizeUrl({
        clientId: deps.regional.clientId,
        redirectUri: deps.regional.redirectUri,
        scope: [PRESCRIBER_SCOPE],
        state,
        codeChallenge: pkceChallenge(verifier),
        loginHint: fiscalCode,
      }),
    };
  }

  const returnQuery = z.object({
    code: z.string().max(2000).optional(),
    state: z.string().max(500).optional(),
    error: z.string().max(200).optional(),
    error_description: z.string().max(1000).optional(),
  });

  /**
   * Ritorno dalla pagina regionale: lo state deve essere quello di una richiesta di questo medico,
   * non usata e non scaduta; poi scambio del codice con il code_verifier; chi è entrato con SPID o
   * CIE deve essere il medico collegato, con il profilo di prescrizione.
   */
  async function completeRegionalAccess(
    actor: Actor,
    query: unknown,
  ): Promise<{ esito: 'ok'; scadeIl: Date } | { esito: 'errore'; motivo: string }> {
    requireDoctor(actor);
    const regional = deps.regional;
    if (!regional) throw new HttpError(404, 'Accesso regionale non disponibile');
    const q = returnQuery.parse(query ?? {});
    const fail = async (motivo: string, detail?: string) => {
      await event(actor, 'rupar_piemonte', 'accesso_regionale_rifiutato', detail ?? motivo);
      return { esito: 'errore' as const, motivo };
    };
    if (!q.state) return fail('Ritorno senza state: riprova l’accesso');
    const claimed = await db
      .update(regionalAuthorizationRequest)
      .set({ usedAt: now() })
      .where(
        and(
          eq(regionalAuthorizationRequest.stateHash, stateHash(q.state)),
          eq(regionalAuthorizationRequest.userId, actor.userId),
          isNull(regionalAuthorizationRequest.usedAt),
          gt(regionalAuthorizationRequest.expiresAt, now()),
        ),
      )
      .returning();
    const request = claimed[0];
    if (!request) return fail('Richiesta di accesso non riconosciuta o scaduta: riprova');
    if (q.error)
      return fail(
        q.error === 'access_denied'
          ? 'Accesso regionale annullato o negato'
          : `La Regione ha risposto con un errore (${q.error})`,
        `${q.error}: ${q.error_description ?? ''}`,
      );
    if (!q.code) return fail('Ritorno senza codice di autorizzazione: riprova');
    const verifier = decryptSecret(key, request.verifierEnc, pkceAad(actor.userId)).toString();
    const r = await regional.gateway.exchange({
      code: q.code,
      redirectUri: request.redirectUri,
      clientId: regional.clientId,
      codeVerifier: verifier,
    });
    if (r.outcome === 'unreachable')
      return fail(`Servizio regionale non raggiungibile: ${r.message}`);
    if (r.outcome === 'rejected')
      return fail(
        `La Regione non ha rilasciato il token (${r.error})`,
        `${r.error}: ${r.description ?? ''}`,
      );
    const doctor = await fiscalCodeOf(actor.userId);
    if (r.fiscalCode.toUpperCase() !== doctor.toUpperCase()) {
      await regional.gateway.revoke({
        clientId: regional.clientId,
        fiscalCode: r.fiscalCode,
        accessToken: r.accessToken,
      });
      return fail(
        'L’accesso regionale è stato fatto con un’identità diversa da quella del medico collegato',
      );
    }
    if (!r.scope.includes(PRESCRIBER_SCOPE))
      return fail(
        'La Regione non ha concesso il profilo di prescrizione: va abilitato nel configuratore regionale',
      );
    const validUntil = new Date(now().getTime() + r.expiresIn * 1000);
    await storeSession(db, deps.encryptionKey, {
      userId: actor.userId,
      service: 'rupar_piemonte',
      token: r.accessToken,
      validUntil,
      mode: 'spid_cie',
      subject: r.fiscalCode,
    });
    await event(
      actor,
      'rupar_piemonte',
      'sessione_attivata',
      `SPID o CIE, fino a ${validUntil.toISOString()}`,
    );
    return { esito: 'ok', scadeIl: validUntil };
  }

  /**
   * La sessione del servizio del medico, se vale: solo con il codice fiscale con cui è stata aperta
   * uguale a quello attuale del profilo (regola 4, D111). Se l'amministratore lo ha corretto mentre
   * la sessione si apriva, la chiusura delle sessioni può arrivare prima del salvataggio (revisione
   * dei poteri dell'amministratore, problema 8): qui la sessione si chiude e il medico la riapre.
   */
  async function sessionFor(userId: string, service: CredentialService) {
    const [s] = await db.select().from(serviceSession).where(where(userId, service).session);
    if (!s) return null;
    if (sameFiscalCode(s.subject, await profileFiscalCode(db, userId))) return s;
    const gone = await db
      .delete(serviceSession)
      // Solo la sessione letta: una riaperta nel frattempo, con il codice giusto, resta.
      .where(and(where(userId, service).session, eq(serviceSession.tokenEnc, s.tokenEnc)))
      .returning({ service: serviceSession.service });
    if (gone.length > 0)
      await event(
        { userId },
        service,
        'sessione_chiusa',
        'aperta con un codice fiscale diverso da quello attuale del medico',
      );
    throw new HttpError(
      422,
      `La sessione ${label(service)} era stata aperta con un codice fiscale diverso da quello attuale del medico: è chiusa. Riattivala in «Credenziali dei servizi»`,
      { codice: 'SESSIONE_MANCANTE', servizio: slugOf(service) },
    );
  }

  /**
   * Per gli invii: credenziali e secondo fattore di chi firma. Se mancano, l'invio si ferma prima
   * di contattare il servizio, con un errore che porta alla pagina giusta.
   */
  async function authFor(userId: string, use: ServiceUse): Promise<ServiceAuth> {
    const service = SERVICE_FOR_USE[use];
    const s = NEEDS_SECOND_FACTOR[use] ? await sessionFor(userId, service) : null;
    // Accesso regionale con SPID o CIE: il token sostituisce utente, password e PIN RUPAR (D109).
    if (s?.mode === 'spid_cie') {
      if (s.validUntil <= now())
        throw new HttpError(
          422,
          'L’accesso regionale con SPID o CIE è scaduto: entra di nuovo da «Credenziali dei servizi»',
          { codice: 'SESSIONE_SCADUTA', servizio: slugOf(service) },
        );
      const bearer = decryptSecret(key, s.tokenEnc, aad('sessione', userId, service)).toString();
      return { bearer, sessionId: null };
    }
    const secret = await requireSecret(userId, service);
    if (!NEEDS_SECOND_FACTOR[use]) return { ...secret, sessionId: null };
    if (!s)
      throw new HttpError(
        422,
        `Serve il codice di sessione ${label(service)} (secondo fattore): attivalo in «Credenziali dei servizi»`,
        { codice: 'SESSIONE_MANCANTE', servizio: slugOf(service) },
      );
    if (s.validUntil <= now())
      throw new HttpError(
        422,
        `Il codice di sessione ${label(service)} è scaduto: chiedine uno nuovo in «Credenziali dei servizi»`,
        { codice: 'SESSIONE_SCADUTA', servizio: slugOf(service) },
      );
    const sessionId = decryptSecret(key, s.tokenEnc, aad('sessione', userId, service)).toString();
    return { ...secret, sessionId };
  }

  /** Il servizio ha rifiutato l'accesso durante un invio: si annota; se è la sessione, si toglie. */
  async function authRefused(
    who: { userId: string; workstation?: string | null },
    use: ServiceUse,
    problem: AuthProblem,
    detail: string,
  ) {
    const service = SERVICE_FOR_USE[use];
    if (problem === 'session')
      await db.delete(serviceSession).where(where(who.userId, service).session);
    await event(
      who,
      service,
      problem === 'session' ? 'sessione_rifiutata' : 'credenziali_rifiutate',
      detail,
    );
  }

  return {
    status,
    save,
    remove,
    requestSession,
    confirmSession,
    revokeSession,
    startRegionalAccess,
    completeRegionalAccess,
    authFor,
    authRefused,
  };
}
