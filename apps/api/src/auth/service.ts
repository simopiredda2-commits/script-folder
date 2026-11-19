import type { Role } from '@mmg/domain';
import { and, eq, gt, isNull, lt, ne, sql } from 'drizzle-orm';
import { logAccess } from '../audit/access-log';
import type { Database } from '../db/client';
import { isLockTimeout, withLockTimeout } from '../db/locks';
import { appUser, authChallenge, session, studio } from '../db/schema';
import { withActor, type Tx } from '../db/tx';
import { HttpError } from '../http/errors';
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
 * Codici che un passaggio guarda al massimo, giusti o sbagliati, se lo studio non ha fissato i
 * tentativi: il valore per difetto della soglia (D29). Con la soglia dello studio vale quella.
 */
export const CHALLENGE_DEFAULT_CODES = 5;

/**
 * Attesa massima del blocco della riga dell'utente nell'accesso: rilettura dell'utente prima di
 * aprire il passaggio o la sessione, conto dei tentativi falliti, cambio della password, sblocco
 * della sessione. Limite di buon senso, non di una norma: un accesso non aspetta più di un secondo
 * un'altra transazione (seconda revisione dei poteri dell'amministratore, problema nuovo 2).
 */
export const ACCESS_LOCK_TIMEOUT = '1s';

/** Allo scadere dell'attesa: 503, e il tentativo non si conta. */
export const SERVICE_BUSY_ERROR = 'Il servizio è occupato: riprova tra qualche secondo.';

/**
 * Durata massima del blocco per tentativi falliti, in minuti: limite di buon senso, non di una
 * norma. Dopo la revisione dei poteri dell'amministratore (tappa 14): con un blocco lungo chi
 * conosce il nome utente terrebbe fuori un medico per ore. Vale anche per i valori già salvati.
 */
export const FAILED_LOGIN_LOCK_MAX_MINUTES = 60;

export const GENERIC_LOGIN_ERROR = 'Nome utente o password non validi';

/** Utente bloccato per troppi tentativi falliti: all'accesso e sul passaggio del codice. */
export const LOCKED_LOGIN_ERROR = 'Troppi tentativi falliti: accesso bloccato per qualche minuto';

/** Utente bloccato al cambio della password (429, D165). */
export const LOCKED_CHANGE_ERROR = 'Troppi tentativi falliti: riprova tra qualche minuto';

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

  type StudioRow = typeof studio.$inferSelect;

  /**
   * Una transazione breve sulla riga dell'utente. Se un'altra transazione la tiene oltre
   * ACCESS_LOCK_TIMEOUT, 503 e niente di fatto: nessun tentativo contato, nessuna sessione. Dopo la
   * verifica del codice o della password tutte e due le strade, giusta e sbagliata, passano di qui:
   * un'attesa risponde 503 in tutti e due i casi e non dice a chi prova se aveva indovinato.
   */
  async function onUserRow<T>(fn: (tx: Tx) => Promise<T>, actorId: string | null = null) {
    try {
      return await withActor(db, actorId, fn);
    } catch (e) {
      if (isLockTimeout(e)) throw new HttpError(503, SERVICE_BUSY_ERROR);
      throw e;
    }
  }

  /** L'utente com'è adesso, con la sua riga bloccata fino alla fine della transazione. */
  async function lockUserRow(tx: Tx, userId: string) {
    const [fresh] = await withLockTimeout(tx, ACCESS_LOCK_TIMEOUT, () =>
      tx.select().from(appUser).where(eq(appUser.id, userId)).for('no key update'),
    );
    return fresh;
  }

  /**
   * Conta un tentativo fallito in un solo comando, sul valore che c'è nel database e non su quello
   * letto prima (con le richieste in parallelo il «letto più uno» le contava come una sola), e, se
   * lo studio ha fissato le soglie, alla soglia blocca l'utente e azzera il conto. Dice se adesso
   * l'utente è bloccato, da questo tentativo o da uno arrivato insieme. Il blocco non supera mai
   * FAILED_LOGIN_LOCK_MAX_MINUTES, anche con un valore più alto salvato prima del limite. Va
   * chiamato dentro `onUserRow`: se la riga è occupata oltre l'attesa massima, niente si conta.
   */
  async function registerFailure(tx: Tx, userId: string, st: StudioRow): Promise<boolean> {
    const max = st.maxFailedLogins;
    const lockMinutes = st.failedLoginLockMinutes;
    const t = now();
    let set: Partial<Record<'failedLogins' | 'lockedUntil', ReturnType<typeof sql>>>;
    if (max != null && lockMinutes != null) {
      const reaches = sql`${appUser.failedLogins} + 1 >= ${max}`;
      const until = new Date(
        t.getTime() + minutes(Math.min(lockMinutes, FAILED_LOGIN_LOCK_MAX_MINUTES)),
      ).toISOString();
      set = {
        failedLogins: sql`case when ${reaches} then 0 else ${appUser.failedLogins} + 1 end`,
        lockedUntil: sql`case when ${reaches} then ${until}::timestamptz else ${appUser.lockedUntil} end`,
      };
    } else set = { failedLogins: sql`${appUser.failedLogins} + 1` };
    const [row] = await withLockTimeout(tx, ACCESS_LOCK_TIMEOUT, () =>
      tx
        .update(appUser)
        .set(set)
        .where(eq(appUser.id, userId))
        .returning({ lockedUntil: appUser.lockedUntil }),
    );
    return !!row?.lockedUntil && row.lockedUntil > t;
  }

  /** Chiude il passaggio, se è ancora aperto. */
  const closeChallenge = (q: Database | Tx, id: string) =>
    q
      .update(authChallenge)
      .set({ usedAt: now() })
      .where(and(eq(authChallenge.id, id), isNull(authChallenge.usedAt)));

  /**
   * Prenota un codice sul passaggio prima di guardarlo, in un solo comando: solo se il passaggio è
   * aperto, non è scaduto e ha guardato meno di `max` codici. Restituisce il numero del codice sul
   * passaggio (1 il primo), oppure null: passaggio pieno, già usato o scaduto, e il codice non si
   * guarda. Così con molte richieste insieme se ne guardano al più `max`, giuste o sbagliate
   * (seconda revisione dei poteri dell'amministratore, punto 5).
   */
  async function reserveCode(id: string, max: number): Promise<number | null> {
    const [row] = await onUserRow((tx) =>
      withLockTimeout(tx, ACCESS_LOCK_TIMEOUT, () =>
        tx
          .update(authChallenge)
          .set({ triedCodes: sql`${authChallenge.triedCodes} + 1` })
          .where(
            and(
              eq(authChallenge.id, id),
              isNull(authChallenge.usedAt),
              gt(authChallenge.expiresAt, now()),
              lt(authChallenge.triedCodes, max),
            ),
          )
          .returning({ tried: authChallenge.triedCodes }),
      ),
    );
    return row ? row.tried : null;
  }

  async function createChallenge(
    q: Database | Tx,
    userId: string,
    purpose: 'second_factor' | 'enroll',
    workstation: string,
    pendingSecretEnc: Buffer | null,
  ): Promise<string> {
    const { token, hash } = newToken();
    await q.insert(authChallenge).values({
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
   * Dopo la verifica della password l'utente si rilegge sotto il blocco della sua riga (seconda
   * revisione dei poteri dell'amministratore): con molte password mandate insieme ognuna si conta,
   * e quelle che finiscono dopo il blocco ricevono il messaggio del blocco, giuste o sbagliate.
   */
  async function login(input: {
    username: string;
    password: string;
    workstation: string;
    /** Indirizzo della richiesta (`req.ip`). */
    address?: string | null;
  }): Promise<LoginResult> {
    const found = await loadUser(input.username);
    const logFailure = (reason: string, user?: typeof appUser.$inferSelect) =>
      logAccess(db, {
        studioId: user?.studioId,
        userId: user?.id,
        action: 'accesso_fallito',
        outcome: 'fallito',
        workstation: input.workstation,
        details: { motivo: reason, indirizzo: input.address ?? null },
      });
    const generic = { ok: false as const, message: GENERIC_LOGIN_ERROR };
    const locked = { ok: false as const, message: LOCKED_LOGIN_ERROR };
    if (!found) {
      await logFailure('utente sconosciuto');
      return generic;
    }
    const { user, studio: st } = found;
    if (user.status !== 'active') {
      await logFailure('utente sospeso', user);
      return generic;
    }
    if (user.lockedUntil && user.lockedUntil > now()) {
      await logFailure('utente bloccato per troppi tentativi', user);
      return locked;
    }
    if (!(await verifyPassword(input.password, user.passwordHash))) {
      const nowLocked = await onUserRow((tx) => registerFailure(tx, user.id, st));
      await logFailure('password errata', user);
      return nowLocked ? locked : generic;
    }

    // Password giusta: il passaggio si apre nella stessa transazione che rilegge l'utente sotto il
    // blocco della sua riga. Un blocco, una sospensione o un'attesa arrivati mentre si verificava
    // la password lo fermano.
    type Stop = 'sospeso' | 'bloccato' | 'attesa';
    const out = await onUserRow(async (tx): Promise<LoginResult | Stop> => {
      const fresh = await lockUserRow(tx, user.id);
      if (!fresh || fresh.status !== 'active') return 'sospeso';
      if (fresh.lockedUntil && fresh.lockedUntil > now()) return 'bloccato';
      // Nessun passaggio successivo finché un titolare non conferma (tappa 14).
      if (fresh.awaitingConfirmation) return 'attesa';
      if (fresh.totpSecretEnc && fresh.totpEnabledAt) {
        const challengeToken = await createChallenge(
          tx,
          user.id,
          'second_factor',
          input.workstation,
          null,
        );
        return { ok: true, step: 'second_factor', challengeToken };
      }
      const secret = newTotpSecret();
      const challengeToken = await createChallenge(
        tx,
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
    });
    if (out === 'sospeso') {
      await logFailure('utente sospeso', user);
      return generic;
    }
    if (out === 'bloccato') {
      await logFailure('utente bloccato per troppi tentativi', user);
      return locked;
    }
    if (out === 'attesa') {
      await logFailure('in attesa della conferma di un medico titolare', user);
      return { ok: false, message: AWAITING_CONFIRMATION_ERROR };
    }
    return out;
  }

  /**
   * Secondo passo: codice TOTP. Con `enroll` attiva anche il secondo fattore. Dopo le revisioni dei
   * poteri dell'amministratore (tappa 14): un utente bloccato non entra nemmeno su un passaggio già
   * aperto; ogni codice si conta sul passaggio prima di guardarlo, e il passaggio ne guarda al più
   * tanti quanti i tentativi dello studio, anche con molte richieste insieme; i codici sbagliati
   * contano anche per l'utente, in un solo comando; con il codice giusto il passaggio si consuma
   * una volta sola e l'utente si rilegge, sotto blocco, nella stessa transazione che apre la
   * sessione.
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

    // Il codice si conta sul passaggio prima di guardarlo: con molte richieste insieme se ne
    // guardano al più `max`, giuste o sbagliate; le altre trovano il passaggio pieno.
    const max = st.maxFailedLogins ?? CHALLENGE_DEFAULT_CODES;
    const tried = await reserveCode(challenge.id, max);
    if (tried === null) {
      const [current] = await db
        .select({ tried: authChallenge.triedCodes })
        .from(authChallenge)
        .where(eq(authChallenge.id, challenge.id));
      return {
        ok: false,
        message: (current?.tried ?? 0) >= max ? TOO_MANY_CODES_ERROR : EXPIRED_CHALLENGE_ERROR,
      };
    }
    // L'ultimo codice che il passaggio guarda: se è sbagliato, il passaggio si chiude.
    const last = tried >= max;

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
    // Codice sbagliato: conta per l'utente, in un solo comando sotto il blocco della sua riga; se
    // era l'ultimo che il passaggio guarda, il passaggio si chiude. Sul passaggio era già contato.
    const wrongCode = async (): Promise<SessionResult> => {
      const locked = await onUserRow(async (tx) => {
        const l = await registerFailure(tx, user.id, st);
        if (last) await closeChallenge(tx, challenge.id);
        return l;
      });
      await failure(db, { motivo: 'codice errato', ...(last ? { passaggioChiuso: true } : {}) });
      if (locked) return { ok: false, message: LOCKED_LOGIN_ERROR };
      return { ok: false, message: last ? TOO_MANY_CODES_ERROR : 'Codice non valido' };
    };
    if (step === null) return wrongCode();

    const { token, hash } = newToken();
    const expiresAt = new Date(now().getTime() + deps.sessionMaxHours * 3_600_000);
    const done = await onUserRow(async (tx): Promise<SessionResult | 'ripetuto'> => {
      // L'utente com'è adesso, bloccato fino alla fine: una sospensione, un'attesa o un blocco
      // arrivati dopo la prima lettura fermano la sessione. Chi tiene la riga oltre l'attesa
      // massima fa rispondere 503, come al codice sbagliato.
      const state = await withLockTimeout(tx, ACCESS_LOCK_TIMEOUT, async () => {
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
          return 'fermo' as const;
        }
        if (fresh.lockedUntil && fresh.lockedUntil > now()) {
          await closeChallenge(tx, challenge.id);
          return 'bloccato' as const;
        }
        // Lo stesso codice usato nel frattempo su un altro passaggio non vale una seconda volta:
        // conta come un codice sbagliato, come quando arriva dopo.
        if (
          challenge.purpose !== 'enroll' &&
          fresh.totpLastStep != null &&
          step <= fresh.totpLastStep
        )
          return 'ripetuto' as const;
        // Il passaggio si consuma una volta sola: se un'altra richiesta l'ha già usato o chiuso,
        // qui ci si ferma.
        const used = await tx
          .update(authChallenge)
          .set({ usedAt: now() })
          .where(and(eq(authChallenge.id, challenge.id), isNull(authChallenge.usedAt)))
          .returning({ id: authChallenge.id });
        return used.length === 0 ? ('usato' as const) : ('aperto' as const);
      });
      if (state === 'fermo' || state === 'usato')
        return { ok: false, message: EXPIRED_CHALLENGE_ERROR };
      if (state === 'bloccato') {
        await failure(tx, { motivo: 'utente bloccato per troppi tentativi' });
        return { ok: false, message: LOCKED_LOGIN_ERROR };
      }
      if (state === 'ripetuto') return 'ripetuto';
      // Accesso riuscito: tentativi a zero sulla riga bloccata. Un tentativo sbagliato arrivato
      // nel frattempo aspetta questa transazione e si conta dopo, sul valore azzerato.
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
    const wrongCode = async () => {
      await onUserRow((tx) => registerFailure(tx, user.id, st));
      await logAccess(db, {
        studioId: user.studioId,
        userId: user.id,
        action: 'secondo_fattore_fallito',
        outcome: 'fallito',
        workstation: row.session.workstation,
        details: { motivo: 'codice errato allo sblocco', indirizzo: address },
      });
      return false;
    };
    if (step === null) return wrongCode();
    const done = await onUserRow(async (tx) => {
      // L'utente riletto sotto il blocco della sua riga (seconda revisione dei poteri
      // dell'amministratore): bloccato o sospeso nel frattempo, per esempio dai codici sbagliati
      // mandati insieme, non si sblocca; lo stesso codice usato nel frattempo conta come sbagliato.
      const fresh = await lockUserRow(tx, user.id);
      if (!fresh || fresh.status !== 'active' || fresh.awaitingConfirmation) return 'fermo';
      if (fresh.lockedUntil && fresh.lockedUntil > now()) return 'fermo';
      if (fresh.totpLastStep != null && step <= fresh.totpLastStep) return 'ripetuto';
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
      return 'sbloccata';
    });
    if (done === 'ripetuto') return wrongCode();
    return done === 'sbloccata';
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
    const locked = { ok: false as const, status: 429 as const, message: LOCKED_CHANGE_ERROR };
    if (user.lockedUntil && user.lockedUntil > t) {
      await failed('utente bloccato per troppi tentativi');
      return locked;
    }
    const problem = passwordProblem(input.next, {
      username: user.username,
      current: input.current,
    });
    if (problem) return { ok: false, status: 400, message: problem };
    if (!(await verifyPassword(input.current, user.passwordHash))) {
      const nowLocked = await onUserRow((tx) => registerFailure(tx, user.id, st));
      await failed('password attuale errata');
      // Bloccato adesso, da questo tentativo o da uno arrivato insieme: lo stesso 429 che riceve
      // la password giusta con l'utente bloccato, così chi prova non sa se aveva indovinato.
      return nowLocked
        ? locked
        : { ok: false, status: 400, message: 'La password attuale non è corretta' };
    }
    const passwordHash = await hashPassword(input.next);
    const closed = await onUserRow(async (tx) => {
      // L'utente riletto sotto il blocco della sua riga: bloccato nel frattempo dalle password
      // sbagliate mandate insieme, la password non cambia.
      const fresh = await lockUserRow(tx, user.id);
      if (!fresh || (fresh.lockedUntil && fresh.lockedUntil > now())) return null;
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
    }, user.id);
    if (closed === null) {
      await failed('utente bloccato per troppi tentativi');
      return locked;
    }
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
