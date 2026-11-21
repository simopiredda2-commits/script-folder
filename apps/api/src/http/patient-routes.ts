import { unseenLockCount } from '../auth/account-locks';
import { ADVANCED_DRESSING_CODE, can, ROLE_LABELS } from '@mmg/domain';
import { and, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { logAccess } from '../audit/access-log';
import type { Actor } from '../auth/service';
import type { Database } from '../db/client';
import {
  accessLog,
  allergyDetail,
  appUser,
  archive,
  clinicalEntry,
  diaryDetail,
  doctorProfile,
  exemption,
  patient,
  problemDetail,
  therapeuticPlan,
  therapy,
} from '../db/schema';
import { withActor } from '../db/tx';
import { advancedCodesOf } from '../clinical/supplies';
import { buildCsvZip } from '../export/csv';
import { buildExport } from '../export/export';
import { guardPatient, loadArchiveContext, visibleArchives } from '../patients/access';
import { labResults, latestMeasurements, timeline } from '../patients/timeline';
import { studioDate } from '../prescriptions/rules-check';
import { ReferenceData, type AifaChange, type DrugShortage } from '../reference/lookup';
import { HttpError } from './errors';

const idParams = z.object({ id: z.uuid() });

/** Campi dell'anagrafica modificabili (la segreteria li gestisce). */
const registryPatch = z
  .object({
    phone: z.string().max(40).nullable(),
    email: z.email().nullable(),
    residenceStreet: z.string().max(200).nullable(),
    residenceNumber: z.string().max(20).nullable(),
    residenceTown: z.string().max(100).nullable(),
    residenceProvince: z.string().max(2).nullable(),
    domicile: z.string().max(300).nullable(),
    occupation: z.string().max(200).nullable(),
    employerEmail: z.email().nullable(),
  })
  .partial()
  .strict();

export interface PatientRouteDeps {
  /** Banche dati, per i farmaci carenti delle terapie in corso (D202); senza, nessuna carenza. */
  reference?: ReferenceData;
  now?: () => Date;
}

export function registerPatientRoutes(
  app: FastifyInstance,
  db: Database,
  deps: PatientRouteDeps = {},
) {
  const now = deps.now ?? (() => new Date());
  app.get('/api/io', async (req) => {
    const actor = req.actor!;
    // L'archivio di cui l'utente è titolare: impostazioni ed esportazione dall'interfaccia.
    const [own] = await db
      .select({ id: archive.id, nome: archive.name })
      .from(archive)
      .where(and(eq(archive.studioId, actor.studioId), eq(archive.ownerUserId, actor.userId)));
    // Il nome utente serve al modulo del cambio della password (gestori di password).
    const [me] = await db
      .select({ username: appUser.username, pending: doctorProfile.pendingFiscalCode })
      .from(appUser)
      .leftJoin(doctorProfile, eq(doctorProfile.userId, appUser.id))
      .where(eq(appUser.id, actor.userId));
    return {
      id: actor.userId,
      nome: actor.displayName,
      nomeUtente: me?.username ?? null,
      ruoli: actor.roles.map((r) => ({ codice: r, nome: ROLE_LABELS[r] })),
      postazione: actor.workstation,
      archivio: own ?? null,
      // Password temporanea: l'interfaccia mostra solo il cambio della password (tappa 14).
      devoCambiarePassword: actor.mustChangePassword,
      // Correzione del codice fiscale dell'amministratore che aspetta il medico (D181).
      codiceFiscaleDaConfermare: !!me?.pending,
      // Blocchi del conto ancora da vedere: i propri e, per un titolare, dello studio (D188).
      blocchiDaVedere: await unseenLockCount(db, actor),
    };
  });

  /** Elenco e ricerca: nome, cognome, codice fiscale, anno di nascita, telefono. */
  app.get('/api/pazienti', async (req) => {
    const actor = req.actor!;
    const q = z
      .object({ q: z.string().max(100).optional() })
      .parse(req.query)
      .q?.trim();
    const archives = await visibleArchives(db, actor, 'registry.read');
    // Quanti archivi vede chi chiede: con nessuno, l'interfaccia spiega il perché (l'amministratore
    // dello studio non apre le cartelle; un sostituto vede solo con un'autorizzazione in corso).
    if (archives.length === 0) return { pazienti: [], archivi: 0 };
    const like = q ? `%${q}%` : undefined;
    const rows = await db
      .select({
        id: patient.id,
        nome: patient.firstName,
        cognome: patient.lastName,
        dataNascita: patient.birthDate,
        codiceFiscale: patient.fiscalCode,
        stato: patient.status,
      })
      .from(patient)
      .where(
        and(
          eq(patient.studioId, actor.studioId),
          inArray(patient.archiveId, archives),
          like
            ? or(
                ilike(patient.lastName, like),
                ilike(patient.firstName, like),
                ilike(sql`${patient.lastName} || ' ' || ${patient.firstName}`, like),
                ilike(patient.fiscalCode, like),
                ilike(patient.phone, like),
                ilike(sql`${patient.birthDate}::text`, like),
              )
            : undefined,
        ),
      )
      .orderBy(patient.lastName, patient.firstName)
      .limit(100);
    return { pazienti: rows, archivi: archives.length };
  });

  /** Apertura della cartella: anagrafica e, per chi può, il riepilogo clinico. */
  app.get('/api/pazienti/:id', { config: { patientScoped: true } }, async (req) => {
    const actor = req.actor!;
    const { id } = idParams.parse(req.params);
    const { patient: p, context } = await guardPatient(
      db,
      actor,
      id,
      'registry.read',
      'apertura_cartella',
    );
    const summaryAllowed = can(actor, 'clinical.summary.read', {
      ...context,
      now: new Date(),
    }).allowed;
    const reservedAllowed = can(actor, 'reserved.read', { ...context, now: new Date() }).allowed;
    const summary = summaryAllowed
      ? {
          allergie: await db
            .select({ sostanza: allergyDetail.substance, reazione: allergyDetail.reaction })
            .from(allergyDetail)
            .innerJoin(clinicalEntry, eq(clinicalEntry.id, allergyDetail.entryId))
            .where(
              and(
                eq(clinicalEntry.patientId, id),
                eq(clinicalEntry.status, 'active'),
                reservedAllowed ? undefined : eq(clinicalEntry.reserved, false),
              ),
            ),
          problemiAttivi: await db
            .select({
              id: problemDetail.entryId,
              descrizione: problemDetail.description,
              codice: problemDetail.icdCode,
              dal: problemDetail.onsetOn,
            })
            .from(problemDetail)
            .innerJoin(clinicalEntry, eq(clinicalEntry.id, problemDetail.entryId))
            .where(
              and(
                eq(clinicalEntry.patientId, id),
                eq(clinicalEntry.status, 'active'),
                eq(problemDetail.state, 'active'),
                reservedAllowed ? undefined : eq(clinicalEntry.reserved, false),
              ),
            ),
          pianiTerapeutici: await db
            .select({ farmaco: therapeuticPlan.drugName, scadenza: therapeuticPlan.expiresOn })
            .from(therapeuticPlan)
            .where(
              and(
                eq(therapeuticPlan.patientId, id),
                eq(therapeuticPlan.status, 'active'),
                reservedAllowed ? undefined : eq(therapeuticPlan.reserved, false),
              ),
            ),
          esenzioni: await db
            .select({ codice: exemption.code, dal: exemption.validFrom, al: exemption.validTo })
            .from(exemption)
            .where(and(eq(exemption.patientId, id), isNull(exemption.annulledAt))),
          parametri: await latestMeasurements(db, id, reservedAllowed),
        }
      : null;
    return { paziente: p, riepilogo: summary };
  });

  app.get('/api/pazienti/:id/diario', { config: { patientScoped: true } }, async (req) => {
    const actor = req.actor!;
    const { id } = idParams.parse(req.params);
    const { context } = await guardPatient(db, actor, id, 'clinical.diary.read', 'lettura_diario');
    const reservedAllowed = can(actor, 'reserved.read', { ...context, now: new Date() }).allowed;
    const notes = await db
      .select({
        id: clinicalEntry.id,
        data: clinicalEntry.occurredOn,
        contatto: diaryDetail.contactType,
        testo: diaryDetail.text,
        stato: clinicalEntry.status,
      })
      .from(diaryDetail)
      .innerJoin(clinicalEntry, eq(clinicalEntry.id, diaryDetail.entryId))
      .where(
        and(
          eq(clinicalEntry.patientId, id),
          reservedAllowed ? undefined : eq(clinicalEntry.reserved, false),
        ),
      )
      .orderBy(desc(clinicalEntry.occurredOn));
    return { diario: notes };
  });

  app.get('/api/pazienti/:id/cronologia', { config: { patientScoped: true } }, async (req) => {
    const { id } = idParams.parse(req.params);
    return timeline(db, req.actor!, id, req.query);
  });

  app.get('/api/pazienti/:id/esami', { config: { patientScoped: true } }, async (req) => {
    const { id } = idParams.parse(req.params);
    return labResults(db, req.actor!, id);
  });

  app.get('/api/pazienti/:id/terapie', { config: { patientScoped: true } }, async (req) => {
    const actor = req.actor!;
    const { id } = idParams.parse(req.params);
    const { context } = await guardPatient(db, actor, id, 'therapy.read', 'lettura_terapie');
    const reservedAllowed = can(actor, 'reserved.read', { ...context, now: new Date() }).allowed;
    const rows = await db
      .select()
      .from(therapy)
      .where(
        and(eq(therapy.patientId, id), reservedAllowed ? undefined : eq(therapy.reserved, false)),
      )
      .orderBy(therapy.drugName);
    // Avviso di carenza sui farmaci in terapia (requisiti, «Banche dati»; D202): per le terapie
    // non concluse con l'AIC, dall'elenco AIFA in vigore oggi.
    const shortages = deps.reference
      ? await deps.reference.shortages(
          rows.filter((r) => r.status !== 'ended' && r.drugAic).map((r) => r.drugAic!),
          studioDate(now()),
        )
      : new Map<string, DrugShortage>();
    // Le altre variazioni AIFA (A7, D205), per le stesse terapie.
    const changes = deps.reference
      ? await deps.reference.aifaChanges(
          rows
            .filter((r) => r.status !== 'ended' && r.drugAic)
            .map((r) => ({
              id: r.id,
              drugAic: r.drugAic,
              drugClass: r.drugClass,
              aifaNote: r.aifaNote,
              activeIngredient: r.activeIngredient,
              atc: r.atc,
              hasPlan: r.therapeuticPlanId !== null,
            })),
          studioDate(now()),
        )
      : new Map<string, AifaChange[]>();
    return {
      terapie: rows.map((r) => ({
        ...r,
        shortage: (r.status !== 'ended' && r.drugAic && shortages.get(r.drugAic)) || null,
        aifaChanges: changes.get(r.id) ?? [],
      })),
    };
  });

  app.patch('/api/pazienti/:id/anagrafica', { config: { patientScoped: true } }, async (req) => {
    const actor = req.actor!;
    const { id } = idParams.parse(req.params);
    await guardPatient(db, actor, id, 'registry.write', 'modifica_anagrafica');
    const patch = registryPatch.parse(req.body);
    if (Object.keys(patch).length === 0) throw new HttpError(400, 'Nessun campo da modificare');
    const [updated] = await withActor(db, actor.userId, (tx) =>
      tx
        .update(patient)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(patient.id, id))
        .returning(),
    );
    return { paziente: updated };
  });

  app.get('/api/pazienti/:id/registro', { config: { patientScoped: true } }, async (req) => {
    const actor = req.actor!;
    const { id } = idParams.parse(req.params);
    await guardPatient(db, actor, id, 'access_log.read', 'lettura_registro');
    const rows = await db
      .select({
        quando: accessLog.at,
        utente: accessLog.userId,
        azione: accessLog.action,
        esito: accessLog.outcome,
        postazione: accessLog.workstation,
      })
      .from(accessLog)
      .where(eq(accessLog.patientId, id))
      .orderBy(desc(accessLog.seq));
    return { registro: rows };
  });

  const archiveParams = z.object({ id: z.uuid() });
  const settingsBody = z
    .object({
      segreteriaLeggeDiario: z.boolean(),
      segreteriaLeggeRiepilogo: z.boolean(),
      /**
       * Le voci del gruppo 04.49 dell'allegato 2 che il titolare considera medicazioni avanzate,
       * con la regola dello specialista (D237). L'elenco intero: sostituisce quello di prima.
       */
      medicazioniAvanzate: z
        .array(
          z
            .string()
            .trim()
            .regex(
              ADVANCED_DRESSING_CODE,
              'Solo voci del gruppo 04.49 dell’allegato 2 del DPCM LEA',
            ),
        )
        .max(50),
    })
    .partial()
    .strict();

  /**
   * Che cosa vede la segreteria di questo archivio: lo decide il titolare (D30). Nel registro la
   * consultazione e la modifica restano distinte, la modifica con i nomi dei campi (mai i valori).
   */
  const guardArchiveSettings = async (
    actor: Actor,
    archiveId: string,
    fase: 'lettura' | 'modifica',
    campi: string[] = [],
  ) => {
    const ctx = await loadArchiveContext(db, archiveId);
    const decision = can(actor, 'archive.settings', { ...ctx, now: new Date() });
    await logAccess(db, {
      studioId: actor.studioId,
      userId: actor.userId,
      action: 'impostazioni_archivio',
      outcome: decision.allowed ? 'consentito' : 'negato',
      workstation: actor.workstation,
      details: {
        archivio: archiveId,
        fase,
        ...(campi.length ? { campi } : {}),
        motivo: decision.reason,
      },
    });
    if (!decision.allowed) throw new HttpError(403, decision.reason);
    return ctx;
  };

  app.get('/api/archivi/:id/impostazioni', async (req) => {
    const { id } = archiveParams.parse(req.params);
    const ctx = await guardArchiveSettings(req.actor!, id, 'lettura');
    return {
      segreteriaLeggeDiario: ctx.settings.secretaryCanReadDiary,
      segreteriaLeggeRiepilogo: ctx.settings.secretaryCanReadSummary,
      medicazioniAvanzate: await advancedCodesOf(db, id),
    };
  });

  app.patch('/api/archivi/:id/impostazioni', async (req) => {
    const { id } = archiveParams.parse(req.params);
    const parsed = settingsBody.safeParse(req.body);
    await guardArchiveSettings(
      req.actor!,
      id,
      'modifica',
      parsed.success ? Object.keys(parsed.data) : [],
    );
    const body = settingsBody.parse(req.body);
    // Solo voci del nomenclatore in uso: una voce che non c'è non si potrebbe scegliere (D237).
    const advanced = body.medicazioniAvanzate && [...new Set(body.medicazioniAvanzate)].sort();
    if (advanced?.length) {
      const known = new Set(
        (await new ReferenceData(db).supplyCatalog(studioDate(now())))
          .filter((i) => i.entryType === 'presidio' && i.annex === '2')
          .map((i) => i.code),
      );
      const unknown = advanced.filter((c) => !known.has(c));
      if (unknown.length)
        throw new HttpError(
          400,
          `Non sono voci del nomenclatore dell’allegato 2 in uso: ${unknown.join(', ')}`,
        );
    }
    const [row] = await withActor(db, req.actor!.userId, (tx) =>
      tx
        .update(archive)
        .set({
          ...(body.segreteriaLeggeDiario !== undefined
            ? { secretaryCanReadDiary: body.segreteriaLeggeDiario }
            : {}),
          ...(body.segreteriaLeggeRiepilogo !== undefined
            ? { secretaryCanReadSummary: body.segreteriaLeggeRiepilogo }
            : {}),
          ...(advanced !== undefined ? { advancedDressingCodes: advanced } : {}),
        })
        .where(eq(archive.id, id))
        .returning(),
    );
    return {
      segreteriaLeggeDiario: row!.secretaryCanReadDiary,
      segreteriaLeggeRiepilogo: row!.secretaryCanReadSummary,
      medicazioniAvanzate: row!.advancedDressingCodes,
    };
  });

  /** Esportazione completa dell'archivio del medico titolare. */
  app.get('/api/esportazione', async (req, reply) => {
    const actor = req.actor!;
    const { formato: format } = z
      .object({ formato: z.enum(['json', 'csv']).default('json') })
      .parse(req.query);
    const own = await db
      .select({ id: archive.id })
      .from(archive)
      .where(and(eq(archive.studioId, actor.studioId), eq(archive.ownerUserId, actor.userId)));
    const target = own[0];
    const decision = target
      ? can(actor, 'data.export', { ...(await loadArchiveContext(db, target.id)), now: new Date() })
      : { allowed: false, reason: 'Nessun archivio di cui sei titolare' };
    await logAccess(db, {
      studioId: actor.studioId,
      userId: actor.userId,
      action: 'esportazione',
      outcome: decision.allowed ? 'consentito' : 'negato',
      workstation: actor.workstation,
      details: { archivio: target?.id ?? null, formato: format, motivo: decision.reason },
    });
    if (!target || !decision.allowed) throw new HttpError(403, decision.reason);
    const doc = await buildExport(db, target.id, new Date());
    const day = doc.generato_il.slice(0, 10);
    if (format === 'csv') {
      reply.header('content-type', 'application/zip');
      reply.header('content-disposition', `attachment; filename="esportazione-${day}-csv.zip"`);
      return reply.send(Buffer.from(buildCsvZip(doc)));
    }
    reply.header('content-disposition', `attachment; filename="esportazione-${day}.json"`);
    return doc;
  });
}
