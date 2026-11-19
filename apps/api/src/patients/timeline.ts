import { AFT_ACTIVITY_KINDS, can } from '@mmg/domain';
import { and, desc, eq, gte, inArray, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Actor } from '../auth/service';
import type { Database } from '../db/client';
import {
  aftActivity,
  allergyDetail,
  anamnesisDetail,
  appUser,
  clinicalEntry,
  diaryDetail,
  examinationDetail,
  labResultDetail,
  measurementDetail,
  prescription,
  prescriptionLine,
  problemDetail,
  reportDetail,
  riskFactorDetail,
  vaccinationDetail,
} from '../db/schema';
import { guardPatient } from './access';

/** Filtri della cronologia, come nella cartella dei requisiti: tutto, visite, ricette, esami. */
export const timelineQuery = z
  .object({ tipo: z.enum(['tutto', 'visite', 'ricette', 'esami']).default('tutto') })
  .strict();

const VISIT_KINDS = ['diary', 'examination', 'measurement'] as const;
const EXAM_KINDS = ['lab_result', 'report'] as const;

export interface TimelineItem {
  id: string;
  data: string;
  tipo: string;
  titolo: string;
  testo: string | null;
  annullata: boolean;
  autore: string | null;
}

const PRESCRIPTION_LABELS: Record<string, string> = {
  pharma_ssn: 'Ricetta farmaceutica SSN',
  specialist_ssn: 'Ricetta specialistica SSN',
  white: 'Ricetta bianca',
  devices: 'Ricetta per presidi',
};

/** Testo breve di ogni voce, dal suo dettaglio. */
async function details(db: Database, ids: string[]) {
  const out = new Map<string, { titolo: string; testo: string | null }>();
  if (!ids.length) return out;
  const set = (id: string, titolo: string, testo: string | null = null) =>
    out.set(id, { titolo, testo });
  for (const r of await db.select().from(diaryDetail).where(inArray(diaryDetail.entryId, ids)))
    set(r.entryId, 'Nota di visita', r.text);
  for (const r of await db.select().from(problemDetail).where(inArray(problemDetail.entryId, ids)))
    set(r.entryId, r.description, r.icdCode);
  for (const r of await db
    .select()
    .from(measurementDetail)
    .where(inArray(measurementDetail.entryId, ids)))
    set(r.entryId, r.measure, `${r.value} ${r.unit}`);
  for (const r of await db.select().from(allergyDetail).where(inArray(allergyDetail.entryId, ids)))
    set(r.entryId, `Allergia: ${r.substance}`, r.reaction);
  for (const r of await db
    .select()
    .from(anamnesisDetail)
    .where(inArray(anamnesisDetail.entryId, ids)))
    set(r.entryId, 'Anamnesi', r.text);
  for (const r of await db
    .select()
    .from(riskFactorDetail)
    .where(inArray(riskFactorDetail.entryId, ids)))
    set(r.entryId, r.factor, r.value);
  for (const r of await db
    .select()
    .from(examinationDetail)
    .where(inArray(examinationDetail.entryId, ids)))
    set(r.entryId, 'Esame obiettivo', r.text);
  for (const r of await db
    .select()
    .from(vaccinationDetail)
    .where(inArray(vaccinationDetail.entryId, ids)))
    set(r.entryId, `Vaccinazione: ${r.vaccine}`, r.lot ? `lotto ${r.lot}` : null);
  for (const r of await db
    .select()
    .from(labResultDetail)
    .where(inArray(labResultDetail.entryId, ids)))
    set(r.entryId, r.analyte, `${r.value}${r.unit ? ` ${r.unit}` : ''}`);
  for (const r of await db.select().from(reportDetail).where(inArray(reportDetail.entryId, ids)))
    set(r.entryId, r.title, r.facility);
  return out;
}

/** Cronologia unica della cartella: voci cliniche e ricette in ordine di data. */
export async function timeline(db: Database, actor: Actor, patientId: string, rawQuery: unknown) {
  const { context } = await guardPatient(
    db,
    actor,
    patientId,
    'clinical.diary.read',
    'lettura_cronologia',
  );
  const { tipo } = timelineQuery.parse(rawQuery ?? {});
  const now = new Date();
  const reservedAllowed = can(actor, 'reserved.read', { ...context, now }).allowed;
  const items: TimelineItem[] = [];

  if (tipo !== 'ricette') {
    const kinds: SQL | undefined =
      tipo === 'visite'
        ? inArray(clinicalEntry.kind, [...VISIT_KINDS])
        : tipo === 'esami'
          ? inArray(clinicalEntry.kind, [...EXAM_KINDS])
          : undefined;
    const entries = await db
      .select({ e: clinicalEntry, author: appUser.displayName })
      .from(clinicalEntry)
      .innerJoin(appUser, eq(appUser.id, clinicalEntry.authorUserId))
      .where(
        and(
          eq(clinicalEntry.patientId, patientId),
          reservedAllowed ? undefined : eq(clinicalEntry.reserved, false),
          kinds,
        ),
      );
    const text = await details(
      db,
      entries.map((x) => x.e.id),
    );
    for (const { e, author } of entries) {
      const d = text.get(e.id);
      items.push({
        id: e.id,
        data: e.occurredOn,
        tipo: e.kind,
        titolo: d?.titolo ?? e.kind,
        testo: d?.testo ?? e.notes,
        annullata: e.status === 'annulled',
        autore: author,
      });
    }
  }

  if (tipo === 'tutto' || tipo === 'ricette') {
    const therapyAllowed = can(actor, 'therapy.read', { ...context, now }).allowed;
    if (therapyAllowed) {
      const rows = await db
        .select({ p: prescription, line: prescriptionLine })
        .from(prescription)
        .innerJoin(prescriptionLine, eq(prescriptionLine.prescriptionId, prescription.id))
        .where(
          and(
            eq(prescription.patientId, patientId),
            inArray(prescription.status, ['sent', 'paper']),
          ),
        );
      const byId = new Map<string, { p: (typeof rows)[number]['p']; lines: string[] }>();
      for (const { p, line } of rows) {
        const g = byId.get(p.id) ?? { p, lines: [] };
        g.lines.push(
          `${line.drugName ?? line.serviceDescription ?? line.serviceCode ?? ''} × ${line.quantity}`,
        );
        byId.set(p.id, g);
      }
      for (const { p, lines } of byId.values()) {
        const at = p.sentAt ?? p.paperPrintedAt ?? p.preparedAt;
        items.push({
          id: p.id,
          data: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(at),
          tipo: 'prescription',
          titolo: PRESCRIPTION_LABELS[p.kind] ?? p.kind,
          testo: lines.join('; '),
          annullata: false,
          autore: null,
        });
      }
    }
  }
  // Attività dei colleghi dell'AFT per questo paziente (registro di AFT, D161).
  if (tipo === 'tutto' || tipo === 'visite') {
    const rows = await db
      .select({ a: aftActivity, doctor: appUser.displayName })
      .from(aftActivity)
      .innerJoin(appUser, eq(appUser.id, aftActivity.doctorUserId))
      .where(eq(aftActivity.patientId, patientId));
    for (const { a, doctor } of rows) {
      const kind = AFT_ACTIVITY_KINDS.find((k) => k.key === a.kind)?.label ?? a.kind;
      items.push({
        id: a.id,
        data: new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(a.performedAt),
        tipo: 'aft_activity',
        titolo: `Collega dell’AFT: ${kind}`,
        testo: [a.outcome, a.notes].filter(Boolean).join('. '),
        annullata: false,
        autore: doctor,
      });
    }
  }
  items.sort((a, b) => b.data.localeCompare(a.data));
  return { cronologia: items };
}

/** Risultati di laboratorio: valore e intervallo stampato sul referto, senza giudizio (regola 3). */
export async function labResults(db: Database, actor: Actor, patientId: string) {
  const { context } = await guardPatient(
    db,
    actor,
    patientId,
    'clinical.diary.read',
    'lettura_esami',
  );
  const reservedAllowed = can(actor, 'reserved.read', { ...context, now: new Date() }).allowed;
  const rows = await db
    .select({
      id: clinicalEntry.id,
      data: clinicalEntry.occurredOn,
      esame: labResultDetail.analyte,
      valore: labResultDetail.value,
      unita: labResultDetail.unit,
      minimo: labResultDetail.referenceLow,
      massimo: labResultDetail.referenceHigh,
      intervallo: labResultDetail.referenceText,
      codicePrestazione: labResultDetail.serviceCode,
    })
    .from(labResultDetail)
    .innerJoin(clinicalEntry, eq(clinicalEntry.id, labResultDetail.entryId))
    .where(
      and(
        eq(clinicalEntry.patientId, patientId),
        eq(clinicalEntry.status, 'active'),
        reservedAllowed ? undefined : eq(clinicalEntry.reserved, false),
      ),
    )
    .orderBy(desc(clinicalEntry.occurredOn), labResultDetail.analyte);
  return { esami: rows };
}

/** Ultimo valore di ogni parametro negli ultimi 12 mesi, per il riepilogo. */
export async function latestMeasurements(
  db: Database,
  patientId: string,
  reservedAllowed: boolean,
) {
  const since = new Date();
  since.setMonth(since.getMonth() - 12);
  const rows = await db
    .select({
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
        gte(clinicalEntry.occurredOn, since.toISOString().slice(0, 10)),
        reservedAllowed ? undefined : eq(clinicalEntry.reserved, false),
      ),
    )
    .orderBy(desc(clinicalEntry.occurredOn));
  const seen = new Set<string>();
  return rows.filter((r) => (seen.has(r.parametro) ? false : (seen.add(r.parametro), true)));
}
