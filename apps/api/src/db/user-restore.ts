import { ROLE_LABELS, type Role } from '@mmg/domain';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  closeSessions,
  isActiveConfirmedOwner,
  lockOwnerArchives,
  lockStudioUsers,
  otherActiveOwners,
  temporaryPassword,
} from '../admin/user-service';
import { logAccess } from '../audit/access-log';
import { hashPassword } from '../security/password';
import type { Database } from './client';
import { appUser, doctorProfile, studio } from './schema';

/**
 * Ripristino delle credenziali di un utente da chi gestisce il servizio, sul server (tappa 14):
 * per medici e segreteria è l'unica strada, perché l'amministratore dello studio, conoscendo la
 * password temporanea o azzerando il secondo fattore, entrerebbe al loro posto. Vale per tutti gli
 * utenti, amministratori compresi (per esempio l'unico amministratore che ha perso il telefono).
 *
 * - Senza opzioni: password temporanea nuova, mostrata una volta, da cambiare al prossimo accesso;
 *   tentativi falliti e blocco a zero; sessioni chiuse.
 * - `secondoFattore`: anche il secondo fattore si azzera e si riattiva al prossimo accesso.
 * - `riattiva`: l'utente sospeso torna attivo, con la password temporanea nuova; toglie il segno
 *   della sospensione del server.
 * - `sospendi`: l'utente si sospende e le sessioni si chiudono, senza password nuova; è la strada
 *   per un titolare con pazienti, dopo l'esportazione dei suoi dati (regola 4). La sospensione è
 *   «del server»: dal programma non si riattiva (seconda revisione dei poteri, problema 7). Un
 *   utente già sospeso dal programma diventa sospeso dal server.
 * - `sblocca`: toglie il blocco dopo i tentativi falliti, senza cambiare password né secondo
 *   fattore e senza chiudere le sessioni; per medici e segreteria l'amministratore non può.
 * - `mostra` (showRequest): stampa la richiesta di conferma, senza cambiare nulla: nome utente,
 *   nome, ruoli, dati del medico, chi l'ha fatta e quando, con la data esatta, e lo stato.
 * - `conferma`, con `richiestaIl`: conferma un utente in attesa quando nello studio non c'è un
 *   medico titolare attivo e confermato che possa farlo (studio nuovo, titolari sospesi o in
 *   attesa), con una password temporanea nuova e il secondo fattore da riattivare; sessioni e
 *   passaggi d'accesso si chiudono. Vale solo per la richiesta letta con `mostra`: se nel
 *   frattempo è cambiata (data diversa), rifiuta e rimanda a `mostra`, come la conferma dal
 *   programma (seconda revisione, problema nuovo 1). Se un titolare può confermare, rifiuta: la
 *   conferma si fa dal programma.
 * - `rifiuta`: l'utente in attesa resta in attesa, si sospende ed è sospeso dal server: dal
 *   programma non si riattiva e non si conferma.
 *
 * Ogni azione va nel registro delle azioni di amministrazione, senza utente (non c'è una sessione)
 * e con `tramite: 'comando del server'`; mai password o segreti, mai dati dei pazienti.
 */
export const restoreInput = z
  .object({
    utente: z.string().trim().toLowerCase().min(1, 'manca il nome utente'),
    secondoFattore: z.boolean().default(false),
    sospendi: z.boolean().default(false),
    riattiva: z.boolean().default(false),
    sblocca: z.boolean().default(false),
    conferma: z.boolean().default(false),
    rifiuta: z.boolean().default(false),
    mostra: z.boolean().default(false),
    /** La data della richiesta, come la stampa `mostra` (ISO 8601 con il fuso). */
    richiestaIl: z.iso
      .datetime({
        offset: true,
        error: 'una data e ora ISO 8601 con il fuso, come la stampa --mostra',
      })
      .optional(),
  })
  .strict()
  .refine((v) => !(v.sospendi && v.riattiva), {
    message: 'sospendere e riattivare insieme non si può: scegline uno',
    path: ['sospendi'],
  })
  .refine(
    (v) =>
      !(v.sblocca && (v.secondoFattore || v.sospendi || v.riattiva || v.conferma || v.rifiuta)),
    {
      message:
        'va da solo: toglie il blocco senza cambiare la password (una password nuova toglie già il blocco)',
      path: ['sblocca'],
    },
  )
  .refine((v) => !(v.conferma && v.sospendi), {
    message: 'confermare e sospendere insieme non si può: scegline uno',
    path: ['conferma'],
  })
  .refine(
    (v) =>
      !(
        v.mostra &&
        (v.secondoFattore ||
          v.sospendi ||
          v.riattiva ||
          v.sblocca ||
          v.conferma ||
          v.rifiuta ||
          v.richiestaIl)
      ),
    { message: 'va da solo: stampa la richiesta senza cambiare nulla', path: ['mostra'] },
  )
  .refine(
    (v) =>
      !(v.rifiuta && (v.secondoFattore || v.sospendi || v.riattiva || v.conferma || v.richiestaIl)),
    {
      message: 'va da solo: l’utente resta in attesa e si sospende, senza password nuova',
      path: ['rifiuta'],
    },
  )
  .refine((v) => !v.conferma || v.richiestaIl !== undefined, {
    message:
      'serve la data della richiesta che stampa --mostra: prima leggi la richiesta, poi confermala con la sua data',
    path: ['richiestaIl'],
  })
  .refine((v) => v.richiestaIl === undefined || v.conferma, {
    message: 'vale solo con --conferma',
    path: ['richiestaIl'],
  });
export type RestoreInput = z.input<typeof restoreInput>;

export type RestoreAction =
  | 'password_temporanea'
  | 'azzeramento_secondo_fattore'
  | 'sospensione'
  | 'riattivazione'
  | 'sblocco'
  | 'conferma'
  | 'rifiuto';

/**
 * Azioni del comando nel registro (`details.azione`), con la consultazione della richiesta
 * (`mostra`): ognuna ha la sua etichetta nel registro di amministrazione (archive-service.ts).
 */
export const RESTORE_LOG_ACTIONS = [
  'password_temporanea',
  'azzeramento_secondo_fattore',
  'sospensione',
  'riattivazione',
  'sblocco',
  'conferma',
  'rifiuto',
  'consultazione_richiesta',
] as const;

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
  /** Sospeso da chi gestisce il servizio: dal programma non si riattiva. */
  suspendedByService: boolean;
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
  rifiuto: ['stato'],
};

/** La richiesta è cambiata dopo `mostra`: si rilegge, la data nuova non si dice qui. */
export const STALE_SERVER_REQUEST =
  'La richiesta di conferma è cambiata dopo che l’hai letta, oppure la data non è quella che --mostra ha stampato: rileggila con --mostra, controlla di nuovo i dati con l’interessato e conferma con la data che stampa.';

const NO_USER = (username: string) => `Nessun utente «${username}»`;

/** La richiesta di conferma di un utente, come la legge chi gestisce il servizio (`mostra`). */
export interface RequestView {
  userId: string;
  username: string;
  displayName: string;
  studioName: string;
  roles: Role[];
  /** I ruoli con i nomi in italiano. */
  roleNames: string[];
  doctor: {
    firstName: string | null;
    lastName: string | null;
    fiscalCode: string | null;
    regionalCode: string | null;
    asl: string | null;
  } | null;
  status: 'active' | 'suspended';
  suspendedByService: boolean;
  awaitingConfirmation: boolean;
  /** Chi ha fatto la richiesta (nome utente e nome); null se è del server o non è nota. */
  requestedBy: { username: string; displayName: string } | null;
  /** La data esatta della richiesta, ISO 8601: è quella da dare a `--richiesta-il`. */
  requestedAt: string | null;
  /** Nello studio c'è un medico titolare attivo e confermato: la conferma la fa lui. */
  ownerCanConfirm: boolean;
}

/**
 * `mostra`: legge la richiesta di conferma di un utente, senza cambiare nulla. Nel registro di
 * amministrazione resta solo che il server l'ha letta, con la data della richiesta: nessun valore
 * dei dati dell'utente e nessun dato dei pazienti.
 */
export async function showRequest(db: Database, raw: { utente: string }): Promise<RequestView> {
  const username = z.string().trim().toLowerCase().min(1, 'manca il nome utente').parse(raw.utente);
  const [u] = await db
    .select({
      id: appUser.id,
      studioId: appUser.studioId,
      studioName: studio.name,
      username: appUser.username,
      displayName: appUser.displayName,
      roles: appUser.roles,
      status: appUser.status,
      suspendedByService: appUser.suspendedByService,
      awaitingConfirmation: appUser.awaitingConfirmation,
      confirmationRequestedBy: appUser.confirmationRequestedBy,
      confirmationRequestedAt: appUser.confirmationRequestedAt,
    })
    .from(appUser)
    .innerJoin(studio, eq(studio.id, appUser.studioId))
    .where(eq(appUser.username, username));
  if (!u) throw new Error(NO_USER(username));
  const [p] = await db
    .select({
      firstName: doctorProfile.firstName,
      lastName: doctorProfile.lastName,
      fiscalCode: doctorProfile.fiscalCode,
      regionalCode: doctorProfile.regionalCode,
      asl: doctorProfile.asl,
    })
    .from(doctorProfile)
    .where(eq(doctorProfile.userId, u.id));
  const colleagues = await db
    .select({
      id: appUser.id,
      username: appUser.username,
      displayName: appUser.displayName,
      status: appUser.status,
      awaitingConfirmation: appUser.awaitingConfirmation,
      roles: appUser.roles,
    })
    .from(appUser)
    .where(eq(appUser.studioId, u.studioId));
  const requester = colleagues.find((c) => c.id === u.confirmationRequestedBy) ?? null;
  const requestedAt = u.confirmationRequestedAt?.toISOString() ?? null;
  await logAccess(db, {
    studioId: u.studioId,
    userId: null,
    patientId: null,
    action: 'amministrazione',
    outcome: 'riuscito',
    workstation: null,
    details: {
      area: 'utenti',
      azione: 'consultazione_richiesta',
      tramite: 'comando del server',
      utente: u.username,
      utenteId: u.id,
      ...(u.awaitingConfirmation ? { richiestaIl: requestedAt } : {}),
    },
  });
  return {
    userId: u.id,
    username: u.username,
    displayName: u.displayName,
    studioName: u.studioName,
    roles: u.roles,
    roleNames: u.roles.map((r) => ROLE_LABELS[r]),
    doctor: p ?? null,
    status: u.status,
    suspendedByService: u.suspendedByService,
    awaitingConfirmation: u.awaitingConfirmation,
    requestedBy: requester
      ? { username: requester.username, displayName: requester.displayName }
      : null,
    requestedAt: u.awaitingConfirmation ? requestedAt : null,
    ownerCanConfirm: colleagues.some((c) => c.id !== u.id && isActiveConfirmedOwner(c)),
  };
}

export async function restoreUser(
  db: Database,
  raw: RestoreInput,
  opts: { now?: () => Date } = {},
): Promise<RestoreResult> {
  const input = restoreInput.parse(raw);
  if (input.mostra) throw new Error('--mostra stampa la richiesta: si legge con showRequest');
  const now = opts.now ?? (() => new Date());
  const [found] = await db
    .select({ id: appUser.id, studioId: appUser.studioId, studioName: studio.name })
    .from(appUser)
    .innerJoin(studio, eq(studio.id, appUser.studioId))
    .where(eq(appUser.username, input.utente));
  if (!found) throw new Error(NO_USER(input.utente));
  const password = input.sospendi || input.sblocca || input.rifiuta ? null : temporaryPassword();
  const passwordHash = password ? await hashPassword(password) : null;

  return db.transaction(async (tx) => {
    // Una sospensione blocca prima gli archivi dell'utente, come dal programma: un paziente che
    // sta entrando finisce prima, uno che arriva dopo trova l'utente sospeso e non entra.
    if (input.sospendi || input.rifiuta)
      await lockOwnerArchives(tx, found.studioId, found.id, input.utente);
    const users = await lockStudioUsers(tx, found.studioId);
    const target = users.find((u) => u.id === found.id)!;
    const t = now();
    if (input.sospendi && target.status === 'suspended' && target.suspendedByService)
      throw new Error('L’utente è già sospeso da chi gestisce il servizio: niente da fare');
    if (input.riattiva && target.status === 'active')
      throw new Error('L’utente è già attivo: per una password nuova togli --riattiva');
    if (input.sospendi && target.status === 'active' && target.roles.includes('administrator')) {
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
      // Si conferma solo la richiesta letta con --mostra, sotto il blocco degli utenti dello
      // studio, come la conferma dal programma.
      if (target.confirmationRequestedAt?.getTime() !== new Date(input.richiestaIl!).getTime())
        throw new Error(STALE_SERVER_REQUEST);
    }
    if (input.rifiuta) {
      if (!target.awaitingConfirmation)
        throw new Error(
          'L’utente non è in attesa di conferma: niente da rifiutare (per fermare un utente già confermato c’è --sospendi)',
        );
      if (target.status === 'suspended' && target.suspendedByService)
        throw new Error('L’utente è già sospeso da chi gestisce il servizio: niente da fare');
    }

    const actions: RestoreAction[] = [];
    const patch: Partial<typeof appUser.$inferInsert> = {};
    const secondFactorWasInactive = input.secondoFattore && target.totpEnabledAt === null;
    if (input.sblocca) {
      Object.assign(patch, { failedLogins: 0, lockedUntil: null });
      actions.push('sblocco');
    } else if (input.rifiuta) {
      // Resta in attesa (la richiesta non cambia), e la sospensione è del server.
      Object.assign(patch, { status: 'suspended', suspendedByService: true });
      actions.push('rifiuto');
    } else if (input.conferma) {
      if (input.riattiva) {
        Object.assign(patch, { status: 'active', suspendedByService: false });
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
        // Sospesa dal server, la riattiva solo il server (problema 7).
        Object.assign(patch, { status: 'suspended', suspendedByService: true });
        actions.push('sospensione');
      }
      if (input.riattiva) {
        Object.assign(patch, { status: 'active', suspendedByService: false });
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
    const requester = users.find((u) => u.id === target.confirmationRequestedBy)?.username ?? null;
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
          // Per conferme e rifiuti: chi aveva chiesto la conferma, e quando.
          ...(azione === 'conferma' || azione === 'rifiuto'
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
      suspendedByService: patch.suspendedByService ?? target.suspendedByService,
      awaitingConfirmation: awaitingAfter,
      secondFactorWasInactive,
    };
  });
}
