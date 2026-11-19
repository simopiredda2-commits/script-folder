import type { Role } from '@mmg/domain';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { closeSessions, lockStudioUsers, temporaryPassword } from '../admin/user-service';
import { logAccess } from '../audit/access-log';
import { hashPassword } from '../security/password';
import type { Database } from './client';
import { appUser, studio } from './schema';

/**
 * Ripristino delle credenziali di un utente da chi gestisce il servizio, sul server (tappa 14):
 * per medici e segreteria è l'unica strada, perché l'amministratore dello studio, conoscendo la
 * password temporanea o azzerando il secondo fattore, entrerebbe al loro posto. Vale per tutti gli
 * utenti, amministratori compresi (per esempio l'unico amministratore che ha perso il telefono).
 *
 * - Senza opzioni: password temporanea nuova, mostrata una volta, da cambiare al prossimo accesso;
 *   tentativi falliti e blocco a zero; sessioni chiuse.
 * - `secondoFattore`: anche il secondo fattore si azzera e si riattiva al prossimo accesso.
 * - `riattiva`: l'utente sospeso torna attivo, con la password temporanea nuova.
 * - `sospendi`: l'utente si sospende e le sessioni si chiudono, senza password nuova; è la strada
 *   per un titolare con pazienti, dopo l'esportazione dei suoi dati (regola 4).
 *
 * La conferma di un titolare non si salta: chi è in attesa resta in attesa. Ogni azione va nel
 * registro delle azioni di amministrazione, senza utente (non c'è una sessione) e con
 * `tramite: 'comando del server'`; mai password o segreti.
 */
export const restoreInput = z
  .object({
    utente: z.string().trim().toLowerCase().min(1, 'manca il nome utente'),
    secondoFattore: z.boolean().default(false),
    sospendi: z.boolean().default(false),
    riattiva: z.boolean().default(false),
  })
  .strict()
  .refine((v) => !(v.sospendi && v.riattiva), {
    message: 'sospendere e riattivare insieme non si può: scegline uno',
    path: ['sospendi'],
  });
export type RestoreInput = z.input<typeof restoreInput>;

export type RestoreAction =
  'password_temporanea' | 'azzeramento_secondo_fattore' | 'sospensione' | 'riattivazione';

export interface RestoreResult {
  userId: string;
  username: string;
  displayName: string;
  studioName: string;
  roles: Role[];
  /** Mostrata una sola volta: va consegnata di persona e cambiata al prossimo accesso. */
  temporaryPassword: string | null;
  actions: RestoreAction[];
  closedSessions: number;
  status: 'active' | 'suspended';
  /** In attesa della conferma di un medico titolare: entra solo dopo. */
  awaitingConfirmation: boolean;
  /** Il secondo fattore non era attivo: niente da azzerare. */
  secondFactorWasInactive: boolean;
}

export async function restoreUser(
  db: Database,
  raw: RestoreInput,
  opts: { now?: () => Date } = {},
): Promise<RestoreResult> {
  const input = restoreInput.parse(raw);
  const now = opts.now ?? (() => new Date());
  const [found] = await db
    .select({ id: appUser.id, studioId: appUser.studioId, studioName: studio.name })
    .from(appUser)
    .innerJoin(studio, eq(studio.id, appUser.studioId))
    .where(eq(appUser.username, input.utente));
  if (!found) throw new Error(`Nessun utente «${input.utente}»`);
  const password = input.sospendi ? null : temporaryPassword();
  const passwordHash = password ? await hashPassword(password) : null;

  return db.transaction(async (tx) => {
    const users = await lockStudioUsers(tx, found.studioId);
    const target = users.find((u) => u.id === found.id)!;
    if (input.sospendi && target.status === 'suspended')
      throw new Error('L’utente è già sospeso: niente da fare');
    if (input.riattiva && target.status === 'active')
      throw new Error('L’utente è già attivo: per una password nuova togli --riattiva');
    if (input.sospendi && target.roles.includes('administrator')) {
      const others = users.filter(
        (u) => u.id !== target.id && u.status === 'active' && u.roles.includes('administrator'),
      );
      if (others.length === 0)
        throw new Error(
          'È l’unico amministratore attivo dello studio: invece di sospenderlo, ripristina le sue credenziali (senza --sospendi, con --secondo-fattore)',
        );
    }
    const t = now();
    const actions: RestoreAction[] = [];
    const patch: Partial<typeof appUser.$inferInsert> = {};
    if (passwordHash) {
      Object.assign(patch, {
        passwordHash,
        mustChangePassword: true,
        failedLogins: 0,
        lockedUntil: null,
      });
      actions.push('password_temporanea');
    }
    const secondFactorWasInactive = input.secondoFattore && target.totpEnabledAt === null;
    if (input.secondoFattore && !secondFactorWasInactive) {
      Object.assign(patch, { totpSecretEnc: null, totpEnabledAt: null, totpLastStep: null });
      actions.push('azzeramento_secondo_fattore');
    }
    if (input.sospendi) {
      patch.status = 'suspended';
      actions.push('sospensione');
    }
    if (input.riattiva) {
      patch.status = 'active';
      actions.push('riattivazione');
    }
    await tx.update(appUser).set(patch).where(eq(appUser.id, target.id));
    const closed = await closeSessions(tx, target.id, t);
    const FIELDS: Record<RestoreAction, string> = {
      password_temporanea: 'password',
      azzeramento_secondo_fattore: 'secondoFattore',
      sospensione: 'stato',
      riattivazione: 'stato',
    };
    for (const [i, azione] of actions.entries())
      await logAccess(tx, {
        studioId: found.studioId,
        userId: null,
        patientId: null,
        action: 'amministrazione',
        outcome: 'riuscito',
        workstation: null,
        details: {
          area: 'utenti',
          azione,
          tramite: 'comando del server',
          utente: target.username,
          utenteId: target.id,
          ruoliPrima: target.roles,
          ruoliDopo: target.roles,
          campi: [FIELDS[azione]],
          // Le sessioni si chiudono una volta sola: le conta la prima riga.
          ...(i === 0 ? { sessioniChiuse: closed } : {}),
          ...(target.awaitingConfirmation ? { attesaConferma: true } : {}),
        },
      });
    return {
      userId: target.id,
      username: target.username,
      displayName: target.displayName,
      studioName: found.studioName,
      roles: target.roles,
      temporaryPassword: password,
      actions,
      closedSessions: closed,
      status: patch.status ?? target.status,
      awaitingConfirmation: target.awaitingConfirmation,
      secondFactorWasInactive,
    };
  });
}
