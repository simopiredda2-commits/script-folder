import { and, asc, eq, gte, isNotNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { alias } from 'drizzle-orm/pg-core';
import type { Database } from '../db/client';
import {
  appUser,
  clinicalEntry,
  diaryDetail,
  patient,
  prescription,
  vaccinationDetail,
} from '../db/schema';
import { toCsv } from '../export/csv';
import { HttpError } from '../http/errors';
import { studioDate } from '../prescriptions/rules-check';

/**
 * Riepiloghi dell'archivio per periodo (requisiti, «La giornata di lavoro»: «Riepiloghi. Visite,
 * prescrizioni, vaccinazioni, PPIP e fatture per periodo, con esportazione»; D201). PPIP e fatture
 * non ci sono ancora: servono le regole del Piemonte e la fattura (fase 2).
 *
 * - Visite e contatti: le note del diario, per tipo di contatto, dei pazienti dell'archivio.
 * - Ricette: inviate, cartacee e annullate nel periodo, fatte nell'archivio.
 * - Vaccinazioni: per vaccino e campagna, dei pazienti dell'archivio.
 *
 * Contano solo le voci non annullate. Nessun testo clinico: né nei conteggi né nel CSV.
 */

/** Il periodo, giorni dello studio inclusi (AAAA-MM-GG). */
export interface Period {
  from: string;
  to: string;
}

export const CONTACT_LABELS = {
  office: 'In studio',
  home: 'A domicilio',
  televisit: 'Televisita',
  phone: 'Telefono',
} as const;
type ContactType = keyof typeof CONTACT_LABELS;

export const PRESCRIPTION_KIND_LABELS = {
  pharma_ssn: 'Farmaceutica SSN',
  specialist_ssn: 'Specialistica SSN',
  white: 'Bianca',
  devices: 'Presidi',
} as const;
type PrescriptionKind = keyof typeof PRESCRIPTION_KIND_LABELS;

const EVENT_LABELS = { inviata: 'Inviata', cartacea: 'Cartacea', annullata: 'Annullata' } as const;
type PrescriptionEvent = keyof typeof EVENT_LABELS;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Una data vera, AAAA-MM-GG (niente 30 febbraio). */
function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Il periodo dalla richiesta: «dal» e «al», date vere, la prima non dopo la seconda. */
export function parsePeriod(query: unknown): Period {
  const q = (query ?? {}) as Record<string, unknown>;
  if (!isIsoDate(q.dal) || !isIsoDate(q.al))
    throw new HttpError(400, 'Il periodo vuole le date «dal» e «al», come AAAA-MM-GG');
  if (q.dal > q.al) throw new HttpError(400, 'Nel periodo la data «dal» viene dopo la data «al»');
  return { from: q.dal, to: q.al };
}

/** Il giorno dello studio di un istante è nel periodo (Europe/Rome, come `studioDate`). */
const dayIn = (col: PgColumn, p: Period): SQL =>
  sql`(${col} at time zone 'Europe/Rome')::date between ${p.from}::date and ${p.to}::date`;

interface PatientRef {
  patientId: string;
  lastName: string;
  firstName: string;
  fiscalCode: string;
}

export interface ContactRow extends PatientRef {
  on: string;
  type: ContactType;
  author: string;
}

export interface VaccinationRow extends PatientRef {
  on: string;
  vaccine: string;
  dose: number | null;
  campaign: string | null;
  lot: string | null;
  author: string;
}

export interface PrescriptionEventRow extends PatientRef {
  on: string;
  event: PrescriptionEvent;
  kind: PrescriptionKind;
  nre: string | null;
  lines: number;
  doctor: string;
}

const patientFields = {
  patientId: patient.id,
  lastName: patient.lastName,
  firstName: patient.firstName,
  fiscalCode: patient.fiscalCode,
};

/** Visite e contatti: note del diario non annullate dei pazienti dell'archivio, nel periodo. */
async function contacts(db: Database, archiveId: string, p: Period): Promise<ContactRow[]> {
  const author = alias(appUser, 'autore');
  return db
    .select({
      ...patientFields,
      on: clinicalEntry.occurredOn,
      type: diaryDetail.contactType,
      author: author.displayName,
    })
    .from(clinicalEntry)
    .innerJoin(diaryDetail, eq(diaryDetail.entryId, clinicalEntry.id))
    .innerJoin(patient, eq(patient.id, clinicalEntry.patientId))
    .innerJoin(author, eq(author.id, clinicalEntry.authorUserId))
    .where(
      and(
        eq(patient.archiveId, archiveId),
        eq(clinicalEntry.kind, 'diary'),
        eq(clinicalEntry.status, 'active'),
        gte(clinicalEntry.occurredOn, p.from),
        lte(clinicalEntry.occurredOn, p.to),
      ),
    )
    .orderBy(
      asc(clinicalEntry.occurredOn),
      asc(patient.lastName),
      asc(patient.firstName),
      asc(clinicalEntry.id),
    );
}

/** Vaccinazioni non annullate dei pazienti dell'archivio, nel periodo. */
async function vaccinations(db: Database, archiveId: string, p: Period): Promise<VaccinationRow[]> {
  const author = alias(appUser, 'autore');
  return db
    .select({
      ...patientFields,
      on: clinicalEntry.occurredOn,
      vaccine: vaccinationDetail.vaccine,
      dose: vaccinationDetail.doseNumber,
      campaign: vaccinationDetail.campaign,
      lot: vaccinationDetail.lot,
      author: author.displayName,
    })
    .from(clinicalEntry)
    .innerJoin(vaccinationDetail, eq(vaccinationDetail.entryId, clinicalEntry.id))
    .innerJoin(patient, eq(patient.id, clinicalEntry.patientId))
    .innerJoin(author, eq(author.id, clinicalEntry.authorUserId))
    .where(
      and(
        eq(patient.archiveId, archiveId),
        eq(clinicalEntry.kind, 'vaccination'),
        eq(clinicalEntry.status, 'active'),
        gte(clinicalEntry.occurredOn, p.from),
        lte(clinicalEntry.occurredOn, p.to),
      ),
    )
    .orderBy(
      asc(clinicalEntry.occurredOn),
      asc(patient.lastName),
      asc(patient.firstName),
      asc(clinicalEntry.id),
    );
}

/**
 * Le ricette dell'archivio come eventi del periodo: inviata (il giorno dell'invio, a nome di chi
 * firma), cartacea (il giorno della stampa) e annullata (il giorno dell'annullamento, solo se era
 * stata inviata o stampata: una bozza scartata non è una ricetta). Una ricetta inviata e poi
 * annullata nello stesso periodo conta in tutti e due.
 */
async function prescriptionEvents(
  db: Database,
  archiveId: string,
  p: Period,
): Promise<PrescriptionEventRow[]> {
  const signer = alias(appUser, 'firma');
  const printer = alias(appUser, 'stampa');
  const canceller = alias(appUser, 'annulla');
  const rows = await db
    .select({
      ...patientFields,
      kind: prescription.kind,
      nre: prescription.nre,
      sentAt: prescription.sentAt,
      paperAt: prescription.paperPrintedAt,
      cancelledAt: prescription.cancelledAt,
      signer: signer.displayName,
      printer: printer.displayName,
      canceller: canceller.displayName,
      lines: sql<number>`(select count(*)::int from prescription_line l where l.prescription_id = ${prescription.id})`,
    })
    .from(prescription)
    .innerJoin(patient, eq(patient.id, prescription.patientId))
    .leftJoin(signer, eq(signer.id, prescription.signedBy))
    .leftJoin(printer, eq(printer.id, prescription.paperPrintedBy))
    .leftJoin(canceller, eq(canceller.id, prescription.cancelledBy))
    .where(
      and(
        eq(prescription.archiveId, archiveId),
        or(
          dayIn(prescription.sentAt, p),
          dayIn(prescription.paperPrintedAt, p),
          and(
            dayIn(prescription.cancelledAt, p),
            or(isNotNull(prescription.sentAt), isNotNull(prescription.paperPrintedAt)),
          ),
        ),
      ),
    );
  const inPeriod = (at: Date | null) => {
    if (!at) return null;
    const day = studioDate(at);
    return day >= p.from && day <= p.to ? day : null;
  };
  const events: PrescriptionEventRow[] = [];
  for (const r of rows) {
    const base = {
      patientId: r.patientId,
      lastName: r.lastName,
      firstName: r.firstName,
      fiscalCode: r.fiscalCode,
      kind: r.kind,
      nre: r.nre,
      lines: r.lines,
    };
    const sent = inPeriod(r.sentAt);
    if (sent) events.push({ ...base, on: sent, event: 'inviata', doctor: r.signer ?? '' });
    const paper = inPeriod(r.paperAt);
    if (paper) events.push({ ...base, on: paper, event: 'cartacea', doctor: r.printer ?? '' });
    const cancelled = (r.sentAt || r.paperAt) && inPeriod(r.cancelledAt);
    if (cancelled)
      events.push({ ...base, on: cancelled, event: 'annullata', doctor: r.canceller ?? '' });
  }
  return events.sort(
    (a, b) =>
      a.on.localeCompare(b.on) ||
      a.lastName.localeCompare(b.lastName, 'it') ||
      a.firstName.localeCompare(b.firstName, 'it') ||
      a.event.localeCompare(b.event),
  );
}

/** Conteggio per nome, dal più alto; a parità, in ordine alfabetico. */
function byName(names: string[]) {
  const counts = new Map<string, number>();
  for (const n of names) counts.set(n, (counts.get(n) ?? 0) + 1);
  return [...counts]
    .map(([medico, numero]) => ({ medico, numero }))
    .sort((a, b) => b.numero - a.numero || a.medico.localeCompare(b.medico, 'it'));
}

/** Tutte le righe del periodo: per i conteggi e per l'esportazione. */
export async function periodRows(db: Database, archiveId: string, p: Period) {
  return {
    contacts: await contacts(db, archiveId, p),
    prescriptions: await prescriptionEvents(db, archiveId, p),
    vaccinations: await vaccinations(db, archiveId, p),
  };
}

export type PeriodRows = Awaited<ReturnType<typeof periodRows>>;

/** I conteggi del periodo, senza nomi di pazienti. */
export function summarize(rows: PeriodRows, p: Period) {
  const contactTypes = Object.keys(CONTACT_LABELS) as ContactType[];
  const kinds = Object.keys(PRESCRIPTION_KIND_LABELS) as PrescriptionKind[];
  const count = (kind: PrescriptionKind | null, event: PrescriptionEvent) =>
    rows.prescriptions.filter((r) => (!kind || r.kind === kind) && r.event === event).length;
  const lines = (kind: PrescriptionKind | null) =>
    rows.prescriptions
      .filter((r) => (!kind || r.kind === kind) && r.event !== 'annullata')
      .reduce((n, r) => n + r.lines, 0);
  const vaccines = new Map<string, { vaccino: string; campagna: string | null; numero: number }>();
  for (const v of rows.vaccinations) {
    const key = JSON.stringify([v.vaccine, v.campaign]);
    const seen = vaccines.get(key) ?? { vaccino: v.vaccine, campagna: v.campaign, numero: 0 };
    seen.numero++;
    vaccines.set(key, seen);
  }
  const visits = rows.contacts.filter((c) => c.type !== 'phone').length;
  return {
    dal: p.from,
    al: p.to,
    visite: {
      /** Visite: in studio, a domicilio e televisite; i contatti telefonici a parte. */
      totale: visits,
      telefonici: rows.contacts.length - visits,
      perTipo: contactTypes.map((t) => ({
        tipo: t,
        nome: CONTACT_LABELS[t],
        numero: rows.contacts.filter((c) => c.type === t).length,
      })),
      perMedico: byName(rows.contacts.map((c) => c.author)),
    },
    ricette: {
      totale: {
        inviate: count(null, 'inviata'),
        cartacee: count(null, 'cartacea'),
        annullate: count(null, 'annullata'),
        righe: lines(null),
      },
      perTipo: kinds.map((k) => ({
        tipo: k,
        nome: PRESCRIPTION_KIND_LABELS[k],
        inviate: count(k, 'inviata'),
        cartacee: count(k, 'cartacea'),
        annullate: count(k, 'annullata'),
        righe: lines(k),
      })),
      perMedico: byName(rows.prescriptions.filter((r) => r.doctor).map((r) => r.doctor)),
    },
    vaccinazioni: {
      totale: rows.vaccinations.length,
      perVaccino: [...vaccines.values()].sort(
        (a, b) =>
          b.numero - a.numero ||
          a.vaccino.localeCompare(b.vaccino, 'it') ||
          (a.campagna ?? '').localeCompare(b.campagna ?? '', 'it'),
      ),
      perMedico: byName(rows.vaccinations.map((v) => v.author)),
    },
  };
}

export const REPORT_CSV_COLUMNS = [
  'Sezione',
  'Data',
  'Tipo',
  'Cognome',
  'Nome',
  'Codice fiscale',
  'Dettaglio',
  'Medico',
];

/**
 * Il riepilogo in CSV, per un foglio di calcolo: una riga per visita o contatto, per evento di una
 * ricetta e per vaccinazione. Stesso formato dell'esportazione completa (D32): «;», UTF-8 con BOM,
 * date AAAA-MM-GG, testi che sembrano formule con l'apostrofo. Nessun testo clinico.
 */
export function reportCsv(rows: PeriodRows): string {
  const out: Record<string, unknown>[] = [];
  const who = (r: PatientRef) => ({
    Cognome: r.lastName,
    Nome: r.firstName,
    'Codice fiscale': r.fiscalCode,
  });
  for (const c of rows.contacts)
    out.push({
      Sezione: 'Visite e contatti',
      Data: c.on,
      Tipo: CONTACT_LABELS[c.type],
      ...who(c),
      Dettaglio: '',
      Medico: c.author,
    });
  for (const r of rows.prescriptions)
    out.push({
      Sezione: 'Ricette',
      Data: r.on,
      Tipo: `${PRESCRIPTION_KIND_LABELS[r.kind]} – ${EVENT_LABELS[r.event].toLowerCase()}`,
      ...who(r),
      Dettaglio: [r.nre ? `NRE ${r.nre}` : null, `${r.lines} ${r.lines === 1 ? 'riga' : 'righe'}`]
        .filter(Boolean)
        .join(', '),
      Medico: r.doctor,
    });
  for (const v of rows.vaccinations)
    out.push({
      Sezione: 'Vaccinazioni',
      Data: v.on,
      Tipo: v.vaccine,
      ...who(v),
      Dettaglio: [
        v.dose ? `dose ${v.dose}` : null,
        v.campaign ? `campagna ${v.campaign}` : null,
        v.lot ? `lotto ${v.lot}` : null,
      ]
        .filter(Boolean)
        .join(', '),
      Medico: v.author,
    });
  return toCsv(REPORT_CSV_COLUMNS, out);
}

/** I pazienti che compaiono nelle righe: per il registro degli accessi. */
export function patientsOf(rows: PeriodRows): string[] {
  return [
    ...new Set(
      [...rows.contacts, ...rows.prescriptions, ...rows.vaccinations].map((r) => r.patientId),
    ),
  ];
}
