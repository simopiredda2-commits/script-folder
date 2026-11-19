import { randomBytes } from 'node:crypto';
import {
  can,
  checkFiscalCode,
  CREDENTIAL_SERVICE_LABELS,
  CREDENTIAL_SERVICES,
  opensPatientData,
  PATIENT_DATA_ROLES,
  ROLE_LABELS,
  ROLES,
  type CredentialService,
  type FiscalCodeProblem,
  type Role,
} from '@mmg/domain';
import { and, asc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { logAccess } from '../audit/access-log';
import type { Actor } from '../auth/service';
import { closeServiceSessions } from '../credentials/service';
import {
  decisionOf,
  latestSecretaryDecisions,
  recordSecretaryDecision,
  resetSecretaryDecisions,
  type DecisionRow,
} from './secretary-archives';
import type { Database } from '../db/client';
import { isLockTimeout, withLockTimeout } from '../db/locks';
import {
  appUser,
  archive,
  authChallenge,
  doctorProfile,
  patient,
  session,
  studio,
} from '../db/schema';
import { withActor, type Tx } from '../db/tx';
import { HttpError } from '../http/errors';
import { hashPassword } from '../security/password';
import { CONTROL_CHARACTERS_MESSAGE, hasControlCharacters } from '../security/plain-text';

/**
 * Utenti e ruoli dello studio (tappa 14): li gestisce l'amministratore (requisiti, «Utenti e
 * ruoli»), che non ha accesso clinico. Nessun utente si cancella: si sospende. La password
 * temporanea si vede una volta sola, nella risposta che la crea. Nel registro delle azioni di
 * amministrazione vanno l'azione, l'utente, i ruoli prima e dopo e i nomi dei campi cambiati: mai
 * password, impronte o segreti.
 *
 * Perché l'amministratore non diventi un medico o la segreteria:
 * 1. chi ha un ruolo che apre dati dei pazienti, creato dall'amministratore o a cui
 *    l'amministratore aggiunge quel ruolo, resta in attesa finché un medico titolare attivo e
 *    confermato dello studio non lo conferma, senza eccezioni, anche il primo titolare di uno studio
 *    vuoto; quando nessun titolare può confermare, conferma chi gestisce il servizio, sul server,
 *    in due passi: legge la richiesta (`pnpm utente:ripristina -- --utente NOME --mostra`) e
 *    conferma quella letta (`… --conferma --richiesta-il DATA`). L'amministratore non riceve mai
 *    la password temporanea di questi utenti: la riceve chi conferma;
 * 2. password temporanea, azzeramento del secondo fattore e sblocco dopo i tentativi falliti di
 *    quegli utenti li fa chi gestisce il servizio, sul server (`pnpm utente:ripristina`), non
 *    l'amministratore;
 * 3. un titolare con pazienti nel suo archivio non si sospende, non perde il ruolo e, se è
 *    sospeso, non si riattiva dall'amministratore (prima l'esportazione dei dati, regola 4); e
 *    dal programma non si sospende e non perde il ruolo l'ultimo titolare attivo e confermato,
 *    anche senza pazienti: senza di lui nessuno conferma; chi è sospeso da chi gestisce il
 *    servizio, qualunque ruolo abbia, lo riattiva solo il server;
 * 4. se l'amministratore corregge codice fiscale o codice regionale di un medico, le sessioni dei
 *    servizi legate a quei codici si chiudono (D111).
 */

const AREA = 'utenti';

/**
 * Azioni sugli utenti, come stanno nel registro (`details.azione`). Le ultime tre sono dei medici
 * titolari: elenco, conferma e rifiuto degli utenti in attesa. Ognuna ha la sua etichetta nel
 * registro di amministrazione (archive-service.ts).
 */
export const USER_ACTIONS = [
  'elenco',
  'creazione',
  'modifica',
  'sospensione',
  'riattivazione',
  'password_temporanea',
  'azzeramento_secondo_fattore',
  'sblocco',
  'elenco_da_confermare',
  'conferma',
  'rifiuto',
  /** Ritiro di una correzione del codice fiscale di un medico, prima che lui la confermi (D181). */
  'ritiro_codice_fiscale',
  /** Il titolare conferma la segreteria per il suo archivio, o la toglie (D181). */
  'conferma_archivio',
  'rifiuto_archivio',
] as const;
export type UserAction = (typeof USER_ACTIONS)[number];

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

/** Scelta 2: le credenziali di chi apre dati dei pazienti non le ripristina l'amministratore. */
export const CLINICAL_CREDENTIALS_REFUSAL =
  'Password e secondo fattore di medici e segreteria li ripristina chi gestisce il servizio, sul server: l’amministratore dello studio non può, perché entrerebbe al loro posto e vedrebbe i dati dei pazienti';
/**
 * Nemmeno lo sblocco dopo i tentativi falliti: chi ha la password di un medico, o la cerca,
 * riaprirebbe i tentativi quante volte vuole (revisione dei poteri dell'amministratore).
 */
export const CLINICAL_UNLOCK_REFUSAL =
  'Il blocco di medici e segreteria dopo i tentativi falliti lo toglie chi gestisce il servizio, sul server, oppure finisce da solo allo scadere del tempo: l’amministratore dello studio non può, perché riaprirebbe i tentativi su credenziali che non sono sue';

const OWNER_HAS_PATIENTS = 'Il medico titolare ha pazienti nel suo archivio';
/** Scelta 3: titolari con pazienti protetti dalla sospensione e dalla perdita del ruolo. */
export const OWNER_SUSPEND_REFUSAL = `${OWNER_HAS_PATIENTS}: prima il medico esporta i suoi dati (i dati sono del medico), poi la sospensione la fa chi gestisce il servizio, sul server`;
export const OWNER_ROLE_REMOVAL_REFUSAL = `${OWNER_HAS_PATIENTS}: senza il ruolo non potrebbe più aprirlo né esportare i suoi dati. Prima il medico esporta i suoi dati, poi chi gestisce il servizio lo sospende, sul server`;
/** Un ruolo in più lo metterebbe in attesa di conferma: fuori dal suo archivio, come sospeso. */
export const OWNER_ROLE_ADD_REFUSAL = `${OWNER_HAS_PATIENTS}: con un altro ruolo con i dati dei pazienti resterebbe in attesa di conferma, fuori dal suo archivio e senza poter esportare i suoi dati`;
/** Un titolare con pazienti sospeso (dal server) si riattiva solo dal server. */
export const OWNER_REACTIVATE_REFUSAL = `${OWNER_HAS_PATIENTS}: sospeso, lo riattiva solo chi gestisce il servizio, sul server`;
/**
 * Un titolare in attesa con pazienti nell'archivio (possibile solo se entrati prima della richiesta):
 * il rifiuto lo sospenderebbe con i pazienti, e dal programma non si riattiverebbe più. Decide chi
 * gestisce il servizio, sul server (--mostra, poi --conferma o --rifiuta).
 */
export const OWNER_REFUSE_REFUSAL = `${OWNER_HAS_PATIENTS}: il rifiuto lo sospenderebbe con i suoi pazienti. Decide chi gestisce il servizio, sul server`;

/**
 * Chi è sospeso da chi gestisce il servizio, sul server, si riattiva solo dal server, qualunque
 * ruolo abbia (seconda revisione dei poteri dell'amministratore, problema 7): dal programma la
 * riattivazione annullerebbe una decisione presa sul server e rimetterebbe in uso credenziali che
 * si volevano chiudere.
 */
export const serviceSuspendedRefusal = (username: string) =>
  `L’utente è stato sospeso da chi gestisce il servizio: lo riattiva solo lui, sul server (pnpm utente:ripristina -- --utente ${username} --riattiva)`;

/**
 * Attesa massima del blocco degli archivi di un titolare, prima di contarne i pazienti: limite di
 * buon senso, non di una norma. Un'importazione può durare minuti; senza limite la richiesta
 * resterebbe ferma con una connessione occupata (seconda revisione, problema nuovo 2).
 */
export const ARCHIVE_LOCK_TIMEOUT = '2s';
export const ARCHIVE_BUSY_REFUSAL =
  'Nell’archivio del medico è in corso una scrittura (per esempio un’importazione): riprova tra qualche minuto.';
/** I ruoli sono cambiati tra la prima lettura e il blocco: la richiesta si ripete. */
export const CHANGED_MEANWHILE =
  'L’utente è cambiato mentre lo modificavi: rileggi i suoi dati e riprova';

const LAST_OWNER =
  'È l’ultimo medico titolare attivo e confermato dello studio: senza di lui, dal programma, nessuno conferma gli utenti con i dati dei pazienti';
/** L'ultimo titolare attivo e confermato non si perde dal programma, anche senza pazienti. */
export const LAST_OWNER_SUSPEND_REFUSAL = `${LAST_OWNER}. Prima va confermato un altro medico titolare; altrimenti la sospensione la fa chi gestisce il servizio, sul server`;
export const LAST_OWNER_ROLE_REMOVAL_REFUSAL = `${LAST_OWNER}. Prima va confermato un altro medico titolare; altrimenti lo fa chi gestisce il servizio, sul server`;
export const LAST_OWNER_ROLE_ADD_REFUSAL = `${LAST_OWNER}: con un altro ruolo con i dati dei pazienti resterebbe in attesa di conferma. Prima va confermato un altro medico titolare`;

export const NOT_CONFIRMER = 'Gli utenti li conferma un medico titolare dello studio';
const NOT_AWAITING = 'L’utente non è in attesa di conferma';
const SUSPENDED_CONFIRM = 'L’utente è sospeso: prima lo riattiva l’amministratore';
const STALE_REQUEST =
  'La richiesta è cambiata dopo che l’hai letta: controlla di nuovo i dati dell’utente e conferma';

const AWAITING_NOTICE =
  'In attesa della conferma di un medico titolare dello studio: finché non è confermato, l’utente non entra.';
const PASSWORD_TO_OWNER =
  'La password temporanea la riceve il medico titolare che lo conferma, da consegnare di persona; il secondo fattore si attiva al primo accesso.';
const FRESH_CREDENTIALS_NOTICE =
  'Alla conferma il medico titolare riceve una password temporanea nuova, da consegnare di persona: quella di adesso non varrà più e il secondo fattore si attiverà di nuovo.';
const OWN_CREDENTIALS_NOTICE =
  'Dopo la conferma l’utente rientra con la sua password e il suo secondo fattore.';
const STILL_AWAITING_NOTICE =
  'L’utente resta in attesa della conferma di un medico titolare: la richiesta ha la data di adesso.';
/**
 * Nessun titolare attivo e confermato che possa confermare (studio nuovo, titolari sospesi o in
 * attesa): conferma chi gestisce il servizio, sul server, e consegna lui la password. In due passi
 * (seconda revisione, problema nuovo 1): prima legge la richiesta, poi conferma quella che ha letto,
 * con la sua data. La data non è nell'avviso: la stampa solo il primo passo.
 */
export const serverConfirmNotice = (username: string) =>
  `Nello studio non c’è un medico titolare attivo e confermato che possa confermarlo: lo conferma chi gestisce il servizio, sul server. Prima legge la richiesta e la controlla con l’interessato (pnpm utente:ripristina -- --utente ${username} --mostra), poi conferma la richiesta letta, con la data che il primo comando stampa (pnpm utente:ripristina -- --utente ${username} --conferma --richiesta-il DATA), e consegna di persona una password temporanea nuova; il secondo fattore si attiva al primo accesso.`;
const WITHDRAWN_NOTICE =
  'Senza ruoli con i dati dei pazienti la conferma non serve più: la richiesta è ritirata.';

/**
 * Testo scritto dall'amministratore: senza caratteri di controllo o invisibili, perché il server lo
 * stampa sul terminale nella conferma (terza revisione, D179).
 */
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((v) => !hasControlCharacters(v), CONTROL_CHARACTERS_MESSAGE);
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

/**
 * Conferma: la data della richiesta che il titolare ha letto. Se nel frattempo l'amministratore
 * ha cambiato l'utente (ruoli, nome, dati del medico), la richiesta ha una data nuova e la conferma
 * si rifiuta: nessuno conferma ciò che non ha visto.
 */
export const confirmBody = z.object({ richiestaIl: z.iso.datetime({ offset: true }) }).strict();

type DoctorBody = z.infer<typeof doctorBody>;

const FISCAL_CODE_PROBLEMS: Record<FiscalCodeProblem, string> = {
  lunghezza: 'servono 16 caratteri',
  struttura: 'lettere e cifre non sono al loro posto',
  giorno: 'il giorno di nascita non esiste',
  controllo: 'l’ultimo carattere, di controllo, non torna',
};

/**
 * Password temporanea casuale, come quelle dei dati dimostrativi: 16 caratteri. Per ora non
 * scade: la durata è da completare (domanda per la fermata).
 */
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
  awaitingConfirmation: appUser.awaitingConfirmation,
  confirmationRequestedBy: appUser.confirmationRequestedBy,
  confirmationRequestedAt: appUser.confirmationRequestedAt,
  confirmationIssuesPassword: appUser.confirmationIssuesPassword,
  confirmedBy: appUser.confirmedBy,
  confirmedAt: appUser.confirmedAt,
  suspendedByService: appUser.suspendedByService,
};
const profileColumns = {
  userId: doctorProfile.userId,
  fiscalCode: doctorProfile.fiscalCode,
  pendingFiscalCode: doctorProfile.pendingFiscalCode,
  pendingFiscalCodeBy: doctorProfile.pendingFiscalCodeBy,
  pendingFiscalCodeAt: doctorProfile.pendingFiscalCodeAt,
  regionalCode: doctorProfile.regionalCode,
  asl: doctorProfile.asl,
  firstName: doctorProfile.firstName,
  lastName: doctorProfile.lastName,
};
const archiveColumns = { id: archive.id, name: archive.name, ownerUserId: archive.ownerUserId };

export interface UserRow {
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
  awaitingConfirmation: boolean;
  confirmationRequestedBy: string | null;
  confirmationRequestedAt: Date | null;
  confirmationIssuesPassword: boolean;
  confirmedBy: string | null;
  confirmedAt: Date | null;
  /** Sospeso da chi gestisce il servizio: si riattiva solo dal server. */
  suspendedByService: boolean;
}
interface ProfileRow {
  userId: string;
  fiscalCode: string | null;
  /** Correzione proposta dall'amministratore, in attesa del medico (D181). */
  pendingFiscalCode: string | null;
  pendingFiscalCodeBy: string | null;
  pendingFiscalCodeAt: Date | null;
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

const roleList = (roles: readonly Role[]) =>
  roles.map((c) => ({ codice: c, nome: ROLE_LABELS[c] }));

interface ViewContext {
  actorId: string;
  t: Date;
  /** Nome mostrato degli utenti dello studio, per chi ha chiesto o dato la conferma. */
  names: Map<string, string>;
  /** Utenti con pazienti negli archivi di cui sono titolari. */
  withPatients: Set<string>;
  /** Titolari attivi e confermati dello studio: quelli che possono confermare. */
  confirmers: Set<string>;
  /** Archivi dello studio e decisioni dei titolari sulla segreteria (D181). */
  archives: ArchiveRow[];
  secretaryDecisions: Map<string, DecisionRow>;
}

function view(u: UserRow, p: ProfileRow | null, a: ArchiveRow | null, c: ViewContext) {
  const who = (id: string | null) => (id ? (c.names.get(id) ?? null) : null);
  return {
    id: u.id,
    nomeUtente: u.username,
    nome: u.displayName,
    email: u.email,
    ruoli: roleList(u.roles),
    stato: u.status === 'active' ? ('attivo' as const) : ('sospeso' as const),
    secondoFattoreAttivo: u.totpEnabledAt !== null,
    bloccatoFinoA: u.lockedUntil && u.lockedUntil > c.t ? u.lockedUntil.toISOString() : null,
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
          /** La correzione del codice fiscale in attesa del medico: fino ad allora vale l'altro. */
          correzioneCodiceFiscale: p.pendingFiscalCode
            ? {
                proposto: p.pendingFiscalCode,
                da: who(p.pendingFiscalCodeBy),
                il: p.pendingFiscalCodeAt?.toISOString() ?? null,
              }
            : null,
        }
      : null,
    archivio: a ? { id: a.id, nome: a.name } : null,
    io: u.id === c.actorId,
    /** In attesa della conferma di un medico titolare: non entra (scelta 1). */
    inAttesaDiConferma: u.awaitingConfirmation,
    richiestaDiConferma:
      u.awaitingConfirmation && u.confirmationRequestedAt
        ? { da: who(u.confirmationRequestedBy), il: u.confirmationRequestedAt.toISOString() }
        : null,
    confermato:
      !u.awaitingConfirmation && u.confirmedAt
        ? { da: who(u.confirmedBy), il: u.confirmedAt.toISOString() }
        : null,
    /**
     * Password, secondo fattore e sblocco dopo i tentativi falliti li fa chi gestisce il servizio,
     * sul server (scelta 2).
     */
    ripristinoDalServizio: opensPatientData(u.roles),
    /**
     * Titolare con pazienti: l'amministratore non lo sospende, non gli toglie il ruolo e, se è
     * sospeso, non lo riattiva.
     */
    titolareConPazienti: u.roles.includes('owner_doctor') && c.withPatients.has(u.id),
    /** L'ultimo titolare attivo e confermato: dal programma non si sospende e non perde il ruolo. */
    ultimoTitolare: c.confirmers.size === 1 && c.confirmers.has(u.id),
    /** In attesa e nessun titolare può confermarlo: lo conferma chi gestisce il servizio. */
    confermaDalServizio: u.awaitingConfirmation && c.confirmers.size === 0,
    /** Sospeso da chi gestisce il servizio, sul server: dal programma non si riattiva. */
    sospesoDalServizio: u.status === 'suspended' && u.suspendedByService,
    /**
     * Per la segreteria, archivio per archivio: confermata dal titolare, tolta, o da confermare
     * (D181). In medicina di gruppo ogni titolare decide per il suo.
     */
    archiviSegreteria: u.roles.includes('secretary')
      ? c.archives.map((a) => {
          const d = c.secretaryDecisions.get(`${a.id}:${u.id}`);
          return {
            archivio: { id: a.id, nome: a.name },
            stato: decisionOf(c.secretaryDecisions, a.id, u.id),
            da: d ? who(d.decidedBy) : null,
            il: d?.decidedAt.toISOString() ?? null,
          };
        })
      : null,
  };
}

export type UserView = ReturnType<typeof view>;

/** Un utente in attesa, come lo vede il medico titolare che deve confermarlo. */
function pendingView(u: UserRow, p: ProfileRow | null, names: Map<string, string>) {
  return {
    id: u.id,
    nomeUtente: u.username,
    nome: u.displayName,
    email: u.email,
    ruoli: roleList(u.roles),
    stato: u.status === 'active' ? ('attivo' as const) : ('sospeso' as const),
    inAttesaDiConferma: u.awaitingConfirmation,
    creatoIl: u.createdAt.toISOString(),
    /** Chi ha creato o cambiato l'utente, e quando: la conferma vale per questa richiesta. */
    richiesta: {
      da: u.confirmationRequestedBy ? (names.get(u.confirmationRequestedBy) ?? null) : null,
      il: u.confirmationRequestedAt?.toISOString() ?? null,
    },
    /** Alla conferma il titolare riceve la password temporanea da consegnare di persona. */
    passwordAllaConferma: u.confirmationIssuesPassword,
    medico: p
      ? {
          nome: p.firstName,
          cognome: p.lastName,
          codiceFiscale: p.fiscalCode,
          codiceFiscaleInAttesaDelMedico: p.pendingFiscalCode,
        }
      : null,
  };
}

/** Chiude le sessioni aperte dell'utente e i passaggi d'accesso a metà. */
export async function closeSessions(tx: Tx, userId: string, t: Date): Promise<number> {
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
 * Gli utenti dello studio, bloccati fino alla fine della transazione, dopo la riga dello studio:
 * due azioni insieme sugli utenti dello stesso studio vanno in fila, anche quando una crea un
 * utente (una riga che il blocco delle righe esistenti non vede). Così due amministratori non
 * lasciano lo studio senza amministratori e non nascono due «primi titolari». «No key update» non
 * ferma le righe nuove del registro che puntano agli utenti e allo studio.
 */
export async function lockStudioUsers(tx: Tx, studioId: string): Promise<UserRow[]> {
  await tx
    .select({ id: studio.id })
    .from(studio)
    .where(eq(studio.id, studioId))
    .for('no key update');
  return tx
    .select(userColumns)
    .from(appUser)
    .where(eq(appUser.studioId, studioId))
    .orderBy(asc(appUser.id))
    .for('no key update');
}

/** Utenti con pazienti negli archivi di cui sono titolari (scelta 3). */
async function ownersWithPatients(
  q: Database | Tx,
  studioId: string,
  userIds?: readonly string[],
): Promise<Set<string>> {
  const rows = await q
    .selectDistinct({ ownerUserId: archive.ownerUserId })
    .from(archive)
    .innerJoin(patient, eq(patient.archiveId, archive.id))
    .where(
      and(
        eq(archive.studioId, studioId),
        userIds ? inArray(archive.ownerUserId, [...userIds]) : undefined,
      ),
    );
  return new Set(rows.map((r) => r.ownerUserId));
}

/** Medico titolare attivo e confermato: può confermare gli utenti in attesa. */
export const isActiveConfirmedOwner = (
  u: Pick<UserRow, 'status' | 'awaitingConfirmation' | 'roles'>,
) => u.status === 'active' && !u.awaitingConfirmation && u.roles.includes('owner_doctor');

/** Titolari attivi e già confermati dello studio, tranne `exceptId`. */
export const otherActiveOwners = (users: readonly UserRow[], exceptId: string | null) =>
  users.filter((u) => u.id !== exceptId && isActiveConfirmedOwner(u));

/**
 * Blocca (FOR UPDATE) le righe degli archivi del titolare, prima di contarne i pazienti. Un
 * paziente che sta entrando tiene la chiave esterna sull'archivio (FOR KEY SHARE) e, nelle strade
 * che creano pazienti, anche FOR SHARE (patients/archive-owner.ts): tutti e due vanno in conflitto
 * con questo blocco. Così il conteggio aspetta la fine di quella transazione e vede il paziente
 * (revisione dei poteri dell'amministratore, problema 6), e un paziente che arriva dopo trova il
 * titolare già sospeso e non entra (gara inversa). L'attesa ha un tetto, ARCHIVE_LOCK_TIMEOUT:
 * allo scadere, 409 con il motivo, nel registro come gli altri rifiuti.
 *
 * Si chiama prima di lockStudioUsers (seconda revisione, problema nuovo 2): mentre aspetta
 * l'archivio, la richiesta non tiene fermi gli utenti dello studio e quindi i loro accessi. Nessuno
 * stallo reciproco: chi scrive pazienti blocca l'archivio e prende sullo studio e sugli utenti solo
 * FOR KEY SHARE, compatibile con lockStudioUsers; le sole strade che bloccano sia gli archivi di un
 * titolare sia gli utenti dello studio (sospensione, riattivazione e ruoli, qui) li prendono in
 * quest'ordine, e se dopo il blocco degli utenti l'utente risulta titolare senza che i suoi archivi
 * siano bloccati, la richiesta si ferma (CHANGED_MEANWHILE) invece di bloccarli nell'ordine inverso.
 */
export async function lockOwnerArchives(
  tx: Tx,
  studioId: string,
  userId: string,
  username: string,
): Promise<void> {
  try {
    await withLockTimeout(tx, ARCHIVE_LOCK_TIMEOUT, () =>
      tx
        .select({ id: archive.id })
        .from(archive)
        .where(and(eq(archive.studioId, studioId), eq(archive.ownerUserId, userId)))
        .for('update'),
    );
  } catch (e) {
    if (isLockTimeout(e)) throw new Refusal(409, ARCHIVE_BUSY_REFUSAL, username);
    throw e;
  }
}

/** Il titolare ha pazienti nei suoi archivi? I suoi archivi vanno bloccati prima. */
async function ownerHasPatients(tx: Tx, studioId: string, userId: string): Promise<boolean> {
  return (await ownersWithPatients(tx, studioId, [userId])).has(userId);
}

function ensureOtherActiveAdmin(users: readonly UserRow[], target: UserRow) {
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

/** Avviso sulle sessioni dei servizi chiuse dopo una correzione dei codici del medico. */
export function servicesNotice(what: string, closed: readonly CredentialService[]): string {
  const list = closed.map((s) => CREDENTIAL_SERVICE_LABELS[s]).join(' e ');
  return closed.length === 1
    ? `${what} del medico cambiato: chiusa la sua sessione ${list}. Il medico la riattiva da «Credenziali dei servizi».`
    : `${what} del medico cambiato: chiuse le sue sessioni ${list}. Il medico le riattiva da «Credenziali dei servizi».`;
}

interface DoneDetails {
  azione: UserAction;
  utente: string;
  utenteId: string;
  ruoliPrima: Role[];
  ruoliDopo: Role[];
  campi: string[];
  sessioniChiuse?: number;
  /** Dopo l'azione l'utente è in attesa della conferma di un titolare (scelta 1). */
  attesaConferma?: boolean;
  /** Senza più ruoli con i dati dei pazienti, la richiesta di conferma è ritirata. */
  richiestaRitirata?: boolean;
  /** Sessioni dei servizi del medico chiuse dopo la correzione dei suoi codici (scelta 4). */
  sessioniServiziChiuse?: CredentialService[];
  /** Il codice fiscale corretto aspetta la conferma del medico (D181). */
  codiceFiscaleInAttesaDelMedico?: boolean;
  /** L'archivio su cui il titolare ha deciso per la segreteria (D181). */
  archivio?: string;
  /** Per conferme e rifiuti: chi aveva chiesto la conferma, e quando. */
  richiestaDa?: string | null;
  richiestaIl?: string | null;
}

/** Segreteria e archivi in medicina di gruppo (D181). */
export const SECRETARY_OWN_ARCHIVE_NOTICE =
  'La segreteria lavora sul tuo archivio. Sugli archivi degli altri titolari dello studio dopo la loro conferma.';
export const SECRETARY_ARCHIVES_RESET_NOTICE =
  'Ruolo di segreteria cambiato: le conferme dei titolari per i loro archivi non valgono più, ognuno la conferma di nuovo per il suo.';

/** Correzione del codice fiscale di un medico fatta dall'amministratore (D181). */
export const FISCAL_CODE_PENDING_NOTICE =
  'La correzione del codice fiscale resta in sospeso finché il medico non la conferma dal programma: fino ad allora vale quello di prima, anche per i servizi.';

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

  const logDone = (tx: Tx, actor: Actor, details: DoneDetails) =>
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

  /** Solo un medico titolare conferma o rifiuta gli utenti in attesa; i rifiuti nel registro. */
  async function requireConfirmer(actor: Actor, azione: UserAction): Promise<void> {
    if (can(actor, 'studio.confirm_users').allowed) return;
    await logRefusal(actor, azione, null, NOT_CONFIRMER);
    throw new HttpError(403, NOT_CONFIRMER);
  }

  /**
   * Esegue un'azione sugli utenti. Il permesso si controlla anche qui, non solo nella rotta: una
   * rotta nuova senza controllo non apre nulla. Se una regola rifiuta, la transazione si annulla e il
   * rifiuto si registra.
   */
  async function guarded<T>(
    actor: Actor,
    azione: UserAction,
    fn: () => Promise<T>,
    check: (actor: Actor, azione: UserAction) => Promise<void> = requireAdmin,
  ): Promise<T> {
    await check(actor, azione);
    try {
      return await fn();
    } catch (e) {
      if (e instanceof Refusal) await logRefusal(actor, azione, e.target || null, e.message);
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

  async function studioNames(q: Database | Tx, studioId: string): Promise<Map<string, string>> {
    const rows = await q
      .select({ id: appUser.id, name: appUser.displayName })
      .from(appUser)
      .where(eq(appUser.studioId, studioId));
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  async function profileOf(q: Database | Tx, userId: string): Promise<ProfileRow | null> {
    const [p] = await q
      .select(profileColumns)
      .from(doctorProfile)
      .where(eq(doctorProfile.userId, userId));
    return p ?? null;
  }

  /** I titolari attivi e confermati dello studio: chi può confermare gli utenti in attesa. */
  async function confirmersOf(q: Database | Tx, studioId: string): Promise<Set<string>> {
    const rows = await q
      .select({
        id: appUser.id,
        status: appUser.status,
        awaitingConfirmation: appUser.awaitingConfirmation,
        roles: appUser.roles,
      })
      .from(appUser)
      .where(eq(appUser.studioId, studioId));
    return new Set(rows.filter(isActiveConfirmedOwner).map((r) => r.id));
  }

  async function one(actor: Actor, id: string): Promise<UserView> {
    const u = await targetOf(db, actor, id);
    const archives = await db
      .select(archiveColumns)
      .from(archive)
      .where(eq(archive.studioId, actor.studioId))
      .orderBy(asc(archive.name));
    return view(u, await profileOf(db, id), await ownArchive(db, actor, id), {
      actorId: actor.userId,
      t: now(),
      names: await studioNames(db, actor.studioId),
      withPatients: await ownersWithPatients(db, actor.studioId, [id]),
      confirmers: await confirmersOf(db, actor.studioId),
      archives,
      secretaryDecisions: await latestSecretaryDecisions(db, {
        archiveIds: archives.map((a) => a.id),
        userIds: [id],
      }),
    });
  }

  async function pendingOne(actor: Actor, id: string) {
    const u = await targetOf(db, actor, id);
    return pendingView(u, await profileOf(db, id), await studioNames(db, actor.studioId));
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
        pendingFiscalCode: doctorProfile.pendingFiscalCode,
        regionalCode: doctorProfile.regionalCode,
      })
      .from(doctorProfile)
      .innerJoin(appUser, eq(appUser.id, doctorProfile.userId))
      .where(
        and(
          eq(appUser.studioId, actor.studioId),
          or(
            eq(doctorProfile.fiscalCode, d.fiscalCode),
            // Anche una correzione in attesa di un altro medico (D181): due medici con lo stesso
            // codice, dopo le due conferme, non devono esserci.
            eq(doctorProfile.pendingFiscalCode, d.fiscalCode),
            d.regionalCode ? eq(doctorProfile.regionalCode, d.regionalCode) : undefined,
          ),
        ),
      );
    const others = rows.filter((r) => r.userId !== exceptUserId);
    if (others.some((r) => r.fiscalCode === d.fiscalCode || r.pendingFiscalCode === d.fiscalCode))
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
    const context: ViewContext = {
      actorId: actor.userId,
      t,
      names: new Map(users.map((u) => [u.id, u.displayName])),
      withPatients: await ownersWithPatients(db, actor.studioId),
      confirmers: new Set(users.filter(isActiveConfirmedOwner).map((u) => u.id)),
      archives,
      secretaryDecisions: await latestSecretaryDecisions(db, {
        archiveIds: archives.map((a) => a.id),
        userIds: users.filter((u) => u.roles.includes('secretary')).map((u) => u.id),
      }),
    };
    return {
      utenti: users.map((u) =>
        view(
          u,
          profiles.find((p) => p.userId === u.id) ?? null,
          archives.find((a) => a.ownerUserId === u.id) ?? null,
          context,
        ),
      ),
      ruoli: roleList(ROLES),
    };
  }

  /**
   * Utente nuovo, con una password temporanea da cambiare al primo accesso (il secondo fattore si
   * attiva allo stesso accesso). Per un medico la riga del profilo; per un titolare il suo archivio.
   * Con un ruolo che apre dati dei pazienti l'utente resta in attesa della conferma, sempre, anche
   * il primo titolare di uno studio vuoto (nessuna eccezione di avvio): la password temporanea non
   * la riceve l'amministratore ma chi conferma, cioè un titolare attivo e confermato oppure, se non
   * ce n'è uno, chi gestisce il servizio, sul server.
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
    let created: { id: string; awaiting: boolean; noConfirmer: boolean };
    try {
      created = await withActor(db, actor.userId, async (tx) => {
        const users = await lockStudioUsers(tx, actor.studioId);
        const awaiting = opensPatientData(roles);
        const noConfirmer = otherActiveOwners(users, null).length === 0;
        const t = now();
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
            ...(awaiting
              ? {
                  awaitingConfirmation: true,
                  confirmationRequestedBy: actor.userId,
                  confirmationRequestedAt: t,
                  confirmationIssuesPassword: true,
                }
              : {}),
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
          attesaConferma: awaiting,
        });
        return { id: userId, awaiting, noConfirmer };
      });
    } catch (e) {
      if (isUniqueViolation(e, 'app_user_username_key')) throw new HttpError(409, USERNAME_TAKEN);
      throw e;
    }
    return {
      utente: await one(actor, created.id),
      // In attesa: la password resta sconosciuta a tutti, la riceve chi conferma.
      ...(created.awaiting ? {} : { passwordTemporanea: password }),
      avvisi: created.awaiting
        ? [
            AWAITING_NOTICE,
            created.noConfirmer ? serverConfirmNotice(body.nomeUtente) : PASSWORD_TO_OWNER,
          ]
        : [],
    };
  }

  /**
   * Nome, email, ruoli e dati del medico. Nessuno cambia i propri ruoli; non si toglie l'ultimo
   * amministratore attivo; il ruolo di titolare porta il suo archivio, se manca. Togliere un ruolo
   * non cancella nulla: la risposta dice che cosa resta. Un ruolo nuovo con i dati dei pazienti
   * mette l'utente in attesa della conferma, sempre (le sue sessioni si chiudono); a un titolare
   * con pazienti, e all'ultimo titolare attivo e confermato, il ruolo non si toglie e non se ne
   * aggiungono altri con i dati dei pazienti. Se cambiano codice fiscale o codice regionale del
   * medico, le sessioni dei servizi legate a quei codici si chiudono.
   */
  async function update(actor: Actor, id: string, body: z.infer<typeof updateUserBody>) {
    return guarded(actor, 'modifica', async () => {
      const doctor = body.medico ? doctorValues(body.medico) : null;
      const newRoles = (u: UserRow) => (body.ruoli ? uniqueRoles(body.ruoli) : u.roles);
      // Un titolare che perde il ruolo, o che con un ruolo in più con i dati dei pazienti andrebbe
      // in attesa: i suoi pazienti si contano, con gli archivi bloccati.
      const touchesOwner = (u: UserRow) => {
        const after = newRoles(u);
        if (sameRoles(u.roles, after) || !u.roles.includes('owner_doctor')) return false;
        const added = after.filter((r) => PATIENT_DATA_ROLES.includes(r) && !u.roles.includes(r));
        return !after.includes('owner_doctor') || (added.length > 0 && !u.awaitingConfirmation);
      };
      const ownRolesRefusal = (u: UserRow) =>
        new Refusal(
          403,
          'Non puoi cambiare i tuoi ruoli: lo fa un altro amministratore',
          u.username,
        );
      const notices = await withActor(db, actor.userId, async (tx) => {
        // Prima lettura senza blocchi: se serve, gli archivi del titolare si bloccano prima degli
        // utenti dello studio (problema nuovo 2).
        const pre = await targetOf(tx, actor, id);
        if (pre.id === actor.userId && !sameRoles(pre.roles, newRoles(pre)))
          throw ownRolesRefusal(pre);
        const archivesLocked = touchesOwner(pre);
        if (archivesLocked) await lockOwnerArchives(tx, actor.studioId, id, pre.username);
        const users = await lockStudioUsers(tx, actor.studioId);
        const target = users.find((u) => u.id === id);
        if (!target) throw new HttpError(404, 'Utente non trovato');
        const before = target.roles;
        const after = newRoles(target);
        const rolesChanged = !sameRoles(before, after);
        if (rolesChanged && target.id === actor.userId) throw ownRolesRefusal(target);
        if (
          rolesChanged &&
          before.includes('administrator') &&
          !after.includes('administrator') &&
          target.status === 'active'
        )
          ensureOtherActiveAdmin(users, target);
        // Ruoli con i dati dei pazienti che l'utente non aveva.
        const added = after.filter((r) => PATIENT_DATA_ROLES.includes(r) && !before.includes(r));
        const keepsRole = after.includes('owner_doctor');
        if (touchesOwner(target)) {
          // Diventato titolare dopo la prima lettura: gli archivi non sono bloccati, e bloccarli
          // adesso, dopo gli utenti, potrebbe stallare con un'altra richiesta.
          if (!archivesLocked) throw new Refusal(409, CHANGED_MEANWHILE, target.username);
          if (await ownerHasPatients(tx, actor.studioId, id))
            throw new Refusal(
              409,
              keepsRole ? OWNER_ROLE_ADD_REFUSAL : OWNER_ROLE_REMOVAL_REFUSAL,
              target.username,
            );
          // L'ultimo titolare attivo e confermato non si perde dal programma, anche senza pazienti.
          if (isActiveConfirmedOwner(target) && otherActiveOwners(users, id).length === 0)
            throw new Refusal(
              409,
              keepsRole ? LAST_OWNER_ROLE_ADD_REFUSAL : LAST_OWNER_ROLE_REMOVAL_REFUSAL,
              target.username,
            );
        }
        if (doctor && !isDoctor(after))
          throw new HttpError(400, 'I dati del medico valgono solo per i ruoli di medico');
        const profile = await profileOf(tx, id);
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
        // Correzione del codice fiscale di un medico confermato che ce l'ha già: resta in sospeso,
        // e vale quello di prima, finché il medico non la conferma dal programma (D181). Chi è o
        // va in attesa di conferma non ha ancora lavorato con il suo codice: la correzione vale
        // subito, e chi conferma la vede nella richiesta. Lo stesso codice di adesso, o di nuovo
        // quello proposto, non cambia nulla: la correzione si ritira a parte.
        const willAwait =
          added.length > 0 || (target.awaitingConfirmation && opensPatientData(after));
        const cfProposal =
          doctor &&
          !willAwait &&
          profile?.fiscalCode &&
          doctor.fiscalCode !== profile.fiscalCode &&
          doctor.fiscalCode !== profile.pendingFiscalCode
            ? doctor.fiscalCode
            : null;
        const written = doctor
          ? {
              ...doctor,
              fiscalCode: willAwait
                ? doctor.fiscalCode
                : (profile?.fiscalCode ?? doctor.fiscalCode),
            }
          : null;
        const doctorChanges = written ? changedDoctorFields(profile ?? undefined, written) : [];
        campi.push(...doctorChanges);
        if (cfProposal) campi.push('medico.codiceFiscale');
        const own = await ownArchive(tx, actor, id);
        // Un titolare senza archivio (dati di prima) lo riceve anche se nient'altro cambia.
        const needsArchive = after.includes('owner_doctor') && !own;
        if (needsArchive) campi.push('archivio');
        if (campi.length === 0) throw new HttpError(400, 'Niente da cambiare');

        // Conferma (scelta 1, senza eccezione di avvio): chi riceve un ruolo nuovo con i dati dei
        // pazienti aspetta sempre; chi è già in attesa e cambia ancora aspetta con una richiesta
        // nuova.
        const t = now();
        const awaiting =
          added.length > 0 || (target.awaitingConfirmation && opensPatientData(after));
        const withdrawn = target.awaitingConfirmation && !opensPatientData(after);
        const startsWaiting = awaiting && !target.awaitingConfirmation;
        if (awaiting) {
          patch.awaitingConfirmation = true;
          patch.confirmationRequestedBy = actor.userId;
          patch.confirmationRequestedAt = t;
          // Chi prima non apriva dati dei pazienti può avere credenziali note all'amministratore.
          patch.confirmationIssuesPassword =
            (target.awaitingConfirmation && target.confirmationIssuesPassword) ||
            !opensPatientData(before);
        } else if (withdrawn) {
          patch.awaitingConfirmation = false;
          patch.confirmationRequestedBy = null;
          patch.confirmationRequestedAt = null;
          patch.confirmationIssuesPassword = false;
        }

        if (Object.keys(patch).length > 0)
          await tx.update(appUser).set(patch).where(eq(appUser.id, id));
        if (
          written &&
          (doctorChanges.length > 0 || cfProposal || (willAwait && profile?.pendingFiscalCode))
        ) {
          const set = {
            ...written,
            ...(cfProposal
              ? {
                  pendingFiscalCode: cfProposal,
                  pendingFiscalCodeBy: actor.userId,
                  pendingFiscalCodeAt: t,
                }
              : {}),
            // In attesa di conferma il codice scritto vale subito: una correzione di prima decade.
            ...(willAwait && profile?.pendingFiscalCode
              ? { pendingFiscalCode: null, pendingFiscalCodeBy: null, pendingFiscalCodeAt: null }
              : {}),
          };
          await tx
            .insert(doctorProfile)
            .values({ userId: id, ...set })
            .onConflictDoUpdate({ target: doctorProfile.userId, set });
        }
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
        if (cfProposal) out.push(FISCAL_CODE_PENDING_NOTICE);

        // Codici del medico corretti (scelta 4): le sessioni dei servizi legate a quei codici
        // si chiudono. Il codice fiscale vale per tutti e due i servizi (D102, D111), il codice
        // regionale per il servizio regionale.
        const cfChanged = !!profile && doctorChanges.includes('medico.codiceFiscale');
        const regionalChanged = !!profile && doctorChanges.includes('medico.codiceRegionale');
        let servicesClosed: CredentialService[] = [];
        if (cfChanged || regionalChanged) {
          servicesClosed = await closeServiceSessions(tx, {
            userId: id,
            services: cfChanged ? CREDENTIAL_SERVICES : ['rupar_piemonte'],
            at: t,
            workstation: actor.workstation,
            detail: cfChanged
              ? 'codice fiscale del medico corretto dall’amministratore'
              : 'codice regionale del medico corretto dall’amministratore',
          });
          if (servicesClosed.length > 0)
            out.push(
              servicesNotice(cfChanged ? 'Codice fiscale' : 'Codice regionale', servicesClosed),
            );
        }

        // Il ruolo di segreteria tolto o ridato: le conferme dei titolari per i loro archivi non
        // valgono più, ognuno decide di nuovo (D181).
        if (before.includes('secretary') !== after.includes('secretary')) {
          const reset = await resetSecretaryDecisions(tx, {
            studioId: actor.studioId,
            userId: id,
            by: actor.userId,
            at: t,
          });
          if (reset > 0 && after.includes('secretary')) out.push(SECRETARY_ARCHIVES_RESET_NOTICE);
        }

        // Chi va in attesa non lavora più finché non è confermato.
        const sessionsClosed = startsWaiting ? await closeSessions(tx, id, t) : 0;
        const noConfirmer = awaiting && otherActiveOwners(users, id).length === 0;
        if (startsWaiting) {
          out.push(AWAITING_NOTICE);
          if (sessionsClosed > 0) out.push(`Sessioni aperte chiuse: ${sessionsClosed}.`);
          out.push(
            noConfirmer
              ? serverConfirmNotice(target.username)
              : patch.confirmationIssuesPassword
                ? FRESH_CREDENTIALS_NOTICE
                : OWN_CREDENTIALS_NOTICE,
          );
        } else if (awaiting) {
          out.push(STILL_AWAITING_NOTICE);
          if (noConfirmer) out.push(serverConfirmNotice(target.username));
        }
        if (withdrawn) out.push(WITHDRAWN_NOTICE);

        await logDone(tx, actor, {
          azione: 'modifica',
          utente: target.username,
          utenteId: id,
          ruoliPrima: before,
          ruoliDopo: after,
          campi,
          attesaConferma: awaiting,
          ...(withdrawn ? { richiestaRitirata: true } : {}),
          ...(startsWaiting ? { sessioniChiuse: sessionsClosed } : {}),
          ...(servicesClosed.length > 0 ? { sessioniServiziChiuse: servicesClosed } : {}),
          ...(cfProposal ? { codiceFiscaleInAttesaDelMedico: true } : {}),
        });
        return out;
      });
      return { utente: await one(actor, id), avvisi: notices };
    });
  }

  /**
   * Sospensione (le sessioni si chiudono subito) e riattivazione. Mai sé stessi; mai un titolare
   * con pazienti (scelta 3), né per sospenderlo né per riattivarlo: lo fa chi gestisce il servizio,
   * sul server; mai l'ultimo titolare attivo e confermato, anche senza pazienti; mai la
   * riattivazione di chi è stato sospeso da chi gestisce il servizio, qualunque ruolo abbia: lo
   * riattiva il server (problema 7). Chi era in attesa di conferma, riattivato, resta in attesa con
   * una richiesta nuova: torna nell'elenco dei titolari. Gli archivi di un titolare si bloccano
   * prima degli utenti dello studio, con un'attesa massima (problema nuovo 2).
   */
  async function setStatus(actor: Actor, id: string, active: boolean) {
    const azione: UserAction = active ? 'riattivazione' : 'sospensione';
    return guarded(actor, azione, async () => {
      const r = await withActor(db, actor.userId, async (tx) => {
        const pre = await targetOf(tx, actor, id);
        if (pre.id === actor.userId)
          throw new Refusal(
            403,
            active
              ? 'Il tuo utente lo riattiva un altro amministratore'
              : 'Non puoi sospendere il tuo utente',
            pre.username,
          );
        const archivesLocked = pre.roles.includes('owner_doctor');
        if (archivesLocked) await lockOwnerArchives(tx, actor.studioId, id, pre.username);
        const users = await lockStudioUsers(tx, actor.studioId);
        const target = users.find((u) => u.id === id);
        if (!target) throw new HttpError(404, 'Utente non trovato');
        if (active && target.status === 'active') throw new HttpError(409, 'L’utente è già attivo');
        if (!active && target.status === 'suspended')
          throw new HttpError(409, 'L’utente è già sospeso');
        if (active && target.suspendedByService)
          throw new Refusal(409, serviceSuspendedRefusal(target.username), target.username);
        if (!active && target.roles.includes('administrator'))
          ensureOtherActiveAdmin(users, target);
        if (target.roles.includes('owner_doctor')) {
          // Diventato titolare dopo la prima lettura: gli archivi non sono bloccati.
          if (!archivesLocked) throw new Refusal(409, CHANGED_MEANWHILE, target.username);
          if (await ownerHasPatients(tx, actor.studioId, id))
            throw new Refusal(
              409,
              active ? OWNER_REACTIVATE_REFUSAL : OWNER_SUSPEND_REFUSAL,
              target.username,
            );
        }
        if (!active && isActiveConfirmedOwner(target) && otherActiveOwners(users, id).length === 0)
          throw new Refusal(409, LAST_OWNER_SUSPEND_REFUSAL, target.username);
        const t = now();
        const reRequest = active && target.awaitingConfirmation;
        await tx
          .update(appUser)
          .set({
            status: active ? 'active' : 'suspended',
            // Una sospensione dal programma la riattiva il programma.
            suspendedByService: false,
            ...(reRequest
              ? { confirmationRequestedBy: actor.userId, confirmationRequestedAt: t }
              : {}),
          })
          .where(eq(appUser.id, id));
        const n = active ? 0 : await closeSessions(tx, id, t);
        await logDone(tx, actor, {
          azione,
          utente: target.username,
          utenteId: id,
          ruoliPrima: target.roles,
          ruoliDopo: target.roles,
          campi: ['stato'],
          ...(active ? {} : { sessioniChiuse: n }),
          ...(target.awaitingConfirmation ? { attesaConferma: true } : {}),
        });
        const noConfirmer = reRequest && otherActiveOwners(users, id).length === 0;
        return { closed: n, reRequest, noConfirmer, username: target.username };
      });
      return {
        utente: await one(actor, id),
        sessioniChiuse: r.closed,
        avvisi: r.reRequest
          ? [STILL_AWAITING_NOTICE, ...(r.noConfirmer ? [serverConfirmNotice(r.username)] : [])]
          : [],
      };
    });
  }

  /**
   * Password temporanea nuova, restituita una volta sola: quella di prima non vale più, le sessioni
   * si chiudono, al prossimo accesso va cambiata. Toglie anche il blocco per tentativi falliti. Solo
   * per chi non apre dati dei pazienti (scelta 2): per medici e segreteria la fa chi gestisce il
   * servizio, sul server.
   */
  async function resetPassword(actor: Actor, id: string) {
    return guarded(actor, 'password_temporanea', async () => {
      const password = temporaryPassword();
      const passwordHash = await hashPassword(password);
      const closed = await withActor(db, actor.userId, async (tx) => {
        // Ruoli letti sotto il blocco: un ruolo clinico dato nello stesso momento non sfugge.
        const target = (await lockStudioUsers(tx, actor.studioId)).find((u) => u.id === id);
        if (!target) throw new HttpError(404, 'Utente non trovato');
        if (target.id === actor.userId)
          throw new Refusal(
            403,
            'La tua password la cambi da «Password», nel menu in alto',
            target.username,
          );
        if (opensPatientData(target.roles))
          throw new Refusal(403, CLINICAL_CREDENTIALS_REFUSAL, target.username);
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

  /**
   * Il secondo fattore si azzera: le sessioni si chiudono, al prossimo accesso si riattiva. Solo per
   * chi non apre dati dei pazienti (scelta 2).
   */
  async function resetSecondFactor(actor: Actor, id: string) {
    return guarded(actor, 'azzeramento_secondo_fattore', async () => {
      const closed = await withActor(db, actor.userId, async (tx) => {
        const target = (await lockStudioUsers(tx, actor.studioId)).find((u) => u.id === id);
        if (!target) throw new HttpError(404, 'Utente non trovato');
        if (target.id === actor.userId)
          throw new Refusal(
            403,
            'Il tuo secondo fattore lo azzera un altro amministratore',
            target.username,
          );
        if (opensPatientData(target.roles))
          throw new Refusal(403, CLINICAL_CREDENTIALS_REFUSAL, target.username);
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

  /**
   * Sblocco dopo troppi tentativi falliti: tentativi a zero, blocco tolto. Mai sé stessi. Solo per
   * chi non apre dati dei pazienti: medici e segreteria aspettano la fine del blocco, oppure li
   * sblocca chi gestisce il servizio, sul server (`pnpm utente:ripristina … --sblocca`). Non cambia
   * password né secondo fattore.
   */
  async function unlock(actor: Actor, id: string) {
    return guarded(actor, 'sblocco', async () => {
      await withActor(db, actor.userId, async (tx) => {
        // Ruoli letti sotto il blocco: un ruolo clinico dato nello stesso momento non sfugge.
        const target = (await lockStudioUsers(tx, actor.studioId)).find((u) => u.id === id);
        if (!target) throw new HttpError(404, 'Utente non trovato');
        if (target.id === actor.userId)
          throw new Refusal(
            403,
            'Il tuo utente lo sblocca un altro amministratore',
            target.username,
          );
        if (opensPatientData(target.roles))
          throw new Refusal(403, CLINICAL_UNLOCK_REFUSAL, target.username);
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

  /**
   * Gli utenti in attesa della conferma di un titolare, per i medici titolari: chi sono, con quali
   * ruoli, chi li ha creati o cambiati e quando. I sospesi (anche quelli rifiutati) non ci sono:
   * se l'amministratore li riattiva, tornano con una richiesta nuova.
   */
  async function pending(actor: Actor) {
    await requireConfirmer(actor, 'elenco_da_confermare');
    const rows = await db
      .select(userColumns)
      .from(appUser)
      .where(
        and(
          eq(appUser.studioId, actor.studioId),
          eq(appUser.awaitingConfirmation, true),
          eq(appUser.status, 'active'),
        ),
      )
      .orderBy(asc(appUser.confirmationRequestedAt), asc(appUser.username));
    const ids = rows.map((u) => u.id);
    const profiles = ids.length
      ? await db
          .select(profileColumns)
          .from(doctorProfile)
          .where(inArray(doctorProfile.userId, ids))
      : [];
    const names = await studioNames(db, actor.studioId);
    return {
      utenti: rows.map((u) =>
        pendingView(u, profiles.find((p) => p.userId === u.id) ?? null, names),
      ),
      ...(await secretariesOfMyArchive(actor)),
    };
  }

  /**
   * Le segreterie dello studio, già confermate come utenti, che il titolare non ha ancora
   * confermato per il suo archivio (D181): finché non lo fa, non lo vedono.
   */
  async function secretariesOfMyArchive(actor: Actor) {
    const mine = await ownArchive(db, actor, actor.userId);
    if (!mine) return { perArchivio: [], sulMioArchivio: [] };
    const secretaries = (
      await db
        .select(userColumns)
        .from(appUser)
        .where(
          and(
            eq(appUser.studioId, actor.studioId),
            eq(appUser.status, 'active'),
            eq(appUser.awaitingConfirmation, false),
            sql`'secretary' = any(${appUser.roles})`,
          ),
        )
        .orderBy(asc(appUser.displayName), asc(appUser.username))
    ).filter((u) => u.id !== actor.userId);
    const decisions = await latestSecretaryDecisions(db, {
      archiveIds: [mine.id],
      userIds: secretaries.map((u) => u.id),
    });
    const item = (u: UserRow) => ({
      id: u.id,
      nomeUtente: u.username,
      nome: u.displayName,
      ruoli: roleList(u.roles),
      archivio: { id: mine.id, nome: mine.name },
    });
    return {
      // Da confermare per il mio archivio: senza la mia conferma non lo vedono.
      perArchivio: secretaries
        .filter((u) => decisionOf(decisions, mine.id, u.id) === 'da_confermare')
        .map(item),
      // Lavorano sul mio archivio: le posso togliere.
      sulMioArchivio: secretaries
        .filter((u) => decisionOf(decisions, mine.id, u.id) === 'confermata')
        .map(item),
    };
  }

  /**
   * Il titolare conferma la segreteria per il suo archivio, o la toglie (D181). Vale per una
   * segreteria attiva e già confermata come utente; chi è in attesa si conferma prima come utente.
   */
  async function decideForArchive(actor: Actor, id: string, confirmed: boolean) {
    const azione: UserAction = confirmed ? 'conferma_archivio' : 'rifiuto_archivio';
    return guarded(
      actor,
      azione,
      async () => {
        await withActor(db, actor.userId, async (tx) => {
          const users = await lockStudioUsers(tx, actor.studioId);
          const target = users.find((u) => u.id === id);
          if (!target) throw new HttpError(404, 'Utente non trovato');
          ensureActiveOwner(users, actor, target);
          const mine = await ownArchive(tx, actor, actor.userId);
          if (!mine)
            throw new Refusal(409, 'Non hai un archivio tuo nello studio', target.username);
          if (!target.roles.includes('secretary'))
            throw new Refusal(
              409,
              'Solo la segreteria si conferma per un archivio',
              target.username,
            );
          if (target.awaitingConfirmation)
            throw new Refusal(
              409,
              'È in attesa di conferma come utente: prima la si conferma, nell’elenco qui sopra',
              target.username,
            );
          if (confirmed && target.status !== 'active')
            throw new Refusal(409, SUSPENDED_CONFIRM, target.username);
          const decisions = await latestSecretaryDecisions(tx, {
            archiveIds: [mine.id],
            userIds: [id],
          });
          const current = decisionOf(decisions, mine.id, id);
          if (confirmed ? current === 'confermata' : current === 'rifiutata')
            throw new HttpError(
              409,
              confirmed
                ? 'È già confermata per il tuo archivio'
                : 'Non lavora già sul tuo archivio',
            );
          const t = now();
          await recordSecretaryDecision(tx, {
            archiveId: mine.id,
            userId: id,
            decision: confirmed ? 'confermata' : 'rifiutata',
            by: actor.userId,
            at: t,
          });
          await logDone(tx, actor, {
            azione,
            utente: target.username,
            utenteId: id,
            ruoliPrima: target.roles,
            ruoliDopo: target.roles,
            campi: ['archivio'],
            archivio: mine.id,
          });
        });
        return {
          utente: await one(actor, id).catch(() => null),
          avvisi: [
            confirmed
              ? 'Confermata per il tuo archivio: da adesso la segreteria lo vede.'
              : 'Tolta dal tuo archivio: da adesso la segreteria non lo vede. Gli altri archivi non cambiano.',
          ],
        };
      },
      requireConfirmer,
    );
  }

  /**
   * Conferma di un medico titolare attivo dello studio, per la richiesta che ha letto. Agli utenti
   * nuovi e a chi prima non apriva dati dei pazienti la conferma dà credenziali nuove: password
   * temporanea, che vede solo il titolare e consegna di persona, e secondo fattore da riattivare.
   * Gli altri rientrano con le loro.
   */
  async function confirm(actor: Actor, id: string, body: z.infer<typeof confirmBody>) {
    return guarded(
      actor,
      'conferma',
      async () => {
        const password = temporaryPassword();
        const passwordHash = await hashPassword(password);
        const fresh = await withActor(db, actor.userId, async (tx) => {
          const users = await lockStudioUsers(tx, actor.studioId);
          const target = users.find((u) => u.id === id);
          if (!target) throw new HttpError(404, 'Utente non trovato');
          ensureActiveOwner(users, actor, target);
          if (target.id === actor.userId)
            throw new Refusal(
              403,
              'Il tuo utente lo conferma un altro medico titolare',
              target.username,
            );
          // I rifiuti vanno nel registro come gli altri (revisione dei poteri, problema 9).
          if (!target.awaitingConfirmation) throw new Refusal(409, NOT_AWAITING, target.username);
          if (target.status !== 'active')
            throw new Refusal(
              409,
              target.suspendedByService
                ? serviceSuspendedRefusal(target.username)
                : SUSPENDED_CONFIRM,
              target.username,
            );
          if (target.confirmationRequestedAt?.getTime() !== new Date(body.richiestaIl).getTime())
            throw new Refusal(409, STALE_REQUEST, target.username);
          const t = now();
          const issues = target.confirmationIssuesPassword;
          await tx
            .update(appUser)
            .set({
              awaitingConfirmation: false,
              confirmationIssuesPassword: false,
              confirmedBy: actor.userId,
              confirmedAt: t,
              ...(issues
                ? {
                    passwordHash,
                    mustChangePassword: true,
                    failedLogins: 0,
                    lockedUntil: null,
                    totpSecretEnc: null,
                    totpEnabledAt: null,
                    totpLastStep: null,
                  }
                : {}),
            })
            .where(eq(appUser.id, id));
          const n = issues ? await closeSessions(tx, id, t) : 0;
          // La segreteria lavora sull'archivio del titolare che la conferma; sugli altri archivi
          // dopo la conferma dei loro titolari (D181).
          const mine = target.roles.includes('secretary')
            ? await ownArchive(tx, actor, actor.userId)
            : null;
          const alreadyMine =
            !!mine &&
            decisionOf(
              await latestSecretaryDecisions(tx, { archiveIds: [mine.id], userIds: [id] }),
              mine.id,
              id,
            ) === 'confermata';
          const onMyArchive = !!mine && !alreadyMine;
          if (onMyArchive)
            await recordSecretaryDecision(tx, {
              archiveId: mine.id,
              userId: id,
              decision: 'confermata',
              by: actor.userId,
              at: t,
            });
          await logDone(tx, actor, {
            azione: 'conferma',
            utente: target.username,
            utenteId: id,
            ruoliPrima: target.roles,
            ruoliDopo: target.roles,
            campi: issues ? ['conferma', 'password', 'secondoFattore'] : ['conferma'],
            richiestaDa: requester(users, target),
            richiestaIl: target.confirmationRequestedAt?.toISOString() ?? null,
            ...(issues ? { sessioniChiuse: n } : {}),
          });
          return { issues, onMyArchive };
        });
        return {
          utente: await pendingOne(actor, id),
          ...(fresh.issues ? { passwordTemporanea: password } : {}),
          avvisi: [
            fresh.issues
              ? 'Utente confermato. Consegna di persona la password temporanea: al primo accesso l’utente attiva il secondo fattore e sceglie la sua password.'
              : 'Utente confermato: entra con la sua password e il suo secondo fattore.',
            ...(fresh.onMyArchive ? [SECRETARY_OWN_ARCHIVE_NOTICE] : []),
          ],
        };
      },
      requireConfirmer,
    );
  }

  /** Rifiuto di un medico titolare: l'utente resta senza accesso, sospeso (e ancora in attesa). */
  async function refuse(actor: Actor, id: string) {
    return guarded(
      actor,
      'rifiuto',
      async () => {
        const closed = await withActor(db, actor.userId, async (tx) => {
          // Come nella sospensione: gli archivi di un titolare si bloccano prima degli utenti dello
          // studio, così un paziente che sta entrando nel suo archivio finisce prima (e si conta) o
          // aspetta il rifiuto e poi non entra (archive-owner.ts).
          const pre = await targetOf(tx, actor, id);
          const archivesLocked = pre.roles.includes('owner_doctor');
          if (archivesLocked) await lockOwnerArchives(tx, actor.studioId, id, pre.username);
          const users = await lockStudioUsers(tx, actor.studioId);
          const target = users.find((u) => u.id === id);
          if (!target) throw new HttpError(404, 'Utente non trovato');
          ensureActiveOwner(users, actor, target);
          if (target.id === actor.userId)
            throw new Refusal(
              403,
              'Il tuo utente lo conferma un altro medico titolare',
              target.username,
            );
          if (!target.awaitingConfirmation) throw new Refusal(409, NOT_AWAITING, target.username);
          if (target.status !== 'active')
            throw new Refusal(409, 'L’utente è già sospeso', target.username);
          if (target.roles.includes('owner_doctor')) {
            // Diventato titolare dopo la prima lettura: gli archivi non sono bloccati.
            if (!archivesLocked) throw new Refusal(409, CHANGED_MEANWHILE, target.username);
            if (await ownerHasPatients(tx, actor.studioId, id))
              throw new Refusal(409, OWNER_REFUSE_REFUSAL, target.username);
          }
          const t = now();
          // Il rifiuto di un titolare dal programma lo può annullare l'amministratore, riattivando
          // l'utente con una richiesta nuova: non è una sospensione del server.
          await tx
            .update(appUser)
            .set({ status: 'suspended', suspendedByService: false })
            .where(eq(appUser.id, id));
          const n = await closeSessions(tx, id, t);
          await logDone(tx, actor, {
            azione: 'rifiuto',
            utente: target.username,
            utenteId: id,
            ruoliPrima: target.roles,
            ruoliDopo: target.roles,
            campi: ['stato'],
            sessioniChiuse: n,
            attesaConferma: true,
            richiestaDa: requester(users, target),
            richiestaIl: target.confirmationRequestedAt?.toISOString() ?? null,
          });
          return n;
        });
        return {
          utente: await pendingOne(actor, id),
          sessioniChiuse: closed,
          avvisi: [
            'Utente rifiutato: resta sospeso e non entra. Se l’amministratore lo riattiva, torna in questo elenco con una richiesta nuova.',
          ],
        };
      },
      requireConfirmer,
    );
  }

  /**
   * L'amministratore ritira una correzione del codice fiscale che il medico non ha ancora
   * confermato (D181). Resta il codice di adesso.
   */
  async function withdrawFiscalCode(actor: Actor, id: string) {
    return guarded(actor, 'ritiro_codice_fiscale', async () => {
      await withActor(db, actor.userId, async (tx) => {
        const target = await targetOf(tx, actor, id);
        const [p] = await tx
          .select({ pending: doctorProfile.pendingFiscalCode })
          .from(doctorProfile)
          .where(eq(doctorProfile.userId, id))
          .for('update');
        if (!p?.pending)
          throw new HttpError(409, 'Nessuna correzione del codice fiscale in attesa del medico');
        await tx
          .update(doctorProfile)
          .set({ pendingFiscalCode: null, pendingFiscalCodeBy: null, pendingFiscalCodeAt: null })
          .where(eq(doctorProfile.userId, id));
        await logDone(tx, actor, {
          azione: 'ritiro_codice_fiscale',
          utente: target.username,
          utenteId: id,
          ruoliPrima: target.roles,
          ruoliDopo: target.roles,
          campi: ['medico.codiceFiscale'],
        });
      });
      return { utente: await one(actor, id) };
    });
  }

  return {
    requireAdmin,
    requireConfirmer,
    list,
    withdrawFiscalCode,
    decideForArchive,
    create,
    update,
    setStatus,
    resetPassword,
    resetSecondFactor,
    unlock,
    pending,
    confirm,
    refuse,
  };
}

/** Nome utente di chi ha chiesto la conferma, per il registro. */
const requester = (users: readonly UserRow[], target: UserRow): string | null =>
  users.find((u) => u.id === target.confirmationRequestedBy)?.username ?? null;

/**
 * Chi conferma è, adesso, un medico titolare attivo dello studio: i ruoli della sessione sono
 * quelli dell'accesso, e nel frattempo l'amministratore potrebbe averli cambiati.
 */
function ensureActiveOwner(users: readonly UserRow[], actor: Actor, target: UserRow) {
  const me = users.find((u) => u.id === actor.userId);
  if (
    !me ||
    me.status !== 'active' ||
    me.awaitingConfirmation ||
    !me.roles.includes('owner_doctor')
  )
    throw new Refusal(403, NOT_CONFIRMER, target.username);
}

export type UserAdminService = ReturnType<typeof createUserAdminService>;
