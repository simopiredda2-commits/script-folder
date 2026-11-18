import type { Role } from '@mmg/domain';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { logAccess } from '../audit/access-log';
import type { Database } from '../db/client';
import { appUser, authChallenge, session, studio } from '../db/schema';
import { verifyPassword } from '../security/password';
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

export const GENERIC_LOGIN_ERROR = 'Nome utente o password non validi';

export interface Actor {
  userId: string;
  studioId: string;
  roles: Role[];
  displayName: string;
  sessionId: string;
  workstation: string;
}

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

  /** Conta un tentativo fallito e, se lo studio ha fissato le soglie, blocca l'utente. */
  async function registerFailure(
    user: typeof appUser.$inferSelect,
    st: typeof studio.$inferSelect,
  ): Promise<void> {
    const failed = user.failedLogins + 1;
    const lock =
      st.maxFailedLogins != null &&
      st.failedLoginLockMinutes != null &&
      failed >= st.maxFailedLogins;
    await db
      .update(appUser)
      .set({
        failedLogins: lock ? 0 : failed,
        lockedUntil: lock
          ? new Date(now().getTime() + minutes(st.failedLoginLockMinutes!))
          : user.lockedUntil,
      })
      .where(eq(appUser.id, user.id));
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

  async function login(input: {
    username: string;
    password: string;
    workstation: string;
  }): Promise<LoginResult> {
    const found = await loadUser(input.username);
    const fail = async (reason: string, user?: typeof appUser.$inferSelect) => {
      await logAccess(db, {
        studioId: user?.studioId,
        userId: user?.id,
        action: 'accesso_fallito',
        outcome: 'fallito',
        workstation: input.workstation,
        details: { motivo: reason },
      });
      return { ok: false as const, message: GENERIC_LOGIN_ERROR };
    };
    if (!found) return fail('utente sconosciuto');
    const { user, studio: st } = found;
    if (user.status !== 'active') return fail('utente sospeso', user);
    if (user.lockedUntil && user.lockedUntil > now()) {
      await logAccess(db, {
        studioId: user.studioId,
        userId: user.id,
        action: 'accesso_fallito',
        outcome: 'fallito',
        workstation: input.workstation,
        details: { motivo: 'utente bloccato per troppi tentativi' },
      });
      return {
        ok: false,
        message: 'Troppi tentativi falliti: accesso bloccato per qualche minuto',
      };
    }
    if (!(await verifyPassword(input.password, user.passwordHash))) {
      await registerFailure(user, st);
      return fail('password errata', user);
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

  /** Secondo passo: codice TOTP. Con `enroll` attiva anche il secondo fattore. */
  async function verifySecondFactor(input: {
    challengeToken: string;
    code: string;
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
    if (!row) return { ok: false, message: 'Passaggio scaduto: ripeti l’accesso' };
    const { challenge, user, studio: st } = row;

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
    if (step === null) {
      await registerFailure(user, st);
      await logAccess(db, {
        studioId: user.studioId,
        userId: user.id,
        action: 'secondo_fattore_fallito',
        outcome: 'fallito',
        workstation: challenge.workstation,
      });
      return { ok: false, message: 'Codice non valido' };
    }

    const { token, hash } = newToken();
    const expiresAt = new Date(now().getTime() + deps.sessionMaxHours * 3_600_000);
    await db.transaction(async (tx) => {
      await tx
        .update(authChallenge)
        .set({ usedAt: now() })
        .where(eq(authChallenge.id, challenge.id));
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
    });
    return { ok: true, sessionToken: token, expiresAt };
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
    if (s.revokedAt || s.expiresAt <= t || user.status !== 'active') return { status: 'invalid' };
    const actor: Actor = {
      userId: user.id,
      studioId: user.studioId,
      roles: user.roles,
      displayName: user.displayName,
      sessionId: s.id,
      workstation: s.workstation,
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

  async function unlock(sessionToken: string, password: string): Promise<boolean> {
    const row = await loadSession(sessionToken);
    if (!row || row.session.revokedAt || row.session.expiresAt <= now()) return false;
    const ok = await verifyPassword(password, row.user.passwordHash);
    if (!ok) {
      await registerFailure(row.user, row.studio);
      await logAccess(db, {
        studioId: row.user.studioId,
        userId: row.user.id,
        action: 'accesso_fallito',
        outcome: 'fallito',
        workstation: row.session.workstation,
        details: { motivo: 'password errata allo sblocco' },
      });
      return false;
    }
    await db
      .update(session)
      .set({ lockedAt: null, lastActivityAt: now() })
      .where(eq(session.id, row.session.id));
    await logAccess(db, {
      studioId: row.user.studioId,
      userId: row.user.id,
      action: 'sessione_sbloccata',
      outcome: 'riuscito',
      workstation: row.session.workstation,
    });
    return true;
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

  return { login, verifySecondFactor, authenticate, unlock, logout };
}

export type AuthService = ReturnType<typeof createAuthService>;
