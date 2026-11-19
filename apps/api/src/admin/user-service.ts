import { randomBytes } from 'node:crypto';
import {
  can,
  checkFiscalCode,
  ROLE_LABELS,
  ROLES,
  type FiscalCodeProblem,
  type Role,
} from '@mmg/domain';
import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import { z } from 'zod';
import { logAccess } from '../audit/access-log';
import type { Actor } from '../auth/service';
import type { Database } from '../db/client';
import { appUser, archive, authChallenge, doctorProfile, session } from '../db/schema';
import { withActor, type Tx } from '../db/tx';
import { HttpError } from '../http/errors';
import { hashPassword } from '../security/password';

/**
 * Utenti e ruoli dello studio (tappa 14): li gestisce l'amministratore (requisiti, «Utenti e
 * ruoli»). Nessun utente si cancella: si sospende. La password temporanea si vede una volta sola,
 * nella risposta che la crea. Nel registro delle azioni di amministrazione vanno l'azione, l'utente,
 * i ruoli prima e dopo e i nomi dei campi cambiati: mai password, impronte o segreti.
 */

const AREA = 'utenti';

/** Azioni sugli utenti, come stanno nel registro (`details.azione`). */
export type UserAction =
  | 'elenco'
  | 'creazione'
  | 'modifica'
  | 'sospensione'
  | 'riattivazione'
  | 'password_temporanea'
  | 'azzeramento_secondo_fattore'
  | 'sblocco';

const DOCTOR_ROLES: readonly Role[] = ['owner_doctor', 'substitute_doctor'];
const isDoctor = (roles: readonly Role[]) => roles.some((r) => DOCTOR_ROLES.includes(r));

/**
 * Nome utente come lo legge l'accesso: minuscole, senza spazi ai lati. Lunghezza e caratteri sono
 * limiti di buon senso, non dei requisiti.
 */
const USERNAME = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const USERNAME_RULE =
  'Nome utente: da 3 a 64 caratteri tra lettere minuscole, cifre, punto, trattino e trattino basso';
const USERNAME_TAKEN = 'Nome utente già in uso: scegline un altro';

const text = (max: number) => z.string().trim().max(max);
const email = z.union([z.literal(''), z.email().max(200)]);

/** Dati del medico: nome e cognome come nel codice fiscale; codice regionale e ASL se noti. */
export const doctorBody = z
  .object({
    codiceFiscale: z.string().trim().toUpperCase().max(16),
    nome: text(100).min(1),
    cognome: text(100).min(1),
    codiceRegionale: text(40).optional(),
    asl: text(120).optional(),
  })
  .strict();

const rolesBody = z.array(z.enum(ROLES)).min(1, 'Scegli almeno un ruolo').max(ROLES.length);

export const createUserBody = z
  .object({
    nomeUtente: z.string().trim().toLowerCase().regex(USERNAME, USERNAME_RULE),
    nome: text(120).min(1),
    email: email.optional(),
    ruoli: rolesBody,
    medico: doctorBody.optional(),
  })
  .strict();

/** Modifica: i campi assenti restano come sono; `medico`, se c'è, sostituisce i cinque dati. */
export const updateUserBody = z
  .object({
    nome: text(120).min(1).optional(),
    email: email.optional(),
    ruoli: rolesBody.optional(),
    medico: doctorBody.optional(),
  })
  .strict();

type DoctorBody = z.infer<typeof doctorBody>;

const FISCAL_CODE_PROBLEMS: Record<FiscalCodeProblem, string> = {
  lunghezza: 'servono 16 caratteri',
  struttura: 'lettere e cifre non sono al loro posto',
  giorno: 'il giorno di nascita non esiste',
  controllo: 'l’ultimo carattere, di controllo, non torna',
};

/** Password temporanea casuale, come quelle dei dati dimostrativi: 16 caratteri. */
export const temporaryPassword = () => randomBytes(12).toString('base64url');

/** Colonne lette degli utenti: mai l'impronta della password né il segreto del secondo fattore. */
const userColumns = {
  id: appUser.id,
  username: appUser.username,
  displayName: appUser.displayName,
  email: appUser.email,
  roles: appUser.roles,
  status: appUser.status,
  totpEnabledAt: appUser.totpEnabledAt,
  failedLogins: appUser.failedLogins,
  lockedUntil: appUser.lockedUntil,
  mustChangePassword: appUser.mustChangePassword,
  passwordChangedAt: appUser.passwordChangedAt,
  createdAt: appUser.createdAt,
};
const profileColumns = {
  userId: doctorProfile.userId,
  fiscalCode: doctorProfile.fiscalCode,
  regionalCode: doctorProfile.regionalCode,
  asl: doctorProfile.asl,
  firstName: doctorProfile.firstName,
  lastName: doctorProfile.lastName,
};
const archiveColumns = { id: archive.id, name: archive.name, ownerUserId: archive.ownerUserId };

interface UserRow {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  roles: Role[];
  status: 'active' | 'suspended';
  totpEnabledAt: Date | null;
  failedLogins: number;
  lockedUntil: Date | null;
  mustChangePassword: boolean;
  passwordChangedAt: Date | null;
  createdAt: Date;
}
interface ProfileRow {
  userId: string;
  fiscalCode: string | null;
  regionalCode: string | null;
  asl: string | null;
  firstName: string | null;
  lastName: string | null;
}
interface ArchiveRow {
  id: string;
  name: string;
  ownerUserId: string;
}
interface DoctorValues {
  fiscalCode: string;
  firstName: string;
  lastName: string;
  regionalCode: string | null;
  asl: string | null;
}

/** Nomi dei dati del medico nel registro, come li scrive l'interfaccia. */
const DOCTOR_FIELDS = [
  ['fiscalCode', 'medico.codiceFiscale'],
  ['firstName', 'medico.nome'],
  ['lastName', 'medico.cognome'],
  ['regionalCode', 'medico.codiceRegionale'],
  ['asl', 'medico.asl'],
] as const;

function doctorValues(m: DoctorBody): DoctorValues {
  const check = checkFiscalCode(m.codiceFiscale);
  if (!check.valid)
    throw new HttpError(
      400,
      `Codice fiscale del medico: non è valido (${FISCAL_CODE_PROBLEMS[check.problem!]})`,
    );
  return {
    fiscalCode: m.codiceFiscale,
    firstName: m.nome,
    lastName: m.cognome,
    regionalCode: m.codiceRegionale || null,
    asl: m.asl || null,
  };
}

const changedDoctorFields = (before: ProfileRow | undefined, after: DoctorValues) =>
  DOCTOR_FIELDS.filter(([k]) => (before?.[k] ?? null) !== after[k]).map(([, name]) => name);

const uniqueRoles = (roles: readonly Role[]): Role[] => ROLES.filter((r) => roles.includes(r));
const sameRoles = (a: readonly Role[], b: readonly Role[]) =>
  a.length === b.length && a.every((r) => b.includes(r));

const archiveName = (displayName: string, first?: string | null, last?: string | null) =>
  `Archivio di ${first && last ? `${first} ${last}` : displayName}`;

/** Rifiuto per una regola (sé stessi, ultimo amministratore): va nel registro, poi l'errore. */
class Refusal extends HttpError {
  constructor(
    statusCode: number,
    message: string,
    readonly target: string,
  ) {
    super(statusCode, message);
  }
}

function isUniqueViolation(e: unknown, constraint: string): boolean {
  const err = e as { code?: string; constraint?: string; cause?: unknown };
  const pg = (err.cause ?? err) as { code?: string; constraint?: string };
  return pg.code === '23505' && pg.constraint === constraint;
}

function view(u: UserRow, p: ProfileRow | null, a: ArchiveRow | null, actorId: string, t: Date) {
  return {
    id: u.id,
    nomeUtente: u.username,
    nome: u.displayName,
    email: u.email,
    ruoli: u.roles.map((c) => ({ codice: c, nome: ROLE_LABELS[c] })),
    stato: u.status === 'active' ? ('attivo' as const) : ('sospeso' as const),
    secondoFattoreAttivo: u.totpEnabledAt !== null,
    bloccatoFinoA: u.lockedUntil && u.lockedUntil > t ? u.lockedUntil.toISOString() : null,
    tentativiFalliti: u.failedLogins,
    passwordDaCambiare: u.mustChangePassword,
    passwordCambiataIl: u.passwordChangedAt?.toISOString() ?? null,
    creatoIl: u.createdAt.toISOString(),
    medico: p
      ? {
          codiceFiscale: p.fiscalCode,
          codiceRegionale: p.regionalCode,
          asl: p.asl,
          nome: p.firstName,
          cognome: p.lastName,
        }
      : null,
    archivio: a ? { id: a.id, nome: a.name } : null,
    io: u.id === actorId,
  };
}

export type UserView = ReturnType<typeof view>;

/** Chiude le sessioni aperte dell'utente e i passaggi d'accesso a metà. */
async function closeSessions(tx: Tx, userId: string, t: Date): Promise<number> {
  const closed = await tx
    .update(session)
    .set({ revokedAt: t })
    .where(and(eq(session.userId, userId), isNull(session.revokedAt)))
    .returning({ id: session.id });
  await tx
    .update(authChallenge)
    .set({ usedAt: t })
    .where(and(eq(authChallenge.userId, userId), isNull(authChallenge.usedAt)));
  return closed.length;
}

/**
 * Gli utenti dello studio, bloccati fino alla fine della transazione: due amministratori che
 * cambiano insieme i ruoli o lo stato l'uno dell'altro non lasciano lo studio senza amministratori.
 * «No key update» non ferma le righe nuove del registro che puntano agli utenti.
 */
async function lockedUsers(tx: Tx, studioId: string): Promise<UserRow[]> {
  return tx
    .select(userColumns)
    .from(appUser)
    .where(eq(appUser.studioId, studioId))
    .orderBy(asc(appUser.id))
    .for('no key update');
}

function ensureOtherActiveAdmin(users: UserRow[], target: UserRow) {
  const others = users.filter(
    (u) => u.id !== target.id && u.status === 'active' && u.roles.includes('administrator'),
  );
  if (others.length === 0)
    throw new Refusal(
      409,
      'Serve almeno un amministratore attivo nello studio: prima dai il ruolo a un altro utente',
      target.username,
    );
}

export function createUserAdminService({ db, now }: { db: Database; now: () => Date }) {
  const logRefusal = (actor: Actor, azione: UserAction, utente: string | null, motivo: string) =>
    logAccess(db, {
      studioId: actor.studioId,
      userId: actor.userId,
      patientId: null,
      action: 'amministrazione',
      outcome: 'negato',
      workstation: actor.workstation,
      details: { area: AREA, azione, ...(utente ? { utente } : {}), motivo },
    });

  const logDone = (
    tx: Tx,
    actor: Actor,
    details: {
      azione: UserAction;
      utente: string;
      utenteId: string;
      ruoliPrima: Role[];
      ruoliDopo: Role[];
      campi: string[];
      sessioniChiuse?: number;
    },
  ) =>
    logAccess(tx, {
      studioId: actor.studioId,
      userId: actor.userId,
      patientId: null,
      action: 'amministrazione',
      outcome: 'riuscito',
      workstation: actor.workstation,
      details: { area: AREA, ...details },
    });

  /** Solo l'amministratore dello studio gestisce gli utenti; ogni rifiuto resta nel registro. */
  async function requireAdmin(actor: Actor, azione: UserAction): Promise<void> {
    const d = can(actor, 'admin.users');
    if (d.allowed) return;
    await logRefusal(actor, azione, null, d.reason);
    throw new HttpError(403, d.reason);
  }

  /**
   * Esegue un'azione sugli utenti. Il permesso si controlla anche qui, non solo nella rotta: una
   * rotta nuova senza controllo non apre nulla. Se una regola rifiuta, la transazione si annulla e il
   * rifiuto si registra.
   */
  async function guarded<T>(actor: Actor, azione: UserAction, fn: () => Promise<T>): Promise<T> {
    await requireAdmin(actor, azione);
    try {
      return await fn();
    } catch (e) {
      if (e instanceof Refusal) await logRefusal(actor, azione, e.target, e.message);
      throw e;
    }
  }

  async function targetOf(q: Database | Tx, actor: Actor, id: string): Promise<UserRow> {
    const [u] = await q
      .select(userColumns)
      .from(appUser)
      .where(and(eq(appUser.id, id), eq(appUser.studioId, actor.studioId)));
    if (!u) throw new HttpError(404, 'Utente non trovato');
    return u;
  }

  async function ownArchive(q: Database | Tx, actor: Actor, userId: string) {
    const [a] = await q
      .select(archiveColumns)
      .from(archive)
      .where(and(eq(archive.studioId, actor.studioId), eq(archive.ownerUserId, userId)))
      .orderBy(asc(archive.name))
      .limit(1);
    return a ?? null;
  }

  async function one(actor: Actor, id: string): Promise<UserView> {
    const u = await targetOf(db, actor, id);
    const [p] = await db
      .select(profileColumns)
      .from(doctorProfile)
      .where(eq(doctorProfile.userId, id));
    return view(u, p ?? null, await ownArchive(db, actor, id), actor.userId, now());
  }

  /** Il codice fiscale e il codice regionale di un medico sono suoi, nello studio. */
  async function ensureDoctorCodesFree(
    q: Database | Tx,
    actor: Actor,
    d: DoctorValues,
    exceptUserId: string | null,
  ) {
    const rows = await q
      .select({
        userId: doctorProfile.userId,
        fiscalCode: doctorProfile.fiscalCode,
        regionalCode: doctorProfile.regionalCode,
      })
      .from(doctorProfile)
      .innerJoin(appUser, eq(appUser.id, doctorProfile.userId))
      .where(
        and(
          eq(appUser.studioId, actor.studioId),
          or(
            eq(doctorProfile.fiscalCode, d.fiscalCode),
            d.regionalCode ? eq(doctorProfile.regionalCode, d.regionalCode) : undefined,
          ),
        ),
      );
    const others = rows.filter((r) => r.userId !== exceptUserId);
    if (others.some((r) => r.fiscalCode === d.fiscalCode))
      throw new HttpError(409, 'Codice fiscale già di un altro utente dello studio');
    if (d.regionalCode && others.some((r) => r.regionalCode === d.regionalCode))
      throw new HttpError(409, 'Codice regionale già di un altro medico dello studio');
  }

  async function list(actor: Actor) {
    await requireAdmin(actor, 'elenco');
    const t = now();
    const users = await db
      .select(userColumns)
      .from(appUser)
      .where(eq(appUser.studioId, actor.studioId))
      .orderBy(asc(appUser.displayName), asc(appUser.username));
    const ids = users.map((u) => u.id);
    const profiles = ids.length
      ? await db
          .select(profileColumns)
          .from(doctorProfile)
          .where(inArray(doctorProfile.userId, ids))
      : [];
    const archives = await db
      .select(archiveColumns)
      .from(archive)
      .where(eq(archive.studioId, actor.studioId))
      .orderBy(asc(archive.name));
    return {
      utenti: users.map((u) =>
        view(
          u,
          profiles.find((p) => p.userId === u.id) ?? null,
          archives.find((a) => a.ownerUserId === u.id) ?? null,
          actor.userId,
          t,
        ),
      ),
      ruoli: ROLES.map((c) => ({ codice: c, nome: ROLE_LABELS[c] })),
    };
  }

  /**
   * Utente nuovo, con una password temporanea da cambiare al primo accesso (il secondo fattore si
   * attiva allo stesso accesso). Per un medico la riga del profilo; per un titolare il suo archivio.
   */
  async function create(actor: Actor, body: z.infer<typeof createUserBody>) {
    await requireAdmin(actor, 'creazione');
    const roles = uniqueRoles(body.ruoli);
    if (isDoctor(roles) && !body.medico)
      throw new HttpError(400, 'Per un medico servono nome, cognome e codice fiscale');
    if (!isDoctor(roles) && body.medico)
      throw new HttpError(400, 'I dati del medico valgono solo per i ruoli di medico');
    const doctor = body.medico ? doctorValues(body.medico) : null;
    const [taken] = await db
      .select({ id: appUser.id })
      .from(appUser)
      .where(eq(appUser.username, body.nomeUtente));
    if (taken) throw new HttpError(409, USERNAME_TAKEN);
    if (doctor) await ensureDoctorCodesFree(db, actor, doctor, null);
    const password = temporaryPassword();
    const passwordHash = await hashPassword(password);
    let id: string;
    try {
      id = await withActor(db, actor.userId, async (tx) => {
        const [u] = await tx
          .insert(appUser)
          .values({
            studioId: actor.studioId,
            username: body.nomeUtente,
            displayName: body.nome,
            email: body.email || null,
            passwordHash,
            roles,
            mustChangePassword: true,
          })
          .returning({ id: appUser.id });
        const userId = u!.id;
        const campi = ['nomeUtente', 'nome', 'ruoli', ...(body.email ? ['email'] : [])];
        if (doctor) {
          await tx.insert(doctorProfile).values({ userId, ...doctor });
          campi.push(...changedDoctorFields(undefined, doctor));
        }
        if (roles.includes('owner_doctor')) {
          await tx.insert(archive).values({
            studioId: actor.studioId,
            ownerUserId: userId,
            name: archiveName(body.nome, doctor?.firstName, doctor?.lastName),
          });
          campi.push('archivio');
        }
        await logDone(tx, actor, {
          azione: 'creazione',
          utente: body.nomeUtente,
          utenteId: userId,
          ruoliPrima: [],
          ruoliDopo: roles,
          campi,
        });
        return userId;
      });
    } catch (e) {
      if (isUniqueViolation(e, 'app_user_username_key')) throw new HttpError(409, USERNAME_TAKEN);
      throw e;
    }
    return { utente: await one(actor, id), passwordTemporanea: password };
  }

  /**
   * Nome, email, ruoli e dati del medico. Nessuno cambia i propri ruoli; non si toglie l'ultimo
   * amministratore attivo; il ruolo di titolare porta il suo archivio, se manca. Togliere un ruolo
   * non cancella nulla: la risposta dice che cosa resta.
   */
  async function update(actor: Actor, id: string, body: z.infer<typeof updateUserBody>) {
    return guarded(actor, 'modifica', async () => {
      const doctor = body.medico ? doctorValues(body.medico) : null;
      const notices = await withActor(db, actor.userId, async (tx) => {
        const users = await lockedUsers(tx, actor.studioId);
        const target = users.find((u) => u.id === id);
        if (!target) throw new HttpError(404, 'Utente non trovato');
        const before = target.roles;
        const after = body.ruoli ? uniqueRoles(body.ruoli) : before;
        const rolesChanged = !sameRoles(before, after);
        if (rolesChanged && target.id === actor.userId)
          throw new Refusal(
            403,
            'Non puoi cambiare i tuoi ruoli: lo fa un altro amministratore',
            target.username,
          );
        if (
          rolesChanged &&
          before.includes('administrator') &&
          !after.includes('administrator') &&
          target.status === 'active'
        )
          ensureOtherActiveAdmin(users, target);
        if (doctor && !isDoctor(after))
          throw new HttpError(400, 'I dati del medico valgono solo per i ruoli di medico');
        const [profile] = await tx
          .select(profileColumns)
          .from(doctorProfile)
          .where(eq(doctorProfile.userId, id));
        if (isDoctor(after) && !isDoctor(before) && !profile && !doctor)
          throw new HttpError(400, 'Per un medico servono nome, cognome e codice fiscale');
        if (doctor) await ensureDoctorCodesFree(tx, actor, doctor, id);

        const campi: string[] = [];
        const patch: Partial<typeof appUser.$inferInsert> = {};
        if (body.nome !== undefined && body.nome !== target.displayName) {
          patch.displayName = body.nome;
          campi.push('nome');
        }
        const mail = body.email === undefined ? undefined : body.email || null;
        if (mail !== undefined && mail !== target.email) {
          patch.email = mail;
          campi.push('email');
        }
        if (rolesChanged) {
          patch.roles = after;
          campi.push('ruoli');
        }
        const doctorChanges = doctor ? changedDoctorFields(profile, doctor) : [];
        campi.push(...doctorChanges);
        const own = await ownArchive(tx, actor, id);
        // Un titolare senza archivio (dati di prima) lo riceve anche se nient'altro cambia.
        const needsArchive = after.includes('owner_doctor') && !own;
        if (needsArchive) campi.push('archivio');
        if (campi.length === 0) throw new HttpError(400, 'Niente da cambiare');

        if (Object.keys(patch).length > 0)
          await tx.update(appUser).set(patch).where(eq(appUser.id, id));
        if (doctor && doctorChanges.length > 0)
          await tx
            .insert(doctorProfile)
            .values({ userId: id, ...doctor })
            .onConflictDoUpdate({ target: doctorProfile.userId, set: doctor });
        const out: string[] = [];
        if (needsArchive) {
          const name = archiveName(
            body.nome ?? target.displayName,
            doctor?.firstName ?? profile?.firstName,
            doctor?.lastName ?? profile?.lastName,
          );
          await tx.insert(archive).values({ studioId: actor.studioId, ownerUserId: id, name });
          out.push(`Creato l’archivio «${name}», vuoto.`);
        }
        if (own && before.includes('owner_doctor') && !after.includes('owner_doctor'))
          out.push(
            `L’archivio «${own.name}» resta con tutti i suoi dati: senza il ruolo di medico titolare l’utente non lo apre, finché il ruolo non torna.`,
          );
        if (own && !before.includes('owner_doctor') && after.includes('owner_doctor'))
          out.push(`L’archivio «${own.name}» torna al suo titolare.`);
        if (profile && isDoctor(before) && !isDoctor(after))
          out.push('I dati del medico restano registrati: non si cancella nulla.');
        await logDone(tx, actor, {
          azione: 'modifica',
          utente: target.username,
          utenteId: id,
          ruoliPrima: before,
          ruoliDopo: after,
          campi,
        });
        return out;
      });
      return { utente: await one(actor, id), avvisi: notices };
    });
  }

  /** Sospensione (le sessioni si chiudono subito) e riattivazione. Mai sé stessi. */
  async function setStatus(actor: Actor, id: string, active: boolean) {
    const azione: UserAction = active ? 'riattivazione' : 'sospensione';
    return guarded(actor, azione, async () => {
      const closed = await withActor(db, actor.userId, async (tx) => {
        const users = await lockedUsers(tx, actor.studioId);
        const target = users.find((u) => u.id === id);
        if (!target) throw new HttpError(404, 'Utente non trovato');
        if (target.id === actor.userId)
          throw new Refusal(
            403,
            active
              ? 'Il tuo utente lo riattiva un altro amministratore'
              : 'Non puoi sospendere il tuo utente',
            target.username,
          );
        if (active && target.status === 'active') throw new HttpError(409, 'L’utente è già attivo');
        if (!active && target.status === 'suspended')
          throw new HttpError(409, 'L’utente è già sospeso');
        if (!active && target.roles.includes('administrator'))
          ensureOtherActiveAdmin(users, target);
        await tx
          .update(appUser)
          .set({ status: active ? 'active' : 'suspended' })
          .where(eq(appUser.id, id));
        const n = active ? 0 : await closeSessions(tx, id, now());
        await logDone(tx, actor, {
          azione,
          utente: target.username,
          utenteId: id,
          ruoliPrima: target.roles,
          ruoliDopo: target.roles,
          campi: ['stato'],
          ...(active ? {} : { sessioniChiuse: n }),
        });
        return n;
      });
      return { utente: await one(actor, id), sessioniChiuse: closed };
    });
  }

  /**
   * Password temporanea nuova, restituita una volta sola: quella di prima non vale più, le sessioni
   * si chiudono, al prossimo accesso va cambiata. Toglie anche il blocco per tentativi falliti.
   */
  async function resetPassword(actor: Actor, id: string) {
    return guarded(actor, 'password_temporanea', async () => {
      const target = await targetOf(db, actor, id);
      if (target.id === actor.userId)
        throw new Refusal(
          403,
          'La tua password la cambi da «Password», nel menu in alto',
          target.username,
        );
      const password = temporaryPassword();
      const passwordHash = await hashPassword(password);
      const closed = await withActor(db, actor.userId, async (tx) => {
        await tx
          .update(appUser)
          .set({ passwordHash, mustChangePassword: true, failedLogins: 0, lockedUntil: null })
          .where(and(eq(appUser.id, id), eq(appUser.studioId, actor.studioId)));
        const n = await closeSessions(tx, id, now());
        await logDone(tx, actor, {
          azione: 'password_temporanea',
          utente: target.username,
          utenteId: id,
          ruoliPrima: target.roles,
          ruoliDopo: target.roles,
          campi: ['password'],
          sessioniChiuse: n,
        });
        return n;
      });
      return { utente: await one(actor, id), passwordTemporanea: password, sessioniChiuse: closed };
    });
  }

  /** Il secondo fattore si azzera: le sessioni si chiudono, al prossimo accesso si riattiva. */
  async function resetSecondFactor(actor: Actor, id: string) {
    return guarded(actor, 'azzeramento_secondo_fattore', async () => {
      const closed = await withActor(db, actor.userId, async (tx) => {
        const target = await targetOf(tx, actor, id);
        if (target.id === actor.userId)
          throw new Refusal(
            403,
            'Il tuo secondo fattore lo azzera un altro amministratore',
            target.username,
          );
        if (target.totpEnabledAt === null)
          throw new HttpError(
            409,
            'Il secondo fattore non è ancora attivo: si attiva al primo accesso',
          );
        await tx
          .update(appUser)
          .set({ totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null })
          .where(eq(appUser.id, id));
        const n = await closeSessions(tx, id, now());
        await logDone(tx, actor, {
          azione: 'azzeramento_secondo_fattore',
          utente: target.username,
          utenteId: id,
          ruoliPrima: target.roles,
          ruoliDopo: target.roles,
          campi: ['secondoFattore'],
          sessioniChiuse: n,
        });
        return n;
      });
      return { utente: await one(actor, id), sessioniChiuse: closed };
    });
  }

  /** Sblocco dopo troppi tentativi falliti: tentativi a zero, blocco tolto. Mai sé stessi. */
  async function unlock(actor: Actor, id: string) {
    return guarded(actor, 'sblocco', async () => {
      await withActor(db, actor.userId, async (tx) => {
        const target = await targetOf(tx, actor, id);
        if (target.id === actor.userId)
          throw new Refusal(
            403,
            'Il tuo utente lo sblocca un altro amministratore',
            target.username,
          );
        const locked = target.lockedUntil !== null && target.lockedUntil > now();
        if (!locked && target.failedLogins === 0)
          throw new HttpError(409, 'L’utente non è bloccato e non ha tentativi falliti');
        await tx
          .update(appUser)
          .set({ failedLogins: 0, lockedUntil: null })
          .where(eq(appUser.id, id));
        await logDone(tx, actor, {
          azione: 'sblocco',
          utente: target.username,
          utenteId: id,
          ruoliPrima: target.roles,
          ruoliDopo: target.roles,
          campi: ['blocco'],
        });
      });
      return { utente: await one(actor, id) };
    });
  }

  return {
    requireAdmin,
    list,
    create,
    update,
    setStatus,
    resetPassword,
    resetSecondFactor,
    unlock,
  };
}

export type UserAdminService = ReturnType<typeof createUserAdminService>;
