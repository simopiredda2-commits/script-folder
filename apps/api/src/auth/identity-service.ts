import { createHash, randomBytes } from 'node:crypto';
import type { Role } from '@mmg/domain';
import { newPkceVerifier, pkceChallenge, type DigitalIdentityGateway } from '@mmg/integrations';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { logAccess } from '../audit/access-log';
import type { AppEnvironment } from '../config';
import type { Database } from '../db/client';
import { appUser, authChallenge, doctorProfile, identityRequest, session } from '../db/schema';
import { withActor } from '../db/tx';
import { HttpError } from '../http/errors';
import { hashPassword, verifyPassword } from '../security/password';
import { decryptSecret, encryptSecret, hashToken, newToken } from '../security/secrets';
import { forgetSources, reserveAttempt, sourcesOf, sourceWaitMessage } from './login-sources';
import type { LoginSourceLimits } from './login-sources';
import {
  ACCESS_LOCK_TIMEOUT,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  passwordProblem,
  type Actor,
} from './service';

/**
 * Ripristino delle credenziali con SPID o CIE (D181, D189). Medici e segreteria che hanno perso la
 * password, il codice a 6 cifre o sono bloccati entrano con SPID o CIE: se il codice fiscale
 * riconosciuto è quello del loro utente, scelgono una password nuova, e se serve azzerano il
 * secondo fattore. Il codice fiscale dell'utente è quello del profilo del medico (che
 * l'amministratore non cambia senza la conferma del medico, D184) oppure, per la segreteria,
 * l'identità che ha collegato lei stessa, a sessione aperta e con il codice a 6 cifre.
 *
 * Con il simulatore, che riconosce chiunque come chiunque, in produzione il ripristino e il
 * collegamento sono spenti: altrimenti basterebbe scrivere il codice fiscale di un medico.
 */
export interface IdentityDeps {
  db: Database;
  encryptionKey: Buffer;
  gateway: DigitalIdentityGateway;
  /** Codice del programma presso il gestore dell'identità: da completare con l'accreditamento. */
  clientId: string;
  recoveryRedirectUri: string;
  linkRedirectUri: string;
  environment: AppEnvironment;
  now: () => Date;
  loginSources: LoginSourceLimits | null;
  /** Il codice a 6 cifre a sessione aperta (servizio di accesso, `confirmCode`). */
  confirmCode: (actor: Actor, code: string, address: string | null) => Promise<boolean>;
}

/** Validità di una richiesta di accesso con SPID o CIE, come l'accesso regionale (D111). */
export const IDENTITY_REQUEST_MINUTES = 10;

/** Tempo per scegliere la password nuova dopo il riconoscimento. */
export const RECOVERY_MINUTES = 10;

/** Ruoli che ripristinano da sé con SPID o CIE: medici e segreteria (D181). */
const RECOVERY_ROLES: readonly Role[] = ['owner_doctor', 'substitute_doctor', 'secretary'];

export const IDENTITY_UNAVAILABLE =
  'Il ripristino con SPID o CIE non è ancora collegato al servizio vero: rivolgiti a chi gestisce il servizio';

/**
 * Lo stesso messaggio per nome utente sconosciuto, utente che non può ripristinare da sé e
 * identità diversa: chi prova non sa quale dei tre. Il motivo vero va nel registro.
 */
export const RECOVERY_REFUSAL =
  'Con questa identità il ripristino non è possibile: controlla il nome utente, oppure rivolgiti a chi gestisce il servizio';

export const RECOVERY_EXPIRED = 'Ripristino scaduto o già concluso: ricomincia dall’inizio';

const stateHash = (state: string) => createHash('sha256').update(state).digest('hex');
const verifierAad = (purpose: string) => Buffer.from(`identita:${purpose}`);

const startBody = z
  .object({
    nomeUtente: z.string().trim().min(1, 'Nome utente: obbligatorio').max(100),
    postazione: z.string().trim().min(1, 'Postazione: obbligatoria').max(100),
  })
  .strict();

const passwordBody = z
  .object({
    nuovaPassword: z.string().max(1024),
    azzeraSecondoFattore: z.boolean(),
  })
  .strict();

const linkBody = z.object({ codice: z.string().min(1).max(20) }).strict();

const returnQuery = z.object({
  code: z.string().max(2000).optional(),
  state: z.string().max(500).optional(),
  error: z.string().max(200).optional(),
  error_description: z.string().max(1000).optional(),
});

type UserRow = typeof appUser.$inferSelect;

/** Chi può ripristinare da sé: attivo, confermato, non sospeso dal server, medico o segreteria. */
function mayRecover(u: UserRow | undefined): u is UserRow {
  return (
    !!u &&
    u.status === 'active' &&
    !u.awaitingConfirmation &&
    !u.suspendedByService &&
    u.roles.some((r) => RECOVERY_ROLES.includes(r))
  );
}

const sameCode = (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase();

export function createIdentityService(deps: IdentityDeps) {
  const { db, now } = deps;
  /** Il simulatore riconosce chiunque come chiunque: in produzione non vale. */
  const available = () =>
    !(deps.environment === 'produzione' && deps.gateway.environment === 'simulator');
  const requireAvailable = () => {
    if (!available()) throw new HttpError(404, IDENTITY_UNAVAILABLE);
  };

  async function doctorFiscalCode(userId: string): Promise<string | null> {
    const [p] = await db
      .select({ fiscalCode: doctorProfile.fiscalCode })
      .from(doctorProfile)
      .where(eq(doctorProfile.userId, userId));
    return p?.fiscalCode ?? null;
  }

  /** Il codice fiscale con cui l'utente deve entrare: quello del medico, o l'identità collegata. */
  async function expectedFiscalCode(u: UserRow): Promise<string | null> {
    return (await doctorFiscalCode(u.id)) ?? u.identityFiscalCode ?? null;
  }

  async function newRequest(input: {
    purpose: 'recovery' | 'link';
    userId: string | null;
    redirectUri: string;
    workstation: string | null;
    address: string | null;
  }): Promise<string> {
    const state = randomBytes(32).toString('base64url');
    const verifier = newPkceVerifier();
    const t = now();
    await db.insert(identityRequest).values({
      purpose: input.purpose,
      userId: input.userId,
      stateHash: stateHash(state),
      verifierEnc: encryptSecret(
        deps.encryptionKey,
        Buffer.from(verifier),
        verifierAad(input.purpose),
      ),
      redirectUri: input.redirectUri,
      workstation: input.workstation,
      address: input.address,
      createdAt: t,
      expiresAt: new Date(t.getTime() + IDENTITY_REQUEST_MINUTES * 60_000),
    });
    return deps.gateway.authorizeUrl({
      clientId: deps.clientId,
      redirectUri: input.redirectUri,
      state,
      codeChallenge: pkceChallenge(verifier),
    });
  }

  /**
   * Il ritorno da SPID o CIE: lo state di una richiesta di quel tipo (e di quell'utente, per il
   * collegamento), non usata e non scaduta, poi lo scambio del codice. Dice chi è entrato.
   */
  async function identify(
    purpose: 'recovery' | 'link',
    query: unknown,
    userId: string | null,
  ): Promise<
    | {
        ok: true;
        request: typeof identityRequest.$inferSelect;
        fiscalCode: string;
        method: string;
      }
    | {
        ok: false;
        reason: string;
        detail: string;
        request: typeof identityRequest.$inferSelect | null;
      }
  > {
    const q = returnQuery.parse(query ?? {});
    const bad = (reason: string, detail: string, request = null) => ({
      ok: false as const,
      reason,
      detail,
      request,
    });
    if (!q.state) return bad('Ritorno senza state: ricomincia', 'ritorno senza state');
    const [request] = await db
      .update(identityRequest)
      .set({ returnedAt: now() })
      .where(
        and(
          eq(identityRequest.stateHash, stateHash(q.state)),
          eq(identityRequest.purpose, purpose),
          userId ? eq(identityRequest.userId, userId) : undefined,
          isNull(identityRequest.returnedAt),
          gt(identityRequest.expiresAt, now()),
        ),
      )
      .returning();
    if (!request)
      return bad(
        'Richiesta non riconosciuta o scaduta: ricomincia',
        'state sconosciuto, usato o scaduto',
      );
    const fail = (reason: string, detail: string) => ({
      ok: false as const,
      reason,
      detail,
      request,
    });
    if (q.error)
      return fail(
        q.error === 'access_denied'
          ? 'Accesso con SPID o CIE annullato o negato'
          : `Il gestore dell’identità ha risposto con un errore (${q.error})`,
        `${q.error}: ${q.error_description ?? ''}`,
      );
    if (!q.code) return fail('Ritorno senza codice: ricomincia', 'ritorno senza codice');
    const verifier = decryptSecret(
      deps.encryptionKey,
      request.verifierEnc,
      verifierAad(purpose),
    ).toString();
    const r = await deps.gateway.exchange({
      code: q.code,
      redirectUri: request.redirectUri,
      clientId: deps.clientId,
      codeVerifier: verifier,
    });
    if (r.outcome === 'unreachable')
      return fail(`Gestore dell’identità non raggiungibile: ${r.message}`, r.message);
    if (r.outcome === 'rejected')
      return fail(
        `Il gestore dell’identità non ha riconosciuto l’accesso (${r.error})`,
        `${r.error}: ${r.description ?? ''}`,
      );
    return { ok: true, request, fiscalCode: r.fiscalCode.toUpperCase(), method: r.method };
  }

  const sourcesFor = (address: string | null, workstation: string | null) =>
    deps.loginSources && workstation ? sourcesOf(address, workstation, deps.loginSources) : [];

  return {
    available,

    /**
     * Avvio del ripristino: il nome utente e la postazione, poi la pagina di SPID o CIE. La
     * risposta è la stessa per ogni nome: chi prova non sa se l'utente c'è. Ogni avvio conta come
     * un tentativo sulla sua provenienza, come le password sbagliate (D188), finché il ripristino
     * non si conclude.
     */
    async startRecovery(body: unknown, address: string | null) {
      requireAvailable();
      const b = startBody.parse(body);
      const limits = deps.loginSources;
      const sources = sourcesFor(address, b.postazione);
      if (limits) {
        const reserved = await reserveAttempt(db, sources, now(), limits, ACCESS_LOCK_TIMEOUT);
        if (!reserved.ok)
          throw new HttpError(429, sourceWaitMessage(reserved.kind, reserved.wait), {
            attesaSecondi: reserved.wait,
          });
      }
      const [user] = await db
        .select()
        .from(appUser)
        .where(eq(appUser.username, b.nomeUtente.toLowerCase()));
      const allowed = mayRecover(user);
      const indirizzo = await newRequest({
        purpose: 'recovery',
        userId: allowed ? user.id : null,
        redirectUri: deps.recoveryRedirectUri,
        workstation: b.postazione,
        address,
      });
      await logAccess(db, {
        studioId: user?.studioId,
        userId: user?.id,
        action: 'ripristino_avviato',
        outcome: allowed ? 'consentito' : 'negato',
        workstation: b.postazione,
        details: {
          indirizzo: address,
          ...(allowed
            ? {}
            : { motivo: user ? 'utente che non ripristina da sé' : 'utente sconosciuto' }),
        },
      });
      return { indirizzo };
    },

    /**
     * Ritorno da SPID o CIE per il ripristino: la persona riconosciuta deve avere il codice fiscale
     * dell'utente, che deve poter ancora ripristinare da sé. Riuscito, restituisce il passaggio
     * con cui scegliere la password nuova (va in un cookie, mai nell'indirizzo).
     */
    async completeRecovery(
      query: unknown,
    ): Promise<{ esito: 'ok'; passaggio: string } | { esito: 'errore'; motivo: string }> {
      if (!available()) return { esito: 'errore', motivo: IDENTITY_UNAVAILABLE };
      const id = await identify('recovery', query, null);
      const refuse = async (
        motivo: string,
        detail: string,
        request: typeof identityRequest.$inferSelect | null,
        user?: UserRow,
      ) => {
        await logAccess(db, {
          studioId: user?.studioId,
          userId: user?.id ?? request?.userId,
          action: 'ripristino_rifiutato',
          outcome: 'negato',
          workstation: request?.workstation,
          details: { motivo: detail, indirizzo: request?.address ?? null },
        });
        return { esito: 'errore' as const, motivo };
      };
      if (!id.ok) return refuse(id.reason, id.detail, id.request);
      const { request } = id;
      if (!request.userId) return refuse(RECOVERY_REFUSAL, 'utente sconosciuto o escluso', request);
      const [user] = await db.select().from(appUser).where(eq(appUser.id, request.userId));
      if (!mayRecover(user))
        return refuse(RECOVERY_REFUSAL, 'utente che non ripristina più da sé', request, user);
      const expected = await expectedFiscalCode(user);
      if (!expected)
        return refuse(
          RECOVERY_REFUSAL,
          'nessun codice fiscale per il ripristino (identità non collegata)',
          request,
          user,
        );
      if (!sameCode(expected, id.fiscalCode))
        return refuse(RECOVERY_REFUSAL, 'identità diversa da quella dell’utente', request, user);
      const { token, hash } = newToken();
      await db
        .update(identityRequest)
        .set({
          recoveryTokenHash: hash,
          recoveryUntil: new Date(now().getTime() + RECOVERY_MINUTES * 60_000),
          method: id.method,
        })
        .where(eq(identityRequest.id, request.id));
      await logAccess(db, {
        studioId: user.studioId,
        userId: user.id,
        action: 'ripristino_riconosciuto',
        outcome: 'riuscito',
        workstation: request.workstation,
        details: { metodo: id.method, indirizzo: request.address },
      });
      return { esito: 'ok', passaggio: token };
    },

    /** Il ripristino in corso: chi, che cosa c'è da fare, fino a quando. */
    async recoveryState(token: string | undefined) {
      const found = await openRecovery(token);
      const { user, request } = found;
      return {
        nome: user.displayName,
        nomeUtente: user.username,
        metodo: request.method,
        secondoFattoreAttivo: user.totpEnabledAt !== null,
        bloccatoFinoA:
          user.lockedUntil && user.lockedUntil > now() ? user.lockedUntil.toISOString() : null,
        scadenza: request.recoveryUntil!.toISOString(),
        lunghezzaMinima: PASSWORD_MIN_LENGTH,
        lunghezzaMassima: PASSWORD_MAX_LENGTH,
      };
    },

    /**
     * La password nuova: si controlla prima di consumare il passaggio (una password troppo corta
     * non fa ricominciare da SPID). Poi, in una transazione, il passaggio si consuma una volta
     * sola, l'utente si rilegge sotto il blocco della sua riga, la password cambia, i contatori e
     * il blocco si azzerano, il secondo fattore se chiesto, tutte le sessioni si chiudono.
     */
    async finishRecovery(token: string | undefined, body: unknown) {
      const b = passwordBody.parse(body);
      const { user, request } = await openRecovery(token);
      const problem = passwordProblem(b.nuovaPassword, { username: user.username, current: '' });
      if (problem) throw new HttpError(400, problem);
      if (await verifyPassword(b.nuovaPassword, user.passwordHash))
        throw new HttpError(400, 'La nuova password deve essere diversa da quella di prima');
      const passwordHash = await hashPassword(b.nuovaPassword);
      const t = now();
      const out = await withActor(db, user.id, async (tx) => {
        const [claimed] = await tx
          .update(identityRequest)
          .set({ completedAt: t })
          .where(
            and(
              eq(identityRequest.id, request.id),
              isNull(identityRequest.completedAt),
              gt(identityRequest.recoveryUntil, t),
            ),
          )
          .returning({ id: identityRequest.id });
        if (!claimed) return null;
        const [fresh] = await tx
          .select()
          .from(appUser)
          .where(eq(appUser.id, user.id))
          .for('no key update');
        if (!mayRecover(fresh)) return null;
        await tx
          .update(appUser)
          .set({
            passwordHash,
            passwordChangedAt: t,
            mustChangePassword: false,
            failedLogins: 0,
            failedCodes: 0,
            lockedUntil: null,
            ...(b.azzeraSecondoFattore
              ? { totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null }
              : {}),
          })
          .where(eq(appUser.id, user.id));
        const closed = await tx
          .update(session)
          .set({ revokedAt: t })
          .where(and(eq(session.userId, user.id), isNull(session.revokedAt)))
          .returning({ id: session.id });
        await tx
          .update(authChallenge)
          .set({ usedAt: t })
          .where(and(eq(authChallenge.userId, user.id), isNull(authChallenge.usedAt)));
        const campi = ['password', 'blocco', ...(b.azzeraSecondoFattore ? ['secondoFattore'] : [])];
        await logAccess(tx, {
          studioId: user.studioId,
          userId: user.id,
          action: 'ripristino_credenziali',
          outcome: 'riuscito',
          workstation: request.workstation,
          details: { metodo: request.method, campi, sessioniChiuse: closed.length },
        });
        // Nel registro di amministrazione, come i ripristini dal server: chi, come, che cosa.
        await logAccess(tx, {
          studioId: user.studioId,
          userId: user.id,
          action: 'amministrazione',
          outcome: 'riuscito',
          workstation: request.workstation,
          details: {
            area: 'utenti',
            azione: 'ripristino',
            tramite: 'SPID o CIE',
            utente: user.username,
            utenteId: user.id,
            ruoliPrima: user.roles,
            ruoliDopo: user.roles,
            campi,
            sessioniChiuse: closed.length,
          },
        });
        return { sessioniChiuse: closed.length };
      });
      if (!out) throw new HttpError(401, RECOVERY_EXPIRED);
      // Concluso: la provenienza dell'avvio ricomincia da capo (D188).
      if (deps.loginSources)
        await forgetSources(
          db,
          sourcesFor(request.address, request.workstation),
          now(),
          deps.loginSources,
        );
      return {
        stato: 'ok',
        secondoFattoreAzzerato: b.azzeraSecondoFattore,
        sessioniChiuse: out.sessioniChiuse,
      };
    },

    /** L'identità collegata dell'utente, e se gli serve. */
    async linkState(actor: Actor) {
      const [u] = await db.select().from(appUser).where(eq(appUser.id, actor.userId));
      const doctor = await doctorFiscalCode(actor.userId);
      return {
        disponibile: available(),
        // Per il medico vale il codice fiscale del suo profilo: non collega nulla.
        perIlMedico: doctor !== null,
        puoRipristinare: mayRecover(u),
        collegata: !!u?.identityFiscalCode,
        codiceFiscale: u?.identityFiscalCode ?? null,
        collegataIl: u?.identityLinkedAt?.toISOString() ?? null,
      };
    },

    /**
     * Avvio del collegamento: solo per chi ripristina da sé e non ha il codice fiscale di medico,
     * con il codice a 6 cifre di adesso (chi usa una sessione lasciata aperta non lo ha).
     */
    async startLink(actor: Actor, body: unknown, address: string | null) {
      requireAvailable();
      const b = linkBody.parse(body);
      const [u] = await db.select().from(appUser).where(eq(appUser.id, actor.userId));
      if (!mayRecover(u))
        throw new HttpError(
          403,
          'L’identità digitale serve a chi lavora con i dati dei pazienti: gli amministratori ripristinano le credenziali da un altro amministratore',
        );
      if (await doctorFiscalCode(actor.userId))
        throw new HttpError(
          409,
          'Per il medico il ripristino usa il codice fiscale del suo profilo: non serve collegare nulla',
        );
      if (!(await deps.confirmCode(actor, b.codice, address)))
        throw new HttpError(401, 'Codice non valido');
      return {
        indirizzo: await newRequest({
          purpose: 'link',
          userId: actor.userId,
          redirectUri: deps.linkRedirectUri,
          workstation: actor.workstation,
          address,
        }),
      };
    },

    /** Ritorno da SPID o CIE per il collegamento: il codice fiscale riconosciuto si collega. */
    async completeLink(
      actor: Actor,
      query: unknown,
    ): Promise<{ esito: 'ok' } | { esito: 'errore'; motivo: string }> {
      if (!available()) return { esito: 'errore', motivo: IDENTITY_UNAVAILABLE };
      const id = await identify('link', query, actor.userId);
      if (!id.ok) return { esito: 'errore', motivo: id.reason };
      const t = now();
      await withActor(db, actor.userId, async (tx) => {
        await tx
          .update(appUser)
          .set({ identityFiscalCode: id.fiscalCode, identityLinkedAt: t })
          .where(eq(appUser.id, actor.userId));
        await logAccess(tx, {
          studioId: actor.studioId,
          userId: actor.userId,
          action: 'amministrazione',
          outcome: 'riuscito',
          workstation: actor.workstation,
          details: {
            area: 'utenti',
            azione: 'identita_collegata',
            tramite: 'SPID o CIE',
            utente: (
              await tx
                .select({ username: appUser.username })
                .from(appUser)
                .where(eq(appUser.id, actor.userId))
            )[0]!.username,
            utenteId: actor.userId,
            campi: ['identitaDigitale'],
          },
        });
      });
      return { esito: 'ok' };
    },

    /** Scollega l'identità: il ripristino da sé non vale più finché non si ricollega. */
    async unlink(actor: Actor) {
      const [u] = await db.select().from(appUser).where(eq(appUser.id, actor.userId));
      if (!u?.identityFiscalCode) throw new HttpError(409, 'Nessuna identità collegata');
      await withActor(db, actor.userId, async (tx) => {
        await tx
          .update(appUser)
          .set({ identityFiscalCode: null, identityLinkedAt: null })
          .where(eq(appUser.id, actor.userId));
        await logAccess(tx, {
          studioId: actor.studioId,
          userId: actor.userId,
          action: 'amministrazione',
          outcome: 'riuscito',
          workstation: actor.workstation,
          details: {
            area: 'utenti',
            azione: 'identita_scollegata',
            utente: u.username,
            utenteId: actor.userId,
            campi: ['identitaDigitale'],
          },
        });
      });
      return { stato: 'ok' };
    },
  };

  /** Il ripristino aperto dal passaggio: riconosciuto, non concluso, non scaduto. */
  async function openRecovery(token: string | undefined) {
    if (!token) throw new HttpError(401, RECOVERY_EXPIRED);
    const [request] = await db
      .select()
      .from(identityRequest)
      .where(
        and(
          eq(identityRequest.recoveryTokenHash, hashToken(token)),
          eq(identityRequest.purpose, 'recovery'),
          isNull(identityRequest.completedAt),
          gt(identityRequest.recoveryUntil, now()),
        ),
      );
    if (!request?.userId) throw new HttpError(401, RECOVERY_EXPIRED);
    const [user] = await db.select().from(appUser).where(eq(appUser.id, request.userId));
    if (!mayRecover(user)) throw new HttpError(401, RECOVERY_EXPIRED);
    return { request, user };
  }
}

export type IdentityService = ReturnType<typeof createIdentityService>;
