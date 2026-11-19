import type { Role } from '@mmg/domain';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  closeSessions,
  lockStudioUsers,
  otherActiveOwners,
  temporaryPassword,
} from '../admin/user-service';
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
 * - `sblocca`: toglie il blocco dopo i tentativi falliti, senza cambiare password né secondo
 *   fattore e senza chiudere le sessioni; per medici e segreteria l'amministratore non può.
 * - `conferma`: conferma un utente in attesa quando nello studio non c'è un medico titolare attivo
 *   e confermato che possa farlo (studio nuovo, titolari sospesi o in attesa), con una password
 *   temporanea nuova e il secondo fattore da riattivare; sessioni e passaggi d'accesso si chiudono.
 *   Se un titolare può confermare, il comando rifiuta: la conferma si fa dal programma.
 *
 * Ogni azione va nel registro delle azioni di amministrazione, senza utente (non c'è una sessione)
 * e con `tramite: 'comando del server'`; mai password o segreti.
 */
export const restoreInput = z
  .object({
    utente: z.string().trim().toLowerCase().min(1, 'manca il nome utente'),
    secondoFattore: z.boolean().default(false),
    sospendi: z.boolean().default(false),
    riattiva: z.boolean().default(false),
    sblocca: z.boolean().default(false),
    conferma: z.boolean().default(false),
  })
  .strict()
  .refine((v) => !(v.sospendi && v.riattiva), {
    message: 'sospendere e riattivare insieme non si può: scegline uno',
    path: ['sospendi'],
  })
  .refine((v) => !(v.sblocca && (v.secondoFattore || v.sospendi || v.riattiva || v.conferma)), {
    message:
      'va da solo: toglie il blocco senza cambiare la password (una password nuova toglie già il blocco)',
    path: ['sblocca'],
  })
  .refine((v) => !(v.conferma && v.sospendi), {
    message: 'confermare e sospendere insieme non si può: scegline uno',
    path: ['conferma'],
  });
export type RestoreInput = z.input<typeof restoreInput>;

export type RestoreAction =
  | 'password_temporanea'
  | 'azzeramento_secondo_fattore'
  | 'sospensione'
  | 'riattivazione'
  | 'sblocco'
  | 'conferma';

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

/** Campi cambiati da ogni azione, come li scrive il registro. */
const FIELDS: Record<RestoreAction, string[]> = {
  password_temporanea: ['password'],
  azzeramento_secondo_fattore: ['secondoFattore'],
  sospensione: ['stato'],
  riattivazione: ['stato'],
  sblocco: ['blocco'],
  conferma: ['conferma', 'password', 'secondoFattore'],
};

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
  const password = input.sospendi || input.sblocca ? null : temporaryPassword();
  const passwordHash = password ? await hashPassword(password) : null;

  return db.transaction(async (tx) => {
    const users = await lockStudioUsers(tx, found.studioId);
    const target = users.find((u) => u.id === found.id)!;
    const t = now();
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
    if (
      input.sblocca &&
      !(target.lockedUntil && target.lockedUntil > t) &&
      target.failedLogins === 0
    )
      throw new Error('L’utente non è bloccato e non ha tentativi falliti: niente da sbloccare');
    if (input.conferma) {
      if (!target.awaitingConfirmation)
        throw new Error('L’utente non è in attesa di conferma: niente da confermare');
      if (target.status === 'suspended' && !input.riattiva)
        throw new Error('L’utente è sospeso: per confermarlo aggiungi --riattiva');
      // La conferma dal server vale solo quando nessun titolare può darla dal programma.
      if (otherActiveOwners(users, target.id).length > 0)
        throw new Error(
          'Nello studio c’è un medico titolare attivo e confermato: la conferma la fa lui, dal programma (Strumenti › Utenti da confermare). Il comando conferma solo quando nessun titolare può farlo.',
        );
    }

    const actions: RestoreAction[] = [];
    const patch: Partial<typeof appUser.$inferInsert> = {};
    const secondFactorWasInactive = input.secondoFattore && target.totpEnabledAt === null;
    if (input.sblocca) {
      Object.assign(patch, { failedLogins: 0, lockedUntil: null });
      actions.push('sblocco');
    } else if (input.conferma) {
      if (input.riattiva) {
        patch.status = 'active';
        actions.push('riattivazione');
      }
      // Credenziali nuove, che consegna di persona chi gestisce il servizio: quelle di prima
      // potevano essere note all'amministratore.
      Object.assign(patch, {
        awaitingConfirmation: false,
        confirmationIssuesPassword: false,
        confirmedBy: null,
        confirmedAt: t,
        passwordHash,
        mustChangePassword: true,
        failedLogins: 0,
        lockedUntil: null,
        totpSecretEnc: null,
        totpEnabledAt: null,
        totpLastStep: null,
      });
      actions.push('conferma');
    } else {
      if (passwordHash) {
        Object.assign(patch, {
          passwordHash,
          mustChangePassword: true,
          failedLogins: 0,
          lockedUntil: null,
        });
        actions.push('password_temporanea');
      }
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
        // Chi era in attesa torna nell'elenco dei titolari con una richiesta nuova, del server.
        if (target.awaitingConfirmation) {
          patch.confirmationRequestedAt = t;
          patch.confirmationRequestedBy = null;
        }
      }
    }
    await tx.update(appUser).set(patch).where(eq(appUser.id, target.id));
    // Lo sblocco non tocca le credenziali: le sessioni aperte restano, come dal programma.
    const closes = !input.sblocca;
    const closed = closes ? await closeSessions(tx, target.id, t) : 0;
    const awaitingAfter = target.awaitingConfirmation && !input.conferma;
    const requester = input.conferma
      ? (users.find((u) => u.id === target.confirmationRequestedBy)?.username ?? null)
      : null;
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
          campi: FIELDS[azione],
          // Le sessioni si chiudono una volta sola: le conta la prima riga.
          ...(closes && i === 0 ? { sessioniChiuse: closed } : {}),
          ...(awaitingAfter ? { attesaConferma: true } : {}),
          // Per la conferma: chi aveva chiesto la conferma, e quando.
          ...(azione === 'conferma'
            ? {
                richiestaDa: requester,
                richiestaIl: target.confirmationRequestedAt?.toISOString() ?? null,
              }
            : {}),
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
      awaitingConfirmation: awaitingAfter,
      secondFactorWasInactive,
    };
  });
}
