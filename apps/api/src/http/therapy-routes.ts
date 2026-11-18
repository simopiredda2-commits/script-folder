import { can } from '@mmg/domain';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '../db/client';
import { allergyDetail, clinicalEntry, problemDetail, therapy } from '../db/schema';
import { withActor } from '../db/tx';
import { guardPatient } from '../patients/access';
import { HttpError } from './errors';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const text = (max: number) => z.string().trim().max(max).nullable().optional();

/**
 * Scheda della terapia: il farmaco, come si prende, come va in ricetta, le opzioni (requisiti,
 * «Scheda della terapia»). Il corpo è la scheda intera: si salva com'è sullo schermo.
 */
export const therapyBody = z
  .object({
    // Il farmaco
    drugAic: z
      .string()
      .regex(/^\d{9}$/)
      .nullable()
      .optional(),
    drugName: z.string().trim().min(1).max(300),
    activeIngredient: text(300),
    atc: text(10),
    drugClass: text(5),
    equivalenceGroup: text(50),
    dpc: z.boolean().optional(),
    // Come si prende
    dose: text(50),
    doseUnit: text(50),
    frequency: text(100),
    timeOfDay: text(100),
    route: text(100),
    /** Unità al giorno per il contatore (R11): un numero, o vuoto se non si può dire. */
    unitsPerDay: z
      .string()
      .regex(/^\d+(?:[.,]\d+)?$/)
      .nullable()
      .optional(),
    kind: z.enum(['chronic', 'as_needed', 'cycle']),
    startOn: isoDate,
    endOn: isoDate.nullable().optional(),
    // Come va in ricetta
    packsPerPrescription: z.number().int().min(1).max(99),
    indicationEntryId: z.uuid().nullable().optional(),
    habitualExemptionCode: text(20),
    aifaNote: text(20),
    suggestedByName: text(200),
    suggestedByFacility: text(200),
    suggestedOn: isoDate.nullable().optional(),
    patientInstructions: text(1000),
    // Opzioni
    important: z.boolean().optional(),
    reserved: z.boolean().optional(),
    notReimbursable: z.boolean().optional(),
    byActiveIngredient: z.boolean().optional(),
    notSubstitutable: z.boolean().optional(),
    notSubstitutableReason: text(500),
    multiPrescription: z.boolean().optional(),
    suggestedS: z.boolean().optional(),
    hospitalH: z.boolean().optional(),
  })
  .strict()
  .refine((t) => !t.notSubstitutable || !!t.notSubstitutableReason, {
    message: 'Non sostituibile: serve una sintetica motivazione (R13)',
    path: ['notSubstitutableReason'],
  })
  .refine((t) => t.kind !== 'cycle' || !!t.endOn, {
    message: 'Ciclo con data di fine: manca la data di fine',
    path: ['endOn'],
  })
  .refine((t) => !t.endOn || t.endOn >= t.startOn, {
    message: 'La fine non può venire prima dell’inizio',
    path: ['endOn'],
  })
  .refine((t) => !t.suggestedS || !!t.suggestedByName, {
    message: 'Suggerita (S): servono i dati del medico suggeritore',
    path: ['suggestedByName'],
  });

const suspendBody = z
  .object({
    motivo: z.string().trim().min(1).max(500),
    /** La sospensione è per una reazione avversa: si registra tra le reazioni da farmaci. */
    reazioneAvversa: z.boolean().optional(),
    reazione: z.string().trim().max(500).optional(),
  })
  .strict();

const params = z.object({ id: z.uuid() });
const therapyParams = z.object({ id: z.uuid(), therapyId: z.uuid() });

/** Il corpo, con gli spazi vuoti come «non scritto». */
function normalize(body: z.infer<typeof therapyBody>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) out[k] = v === '' ? null : v;
  if (typeof out.unitsPerDay === 'string') out.unitsPerDay = out.unitsPerDay.replace(',', '.');
  return out as z.infer<typeof therapyBody>;
}

export function registerTherapyRoutes(app: FastifyInstance, db: Database, now: () => Date) {
  const scoped = { config: { patientScoped: true } };

  /** L'indicazione dev'essere un problema di questo paziente. */
  async function checkIndication(patientId: string, entryId: string | null | undefined) {
    if (!entryId) return;
    const [row] = await db
      .select({ id: clinicalEntry.id })
      .from(clinicalEntry)
      .innerJoin(problemDetail, eq(problemDetail.entryId, clinicalEntry.id))
      .where(and(eq(clinicalEntry.id, entryId), eq(clinicalEntry.patientId, patientId)));
    if (!row) throw new HttpError(400, 'Indicazione: non è un problema di questo paziente');
  }

  /** La terapia del paziente; quelle riservate solo a chi può leggerle. */
  async function loadTherapy(
    patientId: string,
    therapyId: string,
    reservedAllowed: boolean,
  ): Promise<typeof therapy.$inferSelect> {
    const [t] = await db
      .select()
      .from(therapy)
      .where(and(eq(therapy.id, therapyId), eq(therapy.patientId, patientId)));
    if (!t || (t.reserved && !reservedAllowed)) throw new HttpError(404, 'Terapia non trovata');
    return t;
  }

  app.post('/api/pazienti/:id/terapie', scoped, async (req, reply) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    await guardPatient(db, actor, id, 'therapy.write', 'nuova_terapia');
    // Il corpo si valida dopo la guardia: anche una richiesta sbagliata è registrata.
    const body = normalize(therapyBody.parse(req.body));
    await checkIndication(id, body.indicationEntryId);
    const [row] = await withActor(db, actor.userId, (tx) =>
      tx
        .insert(therapy)
        .values({ ...body, patientId: id, createdBy: actor.userId })
        .returning({ id: therapy.id }),
    );
    return reply.status(201).send({ id: row!.id });
  });

  app.put('/api/pazienti/:id/terapie/:therapyId', scoped, async (req) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    const { context } = await guardPatient(db, actor, id, 'therapy.write', 'modifica_terapia');
    // Il resto si valida dopo la guardia: anche una richiesta sbagliata entra nel registro.
    const { therapyId } = therapyParams.parse(req.params);
    const reservedAllowed = can(actor, 'reserved.read', { ...context, now: now() }).allowed;
    await loadTherapy(id, therapyId, reservedAllowed);
    const body = normalize(therapyBody.parse(req.body));
    await checkIndication(id, body.indicationEntryId);
    await withActor(db, actor.userId, (tx) =>
      tx
        .update(therapy)
        .set({ ...body, updatedAt: now() })
        .where(eq(therapy.id, therapyId)),
    );
    return { id: therapyId };
  });

  /**
   * Sospensione con motivo. Se il motivo è una reazione avversa, la reazione entra tra le
   * allergie e reazioni da farmaci della cartella (requisiti, «Funzioni in più»).
   */
  app.post('/api/pazienti/:id/terapie/:therapyId/sospendi', scoped, async (req) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    const { context } = await guardPatient(db, actor, id, 'therapy.write', 'sospensione_terapia');
    const { therapyId } = therapyParams.parse(req.params);
    const reservedAllowed = can(actor, 'reserved.read', { ...context, now: now() }).allowed;
    const t = await loadTherapy(id, therapyId, reservedAllowed);
    if (t.status !== 'active') throw new HttpError(409, 'La terapia non è in corso');
    const body = suspendBody.parse(req.body);
    await withActor(db, actor.userId, async (tx) => {
      await tx
        .update(therapy)
        .set({ status: 'suspended', suspendedReason: body.motivo, updatedAt: now() })
        .where(eq(therapy.id, therapyId));
      if (body.reazioneAvversa) {
        const [entry] = await tx
          .insert(clinicalEntry)
          .values({
            patientId: id,
            kind: 'allergy',
            occurredOn: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(now()),
            authorUserId: actor.userId,
            notes: `Sospensione di ${t.drugName}: ${body.motivo}`,
            reserved: t.reserved,
          })
          .returning({ id: clinicalEntry.id });
        await tx.insert(allergyDetail).values({
          entryId: entry!.id,
          substance: t.activeIngredient ?? t.drugName,
          reaction: body.reazione || body.motivo,
          drugRelated: true,
        });
      }
    });
    return { stato: 'suspended', reazioneRegistrata: !!body.reazioneAvversa };
  });

  app.post('/api/pazienti/:id/terapie/:therapyId/riprendi', scoped, async (req) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    const { context } = await guardPatient(db, actor, id, 'therapy.write', 'modifica_terapia');
    const { therapyId } = therapyParams.parse(req.params);
    const reservedAllowed = can(actor, 'reserved.read', { ...context, now: now() }).allowed;
    const t = await loadTherapy(id, therapyId, reservedAllowed);
    if (t.status !== 'suspended') throw new HttpError(409, 'La terapia non è sospesa');
    await withActor(db, actor.userId, (tx) =>
      tx
        .update(therapy)
        .set({ status: 'active', suspendedReason: null, updatedAt: now() })
        .where(eq(therapy.id, therapyId)),
    );
    return { stato: 'active' };
  });
}
