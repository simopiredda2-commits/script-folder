import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client';
import { appUser, therapeuticPlan } from '../db/schema';
import type { Tx } from '../db/tx';
import { HttpError } from '../http/errors';

const isoDate = z.iso.date();
const optionalText = (max: number) => z.string().trim().max(max).optional();
const MS_PER_DAY = 86_400_000;

/**
 * Piano terapeutico in cartella (R5, R6): il farmaco, chi l'ha rilasciato, da quando a quando,
 * le confezioni autorizzate e la posologia del piano. Il corpo è la scheda intera.
 */
export const planBody = z
  .object({
    farmaco: z.string().trim().min(1).max(300),
    aic: z
      .string()
      .regex(/^\d{9}$/)
      .optional(),
    principioAttivo: optionalText(300),
    rilasciatoIl: isoDate,
    scadeIl: isoDate,
    centro: optionalText(200),
    specialista: optionalText(200),
    confezioniAutorizzate: z.number().int().min(1).max(999).optional(),
    posologia: optionalText(500),
    /** In Piemonte alcuni piani sono ancora cartacei (es. Nota 85). */
    cartaceo: z.boolean().optional(),
    riservato: z.boolean().optional(),
    note: optionalText(1000),
  })
  .strict();
export type PlanBody = z.infer<typeof planBody>;

export function planIssues(p: PlanBody, today: string): string[] {
  const out: string[] = [];
  if (p.rilasciatoIl > today) out.push('Rilascio del piano: la data è nel futuro');
  if (p.scadeIl < p.rilasciatoIl) out.push('La scadenza non può venire prima del rilascio');
  return out;
}

function columns(p: PlanBody) {
  return {
    drugName: p.farmaco,
    drugAic: p.aic ?? null,
    activeIngredient: p.principioAttivo || null,
    grantedOn: p.rilasciatoIl,
    expiresOn: p.scadeIl,
    center: p.centro || null,
    specialist: p.specialista || null,
    packsAuthorized: p.confezioniAutorizzate ?? null,
    posologyText: p.posologia || null,
    paperOnly: p.cartaceo ?? false,
    reserved: p.riservato ?? false,
    notes: p.note || null,
  };
}

export async function insertPlan(tx: Tx, patientId: string, userId: string, p: PlanBody) {
  const [row] = await tx
    .insert(therapeuticPlan)
    .values({ ...columns(p), patientId, createdBy: userId })
    .returning({ id: therapeuticPlan.id });
  return row!.id;
}

/** Il piano del paziente, se chi lo chiede può vederlo; altrimenti 404. */
export async function loadPlan(
  db: Database | Tx,
  patientId: string,
  planId: string,
  reservedAllowed: boolean,
) {
  const [p] = await db
    .select()
    .from(therapeuticPlan)
    .where(and(eq(therapeuticPlan.id, planId), eq(therapeuticPlan.patientId, patientId)));
  if (!p || (p.reserved && !reservedAllowed)) throw new HttpError(404, 'Piano non trovato');
  return p;
}

export async function updatePlan(
  tx: Tx,
  plan: typeof therapeuticPlan.$inferSelect,
  p: PlanBody,
  at: Date,
) {
  if (plan.status === 'annulled') throw new HttpError(409, 'Il piano è annullato: non si modifica');
  await tx
    .update(therapeuticPlan)
    .set({ ...columns(p), updatedAt: at })
    .where(eq(therapeuticPlan.id, plan.id));
}

/** Annullamento con motivo: il piano resta in cartella e non vale più per R5 e R6. */
export async function annulPlan(
  tx: Tx,
  plan: typeof therapeuticPlan.$inferSelect,
  userId: string,
  reason: string,
  at: Date,
) {
  if (plan.status === 'annulled') throw new HttpError(409, 'Il piano è già annullato');
  await tx
    .update(therapeuticPlan)
    .set({ status: 'annulled', annulledAt: at, annulledBy: userId, annulReason: reason })
    .where(eq(therapeuticPlan.id, plan.id));
}

/** I piani del paziente, dal più recente, con lo stato alla data. */
export async function listPlans(
  db: Database,
  patientId: string,
  reservedAllowed: boolean,
  today: string,
) {
  const rows = await db
    .select({ p: therapeuticPlan, autore: appUser.displayName })
    .from(therapeuticPlan)
    .leftJoin(appUser, eq(appUser.id, therapeuticPlan.createdBy))
    .where(
      and(
        eq(therapeuticPlan.patientId, patientId),
        reservedAllowed ? undefined : eq(therapeuticPlan.reserved, false),
      ),
    )
    .orderBy(desc(therapeuticPlan.expiresOn), desc(therapeuticPlan.createdAt));
  const days = (from: string, to: string) =>
    Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / MS_PER_DAY);
  return rows.map(({ p, autore }) => ({
    id: p.id,
    farmaco: p.drugName,
    aic: p.drugAic,
    principioAttivo: p.activeIngredient,
    rilasciatoIl: p.grantedOn,
    scadeIl: p.expiresOn,
    centro: p.center,
    specialista: p.specialist,
    confezioniAutorizzate: p.packsAuthorized,
    posologia: p.posologyText,
    cartaceo: p.paperOnly,
    riservato: p.reserved,
    note: p.notes,
    stato: p.status === 'annulled' ? ('annullato' as const) : ('attivo' as const),
    motivoAnnullamento: p.annulReason,
    /** Validità alla data, come la legge R5. */
    validita:
      p.grantedOn > today
        ? ('non_ancora_valido' as const)
        : p.expiresOn < today
          ? ('scaduto' as const)
          : ('valido' as const),
    giorniAllaScadenza: days(today, p.expiresOn),
    registratoDa: autore,
  }));
}
