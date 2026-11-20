import { can } from '@mmg/domain';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '../db/client';
import { allergyDetail, clinicalEntry, problemDetail, therapy } from '../db/schema';
import { withActor } from '../db/tx';
import { guardPatient } from '../patients/access';
import { studioDate } from '../prescriptions/rules-check';
import type { ReferenceData } from '../reference/lookup';
import { HttpError } from './errors';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const text = (max: number) => z.string().trim().max(max).nullable().optional();

/**
 * Stati della terapia e che cosa vogliono dire (tappa 15):
 * - in corso (`active`): si ripete e va nello schema orario;
 * - sospesa (`suspended`): fermata per un motivo, anche una reazione avversa; non si ripete finché
 *   il medico non la riprende, e il motivo resta scritto nella scheda (D81);
 * - conclusa (`ended`): finita, con la data di fine vera. Non si ripete, non va nello schema orario
 *   né nel Profilo sanitario sintetico, e non si riprende: resta tra i farmaci prescritti con il
 *   suo storico. Una terapia nuova dello stesso farmaco è un'altra scheda.
 * La data «Al» di una terapia in corso è la fine prevista (obbligatoria per il ciclo); la
 * conclusione è un fatto, quindi la sua data non può essere nel futuro.
 */
export function concludedTherapyIssues(
  t: { startOn: string; endOn?: string | null },
  today: string,
): string[] {
  if (!t.endOn) return ['Terapia conclusa: manca la data di fine'];
  const out: string[] = [];
  if (t.endOn > today)
    out.push(
      'Terapia conclusa: la data di fine è nel futuro (una fine prevista va nel campo «Al»)',
    );
  if (t.endOn < t.startOn) out.push('Terapia conclusa: la fine viene prima dell’inizio');
  return out;
}

const concludeBody = z.object({ fine: isoDate }).strict();

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
    /**
     * Terapia già conclusa, registrata per lo storico (tappa 15): vale solo per una scheda nuova,
     * con la data di fine. Una terapia in corso si conclude con «Concludi».
     */
    concluded: z.boolean().optional(),
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

export function registerTherapyRoutes(
  app: FastifyInstance,
  db: Database,
  now: () => Date,
  reference?: ReferenceData,
) {
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
    const { concluded, ...body } = normalize(therapyBody.parse(req.body));
    if (concluded) {
      const issues = concludedTherapyIssues(body, studioDate(now()));
      if (issues.length) throw new HttpError(400, issues.join('. '), { problemi: issues });
    }
    await checkIndication(id, body.indicationEntryId);
    const [row] = await withActor(db, actor.userId, (tx) =>
      tx
        .insert(therapy)
        .values({
          ...body,
          patientId: id,
          createdBy: actor.userId,
          ...(concluded ? { status: 'ended' as const } : {}),
        })
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
    const current = await loadTherapy(id, therapyId, reservedAllowed);
    const { concluded, ...body } = normalize(therapyBody.parse(req.body));
    if (concluded !== undefined)
      throw new HttpError(
        400,
        'Terapia già conclusa: si indica solo per una scheda nuova; una terapia in corso si conclude con «Concludi»',
      );
    // Una terapia conclusa resta con la sua data di fine vera, anche dopo una modifica.
    if (current.status === 'ended') {
      const issues = concludedTherapyIssues(body, studioDate(now()));
      if (issues.length) throw new HttpError(400, issues.join('. '), { problemi: issues });
    }
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
   * Classe, nota AIFA, DPC e gruppo di equivalenza dalle banche dati in vigore oggi, come quando si
   * sceglie di nuovo il farmaco nella scheda (D208): chiude le variazioni AIFA di classe e di nota
   * (D205). Il resto della scheda non cambia; lo storico delle modifiche conserva i valori di prima.
   */
  app.post('/api/pazienti/:id/terapie/:therapyId/aggiorna-dati-farmaco', scoped, async (req) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    const { context } = await guardPatient(db, actor, id, 'therapy.write', 'modifica_terapia');
    const { therapyId } = therapyParams.parse(req.params);
    const reservedAllowed = can(actor, 'reserved.read', { ...context, now: now() }).allowed;
    const t = await loadTherapy(id, therapyId, reservedAllowed);
    if (t.status === 'ended') throw new HttpError(409, 'La terapia è conclusa');
    if (!t.drugAic)
      throw new HttpError(400, 'La terapia non ha il codice AIC del farmaco: non si aggiorna');
    const drug = reference
      ? (await reference.drugs([t.drugAic], studioDate(now()))).get(t.drugAic)
      : undefined;
    if (!drug) throw new HttpError(404, 'Il farmaco non è nelle banche dati in vigore oggi');
    const patch = {
      drugClass: drug.drugClass,
      aifaNote: drug.aifaNote,
      dpc: drug.dpc,
      equivalenceGroup: drug.equivalenceGroup,
    };
    await withActor(db, actor.userId, (tx) =>
      tx
        .update(therapy)
        .set({ ...patch, updatedAt: now() })
        .where(eq(therapy.id, therapyId)),
    );
    return { id: therapyId, ...patch };
  });

  /**
   * Conclusione di una terapia in corso o sospesa, con la data di fine vera (tappa 15). Non è la
   * sospensione: una terapia conclusa non si riprende. Il motivo di una sospensione si toglie
   * dalla scheda, come quando la si riprende; lo storico delle modifiche lo conserva.
   */
  app.post('/api/pazienti/:id/terapie/:therapyId/concludi', scoped, async (req) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    const { context } = await guardPatient(db, actor, id, 'therapy.write', 'modifica_terapia');
    const { therapyId } = therapyParams.parse(req.params);
    const reservedAllowed = can(actor, 'reserved.read', { ...context, now: now() }).allowed;
    const t = await loadTherapy(id, therapyId, reservedAllowed);
    if (t.status === 'ended') throw new HttpError(409, 'La terapia è già conclusa');
    const { fine } = concludeBody.parse(req.body);
    const issues = concludedTherapyIssues({ startOn: t.startOn, endOn: fine }, studioDate(now()));
    if (issues.length) throw new HttpError(400, issues.join('. '), { problemi: issues });
    await withActor(db, actor.userId, (tx) =>
      tx
        .update(therapy)
        .set({ status: 'ended', endOn: fine, suspendedReason: null, updatedAt: now() })
        .where(eq(therapy.id, therapyId)),
    );
    return { stato: 'ended', fine };
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
