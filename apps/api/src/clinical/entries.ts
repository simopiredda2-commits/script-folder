import {
  ANAMNESIS_KIND,
  ANAMNESIS_SECTIONS,
  CONTACT_KIND,
  CONTACT_TYPES,
  ENTRY_KIND,
  ENTRY_TYPES,
  ICD9_DIAGNOSIS_PATTERN,
  MEASURE_KEYS,
  checkProblemDates,
  entryTypeOf,
  keyOf,
  measureByKey,
  parseMeasureValue,
  type EntryType,
} from '@mmg/domain';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client';
import {
  allergyDetail,
  anamnesisDetail,
  appUser,
  clinicalEntry,
  diaryDetail,
  examinationDetail,
  measurementDetail,
  problemDetail,
  riskFactorDetail,
} from '../db/schema';
import type { Tx } from '../db/tx';
import { HttpError } from '../http/errors';

const isoDate = z.iso.date();
const longText = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional();

/** Campi comuni a ogni voce: data, note, riservata, oscurata, promemoria. */
const common = {
  data: isoDate,
  note: optionalText(2000),
  /** Visibile solo al medico. */
  riservata: z.boolean().optional(),
  /** Oscurata su richiesta del paziente: non esce verso il Fascicolo né verso i colleghi. */
  oscurata: z.boolean().optional(),
  /** Promemoria collegato alla voce, tra le scadenze della cartella. */
  promemoria: isoDate.optional(),
};

const problem = z
  .object({
    tipo: z.literal('problema'),
    ...common,
    descrizione: longText(300),
    /** ICD-9-CM 2007, nel formato dello schema del Sistema TS (codiceDiagnosi). */
    codice: z.string().trim().toUpperCase().max(10).optional(),
    stato: z.enum(['attivo', 'risolto']).default('attivo'),
    dal: isoDate.optional(),
    risoltoIl: isoDate.optional(),
    quesitoAperto: z.boolean().optional(),
  })
  .strict();

const diary = z
  .object({
    tipo: z.literal('diario'),
    ...common,
    contatto: z.enum(CONTACT_TYPES),
    testo: longText(10000),
  })
  .strict();

const measure = z
  .object({
    tipo: z.literal('misura'),
    ...common,
    parametro: z.enum(MEASURE_KEYS),
    valore: z.string().max(20),
  })
  .strict();

const anamnesis = z
  .object({
    tipo: z.literal('anamnesi'),
    ...common,
    sezione: z.enum(ANAMNESIS_SECTIONS),
    testo: longText(5000),
  })
  .strict();

const allergy = z
  .object({
    tipo: z.literal('allergia'),
    ...common,
    sostanza: longText(200),
    reazione: optionalText(500),
    daFarmaco: z.boolean().optional(),
  })
  .strict();

const lifestyle = z
  .object({
    tipo: z.literal('stile_di_vita'),
    ...common,
    fattore: longText(100),
    valore: longText(300),
  })
  .strict();

const examination = z
  .object({
    tipo: z.literal('esame_obiettivo'),
    ...common,
    testo: longText(5000),
    /** Nome della scheda o della scala di valutazione (es. le schede UVG). */
    scala: optionalText(100),
    punteggio: optionalText(50),
  })
  .strict();

export const newEntryBody = z.discriminatedUnion('tipo', [
  problem,
  diary,
  measure,
  anamnesis,
  allergy,
  lifestyle,
  examination,
]);
export type NewEntry = z.infer<typeof newEntryBody>;

/** Più parametri della stessa visita insieme: pressione, peso, altezza e gli altri. */
export const newMeasurementsBody = z
  .object({
    data: isoDate,
    note: optionalText(2000),
    riservata: z.boolean().optional(),
    misure: z
      .array(z.object({ parametro: z.enum(MEASURE_KEYS), valore: z.string().max(20) }).strict())
      .min(1)
      .max(MEASURE_KEYS.length)
      .refine((m) => new Set(m.map((x) => x.parametro)).size === m.length, {
        message: 'Ogni parametro una volta sola',
      }),
  })
  .strict();

export const entryPatchBody = z
  .object({
    riservata: z.boolean().optional(),
    oscurata: z.boolean().optional(),
    promemoria: isoDate.nullable().optional(),
    stato: z.enum(['attivo', 'risolto']).optional(),
    risoltoIl: isoDate.nullable().optional(),
    quesitoAperto: z.boolean().optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: 'Nessun campo da modificare' });

export const annulBody = z.object({ motivo: longText(500) }).strict();

export const listQuery = z
  .object({
    tipo: z.enum(ENTRY_TYPES).optional(),
    /** Anche le voci annullate, con il motivo. */
    annullate: z.enum(['si', 'no']).default('si'),
  })
  .strict();

/** Errori formali di una voce nuova, in italiano; vuoto se va bene. */
export function entryIssues(e: NewEntry, today: string): string[] {
  const out: string[] = [];
  if (e.data > today) out.push('Data della voce: è nel futuro');
  if (e.promemoria && e.promemoria < e.data)
    out.push('Promemoria: la data viene prima di quella della voce');
  if (e.tipo === 'problema') {
    if (e.codice && !ICD9_DIAGNOSIS_PATTERN.test(e.codice))
      out.push('Codice: non è nel formato ICD-9-CM (es. 401.9, 250.00, V17.3)');
    out.push(
      ...checkProblemDates({ state: e.stato, onsetOn: e.dal, resolvedOn: e.risoltoIl }, today),
    );
  }
  if (e.tipo === 'misura') {
    const r = parseMeasureValue(e.valore, measureByKey(e.parametro)!);
    if ('error' in r) out.push(r.error);
  }
  return out;
}

export function assertNoIssues(issues: string[]): void {
  if (issues.length) throw new HttpError(400, issues.join('. '), { problemi: issues });
}

/** Scrive la voce e il suo dettaglio, nella transazione dell'utente (storico). */
export async function insertEntry(
  tx: Tx,
  patientId: string,
  authorUserId: string,
  e: NewEntry,
): Promise<string> {
  const [row] = await tx
    .insert(clinicalEntry)
    .values({
      patientId,
      kind: ENTRY_KIND[e.tipo],
      occurredOn: e.data,
      authorUserId,
      notes: e.note || null,
      reserved: e.riservata ?? false,
      obscured: e.oscurata ?? false,
      reminderOn: e.promemoria ?? null,
    })
    .returning({ id: clinicalEntry.id });
  const entryId = row!.id;
  switch (e.tipo) {
    case 'problema':
      await tx.insert(problemDetail).values({
        entryId,
        icdCode: e.codice || null,
        description: e.descrizione,
        state: e.stato === 'risolto' ? 'resolved' : 'active',
        onsetOn: e.dal ?? null,
        resolvedOn: e.risoltoIl ?? null,
        openQuestion: e.quesitoAperto ?? false,
      });
      break;
    case 'diario':
      await tx
        .insert(diaryDetail)
        .values({ entryId, contactType: CONTACT_KIND[e.contatto], text: e.testo });
      break;
    case 'misura': {
      const def = measureByKey(e.parametro)!;
      const parsed = parseMeasureValue(e.valore, def);
      if ('error' in parsed) throw new HttpError(400, parsed.error);
      await tx
        .insert(measurementDetail)
        .values({ entryId, measure: def.label, value: parsed.value, unit: def.unit });
      break;
    }
    case 'anamnesi':
      await tx
        .insert(anamnesisDetail)
        .values({ entryId, section: ANAMNESIS_KIND[e.sezione], text: e.testo });
      break;
    case 'allergia':
      await tx.insert(allergyDetail).values({
        entryId,
        substance: e.sostanza,
        reaction: e.reazione || null,
        drugRelated: e.daFarmaco ?? false,
      });
      break;
    case 'stile_di_vita':
      await tx.insert(riskFactorDetail).values({ entryId, factor: e.fattore, value: e.valore });
      break;
    case 'esame_obiettivo':
      await tx.insert(examinationDetail).values({
        entryId,
        text: e.testo,
        scale: e.scala || null,
        score: e.punteggio || null,
      });
      break;
  }
  return entryId;
}

/** Dettaglio di una voce nell'interfaccia, con le parole dei requisiti. */
export type EntryDetail =
  | {
      descrizione: string;
      codice: string | null;
      sistema: string;
      stato: 'attivo' | 'risolto';
      dal: string | null;
      risoltoIl: string | null;
      quesitoAperto: boolean;
    }
  | { contatto: string | undefined; testo: string }
  | { parametro: string; valore: string; unita: string }
  | { sezione: string | undefined; testo: string }
  | { sostanza: string; reazione: string | null; daFarmaco: boolean }
  | { fattore: string; valore: string }
  | { testo: string; scala: string | null; punteggio: string | null };

/** I dettagli delle voci, per id. */
async function loadDetails(db: Database | Tx, ids: string[]) {
  const out = new Map<string, EntryDetail>();
  if (!ids.length) return out;
  for (const r of await db.select().from(problemDetail).where(inArray(problemDetail.entryId, ids)))
    out.set(r.entryId, {
      descrizione: r.description,
      codice: r.icdCode,
      sistema: r.icdSystem,
      stato: r.state === 'resolved' ? 'risolto' : 'attivo',
      dal: r.onsetOn,
      risoltoIl: r.resolvedOn,
      quesitoAperto: r.openQuestion,
    });
  for (const r of await db.select().from(diaryDetail).where(inArray(diaryDetail.entryId, ids)))
    out.set(r.entryId, { contatto: keyOf(CONTACT_KIND, r.contactType), testo: r.text });
  for (const r of await db
    .select()
    .from(measurementDetail)
    .where(inArray(measurementDetail.entryId, ids)))
    out.set(r.entryId, { parametro: r.measure, valore: r.value, unita: r.unit });
  for (const r of await db
    .select()
    .from(anamnesisDetail)
    .where(inArray(anamnesisDetail.entryId, ids)))
    out.set(r.entryId, { sezione: keyOf(ANAMNESIS_KIND, r.section), testo: r.text });
  for (const r of await db.select().from(allergyDetail).where(inArray(allergyDetail.entryId, ids)))
    out.set(r.entryId, {
      sostanza: r.substance,
      reazione: r.reaction,
      daFarmaco: r.drugRelated,
    });
  for (const r of await db
    .select()
    .from(riskFactorDetail)
    .where(inArray(riskFactorDetail.entryId, ids)))
    out.set(r.entryId, { fattore: r.factor, valore: r.value });
  for (const r of await db
    .select()
    .from(examinationDetail)
    .where(inArray(examinationDetail.entryId, ids)))
    out.set(r.entryId, { testo: r.text, scala: r.scale, punteggio: r.score });
  return out;
}

export interface EntryView {
  id: string;
  tipo: EntryType;
  data: string;
  autore: string;
  note: string | null;
  riservata: boolean;
  oscurata: boolean;
  promemoria: string | null;
  stato: 'attiva' | 'annullata';
  annullataIl: Date | null;
  motivoAnnullamento: string | null;
  dettaglio: EntryDetail | null;
}

/** Le voci scritte dalla cartella, dalla più recente; le riservate solo a chi può leggerle. */
export async function listEntries(
  db: Database,
  patientId: string,
  opts: { tipo?: EntryType; reservedAllowed: boolean; includeAnnulled: boolean },
): Promise<EntryView[]> {
  const kinds = opts.tipo ? [ENTRY_KIND[opts.tipo]] : ENTRY_TYPES.map((t) => ENTRY_KIND[t]);
  const rows = await db
    .select({ e: clinicalEntry, autore: appUser.displayName })
    .from(clinicalEntry)
    .innerJoin(appUser, eq(appUser.id, clinicalEntry.authorUserId))
    .where(
      and(
        eq(clinicalEntry.patientId, patientId),
        inArray(clinicalEntry.kind, kinds),
        opts.reservedAllowed ? undefined : eq(clinicalEntry.reserved, false),
        opts.includeAnnulled ? undefined : eq(clinicalEntry.status, 'active'),
      ),
    )
    .orderBy(desc(clinicalEntry.occurredOn), desc(clinicalEntry.createdAt));
  const details = await loadDetails(
    db,
    rows.map((r) => r.e.id),
  );
  return rows.map(({ e, autore }) => ({
    id: e.id,
    tipo: entryTypeOf(e.kind)!,
    data: e.occurredOn,
    autore,
    note: e.notes,
    riservata: e.reserved,
    oscurata: e.obscured,
    promemoria: e.reminderOn,
    stato: e.status === 'annulled' ? 'annullata' : 'attiva',
    annullataIl: e.annulledAt,
    motivoAnnullamento: e.annulReason,
    dettaglio: details.get(e.id) ?? null,
  }));
}

/** Andamento dei parametri nel tempo: una serie per parametro, dalla data più vecchia. */
export async function measurementSeries(db: Database, patientId: string, reservedAllowed: boolean) {
  const rows = await db
    .select({
      id: clinicalEntry.id,
      data: clinicalEntry.occurredOn,
      parametro: measurementDetail.measure,
      valore: measurementDetail.value,
      unita: measurementDetail.unit,
    })
    .from(measurementDetail)
    .innerJoin(clinicalEntry, eq(clinicalEntry.id, measurementDetail.entryId))
    .where(
      and(
        eq(clinicalEntry.patientId, patientId),
        eq(clinicalEntry.status, 'active'),
        reservedAllowed ? undefined : eq(clinicalEntry.reserved, false),
      ),
    )
    .orderBy(asc(clinicalEntry.occurredOn), asc(clinicalEntry.createdAt));
  const series = new Map<
    string,
    { parametro: string; unita: string; valori: { id: string; data: string; valore: string }[] }
  >();
  for (const r of rows) {
    // Stesso parametro con unità diverse: serie diverse, per non mescolare le scale.
    const key = `${r.parametro}\u0000${r.unita}`;
    const s = series.get(key) ?? { parametro: r.parametro, unita: r.unita, valori: [] };
    s.valori.push({ id: r.id, data: r.data, valore: r.valore });
    series.set(key, s);
  }
  return [...series.values()];
}

/** La voce del paziente, se chi la chiede può vederla; altrimenti 404. */
export async function loadEntry(
  db: Database | Tx,
  patientId: string,
  entryId: string,
  reservedAllowed: boolean,
) {
  const [e] = await db
    .select()
    .from(clinicalEntry)
    .where(and(eq(clinicalEntry.id, entryId), eq(clinicalEntry.patientId, patientId)));
  if (!e || (e.reserved && !reservedAllowed)) throw new HttpError(404, 'Voce non trovata');
  return e;
}

/** Modifica ammessa: riservata, oscurata, promemoria; per i problemi stato e quesito. */
export async function patchEntry(
  tx: Tx,
  entry: typeof clinicalEntry.$inferSelect,
  patch: z.infer<typeof entryPatchBody>,
  today: string,
): Promise<void> {
  if (entry.status === 'annulled') throw new HttpError(409, 'La voce è annullata: non si modifica');
  const problemFields =
    patch.stato !== undefined || patch.risoltoIl !== undefined || patch.quesitoAperto !== undefined;
  if (problemFields && entry.kind !== 'problem')
    throw new HttpError(400, 'Stato, risoluzione e quesito aperto valgono solo per i problemi');
  if (patch.promemoria && patch.promemoria < entry.occurredOn)
    throw new HttpError(400, 'Promemoria: la data viene prima di quella della voce');
  const common: Partial<typeof clinicalEntry.$inferInsert> = {};
  if (patch.riservata !== undefined) common.reserved = patch.riservata;
  if (patch.oscurata !== undefined) common.obscured = patch.oscurata;
  if (patch.promemoria !== undefined) common.reminderOn = patch.promemoria;
  if (Object.keys(common).length)
    await tx.update(clinicalEntry).set(common).where(eq(clinicalEntry.id, entry.id));
  if (!problemFields) return;
  const [current] = await tx
    .select()
    .from(problemDetail)
    .where(eq(problemDetail.entryId, entry.id));
  if (!current) throw new HttpError(409, 'Problema senza dettaglio');
  const state = patch.stato ?? (current.state === 'resolved' ? 'risolto' : 'attivo');
  // Tornando attivo, la data di risoluzione si toglie se non se ne indica un'altra.
  const resolvedOn =
    patch.risoltoIl !== undefined
      ? patch.risoltoIl
      : state === 'attivo'
        ? null
        : current.resolvedOn;
  assertNoIssues(checkProblemDates({ state, onsetOn: current.onsetOn, resolvedOn }, today));
  await tx
    .update(problemDetail)
    .set({
      state: state === 'risolto' ? 'resolved' : 'active',
      resolvedOn,
      ...(patch.quesitoAperto !== undefined ? { openQuestion: patch.quesitoAperto } : {}),
    })
    .where(eq(problemDetail.entryId, entry.id));
}

/** Annullamento con motivo: la voce resta, con chi e quando l'ha annullata. */
export async function annulEntry(
  tx: Tx,
  entry: typeof clinicalEntry.$inferSelect,
  userId: string,
  reason: string,
  at: Date,
): Promise<void> {
  if (entry.status === 'annulled') throw new HttpError(409, 'La voce è già annullata');
  await tx
    .update(clinicalEntry)
    .set({ status: 'annulled', annulledAt: at, annulledBy: userId, annulReason: reason })
    .where(eq(clinicalEntry.id, entry.id));
}
