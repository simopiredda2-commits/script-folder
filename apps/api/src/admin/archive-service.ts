import { can, ROLE_LABELS, type Action, type Role } from '@mmg/domain';
import { and, desc, eq, inArray, isNull, lt, ne, notInArray, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { logAccess, type AccessAction } from '../audit/access-log';
import type { Actor } from '../auth/service';
import {
  accessLog,
  aft,
  aftMember,
  appUser,
  archive,
  archiveGrant,
  doctorProfile,
  studio,
} from '../db/schema';
import { withActor } from '../db/tx';
import { HttpError } from '../http/errors';
import { startOfStudioDay } from '../http/today-routes';
import { loadArchiveContext } from '../patients/access';
import { studioDate } from '../prescriptions/rules-check';
import type { AdminDeps } from './deps';

/**
 * Archivio del titolare (tappa 14): autorizzazioni a sostituti e colleghi di gruppo (D18, D21),
 * avvisi sugli accessi anomali calcolati dal registro degli accessi (Garante, par. 7, lett. c) e
 * registro delle azioni di amministrazione dello studio. Le autorizzazioni non si cancellano: si
 * revocano (trigger della migrazione 0022); ogni concessione e revoca va nel registro, senza dati
 * dei pazienti.
 */

type GrantRow = typeof archiveGrant.$inferSelect;
type GrantKind = GrantRow['kind'];
type StudioRow = typeof studio.$inferSelect;

/** Motivo di un'autorizzazione: almeno 10 caratteri, come il motivo d'accesso dell'AFT (D161). */
export const GRANT_REASON_MIN = 10;
/** Limiti di buon senso, non di una norma: motivo, periodo degli avvisi, righe per pagina. */
export const GRANT_REASON_MAX = 300;
export const ALERT_DAYS = { default: 30, min: 1, max: 365 } as const;
export const ADMIN_LOG_PAGE = { default: 50, max: 200 } as const;

/** Chi si può autorizzare con ciascun tipo: il ruolo che il medico deve avere. */
export const GRANT_KINDS: Record<
  GrantKind,
  { nome: string; ruolo: Role; spiegazione: string; nessuno: string }
> = {
  substitution: {
    nome: 'Sostituzione',
    ruolo: 'substitute_doctor',
    spiegazione:
      'Un medico con il ruolo di sostituto lavora sull’archivio per il periodo indicato; ricette e certificati restano a nome suo.',
    nessuno:
      'Nessun medico con il ruolo di sostituto nello studio: lo aggiunge l’amministratore in Strumenti › Utenti e ruoli.',
  },
  group_colleague: {
    nome: 'Medicina di gruppo',
    ruolo: 'owner_doctor',
    spiegazione:
      'Un altro medico titolare dello studio vede e cura i tuoi pazienti per il periodo indicato.',
    nessuno: 'Nessun altro medico titolare nello studio.',
  },
};

const NOT_GROUP_STUDIO =
  'Lo studio non è di medicina di gruppo: il tipo dello studio lo cambia l’amministratore in Strumenti › Dati dello studio';

export type GrantState = 'attiva' | 'futura' | 'scaduta' | 'revocata';
export const GRANT_STATE_LABELS: Record<GrantState, string> = {
  attiva: 'Attiva',
  futura: 'Futura',
  scaduta: 'Scaduta',
  revocata: 'Revocata',
};
const STATE_ORDER: GrantState[] = ['attiva', 'futura', 'scaduta', 'revocata'];

/**
 * Stato di un'autorizzazione in un istante: le stesse condizioni di `can()` in `@mmg/domain`
 * (attiva se non revocata e l'istante sta tra inizio e fine, estremi compresi).
 */
export function grantState(
  g: Pick<GrantRow, 'validFrom' | 'validTo' | 'revokedAt'>,
  at: Date,
): GrantState {
  if (g.revokedAt) return 'revocata';
  if (at.getTime() < g.validFrom.getTime()) return 'futura';
  if (at.getTime() > g.validTo.getTime()) return 'scaduta';
  return 'attiva';
}

/** AAAA-MM-GG più `days` giorni del calendario. */
function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + days, 12)).toISOString().slice(0, 10);
}

/**
 * Il periodo di un'autorizzazione copre giorni interi dello studio (Europe/Rome): dalla mezzanotte
 * del primo giorno all'ultimo millesimo dell'ultimo, anche nei giorni del cambio dell'ora.
 */
export function grantPeriod(from: string, to: string): { validFrom: Date; validTo: Date } {
  return {
    validFrom: startOfStudioDay(from),
    validTo: new Date(startOfStudioDay(addDays(to, 1)).getTime() - 1),
  };
}

const itDate = (iso: string) => iso.split('-').reverse().join('/');

export const grantBody = z
  .object({
    medico: z.uuid({ error: 'Medico: da scegliere' }),
    tipo: z.enum(['substitution', 'group_colleague'], {
      error: 'Tipo: sostituzione o medicina di gruppo',
    }),
    dal: z.iso.date({ error: 'Dal: una data valida' }),
    al: z.iso.date({ error: 'Al: una data valida' }),
    motivo: z
      .string({ error: `Motivo: almeno ${GRANT_REASON_MIN} caratteri` })
      .trim()
      .min(GRANT_REASON_MIN, `Motivo: almeno ${GRANT_REASON_MIN} caratteri`)
      .max(GRANT_REASON_MAX, `Motivo: al massimo ${GRANT_REASON_MAX} caratteri`),
  })
  .strict();

const alertsQuery = z.object({
  giorni: z.coerce
    .number({ error: 'Giorni: un numero' })
    .int('Giorni: un numero intero')
    .min(ALERT_DAYS.min, `Giorni: da ${ALERT_DAYS.min} a ${ALERT_DAYS.max}`)
    .max(ALERT_DAYS.max, `Giorni: da ${ALERT_DAYS.min} a ${ALERT_DAYS.max}`)
    .default(ALERT_DAYS.default),
});

const adminLogQuery = z.object({
  /** Righe con numero più piccolo di questo: la pagina dopo, verso le più vecchie. */
  prima: z.coerce.number({ error: 'Prima: un numero' }).int().positive().optional(),
  limite: z.coerce
    .number({ error: 'Limite: un numero' })
    .int()
    .min(1, `Limite: da 1 a ${ADMIN_LOG_PAGE.max}`)
    .max(ADMIN_LOG_PAGE.max, `Limite: da 1 a ${ADMIN_LOG_PAGE.max}`)
    .default(ADMIN_LOG_PAGE.default),
});

/** Controlla un corpo o una richiesta: i problemi tutti insieme, ognuno detto in chiaro. */
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value ?? {});
  if (r.success) return r.data;
  const problems = [...new Set(r.error.issues.map((i) => i.message))];
  throw new HttpError(400, problems.join('. '), { problemi: problems });
}

// Avvisi sugli accessi anomali ------------------------------------------------------------------

/** Fonte degli avvisi: il registro degli accessi deve segnalare gli accessi anomali. */
export const ALERT_SOURCE =
  'Garante per la protezione dei dati personali, Linee guida sul dossier sanitario, provv. 4/6/2015, n. 331 (G.U. n. 164 del 17/7/2015), par. 7, lett. c: avvisi sugli accessi anomali (numero, tipologia, orari)';

export type AlertKind = 'cartelle_al_giorno' | 'fascia_oraria' | 'consultazioni_aft_al_giorno';

/** I tre avvisi, con il nome che hanno nei dati dello studio (dove l'amministratore li imposta). */
export const ALERT_NAMES: Record<AlertKind, string> = {
  cartelle_al_giorno: 'Cartelle diverse aperte da un utente in un giorno',
  fascia_oraria: 'Fascia oraria degli accessi',
  consultazioni_aft_al_giorno: 'Consultazioni dell’AFT di un collega in un giorno',
};
const ALERT_ORDER: AlertKind[] = [
  'cartelle_al_giorno',
  'fascia_oraria',
  'consultazioni_aft_al_giorno',
];

/** Le azioni dell'AFT su un paziente: le conta il loro avviso, non quello delle cartelle. */
const AFT_ACTIONS = sql`('consultazione_aft', 'attivita_aft')`;

type RuleState = 'attiva' | 'da_completare' | 'non_valida';
interface AlertRules {
  cartelle_al_giorno: { stato: RuleState; soglia: number | null };
  fascia_oraria: { stato: RuleState; dalle: number | null; alle: number | null };
  consultazioni_aft_al_giorno: { stato: RuleState; soglia: number | null };
}

const isHour = (h: number) => Number.isInteger(h) && h >= 0 && h <= 23;
const countRule = (v: number | null): { stato: RuleState; soglia: number | null } => ({
  stato: v == null ? 'da_completare' : Number.isInteger(v) && v >= 1 ? 'attiva' : 'non_valida',
  soglia: v,
});

/**
 * Le soglie dello studio: vuote = da completare, avviso spento (tappa 14, D20). La fascia vale
 * dall'ora d'inizio (compresa) all'ora di fine (esclusa); se l'inizio è più grande della fine
 * comprende la mezzanotte (22–6: dalle 22:00 alle 5:59). Inizio uguale alla fine non è valido.
 */
export function alertRules(
  s: Pick<
    StudioRow,
    'alertDailyRecords' | 'alertNightFromHour' | 'alertNightToHour' | 'alertAftDaily'
  >,
): AlertRules {
  const from = s.alertNightFromHour;
  const to = s.alertNightToHour;
  return {
    cartelle_al_giorno: countRule(s.alertDailyRecords),
    fascia_oraria: {
      stato:
        from == null || to == null
          ? 'da_completare'
          : isHour(from) && isHour(to) && from !== to
            ? 'attiva'
            : 'non_valida',
      dalle: from,
      alle: to,
    },
    consultazioni_aft_al_giorno: countRule(s.alertAftDaily),
  };
}

const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function ruleThreshold(kind: AlertKind, rules: AlertRules): string | null {
  if (kind === 'fascia_oraria') {
    const { dalle, alle } = rules.fascia_oraria;
    if (dalle == null || alle == null) return null;
    return `dalle ${hh(dalle)} alle ${hh(alle)}${dalle > alle ? ', comprende la mezzanotte' : ''}`;
  }
  const n = rules[kind].soglia;
  return n == null ? null : `più di ${n} al giorno`;
}

interface RawAlert {
  tipo: AlertKind;
  userId: string;
  giorno: string;
  conteggio: number;
  cartelle: number;
  primo: Date;
  ultimo: Date;
}

interface AlertRow extends Record<string, unknown> {
  user_id: string;
  giorno: string;
  conteggio: number;
  cartelle: number;
  primo: Date | string;
  ultimo: Date | string;
}

// Registro delle azioni di amministrazione -------------------------------------------------------

/** Le azioni del registro che riguardano l'amministrazione dello studio e degli archivi. */
export const ADMIN_LOG_ACTIONS = [
  'amministrazione',
  'autorizzazione_archivio',
  'revoca_autorizzazione',
  'cambio_password',
  'impostazioni_archivio',
  'impostazioni_aft',
] as const satisfies readonly AccessAction[];

/** Nomi delle aree e delle azioni scritte dalle sezioni di Strumenti (`details.area`, `.azione`). */
const AREA_LABELS: Record<string, string> = {
  studio: 'Dati dello studio',
  utenti: 'Utenti e ruoli',
  postazioni: 'Postazioni',
  stampa: 'Stampa',
  stampanti: 'Stampanti',
  intestazioni: 'Intestazioni',
  elenchi: 'Elenchi dello studio',
  modelli: 'Modelli',
};
const ACTION_LABELS: Record<string, string> = {
  elenco: 'Consultazione dell’elenco',
  creazione: 'Creazione',
  modifica: 'Modifica',
  sospensione: 'Sospensione',
  riattivazione: 'Riattivazione',
  password_temporanea: 'Password temporanea',
  azzeramento_secondo_fattore: 'Azzeramento del secondo fattore',
  sblocco: 'Sblocco',
  archiviazione: 'Archiviazione',
};

/** «nomeUtente» o «password_temporanea» → «nome utente», «password temporanea». */
const words = (key: string) =>
  key
    .replace(/_/g, ' ')
    .replace(/([a-zà-ù])([A-Z])/g, '$1 $2')
    .toLowerCase();
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const textList = (v: unknown) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const roleList = (v: unknown) =>
  textList(v)
    .map((r) => ROLE_LABELS[r as Role] ?? r)
    .join(', ') || 'nessuno';

interface Names {
  archives: Map<string, string>;
  afts: Map<string, string>;
}

/**
 * Area, azione e dettaglio di una riga del registro, in parole. Si leggono solo campi noti dei
 * dettagli: mai i valori dei campi cambiati, mai dati dei pazienti, mai segreti.
 */
export function describeAdminEntry(
  action: string,
  outcome: string,
  details: Record<string, unknown>,
  names: Names,
): { area: string; azione: string; dettaglio: string | null } {
  const d = details;
  const parts: string[] = [];
  const add = (p: string | null | false | undefined) => {
    if (p) parts.push(p);
  };
  const archiveName = text(d.archivio) && names.archives.get(text(d.archivio)!);
  const campi = textList(d.campi);
  const grantText = () => {
    const kind = text(d.tipo) as GrantKind | null;
    add(kind && GRANT_KINDS[kind] ? GRANT_KINDS[kind].nome : null);
    add(text(d.medico));
    const from = text(d.dal);
    const to = text(d.al);
    add(from && to && `dal ${itDate(from)} al ${itDate(to)}`);
  };
  // Un tentativo negato non è un'azione fatta: «Revoca di un'autorizzazione», con l'esito accanto.
  const done = outcome === 'riuscito';
  let area: string;
  let azione: string;
  switch (action) {
    case 'amministrazione': {
      const a = text(d.area);
      const act = text(d.azione);
      area = a ? (AREA_LABELS[a] ?? capital(words(a))) : 'Amministrazione';
      azione = act ? (ACTION_LABELS[act] ?? capital(words(act))) : 'Azione';
      add(text(d.utente) && `utente ${text(d.utente)}`);
      const ws = d.postazione as { nome?: unknown } | undefined;
      add(ws && text(ws.nome) && `postazione «${text(ws.nome)}»`);
      if (Array.isArray(d.ruoliPrima) && Array.isArray(d.ruoliDopo)) {
        const before = roleList(d.ruoliPrima);
        const after = roleList(d.ruoliDopo);
        add(before !== after && `ruoli: ${before} → ${after}`);
      }
      break;
    }
    case 'cambio_password':
      area = 'Utenti e ruoli';
      azione = 'Cambio della password';
      add(d.obbligato === true && 'password temporanea, al primo accesso');
      break;
    case 'autorizzazione_archivio':
      area = 'Autorizzazioni sull’archivio';
      azione =
        text(d.azione) === 'concessione'
          ? done
            ? 'Autorizzazione concessa'
            : 'Concessione di un’autorizzazione'
          : text(d.azione) === 'medici_autorizzabili'
            ? 'Consultazione dei medici autorizzabili'
            : 'Consultazione delle autorizzazioni';
      grantText();
      break;
    case 'revoca_autorizzazione':
      area = 'Autorizzazioni sull’archivio';
      azione = done ? 'Autorizzazione revocata' : 'Revoca di un’autorizzazione';
      grantText();
      break;
    case 'impostazioni_archivio':
      area = 'Impostazioni dell’archivio';
      azione =
        text(d.fase) === 'modifica'
          ? 'Che cosa vede la segreteria: modifica'
          : text(d.fase) === 'lettura'
            ? 'Che cosa vede la segreteria: consultazione'
            : // Righe scritte prima che le due fasi fossero distinte.
              'Che cosa vede la segreteria: consultazione o modifica';
      break;
    case 'impostazioni_aft': {
      area = 'AFT';
      const aftName = text(d.aft) && names.afts.get(text(d.aft)!);
      if (typeof d.condivisione === 'boolean')
        azione = d.condivisione
          ? 'Condivisione dei pazienti attivata'
          : 'Condivisione dei pazienti spenta';
      else azione = done ? 'Dati dell’AFT modificati' : 'Modifica dei dati dell’AFT';
      add(aftName && `AFT «${aftName}»`);
      break;
    }
    default:
      area = 'Amministrazione';
      azione = capital(words(action));
  }
  add(archiveName && `archivio «${archiveName}»`);
  add(campi.length > 0 && `campi cambiati: ${campi.map(words).join(', ')}`);
  if (outcome === 'negato' || outcome === 'fallito')
    add(text(d.motivo) && `motivo: ${text(d.motivo)}`);
  return { area, azione, dettaglio: parts.length ? capital(parts.join(' · ')) : null };
}

// Servizio ---------------------------------------------------------------------------------------

export function createArchiveAdminService({ db, now }: Pick<AdminDeps, 'db' | 'now'>) {
  /**
   * Decide un'azione sull'archivio con le regole dei permessi. Il rifiuto va nel registro, con il
   * motivo; la risposta dice in chiaro chi può farla.
   */
  async function guard(
    actor: Actor,
    archiveId: string,
    permission: Action,
    logAction: AccessAction,
    azione: string,
    message: string,
  ) {
    const ctx = await loadArchiveContext(db, archiveId);
    const decision = can(actor, permission, { ...ctx, now: now() });
    if (decision.allowed) return ctx;
    await logAccess(db, {
      studioId: actor.studioId,
      userId: actor.userId,
      patientId: null,
      action: logAction,
      outcome: 'negato',
      workstation: actor.workstation,
      details: { archivio: archiveId, azione, permesso: permission, motivo: decision.reason },
    });
    throw new HttpError(403, message);
  }

  const GRANTS_ONLY_OWNER =
    'Le autorizzazioni sull’archivio le vede e le dà solo il medico titolare dell’archivio';

  const grantee = alias(appUser, 'grantee');
  const granter = alias(appUser, 'granter');

  function grantView(g: GrantRow, names: { grantee: string; granter: string }, at: Date) {
    const state = grantState(g, at);
    return {
      id: g.id,
      medico: { id: g.granteeUserId, nome: names.grantee },
      tipo: { codice: g.kind, nome: GRANT_KINDS[g.kind].nome },
      /** Giorni dello studio; inizio e fine sono gli istanti esatti. */
      dal: studioDate(g.validFrom),
      al: studioDate(g.validTo),
      inizio: g.validFrom.toISOString(),
      fine: g.validTo.toISOString(),
      motivo: g.reason,
      stato: { codice: state, nome: GRANT_STATE_LABELS[state] },
      concessaDa: names.granter,
      concessaIl: g.createdAt.toISOString(),
      revocataIl: g.revokedAt ? g.revokedAt.toISOString() : null,
      revocabile: state === 'attiva' || state === 'futura',
    };
  }

  async function loadGrants(archiveId: string, grantId?: string) {
    return db
      .select({ g: archiveGrant, grantee: grantee.displayName, granter: granter.displayName })
      .from(archiveGrant)
      .innerJoin(grantee, eq(grantee.id, archiveGrant.granteeUserId))
      .innerJoin(granter, eq(granter.id, archiveGrant.grantedBy))
      .where(
        and(
          eq(archiveGrant.archiveId, archiveId),
          grantId ? eq(archiveGrant.id, grantId) : undefined,
        ),
      );
  }

  /** Le autorizzazioni dell'archivio: prima le attive e le future, poi le altre, recenti prima. */
  async function listGrants(actor: Actor, archiveId: string) {
    await guard(
      actor,
      archiveId,
      'archive.grants',
      'autorizzazione_archivio',
      'elenco',
      GRANTS_ONLY_OWNER,
    );
    const at = now();
    return (await loadGrants(archiveId))
      .map((r) => grantView(r.g, r, at))
      .sort(
        (a, b) =>
          STATE_ORDER.indexOf(a.stato.codice) - STATE_ORDER.indexOf(b.stato.codice) ||
          b.inizio.localeCompare(a.inizio),
      );
  }

  /**
   * I medici dello studio che si possono autorizzare, per tipo: per la sostituzione chi ha il ruolo
   * di sostituto, per la medicina di gruppo gli altri titolari (solo in uno studio di gruppo, D18).
   * Mai sé stessi, mai utenti sospesi.
   */
  async function grantableDoctors(actor: Actor, archiveId: string) {
    const ctx = await guard(
      actor,
      archiveId,
      'archive.grants',
      'autorizzazione_archivio',
      'medici_autorizzabili',
      GRANTS_ONLY_OWNER,
    );
    const [st] = await db
      .select({ kind: studio.kind })
      .from(studio)
      .where(eq(studio.id, ctx.archive.studioId));
    const users = await db
      .select({
        id: appUser.id,
        nome: appUser.displayName,
        roles: appUser.roles,
        codiceRegionale: doctorProfile.regionalCode,
      })
      .from(appUser)
      .leftJoin(doctorProfile, eq(doctorProfile.userId, appUser.id))
      .where(
        and(
          eq(appUser.studioId, ctx.archive.studioId),
          eq(appUser.status, 'active'),
          ne(appUser.id, actor.userId),
          ne(appUser.id, ctx.archive.ownerUserId),
        ),
      )
      .orderBy(appUser.displayName);
    return {
      tipi: (Object.keys(GRANT_KINDS) as GrantKind[]).map((kind) => {
        const k = GRANT_KINDS[kind];
        const closed = kind === 'group_colleague' && st?.kind !== 'group';
        const medici = closed
          ? []
          : users
              .filter((u) => u.roles.includes(k.ruolo))
              .map((u) => ({ id: u.id, nome: u.nome, codiceRegionale: u.codiceRegionale }));
        return {
          codice: kind,
          nome: k.nome,
          spiegazione: k.spiegazione,
          medici,
          nota: closed ? `${NOT_GROUP_STUDIO}.` : medici.length === 0 ? k.nessuno : null,
        };
      }),
    };
  }

  /** Concede un'autorizzazione sul proprio archivio: medico, tipo, periodo e motivo. */
  async function createGrant(actor: Actor, archiveId: string, body: unknown) {
    const ctx = await guard(
      actor,
      archiveId,
      'archive.grants',
      'autorizzazione_archivio',
      'concessione',
      GRANTS_ONLY_OWNER,
    );
    const b = parse(grantBody, body);
    const at = now();
    const today = studioDate(at);
    const problems: string[] = [];
    // Un'autorizzazione vale da quando la si dà: nessun accesso passato diventa autorizzato.
    if (b.dal < today) problems.push('Dal: l’autorizzazione non può cominciare nel passato');
    if (b.al < b.dal) problems.push('Al: la fine non può venire prima dell’inizio');
    if (problems.length) throw new HttpError(400, problems.join('. '), { problemi: problems });

    const [doctor] = await db
      .select({
        id: appUser.id,
        nome: appUser.displayName,
        roles: appUser.roles,
        status: appUser.status,
      })
      .from(appUser)
      .where(and(eq(appUser.id, b.medico), eq(appUser.studioId, ctx.archive.studioId)));
    if (!doctor) throw new HttpError(404, 'Medico non trovato nello studio');
    if (doctor.id === actor.userId || doctor.id === ctx.archive.ownerUserId)
      throw new HttpError(400, 'Sul tuo archivio non serve un’autorizzazione: sei il titolare');
    if (doctor.status !== 'active')
      throw new HttpError(409, 'L’utente è sospeso: non si può autorizzare');
    const kind = GRANT_KINDS[b.tipo];
    if (b.tipo === 'group_colleague') {
      const [st] = await db
        .select({ kind: studio.kind })
        .from(studio)
        .where(eq(studio.id, ctx.archive.studioId));
      if (st?.kind !== 'group') throw new HttpError(409, NOT_GROUP_STUDIO);
    }
    if (!doctor.roles.includes(kind.ruolo))
      throw new HttpError(
        400,
        b.tipo === 'substitution'
          ? 'La sostituzione si dà a un medico con il ruolo di sostituto'
          : 'La medicina di gruppo si dà a un altro medico titolare dello studio',
      );

    const { validFrom, validTo } = grantPeriod(b.dal, b.al);
    const row = await withActor(db, actor.userId, async (tx) => {
      const [g] = await tx
        .insert(archiveGrant)
        .values({
          archiveId,
          granteeUserId: doctor.id,
          kind: b.tipo,
          validFrom,
          validTo,
          reason: b.motivo,
          grantedBy: actor.userId,
          createdAt: at,
        })
        .returning();
      // Nel registro: chi, quale medico, quale tipo e periodo. Il motivo resta nell'autorizzazione.
      await logAccess(tx, {
        studioId: actor.studioId,
        userId: actor.userId,
        patientId: null,
        action: 'autorizzazione_archivio',
        outcome: 'riuscito',
        workstation: actor.workstation,
        details: {
          archivio: archiveId,
          azione: 'concessione',
          autorizzazione: g!.id,
          medico: doctor.nome,
          medicoId: doctor.id,
          tipo: b.tipo,
          dal: b.dal,
          al: b.al,
        },
      });
      return g!;
    });
    return grantView(row, { grantee: doctor.nome, granter: actor.displayName }, at);
  }

  /** Revoca adesso un'autorizzazione attiva o futura: l'archivio si chiude subito. */
  async function revokeGrant(actor: Actor, archiveId: string, grantId: string) {
    await guard(
      actor,
      archiveId,
      'archive.grants',
      'revoca_autorizzazione',
      'revoca',
      GRANTS_ONLY_OWNER,
    );
    const [found] = await loadGrants(archiveId, grantId);
    if (!found) throw new HttpError(404, 'Autorizzazione non trovata');
    const at = now();
    const state = grantState(found.g, at);
    if (state === 'revocata') throw new HttpError(409, 'L’autorizzazione è già revocata');
    if (state === 'scaduta')
      throw new HttpError(409, 'L’autorizzazione è già scaduta: non serve revocarla');
    const row = await withActor(db, actor.userId, async (tx) => {
      const [g] = await tx
        .update(archiveGrant)
        .set({ revokedAt: at })
        .where(and(eq(archiveGrant.id, grantId), isNull(archiveGrant.revokedAt)))
        .returning();
      if (!g) throw new HttpError(409, 'L’autorizzazione è già revocata');
      await logAccess(tx, {
        studioId: actor.studioId,
        userId: actor.userId,
        patientId: null,
        action: 'revoca_autorizzazione',
        outcome: 'riuscito',
        workstation: actor.workstation,
        details: {
          archivio: archiveId,
          azione: 'revoca',
          autorizzazione: g.id,
          medico: found.grantee,
          medicoId: g.granteeUserId,
          tipo: g.kind,
          dal: studioDate(g.validFrom),
          al: studioDate(g.validTo),
          statoPrima: state,
        },
      });
      return g;
    });
    return grantView(row, found, at);
  }

  /** Righe raggruppate per utente e giorno dello studio, dal registro degli accessi. */
  async function grouped(query: ReturnType<typeof sql>): Promise<AlertRow[]> {
    return (await db.execute<AlertRow>(query)).rows;
  }

  /**
   * Avvisi sugli accessi anomali alle cartelle dell'archivio negli ultimi `giorni` giorni, con le
   * soglie dello studio. Una soglia vuota spegne il suo avviso: nessun calcolo, e la risposta dice
   * che è da completare. I conteggi comprendono gli accessi negati: anche i tentativi contano.
   */
  async function accessAlerts(actor: Actor, archiveId: string, query: unknown) {
    const { giorni } = parse(alertsQuery, query);
    const ctx = await loadArchiveContext(db, archiveId);
    const decision = can(actor, 'access_log.read', { ...ctx, now: now() });
    await logAccess(db, {
      studioId: actor.studioId,
      userId: actor.userId,
      patientId: null,
      action: 'lettura_avvisi_accessi',
      outcome: decision.allowed ? 'consentito' : 'negato',
      workstation: actor.workstation,
      details: { archivio: archiveId, giorni, motivo: decision.reason },
    });
    if (!decision.allowed)
      throw new HttpError(
        403,
        'Gli avvisi sugli accessi all’archivio li legge solo il medico titolare',
      );
    const [st] = await db.select().from(studio).where(eq(studio.id, ctx.archive.studioId));
    const [a] = await db
      .select({ name: archive.name })
      .from(archive)
      .where(eq(archive.id, archiveId));
    const rules = alertRules(st!);
    const at = now();
    const today = studioDate(at);
    const firstDay = addDays(today, -(giorni - 1));
    const since = startOfStudioDay(firstDay).toISOString();
    const day = sql`to_char(l.at at time zone 'Europe/Rome', 'YYYY-MM-DD')`;
    const base = sql`from access_log l join patient p on p.id = l.patient_id
      where p.archive_id = ${archiveId} and l.at >= ${since}::timestamptz and l.user_id is not null`;
    const raw: RawAlert[] = [];
    const collect = (tipo: AlertKind, rows: AlertRow[]) => {
      for (const r of rows)
        raw.push({
          tipo,
          userId: r.user_id,
          giorno: r.giorno,
          conteggio: Number(r.conteggio),
          cartelle: Number(r.cartelle),
          primo: new Date(r.primo),
          ultimo: new Date(r.ultimo),
        });
    };

    // Un utente che apre più di N cartelle diverse dell'archivio in un giorno (non dall'AFT).
    const daily = rules.cartelle_al_giorno;
    if (daily.stato === 'attiva')
      collect(
        'cartelle_al_giorno',
        await grouped(sql`select l.user_id, ${day} as giorno,
            count(distinct l.patient_id)::int as conteggio, count(distinct l.patient_id)::int as cartelle,
            min(l.at) as primo, max(l.at) as ultimo
          ${base} and l.action not in ${AFT_ACTIONS}
          group by l.user_id, giorno having count(distinct l.patient_id) > ${daily.soglia}`),
      );

    // Accessi nella fascia oraria, in ora italiana; la fascia può comprendere la mezzanotte.
    const band = rules.fascia_oraria;
    if (band.stato === 'attiva') {
      const hour = sql`extract(hour from l.at at time zone 'Europe/Rome')::int`;
      const inBand =
        band.dalle! < band.alle!
          ? sql`(${hour} >= ${band.dalle} and ${hour} < ${band.alle})`
          : sql`(${hour} >= ${band.dalle} or ${hour} < ${band.alle})`;
      collect(
        'fascia_oraria',
        await grouped(sql`select l.user_id, ${day} as giorno,
            count(*)::int as conteggio, count(distinct l.patient_id)::int as cartelle,
            min(l.at) as primo, max(l.at) as ultimo
          ${base} and ${inBand}
          group by l.user_id, giorno`),
      );
    }

    // Un collega dell'AFT con più di N consultazioni in un giorno sui pazienti dell'archivio.
    const aftRule = rules.consultazioni_aft_al_giorno;
    if (aftRule.stato === 'attiva')
      collect(
        'consultazioni_aft_al_giorno',
        await grouped(sql`select l.user_id, ${day} as giorno,
            count(*)::int as conteggio, count(distinct l.patient_id)::int as cartelle,
            min(l.at) as primo, max(l.at) as ultimo
          ${base} and l.action = 'consultazione_aft'
          group by l.user_id, giorno having count(*) > ${aftRule.soglia}`),
      );

    const userIds = [...new Set(raw.map((r) => r.userId))];
    const people = userIds.length
      ? await db
          .select({
            id: appUser.id,
            nome: appUser.displayName,
            studioId: appUser.studioId,
            studio: studio.name,
          })
          .from(appUser)
          .innerJoin(studio, eq(studio.id, appUser.studioId))
          .where(inArray(appUser.id, userIds))
      : [];
    const person = new Map(people.map((p) => [p.id, p]));

    const describe = (r: RawAlert) => {
      if (r.tipo === 'fascia_oraria')
        return `${plural(r.conteggio, 'accesso', 'accessi')} a ${plural(r.cartelle, 'cartella', 'cartelle')} ${ruleThreshold('fascia_oraria', rules)}`;
      if (r.tipo === 'cartelle_al_giorno')
        return `${plural(r.conteggio, 'cartella diversa', 'cartelle diverse')} in un giorno: la soglia è ${ruleThreshold(r.tipo, rules)}`;
      return `${plural(r.conteggio, 'consultazione', 'consultazioni')} dell’AFT in un giorno, su ${plural(r.cartelle, 'paziente', 'pazienti')}: la soglia è ${ruleThreshold(r.tipo, rules)}`;
    };

    // I giorni più recenti prima; nello stesso giorno, per tipo, conteggio e nome.
    const avvisi = raw
      .map((r) => {
        const p = person.get(r.userId);
        return {
          tipo: r.tipo,
          nome: ALERT_NAMES[r.tipo],
          utente: {
            id: r.userId,
            nome: p?.nome ?? 'Utente sconosciuto',
            // Lo studio si dice solo per chi non è dello studio dell'archivio (colleghi dell'AFT).
            studio: p && p.studioId !== ctx.archive.studioId ? p.studio : null,
            io: r.userId === actor.userId,
          },
          giorno: r.giorno,
          conteggio: r.conteggio,
          soglia: r.tipo === 'fascia_oraria' ? null : rules[r.tipo].soglia,
          fascia: r.tipo === 'fascia_oraria' ? { dalle: band.dalle!, alle: band.alle! } : null,
          cartelle: r.cartelle,
          primo: r.primo.toISOString(),
          ultimo: r.ultimo.toISOString(),
          descrizione: describe(r),
        };
      })
      .sort(
        (x, y) =>
          y.giorno.localeCompare(x.giorno) ||
          ALERT_ORDER.indexOf(x.tipo) - ALERT_ORDER.indexOf(y.tipo) ||
          y.conteggio - x.conteggio ||
          x.utente.nome.localeCompare(y.utente.nome, 'it') ||
          x.utente.id.localeCompare(y.utente.id),
      );

    return {
      archivio: { id: archiveId, nome: a?.name ?? null },
      periodo: { giorni, dal: firstDay, al: today },
      regole: ALERT_ORDER.map((k) => ({
        codice: k,
        nome: ALERT_NAMES[k],
        stato: rules[k].stato,
        soglia: rules[k].stato === 'attiva' ? ruleThreshold(k, rules) : null,
      })),
      daCompletare: ALERT_ORDER.filter((k) => rules[k].stato === 'da_completare').map(
        (k) => ALERT_NAMES[k],
      ),
      nonValide: ALERT_ORDER.filter((k) => rules[k].stato === 'non_valida').map(
        (k) => ALERT_NAMES[k],
      ),
      fonte: ALERT_SOURCE,
      avvisi,
    };
  }

  /**
   * Registro delle azioni di amministrazione dello studio, le più recenti prima, a pagine (per
   * numero di riga: le righe nuove non spostano le pagine già lette). Lo leggono i titolari e
   * l'amministratore (D163); ogni lettura va nel registro.
   */
  async function adminLog(actor: Actor, query: unknown) {
    const q = parse(adminLogQuery, query);
    const decision = can(actor, 'studio.admin_log');
    await logAccess(db, {
      studioId: actor.studioId,
      userId: actor.userId,
      patientId: null,
      action: 'lettura_registro_amministrazione',
      outcome: decision.allowed ? 'consentito' : 'negato',
      workstation: actor.workstation,
      details: { prima: q.prima ?? null, motivo: decision.reason },
    });
    if (!decision.allowed)
      throw new HttpError(
        403,
        'Il registro delle azioni di amministrazione lo leggono i medici titolari e l’amministratore dello studio',
      );
    // In medicina di gruppo un titolare vede le azioni sullo studio e sugli utenti, e quelle sul
    // suo archivio e sulle sue AFT: non le autorizzazioni e le impostazioni degli archivi dei
    // colleghi. L'amministratore vede tutto lo studio.
    const scoped = !actor.roles.includes('administrator');
    const ownArchives = scoped
      ? (
          await db
            .select({ id: archive.id })
            .from(archive)
            .where(and(eq(archive.studioId, actor.studioId), eq(archive.ownerUserId, actor.userId)))
        ).map((a) => a.id)
      : [];
    const ownAfts = scoped
      ? (
          await db
            .select({ id: aftMember.aftId })
            .from(aftMember)
            .where(eq(aftMember.userId, actor.userId))
        ).map((a) => a.id)
      : [];
    const archiveScoped: AccessAction[] = [
      'autorizzazione_archivio',
      'revoca_autorizzazione',
      'impostazioni_archivio',
    ];
    const visible = scoped
      ? or(
          notInArray(accessLog.action, [...archiveScoped, 'impostazioni_aft']),
          and(
            inArray(accessLog.action, archiveScoped),
            ownArchives.length
              ? inArray(sql<string>`${accessLog.details}->>'archivio'`, ownArchives)
              : sql`false`,
          ),
          and(
            eq(accessLog.action, 'impostazioni_aft'),
            ownAfts.length
              ? inArray(sql<string>`${accessLog.details}->>'aft'`, ownAfts)
              : sql`false`,
          ),
        )
      : undefined;
    const rows = await db
      .select({
        seq: accessLog.seq,
        at: accessLog.at,
        action: accessLog.action,
        outcome: accessLog.outcome,
        workstation: accessLog.workstation,
        details: accessLog.details,
        user: appUser.displayName,
      })
      .from(accessLog)
      .leftJoin(appUser, eq(appUser.id, accessLog.userId))
      .where(
        and(
          eq(accessLog.studioId, actor.studioId),
          inArray(accessLog.action, [...ADMIN_LOG_ACTIONS]),
          visible,
          q.prima ? lt(accessLog.seq, q.prima) : undefined,
        ),
      )
      .orderBy(desc(accessLog.seq))
      .limit(q.limite + 1);
    const page = rows.slice(0, q.limite);
    const details = page.map((r) => (r.details ?? {}) as Record<string, unknown>);
    const archives = new Map(
      (
        await db
          .select({ id: archive.id, name: archive.name })
          .from(archive)
          .where(eq(archive.studioId, actor.studioId))
      ).map((x) => [x.id, x.name]),
    );
    const aftIds = [
      ...new Set(details.map((d) => text(d.aft)).filter((x): x is string => x !== null)),
    ].filter((x) => z.uuid().safeParse(x).success);
    const afts = new Map(
      (aftIds.length
        ? await db.select({ id: aft.id, name: aft.name }).from(aft).where(inArray(aft.id, aftIds))
        : []
      ).map((x) => [x.id, x.name]),
    );
    return {
      righe: page.map((r, i) => ({
        numero: r.seq,
        quando: r.at.toISOString(),
        utente: r.user ?? null,
        postazione: r.workstation,
        esito: r.outcome,
        ...describeAdminEntry(r.action, r.outcome, details[i]!, { archives, afts }),
      })),
      /** Da passare come `prima` per le righe più vecchie; null se non ce ne sono. */
      prossima: rows.length > q.limite ? page.at(-1)!.seq : null,
    };
  }

  return {
    listGrants,
    grantableDoctors,
    createGrant,
    revokeGrant,
    accessAlerts,
    adminLog,
  };
}

export type ArchiveAdminService = ReturnType<typeof createArchiveAdminService>;
