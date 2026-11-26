import {
  can,
  PRINT_LIMITS,
  STRUCTURE_CODE_PATTERN,
  STUDIO_STRUCTURE_TYPES,
  type Action,
  type StructureType,
} from '@mmg/domain';
import { REGIONAL_PART_LABELS, selectRegionalPackage } from '@mmg/regions';
import { and, arrayContains, asc, count, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { logAccess } from '../audit/access-log';
import { LOGIN_SOURCE_LIMITS } from '../auth/login-sources';
import { FAILED_LOGIN_LOCK_MAX_MINUTES, type Actor } from '../auth/service';
import type { Database } from '../db/client';
import {
  appUser,
  certificateSubmission,
  externalSubmission,
  patient,
  prescription,
  sickLeaveCertificate,
  studio,
  workstation,
} from '../db/schema';
import { withActor, type Tx } from '../db/tx';
import { HttpError } from '../http/errors';
import { CONTROL_CHARACTERS_MESSAGE, hasControlCharacters } from '../security/plain-text';
import { siapValues } from '../siap/values';
import type { AdminDeps } from './deps';

/**
 * Dati e impostazioni dello studio (tappa 14): dati, intestazione, sicurezza dell'accesso, tempo di
 * attesa degli invii, soglie degli avvisi sugli accessi anomali, postazioni e stato del servizio.
 * Li leggono tutti gli utenti dello studio; li cambia l'amministratore. Ogni cambio va nel registro
 * come «amministrazione», con i campi cambiati, prima e dopo: sono dati dello studio, non segreti.
 */

type StudioRow = typeof studio.$inferSelect;
type WorkstationRow = typeof workstation.$inferSelect;

/**
 * Limiti dei valori: controlli di buon senso contro gli errori di battitura, non soglie di una
 * norma. I valori per difetto restano quelli scelti (D29: 5 minuti, 5 tentativi, 15 minuti; D94: 8
 * secondi); le soglie degli avvisi non ce l'hanno: sono da completare.
 */
export const STUDIO_LIMITS = {
  /** I requisiti: la sessione si blocca dopo «pochi minuti» di inattività. */
  idleLockMinutes: { min: 1, max: 30 },
  /**
   * Password sbagliate prima del blocco del conto: la soglia alta (D188). Sotto 20 il blocco
   * tornerebbe a tenere fuori un medico con poche password a caso; oltre 100 non sarebbe più un
   * blocco.
   */
  maxFailedLogins: { min: 20, max: 100 },
  /** Codici sbagliati prima del blocco: i limiti della soglia di prima (D29, D188). */
  maxFailedCodes: { min: 3, max: 10 },
  /**
   * Al massimo un'ora (prima 1440 minuti): dopo la revisione dei poteri dell'amministratore, un
   * blocco lungo terrebbe fuori un medico per un giorno intero a chi conosce il suo nome utente.
   */
  failedLoginLockMinutes: { min: 5, max: FAILED_LOGIN_LOCK_MAX_MINUTES },
  sendTimeoutSeconds: { min: 1, max: 60 },
  alertDailyRecords: { min: 1, max: 10000 },
  alertAftDaily: { min: 1, max: 1000 },
  hour: { min: 0, max: 23 },
  headerLines: PRINT_LIMITS.headerLines,
  headerLineLength: PRINT_LIMITS.headerLineLength,
} as const;

/**
 * Tempo di attesa indicato dalla Regione Piemonte (SIRPED, «Cartelle cliniche MMG e PLS», V06 del
 * 10/04/2026, 3.5.2): «al momento definiti in 8 secondi», contati dalla richiesta di stampa del
 * promemoria (D94, D265; la V05 diceva «6-8 secondi»). Fuori da qui il valore si salva, con un avviso.
 */
export const REGIONAL_SEND_TIMEOUT_SECONDS: { readonly min: number; readonly max: number } = {
  min: 8,
  max: 8,
};

/** Fonte degli avvisi sugli accessi anomali (numero, tipologia, orari degli accessi). */
export const ALERT_SOURCE =
  'Garante per la protezione dei dati personali, Linee guida sul dossier sanitario, provvedimento del 4/6/2015, n. 331 (G.U. n. 164 del 17/7/2015), par. 7, lett. c';

const KIND_LABELS = { single: 'Medico singolo', group: 'Medicina di gruppo' } as const;

const REGION_WHY =
  'va nell’intestazione del promemoria della ricetta SSN (DM 2/11/2011, allegato 2, campo 1): senza, nessuna ricetta SSN si può inviare';

/** Righe dell'intestazione dello studio, senza righe vuote. */
export function headerLinesOf(text: string | null): string[] {
  return (text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

/**
 * Indirizzo completo dello studio su una riga: «Via Roma 1, 10121 Torino (TO)». Va sulla copia del
 * certificato INPS per la visita in studio (D106). Null se non c'è niente.
 */
export function formatStudioAddress(s: {
  address: string | null;
  postalCode: string | null;
  municipality: string | null;
  province: string | null;
}): string | null {
  const town = [s.postalCode?.trim(), s.municipality?.trim()].filter(Boolean).join(' ');
  const province = s.province?.trim();
  const place = town && province ? `${town} (${province})` : town;
  return [s.address?.trim(), place].filter(Boolean).join(', ') || null;
}

/** Tempo massimo di attesa per difetto: il limite alto dei 6–8 secondi del Piemonte (D94). */
export const DEFAULT_SEND_TIMEOUT_SECONDS = 8;

/**
 * Il tempo massimo di attesa degli invii a SAR, Sistema TS e INPS, in millisecondi (D94, D105):
 * l'impostazione dello studio com'è al momento dell'invio.
 */
export async function studioSendTimeoutMs(db: Database, studioId: string): Promise<number> {
  const [row] = await db
    .select({ seconds: studio.sendTimeoutSeconds })
    .from(studio)
    .where(eq(studio.id, studioId));
  return (row?.seconds ?? DEFAULT_SEND_TIMEOUT_SECONDS) * 1000;
}

/** Un tempo di attesa detto a parole: «1 secondo», «8 secondi». */
export function secondsText(ms: number): string {
  const n = ms / 1000;
  return `${n} ${n === 1 ? 'secondo' : 'secondi'}`;
}

/** L'intestazione dello studio, per i certificati dai modelli di chi non ha la sua (D145). */
export async function studioHeaderLines(db: Database, studioId: string): Promise<string[]> {
  const [row] = await db
    .select({ header: studio.headerText })
    .from(studio)
    .where(eq(studio.id, studioId));
  return headerLinesOf(row?.header ?? null);
}

// Corpi delle richieste ------------------------------------------------------------------------

/** Messaggio di un valore del tipo sbagliato o mancante (ogni gruppo si manda intero). */
const typeError =
  (label: string, what: string) =>
  (issue: { input?: unknown }): string =>
    issue.input === undefined ? `${label}: manca` : `${label}: ${what}`;

/** Testo di una riga, senza caratteri di controllo o invisibili (D179: il server li stampa). */
const text = (label: string, max: number) =>
  z
    .string({ error: typeError(label, 'un testo, oppure vuoto') })
    .trim()
    .max(max, `${label}: al massimo ${max} caratteri`)
    .refine(
      (v) => !hasControlCharacters(v),
      `${label}: ${CONTROL_CHARACTERS_MESSAGE.toLowerCase()}`,
    )
    .nullable();

/** Un codice di forma fissa (CAP, sigla della provincia), oppure vuoto. */
const code = (label: string, pattern: RegExp, message: string) =>
  z
    .string({ error: typeError(label, 'un testo, oppure vuoto') })
    .trim()
    .transform((v) => v.toUpperCase())
    .refine((v) => !v || pattern.test(v), message)
    .nullable();

const emailOrEmpty = (label: string) =>
  text(label, 254).refine(
    (v) => !v || z.email().safeParse(v).success,
    `${label}: indirizzo non valido`,
  );

const integer = (label: string, limits: { min: number; max: number }, unit = '') => {
  const msg = `${label}: un numero intero da ${limits.min} a ${limits.max}${unit}`;
  return z.number({ error: msg }).int(msg).min(limits.min, msg).max(limits.max, msg);
};

const dataBody = z
  .object({
    nome: z
      .string({ error: 'Nome dello studio: obbligatorio' })
      .trim()
      .min(1, 'Nome dello studio: obbligatorio')
      .max(200, 'Nome dello studio: al massimo 200 caratteri')
      .refine(
        (v) => !hasControlCharacters(v),
        `Nome dello studio: ${CONTROL_CHARACTERS_MESSAGE.toLowerCase()}`,
      ),
    tipo: z.enum(['single', 'group'], {
      error: 'Tipo di studio: medico singolo o medicina di gruppo',
    }),
    regione: text('Regione', 60),
    indirizzo: text('Indirizzo (via e numero civico)', 100),
    cap: code('CAP', /^\d{5}$/, 'CAP: 5 cifre'),
    comune: text('Comune', 100),
    provincia: code('Provincia', /^[A-Z]{2}$/, 'Provincia: la sigla di 2 lettere'),
    telefono: text('Telefono', 30).refine(
      (v) => !v || (/^\+?[0-9 ()./-]+$/.test(v) && (v.match(/\d/g)?.length ?? 0) >= 5),
      'Telefono: cifre, spazi e i segni + . / - ( ), con almeno 5 cifre',
    ),
    email: emailOrEmpty('Email'),
    pec: emailOrEmpty('PEC'),
  })
  .strict();

const securityBody = z
  .object({
    minutiInattivita: integer(
      'Minuti di inattività prima del blocco',
      STUDIO_LIMITS.idleLockMinutes,
    ),
    tentativiFalliti: integer(
      'Password sbagliate prima del blocco del conto',
      STUDIO_LIMITS.maxFailedLogins,
    ),
    codiciSbagliati: integer(
      'Codici sbagliati prima del blocco del conto',
      STUDIO_LIMITS.maxFailedCodes,
    ),
    minutiBlocco: integer('Durata del blocco', STUDIO_LIMITS.failedLoginLockMinutes, ' minuti'),
  })
  .strict();

/**
 * Codice e tipo della struttura per il SIAP (D289): il gruppo si manda intero, come gli altri. Il
 * codice è quello della codifica STS.11, come lo dà la Regione o l'ASL; vuoto finché non c'è.
 */
const structureBody = z
  .object({
    codice: code(
      'Codice della struttura',
      STRUCTURE_CODE_PATTERN,
      'Codice della struttura: 6 lettere o cifre, come lo dà la Regione o l’ASL',
    ),
    tipo: z.enum(STUDIO_STRUCTURE_TYPES, {
      error: 'Tipo di struttura: uno di quelli dell’elenco',
    }),
  })
  .strict();

const sendingBody = z
  .object({
    secondiAttesa: integer(
      'Tempo massimo di attesa degli invii',
      STUDIO_LIMITS.sendTimeoutSeconds,
      ' secondi',
    ),
  })
  .strict();

const alertsBody = z
  .object({
    cartelleAlGiorno: integer(
      'Cartelle diverse aperte da un utente in un giorno',
      STUDIO_LIMITS.alertDailyRecords,
    ).nullable(),
    fasciaDalle: integer('Fascia oraria, dalle ore', STUDIO_LIMITS.hour).nullable(),
    fasciaAlle: integer('Fascia oraria, alle ore', STUDIO_LIMITS.hour).nullable(),
    consultazioniAftAlGiorno: integer(
      'Consultazioni dell’AFT di un collega in un giorno',
      STUDIO_LIMITS.alertAftDaily,
    ).nullable(),
  })
  .strict();

const updateBody = z
  .object({
    dati: dataBody.optional(),
    intestazione: z
      .array(z.string({ error: 'Intestazione: una riga di testo' }), {
        error: 'Intestazione: un elenco di righe',
      })
      .max(50, 'Intestazione: troppe righe')
      .optional(),
    sicurezza: securityBody.optional(),
    struttura: structureBody.optional(),
    invii: sendingBody.optional(),
    avvisi: alertsBody.optional(),
  })
  .strict()
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'Niente da salvare');

const workstationName = z
  .string({ error: 'Nome della postazione: obbligatorio' })
  .trim()
  .min(1, 'Nome della postazione: obbligatorio')
  .max(100, 'Nome della postazione: al massimo 100 caratteri');
/** Le note della postazione possono andare a capo (area di testo): non passano da text(). */
const workstationNotes = z
  .string({ error: typeError('Note', 'un testo, oppure vuoto') })
  .trim()
  .max(500, 'Note: al massimo 500 caratteri')
  .nullable();

const createWorkstationBody = z
  .object({
    nome: workstationName,
    condivisa: z.boolean({ error: 'Postazione condivisa o personale: da scegliere' }),
    note: workstationNotes.optional(),
  })
  .strict();

const updateWorkstationBody = z
  .object({
    nome: workstationName.optional(),
    condivisa: z.boolean({ error: 'Postazione condivisa o personale: da scegliere' }).optional(),
    note: workstationNotes.optional(),
  })
  .strict()
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'Niente da salvare');

const idParam = z.uuid();

/** Controlla un corpo: i problemi tutti insieme, ognuno detto in chiaro. */
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body ?? {});
  if (r.success) return r.data;
  const problems = [...new Set(r.error.issues.map((i) => i.message))];
  throw new HttpError(400, problems.join('. '), { problemi: problems });
}

// Valori e confronti ---------------------------------------------------------------------------

/** I campi dello studio come si vedono e si registrano, con i nomi dell'interfaccia. */
interface StudioValues {
  nome: string;
  tipo: 'single' | 'group';
  regione: string | null;
  indirizzo: string | null;
  cap: string | null;
  comune: string | null;
  provincia: string | null;
  telefono: string | null;
  email: string | null;
  pec: string | null;
  codiceStruttura: string | null;
  tipoStruttura: StructureType;
  intestazione: string[];
  minutiInattivita: number | null;
  tentativiFalliti: number | null;
  codiciSbagliati: number | null;
  minutiBlocco: number | null;
  secondiAttesa: number;
  cartelleAlGiorno: number | null;
  fasciaDalle: number | null;
  fasciaAlle: number | null;
  consultazioniAftAlGiorno: number | null;
}

function valuesOf(s: StudioRow): StudioValues {
  return {
    nome: s.name,
    tipo: s.kind,
    regione: s.regionName,
    indirizzo: s.address,
    cap: s.postalCode,
    comune: s.municipality,
    provincia: s.province,
    telefono: s.phone,
    email: s.email,
    pec: s.pec,
    codiceStruttura: s.structureCode,
    tipoStruttura: s.structureType,
    intestazione: headerLinesOf(s.headerText),
    minutiInattivita: s.idleLockMinutes,
    tentativiFalliti: s.maxFailedLogins,
    codiciSbagliati: s.maxFailedCodes,
    minutiBlocco: s.failedLoginLockMinutes,
    secondiAttesa: s.sendTimeoutSeconds,
    cartelleAlGiorno: s.alertDailyRecords,
    fasciaDalle: s.alertNightFromHour,
    fasciaAlle: s.alertNightToHour,
    consultazioniAftAlGiorno: s.alertAftDaily,
  };
}

/** La colonna della tabella `studio` di ogni campo. */
const COLUMNS = {
  nome: 'name',
  tipo: 'kind',
  regione: 'regionName',
  indirizzo: 'address',
  cap: 'postalCode',
  comune: 'municipality',
  provincia: 'province',
  telefono: 'phone',
  email: 'email',
  pec: 'pec',
  codiceStruttura: 'structureCode',
  tipoStruttura: 'structureType',
  intestazione: 'headerText',
  minutiInattivita: 'idleLockMinutes',
  tentativiFalliti: 'maxFailedLogins',
  codiciSbagliati: 'maxFailedCodes',
  minutiBlocco: 'failedLoginLockMinutes',
  secondiAttesa: 'sendTimeoutSeconds',
  cartelleAlGiorno: 'alertDailyRecords',
  fasciaDalle: 'alertNightFromHour',
  fasciaAlle: 'alertNightToHour',
  consultazioniAftAlGiorno: 'alertAftDaily',
} as const satisfies Record<keyof StudioValues, keyof typeof studio.$inferInsert>;

/**
 * Solo le colonne dei campi cambiati: due amministratori che cambiano insieme campi diversi non si
 * cancellano a vicenda il lavoro.
 */
function columnsOf(v: StudioValues, keys: (keyof StudioValues)[]) {
  return Object.fromEntries(
    keys.map((k) => [COLUMNS[k], k === 'intestazione' ? v.intestazione.join('\n') || null : v[k]]),
  ) as Partial<typeof studio.$inferInsert>;
}

/** I campi cambiati, con i valori di prima e di dopo. */
function diff<T extends object>(before: T, after: T) {
  const campi = (Object.keys(after) as (keyof T & string)[]).filter(
    (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
  );
  return {
    campi,
    prima: Object.fromEntries(campi.map((k) => [k, before[k]])),
    dopo: Object.fromEntries(campi.map((k) => [k, after[k]])),
  };
}

/** Che cosa manca nei dati dello studio, detto con il perché. */
/**
 * Il pacchetto regionale della regione dello studio (D292): che cosa dà, dove sta oggi, e le parti
 * che mancano, per le quali valgono solo le parti nazionali. Le varianti delle ASL valgono per il
 * medico, non per lo studio.
 */
function regionalView(regionName: string | null) {
  const s = selectRegionalPackage({ regionName });
  return {
    regione: s.region ? { codice: s.region.code, nome: s.region.name } : null,
    pacchetto: s.package ? { chiave: s.package.key, nome: s.package.name } : null,
    parti: s.parts.map((p) => ({
      parte: p.part,
      nome: REGIONAL_PART_LABELS[p.part],
      cosa: p.what,
      nelPacchetto: p.where === 'package',
    })),
    mancano: s.missing.map((p) => ({ parte: p, nome: REGIONAL_PART_LABELS[p] })),
  };
}

/**
 * I tipi di struttura che lo studio può scegliere, con la descrizione e il codice del Ministero
 * dalla trascrizione delle specifiche del SIAP (D284, D289): il legame fra chiave e codice è lì.
 */
function structureTypeOptions() {
  const all = siapValues().tipoStruttura;
  return STUDIO_STRUCTURE_TYPES.map((key) => {
    const v = all.find((x) => x.chiave === key)!;
    return { codice: key, nome: v.descrizione, codiceMinistero: v.codice };
  });
}

function studioGaps(v: StudioValues): string[] {
  const out: string[] = [];
  if (!v.regione) out.push(`Regione: ${REGION_WHY}`);
  if (!v.indirizzo || !v.cap || !v.comune || !v.provincia)
    out.push(
      'Indirizzo completo (via e numero civico, CAP, comune, provincia): va sulla copia del certificato INPS per la visita in studio',
    );
  if (
    v.minutiInattivita == null ||
    v.tentativiFalliti == null ||
    v.codiciSbagliati == null ||
    v.minutiBlocco == null
  )
    out.push('Sicurezza dell’accesso: senza tutti i valori il blocco non è attivo');
  return out;
}

/** Le soglie degli avvisi ancora vuote: finché lo sono, quegli avvisi sono spenti. */
function alertGaps(v: StudioValues): string[] {
  const out: string[] = [];
  if (v.cartelleAlGiorno == null) out.push('Cartelle diverse aperte da un utente in un giorno');
  if (v.fasciaDalle == null || v.fasciaAlle == null) out.push('Fascia oraria degli accessi');
  if (v.consultazioniAftAlGiorno == null)
    out.push('Consultazioni dell’AFT di un collega in un giorno');
  return out;
}

function timeoutNotice(seconds: number): string | null {
  const { min, max } = REGIONAL_SEND_TIMEOUT_SECONDS;
  const range = min === max ? `${min} secondi` : `da ${min} a ${max} secondi`;
  return seconds < min || seconds > max
    ? `La Regione Piemonte indica ${range} (SIRPED, «Cartelle cliniche MMG e PLS», V06, 3.5.2)`
    : null;
}

const ENVIRONMENT_LABELS: Record<string, string> = {
  simulator: 'simulatore',
  test: 'collaudo',
  production: 'produzione',
};
const OUTCOME_LABELS: Record<string, string> = {
  accepted: 'accettato',
  ok: 'riuscito',
  rejected: 'rifiutato',
  unreachable: 'non raggiungibile',
  timeout: 'esito incerto',
  fault: 'eccezione di sistema, esito incerto',
  assigned: 'lotto assegnato',
};

/**
 * Collegamenti con i servizi esterni. Oggi il programma ha solo simulatori: nessuna chiamata a
 * servizi reali (regola 7); gli adattatori veri arriveranno con le specifiche e le credenziali di
 * collaudo. L'ambiente di ogni chiamata fatta resta negli invii, e per il servizio delle ricette
 * della regione, il Sistema TS e l'INPS si vede l'ultimo. Il nome del servizio delle ricette lo dà
 * la regione dello studio (D300).
 */
const INTEGRATIONS = [
  {
    codice: 'regional',
    nome: 'Ricette della regione',
    uso: 'Ricette SSN: farmaci e specialistica',
  },
  { codice: 'sistema_ts', nome: 'Sistema TS', uso: 'Ricetta bianca elettronica' },
  { codice: 'inps', nome: 'Sistema TS per l’INPS', uso: 'Certificati di malattia' },
  { codice: 'fse', nome: 'Gateway del Fascicolo', uso: 'Profilo sanitario sintetico' },
  {
    codice: 'accesso_regionale',
    nome: 'Accesso regionale con SPID o CIE',
    uso: 'Secondo fattore per le ricette SSN',
  },
  {
    codice: 'secondo_fattore',
    nome: 'Codice di sessione',
    uso: 'Secondo fattore del Sistema TS e della Regione',
  },
  { codice: 'email_sms', nome: 'Email e SMS', uso: 'Promemoria e copie dei certificati' },
  {
    codice: 'aura',
    nome: 'AURA (anagrafe regionale)',
    uso: 'Esenzioni e scelte del medico',
  },
] as const;

const workstationView = (w: WorkstationRow) => ({
  id: w.id,
  nome: w.name,
  condivisa: w.shared,
  note: w.notes,
  creataIl: w.createdAt.toISOString(),
  archiviataIl: w.archivedAt?.toISOString() ?? null,
});

const isUniqueViolation = (err: unknown) =>
  (err as { code?: string }).code === '23505' ||
  (err as { cause?: { code?: string } }).cause?.code === '23505';

const duplicateName = (name: string) =>
  new HttpError(
    409,
    `C’è già una postazione attiva che si chiama «${name}»: scegli un altro nome o archivia l’altra`,
  );

export function createStudioAdminService(deps: AdminDeps) {
  const { db, now } = deps;

  async function load(studioId: string): Promise<StudioRow> {
    const [row] = await db.select().from(studio).where(eq(studio.id, studioId));
    if (!row) throw new HttpError(404, 'Studio non trovato');
    return row;
  }

  /** Il permesso, oppure 403: il tentativo negato resta nel registro, con che cosa si tentava. */
  async function requirePermission(
    actor: Actor,
    permission: Action,
    area: string,
    attempted: string,
    message: string,
  ) {
    const d = can(actor, permission);
    if (d.allowed) return;
    await logAccess(db, {
      studioId: actor.studioId,
      userId: actor.userId,
      patientId: null,
      action: 'amministrazione',
      outcome: 'negato',
      workstation: actor.workstation,
      details: { area, azione: attempted, permesso: permission, motivo: d.reason },
    });
    throw new HttpError(403, message);
  }

  async function logChange(tx: Tx, actor: Actor, details: Record<string, unknown>) {
    await logAccess(tx, {
      studioId: actor.studioId,
      userId: actor.userId,
      patientId: null,
      action: 'amministrazione',
      outcome: 'riuscito',
      workstation: actor.workstation,
      details,
    });
  }

  function view(s: StudioRow, actor: Actor) {
    const v = valuesOf(s);
    return {
      dati: {
        nome: v.nome,
        tipo: v.tipo,
        regione: v.regione,
        indirizzo: v.indirizzo,
        cap: v.cap,
        comune: v.comune,
        provincia: v.provincia,
        telefono: v.telefono,
        email: v.email,
        pec: v.pec,
      },
      tipi: (Object.keys(KIND_LABELS) as (keyof typeof KIND_LABELS)[]).map((k) => ({
        codice: k,
        nome: KIND_LABELS[k],
      })),
      /** Come va sulla copia del certificato INPS per la visita in studio. */
      indirizzoCompleto: formatStudioAddress(s),
      struttura: {
        codice: v.codiceStruttura,
        tipo: v.tipoStruttura,
        tipi: structureTypeOptions(),
      },
      pacchettoRegionale: regionalView(v.regione),
      intestazione: v.intestazione,
      sicurezza: {
        minutiInattivita: v.minutiInattivita,
        tentativiFalliti: v.tentativiFalliti,
        codiciSbagliati: v.codiciSbagliati,
        minutiBlocco: v.minutiBlocco,
      },
      invii: { secondiAttesa: v.secondiAttesa, avviso: timeoutNotice(v.secondiAttesa) },
      avvisi: {
        cartelleAlGiorno: v.cartelleAlGiorno,
        fasciaDalle: v.fasciaDalle,
        fasciaAlle: v.fasciaAlle,
        consultazioniAftAlGiorno: v.consultazioniAftAlGiorno,
        daCompletare: alertGaps(v),
        fonte: ALERT_SOURCE,
      },
      daCompletare: studioGaps(v),
      limiti: STUDIO_LIMITS,
      puoModificare: can(actor, 'admin.studio').allowed,
      puoModificareIntestazione: can(actor, 'admin.headers').allowed,
    };
  }

  /** Controlli che legano più campi, o i dati dello studio con il resto. */
  async function crossChecks(s: StudioRow, next: StudioValues, b: z.infer<typeof updateBody>) {
    const problems: string[] = [];
    if (b.dati) {
      const region = next.regione;
      if (!region) problems.push(`Regione: obbligatoria, perché ${REGION_WHY}`);
      else if (!/^\p{L}[\p{L} '’./-]+$/u.test(region))
        problems.push('Regione: solo lettere, spazi, apostrofo, punto e trattino');
      else if (/^REGIONE\b/u.test(region))
        problems.push(
          'Regione: scrivi solo il nome, per esempio PIEMONTE: «REGIONE» lo aggiunge il promemoria',
        );
      if (next.tipo === 'single') {
        const [{ n } = { n: 0 }] = await db
          .select({ n: count() })
          .from(appUser)
          .where(
            and(
              eq(appUser.studioId, s.id),
              eq(appUser.status, 'active'),
              arrayContains(appUser.roles, ['owner_doctor']),
            ),
          );
        if (n > 1)
          problems.push(
            `Tipo di studio: nello studio ci sono ${n} medici titolari attivi, quindi è una medicina di gruppo`,
          );
      }
    }
    if (b.intestazione) {
      if (next.intestazione.length > STUDIO_LIMITS.headerLines)
        problems.push(`Intestazione: al massimo ${STUDIO_LIMITS.headerLines} righe`);
      if (next.intestazione.some((l) => l.length > STUDIO_LIMITS.headerLineLength))
        problems.push(
          `Intestazione: al massimo ${STUDIO_LIMITS.headerLineLength} caratteri per riga`,
        );
    }
    if (b.avvisi) {
      const { fasciaDalle: from, fasciaAlle: to } = next;
      if ((from == null) !== (to == null))
        problems.push(
          'Fascia oraria: indica l’ora d’inizio e quella di fine, oppure lascia vuote tutte e due',
        );
      else if (from != null && from === to)
        problems.push('Fascia oraria: l’ora d’inizio e quella di fine devono essere diverse');
    }
    if (problems.length) throw new HttpError(400, problems.join('. '), { problemi: problems });
  }

  return {
    /** Dati e impostazioni dello studio: li legge ogni utente dello studio. */
    async read(actor: Actor) {
      return view(await load(actor.studioId), actor);
    },

    /**
     * Cambia i gruppi mandati: ogni gruppo si manda intero. L'intestazione vuole il permesso delle
     * intestazioni, gli altri gruppi quello dei dati dello studio. I permessi si controllano prima
     * dei valori: chi non può cambiare non sa nemmeno se i valori andavano bene.
     */
    async update(actor: Actor, body: unknown) {
      const groups = body && typeof body === 'object' ? Object.keys(body) : [];
      if (groups.includes('intestazione'))
        await requirePermission(
          actor,
          'admin.headers',
          'studio',
          'modifica',
          'L’intestazione dello studio la cambia l’amministratore dello studio',
        );
      if (groups.some((g) => g !== 'intestazione') || groups.length === 0)
        await requirePermission(
          actor,
          'admin.studio',
          'studio',
          'modifica',
          'I dati e le impostazioni dello studio li cambia l’amministratore dello studio',
        );
      const b = parse(updateBody, body);
      const s = await load(actor.studioId);
      const before = valuesOf(s);
      const next: StudioValues = {
        ...before,
        ...(b.dati
          ? {
              ...b.dati,
              regione: b.dati.regione ? b.dati.regione.toLocaleUpperCase('it-IT') : null,
              indirizzo: b.dati.indirizzo || null,
              cap: b.dati.cap || null,
              comune: b.dati.comune || null,
              provincia: b.dati.provincia || null,
              telefono: b.dati.telefono || null,
              email: b.dati.email || null,
              pec: b.dati.pec || null,
            }
          : {}),
        ...(b.intestazione
          ? { intestazione: b.intestazione.map((l) => l.trim()).filter(Boolean) }
          : {}),
        ...(b.sicurezza ?? {}),
        ...(b.struttura
          ? { codiceStruttura: b.struttura.codice || null, tipoStruttura: b.struttura.tipo }
          : {}),
        ...(b.invii ?? {}),
        ...(b.avvisi ?? {}),
      };
      await crossChecks(s, next, b);
      const changes = diff(before, next);
      if (!changes.campi.length) return view(s, actor);
      const [saved] = await withActor(db, actor.userId, async (tx) => {
        const rows = await tx
          .update(studio)
          .set(columnsOf(next, changes.campi))
          .where(eq(studio.id, s.id))
          .returning();
        await logChange(tx, actor, { area: 'studio', azione: 'modifica', ...changes });
        return rows;
      });
      return view(saved!, actor);
    },

    /** Postazioni dello studio: le attive e, a parte, le archiviate. */
    async workstations(actor: Actor) {
      const rows = await db
        .select()
        .from(workstation)
        .where(eq(workstation.studioId, actor.studioId))
        .orderBy(asc(sql`lower(${workstation.name})`), asc(workstation.createdAt));
      return {
        postazioni: rows.filter((w) => !w.archivedAt).map(workstationView),
        archiviate: rows.filter((w) => w.archivedAt).map(workstationView),
        puoModificare: can(actor, 'admin.studio').allowed,
      };
    },

    async createWorkstation(actor: Actor, body: unknown) {
      await requirePermission(
        actor,
        'admin.studio',
        'postazioni',
        'creazione',
        'Le postazioni le gestisce l’amministratore dello studio',
      );
      const b = parse(createWorkstationBody, body);
      await ensureFreeName(actor.studioId, b.nome, null);
      try {
        const row = await withActor(db, actor.userId, async (tx) => {
          const [w] = await tx
            .insert(workstation)
            .values({
              studioId: actor.studioId,
              name: b.nome,
              shared: b.condivisa,
              notes: b.note || null,
              createdAt: now(),
            })
            .returning();
          await logChange(tx, actor, {
            area: 'postazioni',
            azione: 'creazione',
            postazione: { id: w!.id, nome: w!.name },
            ...diff<Record<string, unknown>>(
              { nome: null, condivisa: null, note: null },
              { nome: w!.name, condivisa: w!.shared, note: w!.notes },
            ),
          });
          return w!;
        });
        return workstationView(row);
      } catch (err) {
        if (isUniqueViolation(err)) throw duplicateName(b.nome);
        throw err;
      }
    },

    async updateWorkstation(actor: Actor, id: string, body: unknown) {
      await requirePermission(
        actor,
        'admin.studio',
        'postazioni',
        'modifica',
        'Le postazioni le gestisce l’amministratore dello studio',
      );
      const w = await loadWorkstation(actor.studioId, id);
      const b = parse(updateWorkstationBody, body);
      if (w.archivedAt) throw new HttpError(409, 'La postazione è archiviata: non si modifica più');
      const before = { nome: w.name, condivisa: w.shared, note: w.notes };
      const after = {
        nome: b.nome ?? w.name,
        condivisa: b.condivisa ?? w.shared,
        note: b.note === undefined ? w.notes : b.note || null,
      };
      if (after.nome.toLowerCase() !== w.name.toLowerCase())
        await ensureFreeName(actor.studioId, after.nome, w.id);
      const changes = diff(before, after);
      if (!changes.campi.length) return workstationView(w);
      try {
        const row = await withActor(db, actor.userId, async (tx) => {
          const [saved] = await tx
            .update(workstation)
            .set({ name: after.nome, shared: after.condivisa, notes: after.note })
            .where(and(eq(workstation.id, w.id), isNull(workstation.archivedAt)))
            .returning();
          if (!saved) throw new HttpError(409, 'La postazione è cambiata nel frattempo: ricarica');
          await logChange(tx, actor, {
            area: 'postazioni',
            azione: 'modifica',
            postazione: { id: w.id, nome: saved.name },
            ...changes,
          });
          return saved;
        });
        return workstationView(row);
      } catch (err) {
        if (isUniqueViolation(err)) throw duplicateName(after.nome);
        throw err;
      }
    },

    /** Una postazione non si cancella: si archivia, e il nome torna libero. */
    async archiveWorkstation(actor: Actor, id: string) {
      await requirePermission(
        actor,
        'admin.studio',
        'postazioni',
        'archiviazione',
        'Le postazioni le gestisce l’amministratore dello studio',
      );
      const w = await loadWorkstation(actor.studioId, id);
      if (w.archivedAt) throw new HttpError(409, 'La postazione è già archiviata');
      const row = await withActor(db, actor.userId, async (tx) => {
        const [saved] = await tx
          .update(workstation)
          .set({ archivedAt: now() })
          .where(and(eq(workstation.id, w.id), isNull(workstation.archivedAt)))
          .returning();
        if (!saved) throw new HttpError(409, 'La postazione è già archiviata');
        await logChange(tx, actor, {
          area: 'postazioni',
          azione: 'archiviazione',
          postazione: { id: w.id, nome: w.name },
        });
        return saved;
      });
      return workstationView(row);
    },

    /** Stato del servizio, in sola lettura: lo vede l'amministratore dello studio. */
    async serviceStatus(actor: Actor) {
      if (!can(actor, 'admin.studio').allowed)
        throw new HttpError(403, 'Lo stato del servizio lo vede l’amministratore dello studio');
      const s = await load(actor.studioId);
      const last = await lastCalls(actor.studioId);
      const updates = deps.referenceUpdates;
      return {
        collegamenti: await (async () => {
          const regionalName = (await deps.prescriptionServiceName?.(actor.studioId)) ?? null;
          return INTEGRATIONS.map((i) => ({
            ...i,
            ...(i.codice === 'regional' && regionalName ? { nome: regionalName } : {}),
            ambiente: 'simulatore',
            ultimoUso: last[i.codice] ?? null,
          }));
        })(),
        sessione: {
          durataMassimaOre: deps.sessionMaxHours,
          minutiInattivita: s.idleLockMinutes,
        },
        // Attese dopo le password sbagliate (D188): valori del servizio, confermati (D191).
        attese: {
          postazione: LOGIN_SOURCE_LIMITS.workstationFree,
          indirizzo: LOGIN_SOURCE_LIMITS.addressFree,
          primaSecondi: LOGIN_SOURCE_LIMITS.firstWaitSeconds,
          massimaSecondi: LOGIN_SOURCE_LIMITS.maxWaitSeconds,
          dimenticaDopoOre: LOGIN_SOURCE_LIMITS.forgetAfterHours,
        },
        bancheDati: {
          configurato: updates.configured,
          ora: updates.time,
          prossimoGiro: updates.nextRun()?.toISOString() ?? null,
        },
        // AURA (D197): spenta in produzione con il simulatore; l'ultimo controllo di ogni notte.
        aura: deps.aura
          ? await (async () => {
              const run = await deps.aura!.lastRunForStudio(actor.studioId);
              return {
                disponibile: deps.aura!.available(),
                prossimoGiro: deps.auraNextRun?.()?.toISOString() ?? null,
                ultimoGiro: run
                  ? {
                      iniziato: run.startedAt.toISOString(),
                      finito: run.finishedAt?.toISOString() ?? null,
                      pazienti: run.patients,
                      conVariazioni: run.changed,
                      nonRiusciti: run.failed,
                      messaggio: run.message,
                    }
                  : null,
              };
            })()
          : null,
        salvataggi: { nelProgramma: false },
        ambiente: deps.environment,
      };
    },
  };

  async function loadWorkstation(studioId: string, id: string): Promise<WorkstationRow> {
    const parsed = idParam.safeParse(id);
    if (!parsed.success) throw new HttpError(404, 'Postazione non trovata');
    const [w] = await db
      .select()
      .from(workstation)
      .where(and(eq(workstation.id, parsed.data), eq(workstation.studioId, studioId)));
    if (!w) throw new HttpError(404, 'Postazione non trovata');
    return w;
  }

  /** Il nome è libero tra le postazioni attive dello studio (maiuscole e minuscole uguali). */
  async function ensureFreeName(studioId: string, name: string, except: string | null) {
    const [taken] = await db
      .select({ id: workstation.id })
      .from(workstation)
      .where(
        and(
          eq(workstation.studioId, studioId),
          isNull(workstation.archivedAt),
          sql`lower(${workstation.name}) = lower(${name})`,
          ...(except ? [ne(workstation.id, except)] : []),
        ),
      );
    if (taken) throw duplicateName(name);
  }

  /** L'ultima chiamata al servizio della regione, al Sistema TS e all'INPS dello studio. */
  async function lastCalls(studioId: string) {
    const out: Record<
      string,
      { quando: string; ambiente: string; operazione: string; esito: string }
    > = {};
    for (const system of ['regional', 'sistema_ts'] as const) {
      const [row] = await db
        .select({
          at: externalSubmission.at,
          environment: externalSubmission.environment,
          operation: externalSubmission.operation,
          outcome: externalSubmission.outcome,
        })
        .from(externalSubmission)
        .innerJoin(prescription, eq(prescription.id, externalSubmission.prescriptionId))
        .innerJoin(patient, eq(patient.id, prescription.patientId))
        .where(and(eq(patient.studioId, studioId), eq(externalSubmission.system, system)))
        .orderBy(desc(externalSubmission.at), desc(externalSubmission.id))
        .limit(1);
      if (row) out[system] = callView(row);
    }
    const [inps] = await db
      .select({
        at: certificateSubmission.at,
        environment: certificateSubmission.environment,
        operation: certificateSubmission.operation,
        outcome: certificateSubmission.outcome,
      })
      .from(certificateSubmission)
      .innerJoin(
        sickLeaveCertificate,
        eq(sickLeaveCertificate.id, certificateSubmission.certificateId),
      )
      .innerJoin(patient, eq(patient.id, sickLeaveCertificate.patientId))
      .where(eq(patient.studioId, studioId))
      .orderBy(desc(certificateSubmission.at))
      .limit(1);
    if (inps) out.inps = callView(inps);
    return out;
  }
}

function callView(r: { at: Date; environment: string; operation: string; outcome: string }) {
  return {
    quando: r.at.toISOString(),
    ambiente: ENVIRONMENT_LABELS[r.environment] ?? r.environment,
    operazione: r.operation,
    esito: OUTCOME_LABELS[r.outcome] ?? r.outcome,
  };
}

export type StudioAdminService = ReturnType<typeof createStudioAdminService>;
