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
  therapy,
  vaccinationDetail,
} from '../db/schema';
import { historicalSummary, visibleHistorical } from '../prescriptions/historical';
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

/** Ricette fatte con un altro programma (tappa 15): il titolo lo dice sempre. */
const HISTORICAL_LABELS: Record<string, string> = {
  farmaco: 'Farmaco, ricetta fatta con un altro programma',
  prestazione: 'Prestazione, ricetta fatta con un altro programma',
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
    set(
      r.entryId,
      `Vaccinazione: ${r.vaccine}`,
      [r.doseNumber && `dose ${r.doseNumber}`, r.lot && `lotto ${r.lot}`, r.campaign]
        .filter(Boolean)
        .join(' · ') || null,
    );
  for (const r of await db
    .select()
    .from(labResultDetail)
    .where(inArray(labResultDetail.entryId, ids)))
    set(r.entryId, r.analyte, `${r.value}${r.unit ? ` ${r.unit}` : ''}`);
  for (const r of await db.select().from(reportDetail).where(inArray(reportDetail.entryId, ids)))
    set(r.entryId, r.title, r.facility);
  return out;
}

/** Che cosa entra nella cronologia: per chi la legge, e per la scheda condivisa nell'AFT. */
export interface ChronologyScope {
  tipo: z.infer<typeof timelineQuery>['tipo'];
  /** Le voci e le terapie riservate: solo per chi le può leggere. */
  reservedAllowed: boolean;
  /** Le ricette: solo per chi legge le terapie. */
  therapyAllowed: boolean;
  /**
   * La scheda per un collega dell'AFT (D187): niente voci oscurate dal paziente né voci
   * annullate, niente ricette con i dati oscurati, e solo dal giorno del consenso se il paziente
   * non ha consentito di condividere i dati precedenti.
   */
  shared?: { since: string | null };
}

const isoDay = (at: Date) =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(at);

/** Le voci della cronologia di un paziente, in ordine di data, dalla più recente. */
export async function chronology(
  db: Database,
  patientId: string,
  scope: ChronologyScope,
): Promise<TimelineItem[]> {
  const { tipo, reservedAllowed, therapyAllowed, shared } = scope;
  const since = shared?.since ?? null;
  const recent = (day: string) => !since || day >= since;
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
          shared ? eq(clinicalEntry.obscured, false) : undefined,
          shared ? eq(clinicalEntry.status, 'active') : undefined,
          since ? gte(clinicalEntry.occurredOn, since) : undefined,
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

  if ((tipo === 'tutto' || tipo === 'ricette') && therapyAllowed) {
    const rows = await db
      .select({ p: prescription, line: prescriptionLine, reservedTherapy: therapy.reserved })
      .from(prescription)
      .innerJoin(prescriptionLine, eq(prescriptionLine.prescriptionId, prescription.id))
      .leftJoin(therapy, eq(therapy.id, prescriptionLine.therapyId))
      .where(
        and(
          eq(prescription.patientId, patientId),
          inArray(prescription.status, ['sent', 'paper']),
          // Il paziente ha chiesto di oscurare i suoi dati su quella ricetta: non si condivide.
          shared ? eq(prescription.obscured, false) : undefined,
        ),
      );
    const byId = new Map<string, { p: (typeof rows)[number]['p']; lines: string[] }>();
    for (const { p, line, reservedTherapy } of rows) {
      // Le righe di una terapia riservata solo per chi legge le riservate.
      if (reservedTherapy && !reservedAllowed) continue;
      const g = byId.get(p.id) ?? { p, lines: [] };
      g.lines.push(
        `${line.drugName ?? line.serviceDescription ?? line.serviceCode ?? ''} × ${line.quantity}`,
      );
      byId.set(p.id, g);
    }
    for (const { p, lines } of byId.values()) {
      const day = isoDay(p.sentAt ?? p.paperPrintedAt ?? p.preparedAt);
      if (!recent(day)) continue;
      items.push({
        id: p.id,
        data: day,
        tipo: 'prescription',
        titolo: PRESCRIPTION_LABELS[p.kind] ?? p.kind,
        testo: lines.join('; '),
        annullata: false,
        autore: null,
      });
    }
    // Ricette fatte con un altro programma (tappa 15): un tipo a sé, mai confuse con le nostre.
    for (const h of await visibleHistorical(db, patientId, reservedAllowed)) {
      if (shared && h.annulledAt) continue;
      if (!recent(h.prescribedOn)) continue;
      items.push({
        id: h.id,
        data: h.prescribedOn,
        tipo: 'historical_prescription',
        titolo: HISTORICAL_LABELS[h.kind] ?? 'Ricetta fatta con un altro programma',
        testo: historicalSummary(h) || h.notes,
        annullata: !!h.annulledAt,
        autore: null,
      });
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
      const day = isoDay(a.performedAt);
      if (!recent(day)) continue;
      const kind = AFT_ACTIVITY_KINDS.find((k) => k.key === a.kind)?.label ?? a.kind;
      items.push({
        id: a.id,
        data: day,
        tipo: 'aft_activity',
        titolo: `Collega dell’AFT: ${kind}`,
        testo: [a.outcome, a.notes].filter(Boolean).join('. '),
        annullata: false,
        autore: doctor,
      });
    }
  }
  items.sort((a, b) => b.data.localeCompare(a.data));
  return items;
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
  const at = { ...context, now: new Date() };
  return {
    cronologia: await chronology(db, patientId, {
      tipo,
      reservedAllowed: can(actor, 'reserved.read', at).allowed,
      therapyAllowed: can(actor, 'therapy.read', at).allowed,
    }),
  };
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
  const at = { ...context, now: new Date() };
  const reservedAllowed = can(actor, 'reserved.read', at).allowed;
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
  // Dalla tappa 15 la pagina Esami li aggiunge: li scrive il medico, come le altre voci.
  return { esami: rows, puoScrivere: can(actor, 'clinical.write', at).allowed };
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
