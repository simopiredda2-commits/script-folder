import {
  can,
  choiceValidity,
  doctorChoiceIssues,
  doctorChoiceSchema,
  exemptionSchema,
  fiscalCodeCoherence,
  IDENTITY_FIX_REASON_MIN,
  lifeDatesIssues,
  PATIENT_SEXES,
  PATIENT_STATUSES,
  patientAdminIssues,
  patientAdminSchema,
  patientIdentitySchema,
  periodsOverlap,
  REMINDER_CHANNELS,
  type Decision,
  type PatientAdminInput,
  type PatientIdentityInput,
} from '@mmg/domain';
import { and, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import { logAccess } from '../audit/access-log';
import type { Actor } from '../auth/service';
import { assertNoIssues } from '../clinical/entries';
import type { Database } from '../db/client';
import {
  accessLog,
  appUser,
  archive,
  exemption,
  family,
  importBatch,
  importOrigin,
  patient,
  patientChoice,
} from '../db/schema';
import { withActor, type Tx } from '../db/tx';
import { HttpError } from '../http/errors';
import { studioDate } from '../prescriptions/rules-check';
import { ReferenceData } from '../reference/lookup';
import { loadArchiveContext, visibleArchives, type ArchiveContext } from './access';
import { archiveClosedToNewPatients } from './archive-owner';

/**
 * Pannello amministrativo del paziente (tappa 15): nuovo paziente, anagrafica completa, dati SSN,
 * stato, stranieri, lavoro, canale del promemoria, nucleo familiare, esenzioni, scelta del medico.
 * Gli schemi e i controlli sono quelli comuni del dominio (`patient-registry.ts`), gli stessi
 * dell'importazione; qui ci sono i nomi delle colonne, gli archivi, i doppioni e lo storico.
 *
 * Identità (cognome, nome, sesso, nascita, luogo, codice fiscale): D86 la lasciava fuori dalla
 * cartella, da allineare con AURA. Finché AURA non c'è si corregge qui, con un motivo che resta
 * nel registro degli accessi; i valori di prima restano nello storico delle modifiche.
 */

export type PatientRow = typeof patient.$inferSelect;
type PatientInsert = typeof patient.$inferInsert;
type StatusKey = (typeof PATIENT_STATUSES)[number]['key'];
type ChannelKey = (typeof REMINDER_CHANNELS)[number]['key'];
type Db = Database | Tx;

/** Nomi delle API dei dati amministrativi → colonne del paziente. */
export const ADMIN_COLUMNS = {
  telefono: 'phone',
  email: 'email',
  residenzaVia: 'residenceStreet',
  residenzaCivico: 'residenceNumber',
  residenzaCap: 'residencePostalCode',
  residenzaComune: 'residenceTown',
  residenzaProvincia: 'residenceProvince',
  domicilio: 'domicile',
  asl: 'asl',
  distretto: 'district',
  tipoAssistenza: 'assistanceType',
  stato: 'status',
  decedutoIl: 'deceasedOn',
  causaDecesso: 'deathCauseIcd',
  tesseraTeam: 'foreignHealthCard',
  enteEstero: 'foreignInstitution',
  professione: 'occupation',
  condizioneProfessionale: 'employmentCondition',
  emailDatoreLavoro: 'employerEmail',
  canalePromemoria: 'reminderChannel',
  recapitoPromemoria: 'reminderContact',
  canaleSceltoIl: 'reminderChannelChosenOn',
} as const satisfies Record<keyof PatientAdminInput, keyof PatientRow>;

/** Nomi delle API dell'identità → colonne del paziente. */
export const IDENTITY_COLUMNS = {
  cognome: 'lastName',
  nome: 'firstName',
  sesso: 'sex',
  nascita: 'birthDate',
  luogoNascitaCodice: 'birthPlaceCode',
  luogoNascita: 'birthPlaceName',
  codiceFiscale: 'fiscalCode',
} as const satisfies Record<keyof PatientIdentityInput, keyof PatientRow>;

type AdminKey = keyof typeof ADMIN_COLUMNS;
type IdentityKey = keyof typeof IDENTITY_COLUMNS;

/** Tutti i dati amministrativi, con i nomi delle API: null = non scritto. */
export type AdminFields = { [K in AdminKey]: string | null } & { stato: StatusKey };
export interface IdentityFields {
  cognome: string;
  nome: string;
  sesso: 'M' | 'F';
  nascita: string;
  luogoNascitaCodice: string | null;
  luogoNascita: string | null;
  codiceFiscale: string;
}

const statusKey = (db: PatientRow['status']): StatusKey =>
  PATIENT_STATUSES.find((s) => s.db === db)!.key;
const statusDb = (key: StatusKey) => PATIENT_STATUSES.find((s) => s.key === key)!.db;
const channelKey = (db: NonNullable<PatientRow['reminderChannel']>): ChannelKey =>
  REMINDER_CHANNELS.find((c) => c.db === db)!.key;
const channelDb = (key: ChannelKey) => REMINDER_CHANNELS.find((c) => c.key === key)!.db;

/** Data del calendario all'italiana: 2026-11-19 → 19/11/2026. */
const it = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;

export function adminFields(row: PatientRow): AdminFields {
  const out: Record<string, string | null> = {};
  for (const [key, column] of Object.entries(ADMIN_COLUMNS)) out[key] = row[column] ?? null;
  out.stato = statusKey(row.status);
  out.canalePromemoria = row.reminderChannel ? channelKey(row.reminderChannel) : null;
  return out as AdminFields;
}

export function identityFields(row: PatientRow): IdentityFields {
  return {
    cognome: row.lastName,
    nome: row.firstName,
    sesso: row.sex,
    nascita: row.birthDate,
    luogoNascitaCodice: row.birthPlaceCode,
    luogoNascita: row.birthPlaceName,
    codiceFiscale: row.fiscalCode,
  };
}

/** Il vuoto diventa «non scritto» (null); i campi non mandati restano assenti. */
function normalized<T extends Record<string, unknown>>(input: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input))
    if (v !== undefined) out[k] = typeof v === 'string' && v.trim() === '' ? null : v;
  return out as T;
}

/** Dati amministrativi verso le colonne: chiavi dell'interfaccia → valori del database. */
export function adminColumns(input: PatientAdminInput): Partial<PatientInsert> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(normalized(input))) {
    const column = ADMIN_COLUMNS[key as AdminKey];
    if (key === 'stato') out[column] = statusDb(value as StatusKey);
    else if (key === 'canalePromemoria')
      out[column] = value === null ? null : channelDb(value as ChannelKey);
    else out[column] = value;
  }
  return out;
}

/** Identità verso le colonne. */
export function identityColumns(input: Partial<PatientIdentityInput>): Partial<PatientInsert> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(normalized(input)))
    out[IDENTITY_COLUMNS[key as IdentityKey]] = value;
  return out;
}

/** I campi che cambiano davvero, nell'ordine di `after`. */
function changedKeys<K extends string>(
  before: Record<K, unknown>,
  after: Partial<Record<K, unknown>>,
): K[] {
  return (Object.keys(after) as K[]).filter(
    (k) => after[k] !== undefined && (after[k] ?? null) !== (before[k] ?? null),
  );
}

const pick = <T extends object, K extends keyof T>(o: T, keys: readonly K[]) =>
  Object.fromEntries(keys.map((k) => [k, o[k]])) as Pick<T, K>;

/** Errore di unicità di Postgres (codice fiscale già presente), anche avvolto da Drizzle. */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}

// --- Archivi ---------------------------------------------------------------------------------

export interface WritableArchive {
  id: string;
  nome: string;
  titolare: string;
  /** L'archivio è di chi agisce. */
  proprio: boolean;
}

/**
 * Archivi dello studio in cui chi agisce può registrare pazienti nuovi (registry.write), per il
 * modulo del nuovo paziente. Solo gli archivi aperti a pazienti nuovi: titolare attivo, ancora
 * titolare e confermato (archive-owner.ts, che lo ricontrolla sotto blocco al salvataggio, D179).
 */
export async function writableArchives(
  db: Database,
  actor: Actor,
  now: Date,
): Promise<WritableArchive[]> {
  const rows = await db
    .select({
      id: archive.id,
      name: archive.name,
      ownerUserId: archive.ownerUserId,
      owner: appUser.displayName,
    })
    .from(archive)
    .innerJoin(appUser, eq(appUser.id, archive.ownerUserId))
    .where(
      and(
        eq(archive.studioId, actor.studioId),
        eq(appUser.status, 'active'),
        eq(appUser.awaitingConfirmation, false),
        sql`'owner_doctor' = any(${appUser.roles})`,
      ),
    )
    .orderBy(archive.name);
  const out: WritableArchive[] = [];
  for (const a of rows) {
    const ctx = await loadArchiveContext(db, a.id);
    if (can(actor, 'registry.write', { ...ctx, now }).allowed)
      out.push({
        id: a.id,
        nome: a.name,
        titolare: a.owner,
        proprio: a.ownerUserId === actor.userId,
      });
  }
  return out;
}

/** L'archivio proposto: il proprio se c'è, altrimenti l'unico possibile; null se va scelto. */
export function proposedArchive(list: readonly WritableArchive[]): string | null {
  return list.find((a) => a.proprio)?.id ?? (list.length === 1 ? list[0]!.id : null);
}

/**
 * Medici titolari dello studio, attivi e confermati: tra loro il paziente sceglie il medico di
 * famiglia. Un titolare in attesa di conferma non si propone (D179).
 */
async function studioDoctors(db: Db, studioId: string) {
  return db
    .select({ id: appUser.id, nome: appUser.displayName })
    .from(appUser)
    .where(
      and(
        eq(appUser.studioId, studioId),
        eq(appUser.status, 'active'),
        eq(appUser.awaitingConfirmation, false),
        sql`'owner_doctor' = any(${appUser.roles})`,
      ),
    )
    .orderBy(appUser.displayName);
}

// --- Doppioni del codice fiscale --------------------------------------------------------------

/**
 * Il codice fiscale è già di un altro paziente dello studio: 409, con il nome solo se chi agisce
 * può vedere quel paziente. Il tentativo resta nel registro di quel paziente.
 */
async function assertFiscalCodeFree(
  db: Database,
  actor: Actor,
  fiscalCode: string,
  now: Date,
  action: 'nuovo_paziente' | 'correzione_identita',
  exceptId?: string,
): Promise<void> {
  const [other] = await db
    .select()
    .from(patient)
    .where(
      and(
        eq(patient.studioId, actor.studioId),
        eq(patient.fiscalCode, fiscalCode),
        exceptId ? ne(patient.id, exceptId) : undefined,
      ),
    );
  if (!other) return;
  const ctx = await loadArchiveContext(db, other.archiveId);
  const visible = can(actor, 'registry.read', { ...ctx, now }).allowed;
  await logAccess(db, {
    studioId: actor.studioId,
    userId: actor.userId,
    patientId: other.id,
    action,
    outcome: 'negato',
    workstation: actor.workstation,
    details: {
      motivo: 'codice fiscale già registrato per questo paziente',
      visibile: visible,
    },
  });
  if (visible)
    throw new HttpError(
      409,
      `Il codice fiscale è già registrato: ${other.lastName} ${other.firstName}, ${other.sex === 'F' ? 'nata' : 'nato'} il ${it(other.birthDate)}`,
      {
        paziente: {
          id: other.id,
          cognome: other.lastName,
          nome: other.firstName,
          nascita: other.birthDate,
        },
      },
    );
  throw new HttpError(
    409,
    'Il codice fiscale è già registrato nello studio, in un archivio che non puoi vedere: chiedi al medico titolare di quell’archivio',
    { paziente: null },
  );
}

// --- Nuovo paziente ---------------------------------------------------------------------------

export const newPatientSchema = z
  .object({
    /** L'archivio: per il titolare il proprio, per la segreteria da scegliere se ce n'è più d'uno. */
    archivioId: z.uuid().optional(),
    identita: patientIdentitySchema,
    dati: patientAdminSchema.optional(),
  })
  .strict();

const archiveOnly = z.object({ archivioId: z.uuid().optional() }).loose();

/** L'archivio non accetta pazienti nuovi: il titolare è sospeso, non è più titolare o aspetta la conferma. */
class ArchiveClosed extends Error {}

/**
 * Registra un paziente nuovo. Prima il permesso (registry.write sull'archivio, registrato anche se
 * negato), poi i dati, poi il doppione; il registro dice chi l'ha creato, con quale permesso.
 */
export async function createPatient(
  db: Database,
  actor: Actor,
  body: unknown,
  now: Date,
): Promise<{ id: string; avvisi: string[] }> {
  const { archivioId } = archiveOnly.parse(body ?? {});
  const writable = await writableArchives(db, actor, now);
  const target = archivioId ?? proposedArchive(writable);
  const denied = async (status: number, message: string, details: Record<string, unknown>) => {
    await logAccess(db, {
      studioId: actor.studioId,
      userId: actor.userId,
      action: 'nuovo_paziente',
      outcome: 'negato',
      workstation: actor.workstation,
      details: { permesso: 'registry.write', ...details },
    });
    return new HttpError(status, message);
  };
  if (!target) {
    if (writable.length === 0)
      throw await denied(
        403,
        'Non puoi registrare pazienti: serve il permesso di modificare l’anagrafica di un archivio',
        { motivo: 'nessun archivio con il permesso' },
      );
    throw new HttpError(400, 'Scegli l’archivio del paziente');
  }
  let decision: Decision;
  try {
    decision = can(actor, 'registry.write', { ...(await loadArchiveContext(db, target)), now });
  } catch (err) {
    if (!(err instanceof HttpError && err.statusCode === 404)) throw err;
    decision = { allowed: false, reason: 'Archivio non trovato' };
  }
  if (!decision.allowed)
    throw await denied(403, decision.reason, { archivio: target, motivo: decision.reason });

  const input = newPatientSchema.parse(body);
  const today = studioDate(now);
  const dati = normalized(input.dati ?? {});
  assertNoIssues([
    ...lifeDatesIssues(input.identita.nascita, dati.decedutoIl, today),
    ...patientAdminIssues(dati, today),
  ]);
  await assertFiscalCodeFree(db, actor, input.identita.codiceFiscale, now, 'nuovo_paziente');
  let id: string;
  try {
    id = await withActor(db, actor.userId, async (tx) => {
      // Il titolare dell'archivio si ricontrolla sotto il blocco della riga dell'archivio: sospeso
      // (anche un istante prima), il paziente non entra (gara inversa della sospensione).
      const closed = await archiveClosedToNewPatients(tx, target);
      if (closed) throw new ArchiveClosed(closed);
      const [row] = await tx
        .insert(patient)
        .values({
          studioId: actor.studioId,
          archiveId: target,
          ...(identityColumns(input.identita) as Pick<
            PatientInsert,
            'lastName' | 'firstName' | 'sex' | 'birthDate' | 'fiscalCode'
          >),
          ...adminColumns(dati),
        })
        .returning({ id: patient.id });
      await logAccess(tx, {
        studioId: actor.studioId,
        userId: actor.userId,
        patientId: row!.id,
        action: 'nuovo_paziente',
        outcome: 'consentito',
        workstation: actor.workstation,
        details: { permesso: 'registry.write', motivo: decision.reason, archivio: target },
      });
      return row!.id;
    });
  } catch (err) {
    if (err instanceof ArchiveClosed)
      throw await denied(409, err.message, { archivio: target, motivo: err.message });
    // Due registrazioni dello stesso codice fiscale nello stesso momento: vince la prima.
    if (isUniqueViolation(err))
      throw new HttpError(409, 'Il codice fiscale è appena stato registrato per un altro paziente');
    throw err;
  }
  return { id, avvisi: fiscalCodeCoherence(input.identita) };
}

// --- Lettura ----------------------------------------------------------------------------------

/** Righe scritte da un'importazione: quando e da quale programma (provenienza, tappa 15). */
async function importedRows(db: Db, table: string, ids: readonly string[]) {
  if (!ids.length) return new Map<string, { il: string; programma: string | null }>();
  const rows = await db
    .select({
      rowId: importOrigin.rowId,
      at: importBatch.createdAt,
      program: importBatch.sourceProgram,
    })
    .from(importOrigin)
    .innerJoin(importBatch, eq(importBatch.id, importOrigin.batchId))
    .where(and(eq(importOrigin.tableName, table), inArray(importOrigin.rowId, [...ids])));
  return new Map(rows.map((r) => [r.rowId, { il: r.at.toISOString(), programma: r.program }]));
}

const SOURCE_LABEL = { aura: 'AURA', manual: 'Inserita a mano' } as const;

function exemptionState(e: { validFrom: string; validTo: string | null }, today: string) {
  if (e.validFrom > today) return 'futura';
  if (e.validTo && e.validTo < today) return 'scaduta';
  return 'valida';
}

function choiceState(
  c: { chosenOn: string; expiresOn: string | null; endedOn: string | null },
  today: string,
) {
  if (c.endedOn && c.endedOn <= today) return 'cessata';
  if (c.expiresOn && c.expiresOn < today) return 'scaduta';
  if (c.chosenOn > today) return 'futura';
  return 'in_corso';
}

/** Il nucleo familiare con gli altri componenti che chi legge può vedere, senza indizi sugli altri. */
async function familyOf(db: Db, familyId: string, selfId: string, visible: readonly string[]) {
  const [f] = await db.select().from(family).where(eq(family.id, familyId));
  if (!f) return null;
  const members = visible.length
    ? await db
        .select({
          id: patient.id,
          cognome: patient.lastName,
          nome: patient.firstName,
          nascita: patient.birthDate,
        })
        .from(patient)
        .where(
          and(
            eq(patient.familyId, familyId),
            ne(patient.id, selfId),
            inArray(patient.archiveId, [...visible]),
          ),
        )
        .orderBy(patient.lastName, patient.firstName)
    : [];
  return { id: f.id, etichetta: f.label, componenti: members };
}

/**
 * Tutti i dati amministrativi del paziente, con i nomi delle API e le liste di valori. La guardia
 * l'ha già deciso e registrato; qui non si registra altro, così ogni lettura è una riga sola.
 */
export async function adminView(
  db: Database,
  actor: Actor,
  p: PatientRow,
  ctx: ArchiveContext,
  now: Date,
) {
  const today = studioDate(now);
  const [arch] = await db
    .select({ name: archive.name, ownerId: archive.ownerUserId, owner: appUser.displayName })
    .from(archive)
    .innerJoin(appUser, eq(appUser.id, archive.ownerUserId))
    .where(eq(archive.id, p.archiveId));
  const visible = await visibleArchives(db, actor, 'registry.read');
  const exemptions = await db
    .select()
    .from(exemption)
    // Le righe annullate (D197) restano nello storico e nell'esportazione, non nel pannello.
    .where(and(eq(exemption.patientId, p.id), isNull(exemption.annulledAt)))
    .orderBy(desc(exemption.validFrom), exemption.code);
  const choices = await db
    .select({ c: patientChoice, doctor: appUser.displayName })
    .from(patientChoice)
    .innerJoin(appUser, eq(appUser.id, patientChoice.doctorUserId))
    .where(and(eq(patientChoice.patientId, p.id), isNull(patientChoice.annulledAt)))
    .orderBy(desc(patientChoice.chosenOn));
  const corrections = await db
    .select({ at: accessLog.at, details: accessLog.details, user: appUser.displayName })
    .from(accessLog)
    .leftJoin(appUser, eq(appUser.id, accessLog.userId))
    .where(
      and(
        eq(accessLog.patientId, p.id),
        eq(accessLog.action, 'correzione_identita'),
        eq(accessLog.outcome, 'riuscito'),
      ),
    )
    .orderBy(desc(accessLog.seq));
  const imported = {
    patient: await importedRows(db, 'patient', [p.id]),
    exemption: await importedRows(
      db,
      'exemption',
      exemptions.map((e) => e.id),
    ),
    choice: await importedRows(
      db,
      'patient_choice',
      choices.map((c) => c.c.id),
    ),
  };
  const { exemptionExists, catalogLoaded: catalog } = await new ReferenceData(db).exemptionLookups(
    today,
  );
  return {
    paziente: {
      id: p.id,
      archivio: {
        id: p.archiveId,
        nome: arch?.name ?? '',
        titolare: arch?.owner ?? '',
        titolareId: arch?.ownerId ?? null,
      },
      identita: identityFields(p),
      // La causa del decesso è un dato clinico (ICD): la vede chi legge il riepilogo clinico (D171).
      dati: canReadDeathCause(actor, ctx, now)
        ? adminFields(p)
        : { ...adminFields(p), causaDecesso: undefined },
      causaDecessoRiservata: !canReadDeathCause(actor, ctx, now),
      nucleo: p.familyId ? await familyOf(db, p.familyId, p.id, visible) : null,
      importato: imported.patient.get(p.id) ?? null,
      creatoIl: p.createdAt.toISOString(),
      aggiornatoIl: p.updatedAt.toISOString(),
    },
    esenzioni: exemptions.map((e) => ({
      id: e.id,
      codice: e.code,
      dal: e.validFrom,
      al: e.validTo,
      codiceRicetta: e.prescriptionCode,
      fonte: SOURCE_LABEL[e.source],
      daAura: e.source === 'aura',
      importata: imported.exemption.get(e.id) ?? null,
      stato: exemptionState(e, today),
      /**
       * Nel catalogo delle esenzioni in vigore oggi; null senza catalogo, o se il catalogo non ha
       * la famiglia del codice (D190).
       */
      nelCatalogo: exemptionExists(e.code) ?? null,
    })),
    scelte: choices.map(({ c, doctor }) => ({
      id: c.id,
      medicoId: c.doctorUserId,
      medico: doctor,
      dal: c.chosenOn,
      scadenza: c.expiresOn,
      cessataIl: c.endedOn,
      motivoCessazione: c.endReason,
      fonte: c.source === 'aura' ? 'AURA' : 'Inserita a mano',
      daAura: c.source === 'aura',
      importata: imported.choice.get(c.id) ?? null,
      stato: choiceState(c, today),
    })),
    correzioni: corrections.map((r) => {
      const d = (r.details ?? {}) as { campi?: string[]; motivo?: string };
      return {
        quando: r.at.toISOString(),
        utente: r.user,
        campi: d.campi ?? [],
        motivo: d.motivo ?? '',
      };
    }),
    medici: await studioDoctors(db, actor.studioId),
    stati: PATIENT_STATUSES.map((s) => ({ chiave: s.key, nome: s.label })),
    canali: REMINDER_CHANNELS.map((c) => ({ chiave: c.key, nome: c.label })),
    sessi: PATIENT_SEXES.map((s) => ({ chiave: s.key, nome: s.label })),
    catalogoEsenzioni: catalog,
    puoScrivere: can(actor, 'registry.write', { ...ctx, now }).allowed,
    oggi: today,
  };
}

// --- Modifiche --------------------------------------------------------------------------------

/** Dopo la scrittura: che cosa è cambiato, nel registro (la guardia ha già registrato l'accesso). */
async function logDone(
  tx: Db,
  actor: Actor,
  patientId: string,
  action: 'modifica_dati_amministrativi' | 'correzione_identita',
  details: Record<string, unknown>,
) {
  await logAccess(tx, {
    studioId: actor.studioId,
    userId: actor.userId,
    patientId,
    action,
    outcome: 'riuscito',
    workstation: actor.workstation,
    details,
  });
}

/**
 * La causa del decesso è un dato clinico (codice ICD), non anagrafico: la legge chi legge il
 * riepilogo clinico dell'archivio e la scrive il medico (D171).
 */
function canReadDeathCause(actor: Actor, ctx: ArchiveContext, now: Date): boolean {
  return can(actor, 'clinical.summary.read', { ...ctx, now }).allowed;
}

/** Modifica dei dati amministrativi: solo i campi mandati, controllati insieme a quelli che restano. */
export async function updateAdmin(
  db: Database,
  actor: Actor,
  p: PatientRow,
  ctx: ArchiveContext,
  body: unknown,
  now: Date,
  /** Altro da scrivere nel registro, per esempio la fonte quando i dati vengono da AURA (D198). */
  details: Record<string, unknown> = {},
): Promise<{ dati: AdminFields; campi: AdminKey[] }> {
  const input = normalized(patientAdminSchema.parse(body));
  if (Object.keys(input).length === 0) throw new HttpError(400, 'Nessun campo da modificare');
  if (input.causaDecesso !== undefined && !can(actor, 'clinical.write', { ...ctx, now }).allowed)
    throw new HttpError(403, 'La causa del decesso è un dato clinico: la scrive il medico');
  const today = studioDate(now);
  const before = adminFields(p);
  const merged = { ...before, ...input } as PatientAdminInput;
  assertNoIssues([
    ...patientAdminIssues(merged, today),
    ...(input.decedutoIl ? lifeDatesIssues(p.birthDate, input.decedutoIl, today) : []),
  ]);
  const changed = changedKeys<AdminKey>(before, input);
  if (!changed.length) return { dati: before, campi: [] };
  const updated = await withActor(db, actor.userId, async (tx) => {
    const [row] = await tx
      .update(patient)
      .set({ ...adminColumns(pick(input, changed)), updatedAt: now })
      .where(eq(patient.id, p.id))
      .returning();
    await logDone(tx, actor, p.id, 'modifica_dati_amministrativi', { campi: changed, ...details });
    return row!;
  });
  return { dati: adminFields(updated), campi: changed };
}

export const identityFixSchema = patientIdentitySchema.partial().extend({
  motivo: z
    .string()
    .trim()
    .min(IDENTITY_FIX_REASON_MIN, `serve una frase di almeno ${IDENTITY_FIX_REASON_MIN} caratteri`)
    .max(500),
});

/**
 * Correzione dell'identità, con un motivo. L'identità che risulta deve essere valida per intero; un
 * codice fiscale nuovo non può essere di un altro paziente dello studio. Le incoerenze tra il codice
 * fiscale e i dati tornano come avvisi.
 */
export async function correctIdentity(
  db: Database,
  actor: Actor,
  p: PatientRow,
  body: unknown,
  now: Date,
): Promise<{ identita: IdentityFields; campi: IdentityKey[]; avvisi: string[] }> {
  const { motivo, ...fields } = identityFixSchema.parse(body);
  const before = identityFields(p);
  const after = normalized(patientIdentitySchema.parse({ ...before, ...fields }));
  const changed = changedKeys<IdentityKey>(before, after);
  if (!changed.length) throw new HttpError(400, 'L’identità non cambia: correggi almeno un dato');
  if (changed.includes('nascita'))
    assertNoIssues(lifeDatesIssues(after.nascita, p.deceasedOn, studioDate(now)));
  if (changed.includes('codiceFiscale'))
    await assertFiscalCodeFree(db, actor, after.codiceFiscale, now, 'correzione_identita', p.id);
  let updated: PatientRow;
  try {
    updated = await withActor(db, actor.userId, async (tx) => {
      const [row] = await tx
        .update(patient)
        .set({ ...identityColumns(pick(after, changed)), updatedAt: now })
        .where(eq(patient.id, p.id))
        .returning();
      await logDone(tx, actor, p.id, 'correzione_identita', { campi: changed, motivo });
      return row!;
    });
  } catch (err) {
    if (isUniqueViolation(err))
      throw new HttpError(409, 'Il codice fiscale è appena stato registrato per un altro paziente');
    throw err;
  }
  return { identita: identityFields(updated), campi: changed, avvisi: fiscalCodeCoherence(after) };
}

// --- Esenzioni --------------------------------------------------------------------------------

const isoDate = z.iso.date();

export const exemptionPatchSchema = z
  .object({
    /** Fine della validità; null = senza fine. */
    al: isoDate.nullable().optional(),
    codiceRicetta: z.string().trim().toUpperCase().max(20).nullable().optional(),
  })
  .strict();

/**
 * Avvisi dal catalogo delle esenzioni, se importato tra le banche dati: il codice non c'è nella
 * versione in vigore all'inizio della validità, o in quella di oggi se la validità comprende oggi.
 * Senza catalogo nessun avviso (D42): il controllo resta quello di R9.
 */
async function catalogNotes(
  db: Database,
  code: string,
  from: string,
  to: string | null,
  today: string,
): Promise<string[]> {
  const reference = new ReferenceData(db);
  const missingAtStart = (await reference.exemptionLookups(from)).exemptionExists(code) === false;
  const coversToday = from < today && (!to || today <= to);
  const missingToday =
    coversToday && (await reference.exemptionLookups(today)).exemptionExists(code) === false;
  if (!missingAtStart && !missingToday) return [];
  const when = missingAtStart
    ? `in vigore il ${it(from)}${missingToday ? ', né in quello in vigore oggi' : ''}`
    : 'in vigore oggi';
  return [
    `Il codice ${code} non è nel catalogo delle esenzioni ${when}: le ricette con questa esenzione si fermano al controllo R9`,
  ];
}

async function exemptionsOf(db: Db, patientId: string, code: string) {
  return db
    .select()
    .from(exemption)
    .where(
      and(
        eq(exemption.patientId, patientId),
        eq(exemption.code, code),
        isNull(exemption.annulledAt),
      ),
    );
}

function assertNoOverlap(
  rows: readonly (typeof exemption.$inferSelect)[],
  period: { from: string; to: string | null },
  exceptId?: string,
) {
  const clash = rows.find(
    (e) => e.id !== exceptId && periodsOverlap({ from: e.validFrom, to: e.validTo }, period),
  );
  if (clash)
    throw new HttpError(
      409,
      `L’esenzione ${clash.code} è già registrata dal ${it(clash.validFrom)}${clash.validTo ? ` al ${it(clash.validTo)}` : ', senza fine'}: chiudi quella validità prima di registrarne un’altra`,
    );
}

export async function addExemption(
  db: Database,
  actor: Actor,
  p: PatientRow,
  body: unknown,
  now: Date,
): Promise<{ id: string; avvisi: string[] }> {
  const input = exemptionSchema.parse(body);
  const to = input.al ?? null;
  assertNoOverlap(await exemptionsOf(db, p.id, input.codice), { from: input.dal, to });
  const id = await withActor(db, actor.userId, async (tx) => {
    const [row] = await tx
      .insert(exemption)
      .values({
        patientId: p.id,
        code: input.codice,
        validFrom: input.dal,
        validTo: to,
        prescriptionCode: input.codiceRicetta || null,
        source: 'manual',
      })
      .returning({ id: exemption.id });
    return row!.id;
  });
  return { id, avvisi: await catalogNotes(db, input.codice, input.dal, to, studioDate(now)) };
}

/** Fine della validità e codice in ricetta. Un'esenzione non si cancella (trigger, migrazione 0002). */
export async function updateExemption(
  db: Database,
  actor: Actor,
  p: PatientRow,
  exemptionId: string,
  body: unknown,
  now: Date,
): Promise<{ id: string; avvisi: string[] }> {
  const input = normalized(exemptionPatchSchema.parse(body));
  if (Object.keys(input).length === 0) throw new HttpError(400, 'Nessun campo da modificare');
  const [row] = await db
    .select()
    .from(exemption)
    .where(and(eq(exemption.id, exemptionId), eq(exemption.patientId, p.id)));
  if (!row) throw new HttpError(404, 'Esenzione non trovata per questo paziente');
  if (row.annulledAt) throw new HttpError(409, 'Esenzione annullata: non si modifica');
  if (row.source === 'aura')
    throw new HttpError(409, 'Esenzione arrivata da AURA: si aggiorna dall’anagrafe regionale');
  const to = input.al === undefined ? row.validTo : input.al;
  if (to && to < row.validFrom)
    throw new HttpError(400, 'La fine della validità viene dopo l’inizio', {
      problemi: ['La fine della validità viene dopo l’inizio'],
    });
  if (input.al !== undefined)
    assertNoOverlap(
      await exemptionsOf(db, p.id, row.code),
      { from: row.validFrom, to: to ?? null },
      row.id,
    );
  await withActor(db, actor.userId, (tx) =>
    tx
      .update(exemption)
      .set({
        ...(input.al !== undefined ? { validTo: input.al } : {}),
        ...(input.codiceRicetta !== undefined ? { prescriptionCode: input.codiceRicetta } : {}),
      })
      .where(eq(exemption.id, row.id)),
  );
  return {
    id: row.id,
    avvisi:
      input.al !== undefined
        ? await catalogNotes(db, row.code, row.validFrom, to ?? null, studioDate(now))
        : [],
  };
}

// --- Scelta del medico ------------------------------------------------------------------------

export const choiceEndSchema = z
  .object({
    cessataIl: isoDate,
    motivoCessazione: z.string().trim().min(1).max(300),
  })
  .strict();

const choicePeriod = (c: { chosenOn: string; expiresOn: string | null; endedOn: string | null }) =>
  choiceValidity({ dal: c.chosenOn, scadenza: c.expiresOn, cessataIl: c.endedOn });

/** Scelta del medico registrata a mano, in attesa di AURA: un medico titolare dello studio. */
export async function addChoice(
  db: Database,
  actor: Actor,
  p: PatientRow,
  body: unknown,
  now: Date,
): Promise<{ id: string; avvisi: string[] }> {
  const input = normalized(doctorChoiceSchema.parse(body));
  assertNoIssues(doctorChoiceIssues(input, studioDate(now)));
  const doctors = await studioDoctors(db, actor.studioId);
  const doctor = doctors.find((d) => d.id === input.medicoId);
  if (!doctor)
    throw new HttpError(400, 'Il medico scelto non è un medico titolare di questo studio', {
      problemi: ['Il medico scelto non è un medico titolare di questo studio'],
    });
  const existing = await db
    .select({ c: patientChoice, doctor: appUser.displayName })
    .from(patientChoice)
    .innerJoin(appUser, eq(appUser.id, patientChoice.doctorUserId))
    .where(and(eq(patientChoice.patientId, p.id), isNull(patientChoice.annulledAt)));
  const period = choicePeriod({
    chosenOn: input.dal,
    expiresOn: input.scadenza ?? null,
    endedOn: input.cessataIl ?? null,
  });
  const clash = existing.find(({ c }) => periodsOverlap(choicePeriod(c), period));
  if (clash)
    throw new HttpError(
      409,
      `C’è già una scelta che vale nello stesso periodo (${clash.doctor}, dal ${it(clash.c.chosenOn)}): registra prima la sua cessazione`,
    );
  const id = await withActor(db, actor.userId, async (tx) => {
    const [row] = await tx
      .insert(patientChoice)
      .values({
        patientId: p.id,
        doctorUserId: doctor.id,
        chosenOn: input.dal,
        expiresOn: input.scadenza ?? null,
        endedOn: input.cessataIl ?? null,
        endReason: input.motivoCessazione ?? null,
        source: 'manual',
      })
      .returning({ id: patientChoice.id });
    return row!.id;
  });
  const [owner] = await db
    .select({ ownerUserId: archive.ownerUserId })
    .from(archive)
    .where(eq(archive.id, p.archiveId));
  return {
    id,
    avvisi:
      owner && owner.ownerUserId !== doctor.id
        ? [
            `${doctor.nome} non è il titolare dell’archivio in cui sta il paziente: il paziente resta in quell’archivio`,
          ]
        : [],
  };
}

/** Cessazione della scelta, con la data e il motivo. */
export async function endChoice(
  db: Database,
  actor: Actor,
  p: PatientRow,
  choiceId: string,
  body: unknown,
  now: Date,
): Promise<{ id: string }> {
  const input = choiceEndSchema.parse(body);
  const [row] = await db
    .select()
    .from(patientChoice)
    .where(and(eq(patientChoice.id, choiceId), eq(patientChoice.patientId, p.id)));
  if (!row) throw new HttpError(404, 'Scelta non trovata per questo paziente');
  if (row.annulledAt) throw new HttpError(409, 'Scelta annullata: non si modifica');
  if (row.source === 'aura')
    throw new HttpError(
      409,
      'Scelta arrivata da AURA: la cessazione arriva dall’anagrafe regionale',
    );
  if (row.endedOn) throw new HttpError(409, `La scelta è già cessata il ${it(row.endedOn)}`);
  assertNoIssues(
    doctorChoiceIssues(
      {
        dal: row.chosenOn,
        scadenza: row.expiresOn,
        cessataIl: input.cessataIl,
        motivoCessazione: input.motivoCessazione,
      },
      studioDate(now),
    ),
  );
  if (input.cessataIl < row.chosenOn)
    throw new HttpError(400, 'La cessazione viene dopo la scelta', {
      problemi: ['La cessazione viene dopo la scelta'],
    });
  await withActor(db, actor.userId, (tx) =>
    tx
      .update(patientChoice)
      .set({ endedOn: input.cessataIl, endReason: input.motivoCessazione })
      .where(eq(patientChoice.id, row.id)),
  );
  return { id: row.id };
}

// --- Nucleo familiare -------------------------------------------------------------------------

const familyLabel = z.string().trim().min(1).max(100);

/** Nucleo nuovo con un'etichetta, il nucleo di un altro paziente, oppure nessun nucleo. */
export const familySetSchema = z.union([
  z.object({ etichetta: familyLabel }).strict(),
  z.object({ conPaziente: z.uuid() }).strict(),
  z.object({ nessuno: z.literal(true) }).strict(),
]);

export const familyRenameSchema = z.object({ etichetta: familyLabel }).strict();

/**
 * Cambia il nucleo del paziente. Per unirlo al nucleo di un altro paziente, chi agisce deve poter
 * vedere l'altro: lo decide la guardia, che registra la lettura nel registro dell'altro paziente.
 */
export async function setFamily(
  db: Database,
  actor: Actor,
  p: PatientRow,
  body: unknown,
  now: Date,
  readOther: (otherId: string) => Promise<PatientRow>,
): Promise<{ nucleo: string | null }> {
  const input = familySetSchema.parse(body);
  let target: string | null;
  if ('etichetta' in input) {
    target = null;
  } else if ('conPaziente' in input) {
    if (input.conPaziente === p.id)
      throw new HttpError(400, 'Scegli un altro paziente, non lo stesso');
    const other = await readOther(input.conPaziente);
    if (!other.familyId)
      throw new HttpError(
        409,
        `${other.lastName} ${other.firstName} non è in un nucleo familiare: crea il nucleo con un’etichetta, poi unisci l’altro paziente`,
      );
    target = other.familyId;
  } else {
    if (!p.familyId) throw new HttpError(409, 'Il paziente non è in un nucleo familiare');
    target = null;
  }
  if ('conPaziente' in input && target === p.familyId) return { nucleo: target };
  const familyId = await withActor(db, actor.userId, async (tx) => {
    let id = target;
    if ('etichetta' in input) {
      const [f] = await tx
        .insert(family)
        .values({ studioId: actor.studioId, label: input.etichetta })
        .returning({ id: family.id });
      id = f!.id;
    }
    await tx.update(patient).set({ familyId: id, updatedAt: now }).where(eq(patient.id, p.id));
    await logDone(tx, actor, p.id, 'modifica_dati_amministrativi', { campi: ['nucleo'] });
    return id;
  });
  return { nucleo: familyId };
}

/** Nuova etichetta del nucleo: vale per tutti i suoi componenti. */
export async function renameFamily(
  db: Database,
  actor: Actor,
  p: PatientRow,
  body: unknown,
): Promise<{ nucleo: string }> {
  const { etichetta } = familyRenameSchema.parse(body);
  if (!p.familyId) throw new HttpError(409, 'Il paziente non è in un nucleo familiare');
  const familyId = p.familyId;
  await withActor(db, actor.userId, async (tx) => {
    await tx.update(family).set({ label: etichetta }).where(eq(family.id, familyId));
    await logDone(tx, actor, p.id, 'modifica_dati_amministrativi', { campi: ['nucleo'] });
  });
  return { nucleo: familyId };
}

// --- Controllo dell'identità mentre si scrive -------------------------------------------------

export const identityCheckSchema = z
  .object({
    codiceFiscale: z.string().max(32),
    cognome: z.string().max(100).nullable().optional(),
    nome: z.string().max(100).nullable().optional(),
    sesso: z.enum(['M', 'F']).nullable().optional(),
    nascita: isoDate.nullable().optional(),
    luogoNascitaCodice: z.string().max(4).nullable().optional(),
  })
  .strict();
