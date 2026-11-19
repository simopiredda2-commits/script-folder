import type { Role } from '@mmg/domain';
import { and, eq, gt, isNull, ne, sql } from 'drizzle-orm';
import { logAccess } from '../audit/access-log';
import type { Database } from '../db/client';
import { appUser, authChallenge, session, studio } from '../db/schema';
import { withActor, type Tx } from '../db/tx';
import { hashPassword, verifyPassword } from '../security/password';
import { decryptSecret, encryptSecret, hashToken, newToken } from '../security/secrets';
import { newTotpSecret, otpauthUri, verifyTotp } from '../security/totp';

/**
 * Accesso: nome utente e password, poi il secondo fattore (TOTP), obbligatorio per tutti come
 * chiedono i requisiti («autenticazione a due fattori per tutti»). Al primo accesso il secondo
 * fattore si attiva. SPID e CIE arriveranno più avanti.
 */
export interface AuthDeps {
  db: Database;
  encryptionKey: Buffer;
  sessionMaxHours: number;
  /** Nome mostrato nell'app di autenticazione: il nome del prodotto. */
  issuer: string;
  now?: () => Date;
}

/** Durata del passo intermedio fra password e secondo fattore (decisione D19). */
export const CHALLENGE_MINUTES = 5;

/**
 * Codici sbagliati dopo cui il passaggio si chiude, se lo studio non ha fissato i tentativi: il
 * valore per difetto della soglia (D29). Con la soglia dello studio vale quella.
 */
export const CHALLENGE_DEFAULT_WRONG_CODES = 5;

/**
 * Durata massima del blocco per tentativi falliti, in minuti: limite di buon senso, non di una
 * norma. Dopo la revisione dei poteri dell'amministratore (tappa 14): con un blocco lungo chi
 * conosce il nome utente terrebbe fuori un medico per ore. Vale anche per i valori già salvati.
 */
export const FAILED_LOGIN_LOCK_MAX_MINUTES = 60;

export const GENERIC_LOGIN_ERROR = 'Nome utente o password non validi';

/** Utente bloccato per troppi tentativi falliti: all'accesso e sul passaggio del codice. */
export const LOCKED_LOGIN_ERROR = 'Troppi tentativi falliti: accesso bloccato per qualche minuto';

export const EXPIRED_CHALLENGE_ERROR = 'Passaggio scaduto: ripeti l’accesso';

/** Passaggio chiuso dopo i codici sbagliati ammessi dallo studio. */
export const TOO_MANY_CODES_ERROR = 'Troppi codici sbagliati: ripeti l’accesso';

/**
 * Utente con un ruolo che apre dati dei pazienti, creato o cambiato dall'amministratore, non
 * ancora confermato da un medico titolare (tappa 14). Si dice solo dopo la password giusta: con
 * quella sbagliata il messaggio resta quello generico.
 */
export const AWAITING_CONFIRMATION_ERROR =
  'In attesa della conferma di un medico titolare dello studio';

export interface Actor {
  userId: string;
  studioId: string;
  roles: Role[];
  displayName: string;
  sessionId: string;
  workstation: string;
  /**
   * Password temporanea data dall'amministratore (tappa 14): finché non la cambia, l'utente può
   * solo sapere chi è, cambiarla e uscire.
   */
  mustChangePassword: boolean;
}

/**
 * Regole della password scelta dall'utente (tappa 14). I requisiti e le decisioni non ne fissano:
 * una lunghezza minima di buon senso, con il secondo fattore sempre obbligatorio, e nessuna regola
 * su maiuscole, cifre o simboli. La lunghezza massima evita a scrypt testi enormi.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

/** Che cosa non va nella password nuova, o null. Le lunghezze si contano in caratteri. */
export function passwordProblem(
  next: string,
  ctx: { username: string; current: string },
): string | null {
  const length = [...next.normalize('NFC')].length;
  if (length < PASSWORD_MIN_LENGTH)
    return `La nuova password deve avere almeno ${PASSWORD_MIN_LENGTH} caratteri`;
  if (length > PASSWORD_MAX_LENGTH)
    return `La nuova password può avere al massimo ${PASSWORD_MAX_LENGTH} caratteri`;
  if (next.normalize('NFC') === ctx.current.normalize('NFC'))
    return 'La nuova password deve essere diversa da quella attuale';
  if (next.trim().toLowerCase() === ctx.username.trim().toLowerCase())
    return 'La password non può essere il nome utente';
  return null;
}

export const MUST_CHANGE_PASSWORD_ERROR = 'Cambia la password temporanea prima di continuare';

/**
 * Le sole rotte con la sessione aperte a chi deve ancora cambiare la password temporanea; l'uscita
 * è pubblica e resta sempre possibile.
 */
const BEFORE_PASSWORD_CHANGE = new Set([
  'GET /api/io',
  'GET /api/profilo/password',
  'POST /api/profilo/password',
]);

export function allowedBeforePasswordChange(method: string, url: string | undefined): boolean {
  return BEFORE_PASSWORD_CHANGE.has(`${method} ${url ?? ''}`);
}

export type ChangePasswordResult =
  { ok: true; otherSessionsClosed: number } | { ok: false; status: 400 | 429; message: string };

export type LoginResult =
  | { ok: false; message: string }
  | { ok: true; step: 'second_factor'; challengeToken: string }
  | { ok: true; step: 'enroll'; challengeToken: string; otpauthUri: string; secret: string };

export type SessionResult =
  { ok: false; message: string } | { ok: true; sessionToken: string; expiresAt: Date };

export type AuthenticateResult =
  { status: 'ok'; actor: Actor } | { status: 'locked'; actor: Actor } | { status: 'invalid' };

const minutes = (n: number) => n * 60_000;

export function createAuthService(deps: AuthDeps) {
  const { db, encryptionKey } = deps;
  const now = deps.now ?? (() => new Date());

  async function loadUser(username: string) {
    const rows = await db
      .select({ user: appUser, studio })
      .from(appUser)
      .innerJoin(studio, eq(studio.id, appUser.studioId))
      .where(eq(appUser.username, username.trim().toLowerCase()));
    return rows[0];
  }

  /**
   * Conta un tentativo fallito e, se lo studio ha fissato le soglie, blocca l'utente: dice se
   * l'ha bloccato adesso. Il blocco non supera mai FAILED_LOGIN_LOCK_MAX_MINUTES, anche con un
   * valore più alto salvato prima del limite.
   */
  async function registerFailure(
    user: typeof appUser.$inferSelect,
    st: typeof studio.$inferSelect,
  ): Promise<boolean> {
    const failed = user.failedLogins + 1;
    const lock =
      st.maxFailedLogins != null &&
      st.failedLoginLockMinutes != null &&
      failed >= st.maxFailedLogins;
    const lockMinutes = Math.min(st.failedLoginLockMinutes ?? 0, FAILED_LOGIN_LOCK_MAX_MINUTES);
    await db
      .update(appUser)
      .set({
        failedLogins: lock ? 0 : failed,
        lockedUntil: lock ? new Date(now().getTime() + minutes(lockMinutes)) : user.lockedUntil,
      })
      .where(eq(appUser.id, user.id));
    return lock;
  }

  /** Chiude il passaggio, se è ancora aperto. */
  const closeChallenge = (q: Database | Tx, id: string) =>
    q
      .update(authChallenge)
      .set({ usedAt: now() })
      .where(and(eq(authChallenge.id, id), isNull(authChallenge.usedAt)));

  /**
   * Un codice sbagliato in più sul passaggio, in un solo comando: arrivato ai tentativi dello
   * studio (o al valore per difetto) il passaggio si chiude. Dice se ora è chiuso, anche da altri.
   */
  async function countWrongCode(id: string, max: number): Promise<boolean> {
    const at = now().toISOString();
    const [row] = await db
      .update(authChallenge)
      .set({
        failedCodes: sql`${authChallenge.failedCodes} + 1`,
        usedAt: sql`case when ${authChallenge.failedCodes} + 1 >= ${max} then ${at}::timestamptz else ${authChallenge.usedAt} end`,
      })
      .where(and(eq(authChallenge.id, id), isNull(authChallenge.usedAt)))
      .returning({ usedAt: authChallenge.usedAt });
    return !row || row.usedAt !== null;
  }

  async function createChallenge(
    userId: string,
    purpose: 'second_factor' | 'enroll',
    workstation: string,
    pendingSecretEnc: Buffer | null,
  ): Promise<string> {
    const { token, hash } = newToken();
    await db.insert(authChallenge).values({
      userId,
      tokenHash: hash,
      purpose,
      workstation,
      pendingSecretEnc,
      expiresAt: new Date(now().getTime() + minutes(CHALLENGE_MINUTES)),
    });
    return token;
  }

  /**
   * Accesso con nome utente e password. Ogni tentativo fallito va nel registro con la postazione
   * scritta da chi accede e l'indirizzo della richiesta, che chi accede non sceglie (tappa 14).
   */
  async function login(input: {
    username: string;
    password: string;
    workstation: string;
    /** Indirizzo della richiesta (`req.ip`). */
    address?: string | null;
  }): Promise<LoginResult> {
    const found = await loadUser(input.username);
    const fail = async (reason: string, user?: typeof appUser.$inferSelect) => {
      await logAccess(db, {
        studioId: user?.studioId,
        userId: user?.id,
        action: 'accesso_fallito',
        outcome: 'fallito',
        workstation: input.workstation,
        details: { motivo: reason, indirizzo: input.address ?? null },
      });
      return { ok: false as const, message: GENERIC_LOGIN_ERROR };
    };
    if (!found) return fail('utente sconosciuto');
    const { user, studio: st } = found;
    if (user.status !== 'active') return fail('utente sospeso', user);
    if (user.lockedUntil && user.lockedUntil > now()) {
      await fail('utente bloccato per troppi tentativi', user);
      return { ok: false, message: LOCKED_LOGIN_ERROR };
    }
    if (!(await verifyPassword(input.password, user.passwordHash))) {
      await registerFailure(user, st);
      return fail('password errata', user);
    }
    // Password giusta, ma nessun passaggio successivo finché un titolare non conferma (tappa 14).
    if (user.awaitingConfirmation) {
      await fail('in attesa della conferma di un medico titolare', user);
      return { ok: false, message: AWAITING_CONFIRMATION_ERROR };
    }

    if (user.totpSecretEnc && user.totpEnabledAt) {
      const challengeToken = await createChallenge(
        user.id,
        'second_factor',
        input.workstation,
        null,
      );
      return { ok: true, step: 'second_factor', challengeToken };
    }
    const secret = newTotpSecret();
    const challengeToken = await createChallenge(
      user.id,
      'enroll',
      input.workstation,
      encryptSecret(encryptionKey, secret),
    );
    const uri = otpauthUri(secret, user.username, deps.issuer);
    return {
      ok: true,
      step: 'enroll',
      challengeToken,
      otpauthUri: uri,
      secret: new URL(uri).searchParams.get('secret')!,
    };
  }

  /**
   * Secondo passo: codice TOTP. Con `enroll` attiva anche il secondo fattore. Dopo la revisione dei
   * poteri dell'amministratore (tappa 14): un utente bloccato non entra nemmeno su un passaggio già
   * aperto; il passaggio si chiude dopo i codici sbagliati ammessi dallo studio; con il codice
   * giusto il passaggio si consuma una volta sola e l'utente si rilegge, sotto blocco, nella stessa
   * transazione che apre la sessione.
   */
  async function verifySecondFactor(input: {
    challengeToken: string;
    code: string;
    /** Indirizzo della richiesta (`req.ip`). */
    address?: string | null;
  }): Promise<SessionResult> {
    const rows = await db
      .select({ challenge: authChallenge, user: appUser, studio })
      .from(authChallenge)
      .innerJoin(appUser, eq(appUser.id, authChallenge.userId))
      .innerJoin(studio, eq(studio.id, appUser.studioId))
      .where(
        and(
          eq(authChallenge.tokenHash, hashToken(input.challengeToken)),
          isNull(authChallenge.usedAt),
          gt(authChallenge.expiresAt, now()),
        ),
      );
    const row = rows[0];
    if (!row) return { ok: false, message: EXPIRED_CHALLENGE_ERROR };
    const { challenge, user, studio: st } = row;
    // Sospeso o messo in attesa di conferma a metà accesso: il passaggio non vale più (tappa 14).
    if (user.status !== 'active' || user.awaitingConfirmation)
      return { ok: false, message: EXPIRED_CHALLENGE_ERROR };
    const failure = (q: Database | Tx, details: Record<string, unknown>) =>
      logAccess(q, {
        studioId: user.studioId,
        userId: user.id,
        action: 'secondo_fattore_fallito',
        outcome: 'fallito',
        workstation: challenge.workstation,
        details: { ...details, indirizzo: input.address ?? null },
      });
    // Bloccato per troppi tentativi: nessun codice vale, e il passaggio si chiude.
    if (user.lockedUntil && user.lockedUntil > now()) {
      await closeChallenge(db, challenge.id);
      await failure(db, { motivo: 'utente bloccato per troppi tentativi' });
      return { ok: false, message: LOCKED_LOGIN_ERROR };
    }

    const secretEnc =
      challenge.purpose === 'enroll' ? challenge.pendingSecretEnc : user.totpSecretEnc;
    if (!secretEnc) return { ok: false, message: 'Secondo fattore non disponibile' };
    const secret = decryptSecret(encryptionKey, secretEnc);
    const step = verifyTotp(
      secret,
      input.code.trim(),
      now().getTime(),
      challenge.purpose === 'enroll' ? null : (user.totpLastStep ?? null),
    );
    // Codice sbagliato: conta per l'utente e per il passaggio, che si chiude ai tentativi dello
    // studio.
    const wrongCode = async (): Promise<SessionResult> => {
      const locked = await registerFailure(user, st);
      const closed = await countWrongCode(
        challenge.id,
        st.maxFailedLogins ?? CHALLENGE_DEFAULT_WRONG_CODES,
      );
      await failure(db, { motivo: 'codice errato', ...(closed ? { passaggioChiuso: true } : {}) });
      if (locked) return { ok: false, message: LOCKED_LOGIN_ERROR };
      return { ok: false, message: closed ? TOO_MANY_CODES_ERROR : 'Codice non valido' };
    };
    if (step === null) return wrongCode();

    const { token, hash } = newToken();
    const expiresAt = new Date(now().getTime() + deps.sessionMaxHours * 3_600_000);
    const done = await db.transaction(async (tx): Promise<SessionResult | 'ripetuto'> => {
      // L'utente com'è adesso, bloccato fino alla fine: una sospensione, un'attesa o un blocco
      // arrivati dopo la prima lettura fermano la sessione.
      const [fresh] = await tx
        .select({
          status: appUser.status,
          awaitingConfirmation: appUser.awaitingConfirmation,
          lockedUntil: appUser.lockedUntil,
          totpLastStep: appUser.totpLastStep,
        })
        .from(appUser)
        .where(eq(appUser.id, user.id))
        .for('no key update');
      if (!fresh || fresh.status !== 'active' || fresh.awaitingConfirmation) {
        await closeChallenge(tx, challenge.id);
        return { ok: false, message: EXPIRED_CHALLENGE_ERROR };
      }
      if (fresh.lockedUntil && fresh.lockedUntil > now()) {
        await closeChallenge(tx, challenge.id);
        await failure(tx, { motivo: 'utente bloccato per troppi tentativi' });
        return { ok: false, message: LOCKED_LOGIN_ERROR };
      }
      // Lo stesso codice usato nel frattempo su un altro passaggio non vale una seconda volta:
      // conta come un codice sbagliato, come quando arriva dopo.
      if (
        challenge.purpose !== 'enroll' &&
        fresh.totpLastStep != null &&
        step <= fresh.totpLastStep
      )
        return 'ripetuto';
      // Il passaggio si consuma una volta sola: se un'altra richiesta l'ha già usato o chiuso,
      // qui ci si ferma.
      const used = await tx
        .update(authChallenge)
        .set({ usedAt: now() })
        .where(and(eq(authChallenge.id, challenge.id), isNull(authChallenge.usedAt)))
        .returning({ id: authChallenge.id });
      if (used.length === 0) return { ok: false, message: EXPIRED_CHALLENGE_ERROR };
      await tx
        .update(appUser)
        .set({
          failedLogins: 0,
          lockedUntil: null,
          totpLastStep: step,
          ...(challenge.purpose === 'enroll'
            ? { totpSecretEnc: secretEnc, totpEnabledAt: now() }
            : {}),
        })
        .where(eq(appUser.id, user.id));
      await tx.insert(session).values({
        userId: user.id,
        tokenHash: hash,
        workstation: challenge.workstation,
        createdAt: now(),
        lastActivityAt: now(),
        expiresAt,
      });
      if (challenge.purpose === 'enroll') {
        await logAccess(tx, {
          studioId: user.studioId,
          userId: user.id,
          action: 'secondo_fattore_attivato',
          outcome: 'riuscito',
          workstation: challenge.workstation,
        });
      }
      await logAccess(tx, {
        studioId: user.studioId,
        userId: user.id,
        action: 'accesso',
        outcome: 'riuscito',
        workstation: challenge.workstation,
      });
      return { ok: true, sessionToken: token, expiresAt };
    });
    return done === 'ripetuto' ? wrongCode() : done;
  }

  async function loadSession(sessionToken: string) {
    const rows = await db
      .select({ session, user: appUser, studio })
      .from(session)
      .innerJoin(appUser, eq(appUser.id, session.userId))
      .innerJoin(studio, eq(studio.id, appUser.studioId))
      .where(eq(session.tokenHash, hashToken(sessionToken)));
    return rows[0];
  }

  /**
   * Riconosce la sessione. Dopo `idleLockMinutes` di inattività (impostazione dello studio,
   * da completare) la sessione si blocca: serve la password per sbloccarla.
   */
  async function authenticate(sessionToken: string): Promise<AuthenticateResult> {
    const row = await loadSession(sessionToken);
    if (!row) return { status: 'invalid' };
    const { session: s, user, studio: st } = row;
    const t = now();
    if (s.revokedAt || s.expiresAt <= t || user.status !== 'active' || user.awaitingConfirmation)
      return { status: 'invalid' };
    const actor: Actor = {
      userId: user.id,
      studioId: user.studioId,
      roles: user.roles,
      displayName: user.displayName,
      sessionId: s.id,
      workstation: s.workstation,
      mustChangePassword: user.mustChangePassword,
    };
    if (s.lockedAt) return { status: 'locked', actor };
    const idle = st.idleLockMinutes;
    if (idle != null && t.getTime() - s.lastActivityAt.getTime() > minutes(idle)) {
      await db.update(session).set({ lockedAt: t }).where(eq(session.id, s.id));
      await logAccess(db, {
        studioId: user.studioId,
        userId: user.id,
        action: 'sessione_bloccata',
        outcome: 'riuscito',
        workstation: s.workstation,
        details: { minuti_di_inattivita: idle },
      });
      return { status: 'locked', actor };
    }
    await db.update(session).set({ lastActivityAt: t }).where(eq(session.id, s.id));
    return { status: 'ok', actor };
  }

  /**
   * Sblocco della sessione dopo l'inattività: con il codice a 6 cifre dell'app di
   * autenticazione (scelta di Simone alla prima fermata, D31). Lo stesso codice non vale due
   * volte; i codici sbagliati contano come tentativi falliti.
   */
  async function unlock(
    sessionToken: string,
    code: string,
    /** Indirizzo della richiesta (`req.ip`), per il registro dei codici sbagliati. */
    address: string | null = null,
  ): Promise<boolean> {
    const row = await loadSession(sessionToken);
    if (!row || row.session.revokedAt || row.session.expiresAt <= now()) return false;
    const { user, studio: st } = row;
    if (user.status !== 'active' || user.awaitingConfirmation) return false;
    if (user.lockedUntil && user.lockedUntil > now()) return false;
    const step =
      user.totpSecretEnc && user.totpEnabledAt
        ? verifyTotp(
            decryptSecret(encryptionKey, user.totpSecretEnc),
            code.trim(),
            now().getTime(),
            user.totpLastStep ?? null,
          )
        : null;
    if (step === null) {
      await registerFailure(user, st);
      await logAccess(db, {
        studioId: user.studioId,
        userId: user.id,
        action: 'secondo_fattore_fallito',
        outcome: 'fallito',
        workstation: row.session.workstation,
        details: { motivo: 'codice errato allo sblocco', indirizzo: address },
      });
      return false;
    }
    await db.transaction(async (tx) => {
      await tx
        .update(appUser)
        .set({ totpLastStep: step, failedLogins: 0 })
        .where(eq(appUser.id, user.id));
      await tx
        .update(session)
        .set({ lockedAt: null, lastActivityAt: now() })
        .where(eq(session.id, row.session.id));
      await logAccess(tx, {
        studioId: user.studioId,
        userId: user.id,
        action: 'sessione_sbloccata',
        outcome: 'riuscito',
        workstation: row.session.workstation,
      });
    });
    return true;
  }

  /**
   * Cambio della propria password (tappa 14), anche quella temporanea data dall'amministratore.
   * Serve la password attuale: gli errori contano come tentativi falliti, perché da una sessione
   * rubata non si possa provare una password dopo l'altra. Dopo il cambio le altre sessioni
   * dell'utente si chiudono, quella in uso resta; i passaggi d'accesso a metà non valgono più.
   */
  async function changePassword(
    actor: Actor,
    input: {
      current: string;
      next: string;
      /** Indirizzo della richiesta (`req.ip`), per il registro dei tentativi falliti. */
      address?: string | null;
    },
  ): Promise<ChangePasswordResult> {
    const rows = await db
      .select({ user: appUser, studio })
      .from(appUser)
      .innerJoin(studio, eq(studio.id, appUser.studioId))
      .where(eq(appUser.id, actor.userId));
    const row = rows[0];
    if (!row) return { ok: false, status: 400, message: 'Utente non trovato' };
    const { user, studio: st } = row;
    const t = now();
    const failed = (motivo: string) =>
      logAccess(db, {
        studioId: user.studioId,
        userId: user.id,
        action: 'cambio_password',
        outcome: 'fallito',
        workstation: actor.workstation,
        details: { motivo, indirizzo: input.address ?? null },
      });
    if (user.lockedUntil && user.lockedUntil > t) {
      await failed('utente bloccato per troppi tentativi');
      return {
        ok: false,
        status: 429,
        message: 'Troppi tentativi falliti: riprova tra qualche minuto',
      };
    }
    const problem = passwordProblem(input.next, {
      username: user.username,
      current: input.current,
    });
    if (problem) return { ok: false, status: 400, message: problem };
    if (!(await verifyPassword(input.current, user.passwordHash))) {
      await registerFailure(user, st);
      await failed('password attuale errata');
      return { ok: false, status: 400, message: 'La password attuale non è corretta' };
    }
    const passwordHash = await hashPassword(input.next);
    const closed = await withActor(db, user.id, async (tx) => {
      await tx
        .update(appUser)
        .set({
          passwordHash,
          passwordChangedAt: t,
          mustChangePassword: false,
          failedLogins: 0,
        })
        .where(eq(appUser.id, user.id));
      const others = await tx
        .update(session)
        .set({ revokedAt: t })
        .where(
          and(
            eq(session.userId, user.id),
            isNull(session.revokedAt),
            ne(session.id, actor.sessionId),
          ),
        )
        .returning({ id: session.id });
      await tx
        .update(authChallenge)
        .set({ usedAt: t })
        .where(and(eq(authChallenge.userId, user.id), isNull(authChallenge.usedAt)));
      await logAccess(tx, {
        studioId: user.studioId,
        userId: user.id,
        action: 'cambio_password',
        outcome: 'riuscito',
        workstation: actor.workstation,
        details: { obbligato: user.mustChangePassword, altreSessioniChiuse: others.length },
      });
      return others.length;
    });
    return { ok: true, otherSessionsClosed: closed };
  }

  async function logout(sessionToken: string): Promise<void> {
    const row = await loadSession(sessionToken);
    if (!row || row.session.revokedAt) return;
    await db.update(session).set({ revokedAt: now() }).where(eq(session.id, row.session.id));
    await logAccess(db, {
      studioId: row.user.studioId,
      userId: row.user.id,
      action: 'uscita',
      outcome: 'riuscito',
      workstation: row.session.workstation,
    });
  }

  return { login, verifySecondFactor, authenticate, unlock, changePassword, logout };
}

export type AuthService = ReturnType<typeof createAuthService>;
