import {
  ADVANCED_DRESSING_MAX_MONTHS,
  chosenAdvancedDressing,
  SUPPLY_CATEGORY_KEYS,
  supplyCategory,
  supplyEndOn,
  supplyIssues,
  supplyState,
} from '@mmg/domain';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client';
import { appUser, archive, clinicalEntry, problemDetail, supplyPrescription } from '../db/schema';
import type { Tx } from '../db/tx';
import { HttpError } from '../http/errors';

const isoDate = z.iso.date();
const optionalText = (max: number) => z.string().trim().max(max).optional();

/**
 * Prescrizione di presidi e assistenza integrativa (tappa 10). I limiti numerici sono solo di
 * formato (come D93): le quantità massime le decide la Regione (DPCM 12/1/2017, art. 13 e 14).
 */
export const supplyBody = z
  .object({
    categoria: z.enum(SUPPLY_CATEGORY_KEYS),
    // 500: la voce più lunga dell'allegato 2 del DPCM LEA ha 401 caratteri (D236).
    prodotto: z.string().trim().min(1).max(500),
    /** Codice del nomenclatore, se noto: scelto dagli allegati 2 e 3 del DPCM (D218, D236) o scritto. */
    codice: optionalText(30),
    quantitaMensile: z.number().int().min(1).max(9999),
    unita: z.string().trim().min(1).max(50),
    mesi: z.number().int().min(1).max(99),
    dal: isoDate,
    prescrittore: z.enum(['mmg', 'specialista']).default('mmg'),
    primoSpecialista: optionalText(200),
    primoSpecialistaIl: isoDate.optional(),
    indicazione: z.uuid().optional(),
    note: optionalText(1000),
    riservato: z.boolean().optional(),
  })
  .strict();
export type SupplyBody = z.infer<typeof supplyBody>;

export const renewBody = z
  .object({
    /** Dal giorno dopo la fine della precedente, se non si dice altro. */
    dal: isoDate.optional(),
    mesi: z.number().int().min(1).max(99).optional(),
    /**
     * Il rinnovo di una voce che il titolare ha poi scelto come medicazione avanzata passa in quella
     * categoria (D239): è l'unico cambio di categoria ammesso.
     */
    categoria: z.literal('medicazione_avanzata').optional(),
    /**
     * La prima prescrizione dello specialista, quando la prescrizione di prima non la dice: per
     * esempio una trascrizione dello specialista, o una voce passata alle medicazioni avanzate.
     */
    primoSpecialista: optionalText(200),
    primoSpecialistaIl: isoDate.optional(),
  })
  .strict();

export function bodyIssues(b: SupplyBody): string[] {
  return supplyIssues({
    category: b.categoria,
    months: b.mesi,
    prescriber: b.prescrittore,
    firstSpecialist: b.primoSpecialista,
    firstSpecialistOn: b.primoSpecialistaIl,
    startOn: b.dal,
  });
}

/** Le voci dell'allegato 2 che il titolare dell'archivio considera medicazioni avanzate (D237). */
export async function advancedCodesOf(db: Database | Tx, archiveId: string): Promise<string[]> {
  const [a] = await db
    .select({ codes: archive.advancedDressingCodes })
    .from(archive)
    .where(eq(archive.id, archiveId));
  return a?.codes ?? [];
}

/** L'indicazione dev'essere un problema di questo paziente. */
export async function checkIndication(db: Database | Tx, patientId: string, entryId?: string) {
  if (!entryId) return;
  const [row] = await db
    .select({ id: clinicalEntry.id })
    .from(clinicalEntry)
    .innerJoin(problemDetail, eq(problemDetail.entryId, clinicalEntry.id))
    .where(and(eq(clinicalEntry.id, entryId), eq(clinicalEntry.patientId, patientId)));
  if (!row) throw new HttpError(400, 'Indicazione: non è un problema di questo paziente');
}

export async function insertSupply(
  tx: Tx,
  patientId: string,
  userId: string,
  b: SupplyBody,
  renewsId: string | null = null,
) {
  const [row] = await tx
    .insert(supplyPrescription)
    .values({
      patientId,
      category: b.categoria,
      product: b.prodotto,
      code: b.codice || null,
      monthlyQuantity: b.quantitaMensile,
      unit: b.unita,
      months: b.mesi,
      startOn: b.dal,
      endOn: supplyEndOn(b.dal, b.mesi),
      prescriber: b.prescrittore,
      firstSpecialist: b.primoSpecialista || null,
      firstSpecialistOn: b.primoSpecialistaIl ?? null,
      indicationEntryId: b.indicazione ?? null,
      renewsId,
      notes: b.note || null,
      reserved: b.riservato ?? false,
      createdBy: userId,
    })
    .returning({ id: supplyPrescription.id });
  return row!.id;
}

/** La prescrizione del paziente, se chi la chiede può vederla; altrimenti 404. */
export async function loadSupply(
  db: Database | Tx,
  patientId: string,
  supplyId: string,
  reservedAllowed: boolean,
) {
  const [s] = await db
    .select()
    .from(supplyPrescription)
    .where(and(eq(supplyPrescription.id, supplyId), eq(supplyPrescription.patientId, patientId)));
  if (!s || (s.reserved && !reservedAllowed)) throw new HttpError(404, 'Prescrizione non trovata');
  return s;
}

/** Il corpo di un rinnovo: la prescrizione di prima, con le date nuove. */
export function renewalOf(s: typeof supplyPrescription.$inferSelect, r: z.infer<typeof renewBody>) {
  const next = new Date(Date.parse(`${s.endOn}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return supplyBody.parse({
    categoria: s.category,
    prodotto: s.product,
    ...(s.code ? { codice: s.code } : {}),
    quantitaMensile: s.monthlyQuantity,
    unita: s.unit,
    mesi: r.mesi ?? s.months,
    dal: r.dal ?? next,
    prescrittore: 'mmg',
    ...(r.categoria ? { categoria: r.categoria } : {}),
    ...((r.primoSpecialista ?? s.firstSpecialist)
      ? { primoSpecialista: r.primoSpecialista ?? s.firstSpecialist }
      : {}),
    ...((r.primoSpecialistaIl ?? s.firstSpecialistOn)
      ? { primoSpecialistaIl: r.primoSpecialistaIl ?? s.firstSpecialistOn }
      : {}),
    ...(s.indicationEntryId ? { indicazione: s.indicationEntryId } : {}),
    ...(s.notes ? { note: s.notes } : {}),
    riservato: s.reserved,
  });
}

export async function renewSupply(
  tx: Tx,
  s: typeof supplyPrescription.$inferSelect,
  userId: string,
  body: SupplyBody,
  at: Date,
) {
  if (s.status !== 'active') throw new HttpError(409, 'Si rinnova solo una prescrizione in corso');
  const id = await insertSupply(tx, s.patientId, userId, body, s.id);
  await tx
    .update(supplyPrescription)
    .set({ status: 'ended', updatedAt: at })
    .where(eq(supplyPrescription.id, s.id));
  return id;
}

export async function annulSupply(
  tx: Tx,
  s: typeof supplyPrescription.$inferSelect,
  userId: string,
  reason: string,
  at: Date,
) {
  if (s.status === 'annulled') throw new HttpError(409, 'La prescrizione è già annullata');
  await tx
    .update(supplyPrescription)
    .set({ status: 'annulled', annulledAt: at, annulledBy: userId, annulReason: reason })
    .where(eq(supplyPrescription.id, s.id));
}

/**
 * Che cosa chiede il rinnovo di una prescrizione (D239): se la voce è ora fra le medicazioni
 * avanzate del titolare passa in quella categoria; fra le medicazioni avanzate il medico di
 * famiglia rinnova con la prima prescrizione dello specialista e per al massimo 6 mesi.
 */
export function renewalNeeds(
  s: Pick<
    typeof supplyPrescription.$inferSelect,
    'category' | 'code' | 'months' | 'firstSpecialist' | 'firstSpecialistOn'
  >,
  advancedCodes: readonly string[],
) {
  const move =
    s.category !== 'medicazione_avanzata' && chosenAdvancedDressing(s.code, advancedCodes) !== null;
  const advanced = move || s.category === 'medicazione_avanzata';
  return {
    categoria: move ? ('medicazione_avanzata' as const) : null,
    chiedeSpecialista: advanced && !(s.firstSpecialist && s.firstSpecialistOn),
    mesiMassimi: advanced ? ADVANCED_DRESSING_MAX_MONTHS : null,
  };
}

export async function listSupplies(
  db: Database,
  patientId: string,
  reservedAllowed: boolean,
  today: string,
  advancedCodes: readonly string[] = [],
) {
  const rows = await db
    .select({ s: supplyPrescription, by: appUser.displayName })
    .from(supplyPrescription)
    .innerJoin(appUser, eq(appUser.id, supplyPrescription.createdBy))
    .where(
      and(
        eq(supplyPrescription.patientId, patientId),
        reservedAllowed ? undefined : eq(supplyPrescription.reserved, false),
      ),
    )
    .orderBy(desc(supplyPrescription.startOn), desc(supplyPrescription.createdAt));
  return rows.map(({ s, by }) => ({
    id: s.id,
    categoria: s.category,
    nomeCategoria: supplyCategory(s.category)?.label ?? s.category,
    fonte: supplyCategory(s.category)?.source ?? null,
    prodotto: s.product,
    codice: s.code,
    quantitaMensile: s.monthlyQuantity,
    unita: s.unit,
    mesi: s.months,
    dal: s.startOn,
    al: s.endOn,
    prescrittore: s.prescriber,
    primoSpecialista: s.firstSpecialist,
    primoSpecialistaIl: s.firstSpecialistOn,
    indicazione: s.indicationEntryId,
    rinnovaId: s.renewsId,
    note: s.notes,
    riservato: s.reserved,
    stato: supplyState(s, today),
    motivoAnnullamento: s.annulReason,
    registrataDa: by,
    rinnovo: renewalNeeds(s, advancedCodes),
  }));
}
