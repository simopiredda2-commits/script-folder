import {
  isNationalUse,
  NATIONAL_CREDENTIALS,
  needsSecondFactor,
  passwordExpiry,
  passwordState,
  usernameHint,
  type CredentialService,
  type RegionalUse,
  type Role,
  type ServiceUse,
} from '@mmg/domain';
import {
  newPkceVerifier,
  pkceChallenge,
  type AuthProblem,
  type RegionalAuthorizationGateway,
  type RegionalCredentials,
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
import { studioRegion } from '../regions/region';
import { decryptSecret, deriveKey, encryptSecret } from '../security/secrets';

/**
 * Credenziali dei servizi esterni del medico e secondo fattore (D100–D102; D301).
 *
 * Utente, password e PIN si cifrano insieme con una chiave derivata solo per questo uso e legata
 * a medico e servizio: copiati su un'altra riga non si aprono. Le rotte non li restituiscono mai.
 * Li gestisce solo il medico a cui appartengono (regola 5). Ogni evento resta in
 * `service_credential_event`, senza valori segreti.
 *
 * I servizi sono il Sistema TS e il servizio della regione dello studio, descritto dal pacchetto
 * della regione (D301): nome, password, secondo fattore, come si presenta il programma, accesso
 * con SPID o CIE.
 */

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

/**
 * Le credenziali dei servizi di una regione come le usa il servizio (D301): la descrizione del
 * pacchetto, con i servizi creati per questo programma (oggi i simulatori, regola 7).
 */
export interface RegionalCredentialRuntime {
  /** La chiave del pacchetto della regione. */
  region: string;
  info: RegionalCredentials;
  /** Il secondo fattore del servizio, se c'è. */
  secondFactor: SecondFactorGateway | null;
  /** L'accesso con SPID o CIE della regione, con l'indirizzo di ritorno registrato. */
  strongAccess: { gateway: RegionalAuthorizationGateway; redirectUri: string } | null;
  /**
   * Il codice che la regione ha assegnato al programma, dalla configurazione (D267), se la regione
   * vuole che il programma si presenti.
   */
  softwareCode: string | null;
}

export interface CredentialDeps {
  db: Database;
  /** Chiave dell'applicazione: se ne deriva una solo per le credenziali. */
  encryptionKey: Buffer;
  now: () => Date;
  /** Il secondo fattore del Sistema TS (D102). */
  nationalSecondFactor: SecondFactorGateway;
  /** Le credenziali dei servizi delle regioni, una per pacchetto (D301). */
  regional: readonly RegionalCredentialRuntime[];
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
 * vale il codice fiscale che il medico ha adesso. Con SPID o CIE anche il `client_id` per cui la
 * regione ha dato il token, che la revoca ripete (D301).
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
    clientId?: string | null;
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
    clientId: input.clientId ?? null,
  };
  await db
    .insert(serviceSession)
    .values(values)
    .onConflictDoUpdate({ target: [serviceSession.userId, serviceSession.service], set: values });
}

/**
 * Chiude le sessioni dei servizi di un medico (Id-Sessione del secondo fattore, accesso con SPID o
 * CIE) e le sue richieste di accesso regionale ancora aperte per quei servizi. Serve quando
 * l'amministratore corregge il codice fiscale, il codice regionale o il codice ASL del medico, a
 * cui le sessioni sono legate (D102, D111, D266): il medico le riattiva da «Credenziali dei
 * servizi». Le credenziali (utente, password, PIN) restano. Solo nel programma: la revoca presso il
 * servizio non parte da qui. Ogni sessione chiusa resta tra gli eventi delle credenziali, senza
 * valori segreti.
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
  await q
    .update(regionalAuthorizationRequest)
    .set({ usedAt: input.at })
    .where(
      and(
        eq(regionalAuthorizationRequest.userId, input.userId),
        inArray(regionalAuthorizationRequest.service, [...input.services]),
        isNull(regionalAuthorizationRequest.usedAt),
      ),
    );
  const closed = input.services.filter((s) => gone.some((g) => g.service === s));
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

/**
 * Perché un ritorno dalla pagina regionale non va a buon fine, come codice (D193). Nell'indirizzo
 * del ritorno va solo il codice e il testo lo scrive l'interfaccia: un testo nell'indirizzo lo
 * potrebbe scrivere chiunque, in un collegamento al dominio vero. Il motivo vero va nel registro.
 */
export const REGIONAL_FAILURES = [
  'non-riconosciuta',
  'annullato',
  'errore-regione',
  'senza-codice',
  'non-raggiungibile',
  'token-negato',
  'identita-diversa',
  'senza-profilo',
  /** Al ritorno la sessione del programma non c'è più. */
  'sessione',
] as const;
export type RegionalFailure = (typeof REGIONAL_FAILURES)[number];

/** Un servizio con le credenziali del medico, come lo usa il servizio. */
interface Service {
  key: CredentialService;
  slug: string;
  name: string;
  use: string;
  passwordValidityMonths: number | null;
  /** La regione del servizio (chiave del pacchetto); null per il Sistema TS. */
  region: string | null;
  secondFactor: SecondFactorGateway | null;
  /** Gli invii della regione con il secondo fattore oltre a quelli della legge. */
  secondFactorUses: readonly RegionalUse[];
  /** L'accesso con SPID o CIE della regione, con i permessi da chiedere e la nota per il medico. */
  strongAccess:
    | (NonNullable<RegionalCredentialRuntime['strongAccess']> & {
        scope: readonly string[];
        note: string;
      })
    | null;
  /** Come il programma si presenta: il codice della configurazione e la regola della regione. */
  software: { code: string; identity: NonNullable<RegionalCredentials['software']> } | null;
}

export function createCredentialService(deps: CredentialDeps) {
  const { db, now } = deps;
  const key = credentialKey(deps.encryptionKey);
  const national: Service = {
    ...NATIONAL_CREDENTIALS,
    region: null,
    secondFactor: deps.nationalSecondFactor,
    secondFactorUses: [],
    strongAccess: null,
    software: null,
  };
  const regional: Service[] = deps.regional.map((r) => ({
    key: r.info.key,
    slug: r.info.slug,
    name: r.info.name,
    use: r.info.use,
    passwordValidityMonths: r.info.passwordValidityMonths,
    region: r.region,
    secondFactor: r.secondFactor,
    secondFactorUses: r.info.secondFactorUses,
    strongAccess:
      r.strongAccess && r.info.strongAccess
        ? { ...r.strongAccess, scope: r.info.strongAccess.scope, note: r.info.strongAccess.note }
        : null,
    software:
      r.info.software && r.softwareCode !== null
        ? { code: r.softwareCode, identity: r.info.software }
        : null,
  }));
  const services = [national, ...regional];
  const label = (s: Service) => s.name;
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

  /** Il servizio dal suo nome corto, o 404. */
  function bySlug(slug: string): Service {
    const s = services.find((x) => x.slug === slug);
    if (!s) throw new HttpError(404, 'Servizio delle credenziali sconosciuto');
    return s;
  }

  /** Il servizio della regione dello studio del medico, se il pacchetto della regione lo dà. */
  async function ownRegional(actor: Actor): Promise<Service | null> {
    const region = await studioRegion(db, actor.studioId);
    return regional.find((s) => s.region === region) ?? null;
  }

  /**
   * Il servizio da usare per il medico collegato: il Sistema TS o il servizio della regione del suo
   * studio. Le credenziali di un'altra regione non si usano: si possono solo cancellare (D301).
   */
  async function usable(actor: Actor, slug: string): Promise<Service> {
    const s = bySlug(slug);
    if (s === national) return s;
    if ((await ownRegional(actor)) !== s)
      throw new HttpError(
        422,
        `${label(s)} non è il servizio della regione dello studio: le sue credenziali non si usano, si possono solo cancellare`,
      );
    return s;
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

  /** Il secondo fattore del servizio, o 422 se il servizio non ne ha. */
  function secondFactorOf(s: Service): SecondFactorGateway {
    if (!s.secondFactor)
      throw new HttpError(422, `${label(s)} non ha, nel programma, il codice di sessione`);
    return s.secondFactor;
  }

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
    const own = await ownRegional(actor);
    // Il Sistema TS, il servizio della regione dello studio e quelli di altre regioni dove il
    // medico ha ancora credenziali o una sessione, per poterle cancellare.
    const shown = services.filter(
      (s) =>
        s === national ||
        s === own ||
        creds.some((c) => c.service === s.key) ||
        sessions.some((x) => x.service === s.key),
    );
    return {
      servizi: shown.map((service) => {
        const c = creds.find((r) => r.service === service.key);
        const s = sessions.find((r) => r.service === service.key);
        const inUse = service === national || service === own;
        // Aperta con un altro codice fiscale: non vale (regola 4), come in authFor.
        const active =
          inUse && !!s && s.validUntil > now() && sameFiscalCode(s.subject, fiscalCode);
        return {
          servizio: service.slug,
          nome: label(service),
          uso: service.use,
          /** Il servizio del Sistema TS o della regione dello studio: quello che si usa (D301). */
          inUso: inUse,
          impostate: !!c,
          utente: c?.usernameHint ?? null,
          passwordCambiataIl: c?.passwordChangedOn ?? null,
          scadenzaPassword: c
            ? passwordExpiry(service.passwordValidityMonths, c.passwordChangedOn)
            : null,
          statoPassword: c
            ? passwordState(service.passwordValidityMonths, c.passwordChangedOn, today)
            : null,
          aggiornateIl: c?.updatedAt ?? null,
          secondoFattore: inUse && !!service.secondFactor,
          sessione: {
            attiva: active,
            scadeIl: active ? s.validUntil : null,
            modalita: active ? s.mode : null,
          },
          /** Si entra con SPID o CIE della regione (D109), con la nota del pacchetto. */
          accessoRegionale: inUse && !!service.strongAccess,
          notaAccessoRegionale: inUse && service.strongAccess ? service.strongAccess.note : null,
          ambiente: service.secondFactor?.environment ?? null,
        };
      }),
    };
  }

  async function save(actor: Actor, slug: string, body: unknown) {
    requireDoctor(actor);
    const service = await usable(actor, slug);
    const b = saveBody.parse(body ?? {});
    if (!b.utente && !b.password && !b.pin && !b.passwordCambiataIl)
      throw new HttpError(400, 'Niente da cambiare');
    const [existing] = await db
      .select()
      .from(serviceCredential)
      .where(where(actor.userId, service.key).credential);
    // Con utente, password e PIN insieme si sostituisce tutto, anche una riga illeggibile.
    const full = !!(b.utente && b.password && b.pin);
    const old = existing && !full ? open(key, actor.userId, service.key, existing.secretEnc) : null;
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
        previousUsername = open(key, actor.userId, service.key, existing.secretEnc).username;
      } catch {
        previousUsername = null;
      }
    }
    await storeCredentials(db, deps.encryptionKey, {
      userId: actor.userId,
      service: service.key,
      secret,
      passwordChangedOn: changedOn,
    });
    if (existing && secret.username !== previousUsername)
      await db.delete(serviceSession).where(where(actor.userId, service.key).session);
    const changed = [
      b.utente && 'utente',
      b.password && 'password',
      b.pin && 'PIN',
      b.passwordCambiataIl && 'data del cambio della password',
    ].filter(Boolean);
    await event(actor, service.key, existing ? 'cambiate' : 'impostate', changed.join(', '));
    return status(actor);
  }

  /** Si cancellano anche le credenziali di una regione che non è più quella dello studio. */
  async function remove(actor: Actor, slug: string) {
    requireDoctor(actor);
    const service = bySlug(slug);
    const w = where(actor.userId, service.key);
    await db.delete(serviceSession).where(w.session);
    const gone = await db.delete(serviceCredential).where(w.credential).returning();
    if (gone.length > 0) await event(actor, service.key, 'cancellate');
    return status(actor);
  }

  async function requireSecret(userId: string, service: Service): Promise<Secret> {
    const secret = await loadSecret(userId, service.key);
    if (!secret)
      throw new HttpError(
        422,
        `Mancano le credenziali ${label(service)} del medico: inseriscile in «Credenziali dei servizi»`,
        { codice: 'CREDENZIALI_MANCANTI', servizio: service.slug },
      );
    return secret;
  }

  /**
   * Come il programma si presenta alla regione per questo medico, se la regione lo chiede: il
   * codice della configurazione con il codice ASL dei dati del medico (D266, D301). Senza codice
   * ASL nessun servizio della regione che lo vuole si chiama: il messaggio dice chi lo inserisce e
   * dove.
   */
  async function softwareIdOf(userId: string, service: Service): Promise<string | null> {
    if (!service.software) return null;
    const [p] = await db
      .select({ aslCode: doctorProfile.aslCode })
      .from(doctorProfile)
      .where(eq(doctorProfile.userId, userId));
    const r = service.software.identity.identify(service.software.code, p?.aslCode);
    if (!r.ok)
      throw new HttpError(422, r.message, {
        codice: r.code === 'ASL' ? 'CODICE_ASL_MANCANTE' : 'CODICE_GESTIONALE_NON_VALIDO',
        servizio: service.slug,
      });
    return r.value;
  }

  const withSoftware = (secret: Secret, software: string | null): ServiceAuth =>
    software ? { ...secret, software } : secret;

  /** Chiede l'Id-Sessione: il servizio lo manda all'email certificata del medico. */
  async function requestSession(actor: Actor, slug: string) {
    requireDoctor(actor);
    const service = await usable(actor, slug);
    const gateway = secondFactorOf(service);
    const secret = await requireSecret(actor.userId, service);
    const fiscalCode = await fiscalCodeOf(actor.userId);
    const software = await softwareIdOf(actor.userId, service);
    const r = await gateway.requestCode({ auth: withSoftware(secret, software), fiscalCode });
    if (r.outcome === 'unreachable') {
      await event(actor, service.key, 'codice_non_richiesto', r.message);
      throw new HttpError(502, `${label(service)}: ${r.message}. Riprova tra poco.`);
    }
    if (r.outcome === 'rejected') {
      await event(actor, service.key, 'codice_rifiutato', `${r.code}: ${r.message}`);
      throw new HttpError(
        422,
        `${label(service)} ha rifiutato la richiesta del codice: ${r.message}. Controlla utente, password e PIN.`,
        { codice: 'CREDENZIALI_RIFIUTATE', servizio: service.slug },
      );
    }
    await event(actor, service.key, 'codice_richiesto');
    return {
      inviato: true,
      // Come negli ambienti di prova dei servizi che lo fanno: mai in produzione.
      codiceDiProva: gateway.environment === 'production' ? null : r.testCode,
    };
  }

  /** Il medico inserisce il codice ricevuto: si verifica col servizio e vale fino alla scadenza. */
  async function confirmSession(actor: Actor, slug: string, body: unknown) {
    requireDoctor(actor);
    const service = await usable(actor, slug);
    const gateway = secondFactorOf(service);
    const { codice } = codeBody.parse(body ?? {});
    const secret = await requireSecret(actor.userId, service);
    const fiscalCode = await fiscalCodeOf(actor.userId);
    const software = await softwareIdOf(actor.userId, service);
    const r = await gateway.check({
      auth: withSoftware(secret, software),
      fiscalCode,
      sessionId: codice,
    });
    if (r.outcome === 'unreachable')
      throw new HttpError(502, `${label(service)}: ${r.message}. Riprova tra poco.`);
    if (r.outcome === 'invalid') {
      await event(actor, service.key, 'sessione_rifiutata', r.message);
      throw new HttpError(422, 'Il codice non è valido o è scaduto: chiedine uno nuovo');
    }
    // Il codice fiscale con cui la sessione si è aperta: se nel frattempo l'amministratore lo ha
    // corretto, la sessione non vale (authFor).
    await storeSession(db, deps.encryptionKey, {
      userId: actor.userId,
      service: service.key,
      token: codice,
      validUntil: new Date(r.validUntil),
      subject: fiscalCode,
    });
    await event(actor, service.key, 'sessione_attivata', `fino a ${r.validUntil}`);
    return status(actor);
  }

  async function revokeSession(actor: Actor, slug: string) {
    requireDoctor(actor);
    const service = bySlug(slug);
    const w = where(actor.userId, service.key);
    const [s] = await db.select().from(serviceSession).where(w.session);
    if (!s) return status(actor);
    const token = decryptSecret(
      key,
      s.tokenEnc,
      aad('sessione', actor.userId, service.key),
    ).toString();
    let detail: string | null = null;
    if (s.mode === 'spid_cie') {
      // La revoca ripete il client_id per cui la regione ha dato il token, scritto con la sessione
      // (D301), anche se nel frattempo il codice ASL del medico è cambiato.
      const r =
        service.strongAccess && s.clientId
          ? await service.strongAccess.gateway.revoke({
              clientId: s.clientId,
              fiscalCode: s.subject ?? '',
              accessToken: token,
            })
          : ({
              outcome: 'unreachable',
              message: service.strongAccess
                ? 'sessione senza client_id'
                : 'accesso non disponibile',
            } as const);
      if (r.outcome === 'unreachable') detail = `revoca solo locale: ${r.message}`;
      // Per la regione il token era già scaduto, revocato o ignoto.
      if (r.outcome === 'invalid') detail = 'SPID o CIE: per la Regione era già chiuso';
      await db.delete(serviceSession).where(w.session);
      await event(actor, service.key, 'sessione_revocata', detail ?? 'SPID o CIE');
      return status(actor);
    }
    const secret = await loadSecret(actor.userId, service.key);
    if (secret && service.secondFactor) {
      // Senza codice ASL la revoca resta locale: la sessione si chiude comunque qui.
      const software = await softwareIdOf(actor.userId, service).catch(() => null);
      const r = await service.secondFactor.revoke({
        auth: withSoftware(secret, software),
        fiscalCode: await fiscalCodeOf(actor.userId),
        sessionId: token,
      });
      if (r.outcome === 'unreachable') detail = `revoca solo locale: ${r.message}`;
    }
    await db.delete(serviceSession).where(w.session);
    await event(actor, service.key, 'sessione_revocata', detail);
    return status(actor);
  }

  const stateHash = (state: string) => createHash('sha256').update(state).digest('hex');
  const pkceAad = (userId: string) => Buffer.from(`pkce:${userId}`);

  /** Il servizio della regione dello studio con l'accesso con SPID o CIE, o 404. */
  async function strongAccessOf(actor: Actor, slug: string) {
    const service = bySlug(slug);
    const access = service.strongAccess;
    if (!access || (await ownRegional(actor)) !== service)
      throw new HttpError(404, 'Accesso regionale non disponibile');
    return { service, access };
  }

  /**
   * Avvio dell'accesso con SPID o CIE della regione (D109): state casuale (se ne conserva
   * l'impronta) e code_verifier cifrato; il medico va alla pagina di autorizzazione della regione.
   */
  async function startRegionalAccess(actor: Actor, slug: string) {
    requireDoctor(actor);
    const { service, access } = await strongAccessOf(actor, slug);
    const fiscalCode = await fiscalCodeOf(actor.userId);
    // Il client_id: come il programma si presenta alla regione per questo medico (D266). Una
    // regione con l'accesso con SPID o CIE dice sempre come (prova dei pacchetti).
    const clientId = await softwareIdOf(actor.userId, service);
    if (!clientId) throw new HttpError(404, 'Accesso regionale non disponibile');
    const state = randomBytes(32).toString('base64url');
    const verifier = newPkceVerifier();
    await db.insert(regionalAuthorizationRequest).values({
      userId: actor.userId,
      service: service.key,
      stateHash: stateHash(state),
      verifierEnc: encryptSecret(key, Buffer.from(verifier), pkceAad(actor.userId)),
      redirectUri: access.redirectUri,
      clientId,
      expiresAt: new Date(now().getTime() + REGIONAL_REQUEST_MINUTES * 60_000),
    });
    await event(actor, service.key, 'accesso_regionale_avviato', clientId);
    return {
      indirizzo: access.gateway.authorizeUrl({
        clientId,
        redirectUri: access.redirectUri,
        scope: access.scope,
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
   * Ritorno dalla pagina regionale: lo state deve essere quello di una richiesta di questo medico
   * per questo servizio, non usata e non scaduta; poi scambio del codice con il code_verifier; chi
   * è entrato con SPID o CIE deve essere il medico collegato, con i permessi chiesti.
   */
  async function completeRegionalAccess(
    actor: Actor,
    slug: string,
    query: unknown,
  ): Promise<{ esito: 'ok'; scadeIl: Date } | { esito: 'errore'; motivo: RegionalFailure }> {
    requireDoctor(actor);
    const { service, access } = await strongAccessOf(actor, slug);
    const q = returnQuery.parse(query ?? {});
    const fail = async (motivo: RegionalFailure, detail: string) => {
      await event(actor, service.key, 'accesso_regionale_rifiutato', detail);
      return { esito: 'errore' as const, motivo };
    };
    if (!q.state) return fail('non-riconosciuta', 'ritorno senza state');
    const claimed = await db
      .update(regionalAuthorizationRequest)
      .set({ usedAt: now() })
      .where(
        and(
          eq(regionalAuthorizationRequest.stateHash, stateHash(q.state)),
          eq(regionalAuthorizationRequest.userId, actor.userId),
          eq(regionalAuthorizationRequest.service, service.key),
          isNull(regionalAuthorizationRequest.usedAt),
          gt(regionalAuthorizationRequest.expiresAt, now()),
        ),
      )
      .returning();
    const request = claimed[0];
    if (!request) return fail('non-riconosciuta', 'state sconosciuto, usato o scaduto');
    if (q.error)
      return fail(
        q.error === 'access_denied' ? 'annullato' : 'errore-regione',
        `${q.error}: ${q.error_description ?? ''}`,
      );
    if (!q.code) return fail('senza-codice', 'ritorno senza codice di autorizzazione');
    // Lo stesso client_id della richiesta (D266): una richiesta di prima della migrazione non ce l'ha.
    const clientId = request.clientId;
    if (!clientId) return fail('non-riconosciuta', 'richiesta senza client_id');
    const verifier = decryptSecret(key, request.verifierEnc, pkceAad(actor.userId)).toString();
    const r = await access.gateway.exchange({
      code: q.code,
      redirectUri: request.redirectUri,
      clientId,
      codeVerifier: verifier,
    });
    if (r.outcome === 'unreachable') return fail('non-raggiungibile', r.message);
    if (r.outcome === 'rejected') return fail('token-negato', `${r.error}: ${r.description ?? ''}`);
    const doctor = await fiscalCodeOf(actor.userId);
    if (r.fiscalCode.toUpperCase() !== doctor.toUpperCase()) {
      await access.gateway.revoke({
        clientId,
        fiscalCode: r.fiscalCode,
        accessToken: r.accessToken,
      });
      return fail('identita-diversa', 'identità diversa da quella del medico collegato');
    }
    if (!access.scope.every((s) => r.scope.includes(s)))
      return fail('senza-profilo', 'profilo di prescrizione non concesso dalla Regione');
    // Il token vale per il gestionale che l'ha chiesto e fino alla scadenza scritta nel token.
    if (r.clientId !== clientId)
      return fail('token-negato', `token rilasciato per un altro gestionale (${r.clientId})`);
    const validUntil = new Date(r.validUntil);
    if (!(validUntil.getTime() > now().getTime()))
      return fail('token-negato', `token già scaduto (${r.validUntil})`);
    await storeSession(db, deps.encryptionKey, {
      userId: actor.userId,
      service: service.key,
      token: r.accessToken,
      validUntil,
      mode: 'spid_cie',
      subject: r.fiscalCode,
      clientId,
    });
    await event(
      actor,
      service.key,
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
  async function sessionFor(userId: string, service: Service) {
    const [s] = await db.select().from(serviceSession).where(where(userId, service.key).session);
    if (!s) return null;
    if (sameFiscalCode(s.subject, await profileFiscalCode(db, userId))) return s;
    const gone = await db
      .delete(serviceSession)
      // Solo la sessione letta: una riaperta nel frattempo, con il codice giusto, resta.
      .where(and(where(userId, service.key).session, eq(serviceSession.tokenEnc, s.tokenEnc)))
      .returning({ service: serviceSession.service });
    if (gone.length > 0)
      await event(
        { userId },
        service.key,
        'sessione_chiusa',
        'aperta con un codice fiscale diverso da quello attuale del medico',
      );
    throw new HttpError(
      422,
      `La sessione ${label(service)} era stata aperta con un codice fiscale diverso da quello attuale del medico: è chiusa. Riattivala in «Credenziali dei servizi»`,
      { codice: 'SESSIONE_MANCANTE', servizio: service.slug },
    );
  }

  /**
   * Il servizio delle credenziali di un invio: il Sistema TS per gli invii nazionali; per quelli
   * della regione, quello che dice l'integrazione della regione (`credentialService`, D300, D301).
   */
  function serviceForUse(use: ServiceUse, credentialService?: string): Service {
    if (isNationalUse(use)) return national;
    if (!credentialService)
      throw new Error(`Invio della regione senza il servizio delle credenziali: ${use}`);
    return bySlug(credentialService);
  }

  /**
   * Per gli invii: credenziali e secondo fattore di chi firma. Se mancano, l'invio si ferma prima
   * di contattare il servizio, con un errore che porta alla pagina giusta. Per gli invii della
   * regione `credentialService` è il nome corto del servizio che l'integrazione della regione dice.
   */
  async function authFor(
    userId: string,
    use: ServiceUse,
    credentialService?: string,
  ): Promise<ServiceAuth> {
    const service = serviceForUse(use, credentialService);
    const second = needsSecondFactor(use, service.secondFactorUses);
    const s = second ? await sessionFor(userId, service) : null;
    // Accesso con SPID o CIE: il token sostituisce utente, password, PIN e secondo fattore (D109).
    if (s?.mode === 'spid_cie') {
      if (s.validUntil <= now())
        throw new HttpError(
          422,
          'L’accesso regionale con SPID o CIE è scaduto: entra di nuovo da «Credenziali dei servizi»',
          { codice: 'SESSIONE_SCADUTA', servizio: service.slug },
        );
      const bearer = decryptSecret(
        key,
        s.tokenEnc,
        aad('sessione', userId, service.key),
      ).toString();
      return { bearer, sessionId: null };
    }
    const secret = await requireSecret(userId, service);
    if (!second) return { ...secret, sessionId: null };
    if (!s)
      throw new HttpError(
        422,
        `Serve il codice di sessione ${label(service)} (secondo fattore): attivalo in «Credenziali dei servizi»`,
        { codice: 'SESSIONE_MANCANTE', servizio: service.slug },
      );
    if (s.validUntil <= now())
      throw new HttpError(
        422,
        `Il codice di sessione ${label(service)} è scaduto: chiedine uno nuovo in «Credenziali dei servizi»`,
        { codice: 'SESSIONE_SCADUTA', servizio: service.slug },
      );
    const sessionId = decryptSecret(
      key,
      s.tokenEnc,
      aad('sessione', userId, service.key),
    ).toString();
    // Con l'Id-Sessione per email il programma si presenta, se la regione lo chiede (D266).
    const software = await softwareIdOf(userId, service);
    return { ...secret, sessionId, ...(software ? { software } : {}) };
  }

  /** Il servizio ha rifiutato l'accesso durante un invio: si annota; se è la sessione, si toglie. */
  async function authRefused(
    who: { userId: string; workstation?: string | null },
    use: ServiceUse,
    problem: AuthProblem,
    detail: string,
    credentialService?: string,
  ) {
    const service = serviceForUse(use, credentialService);
    if (problem === 'session')
      await db.delete(serviceSession).where(where(who.userId, service.key).session);
    await event(
      who,
      service.key,
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
