import {
  CONTACT_ACCESS_TYPES,
  CONTACT_MODES,
  CONTACT_KIND,
  CONTACT_LABELS,
  CONTACT_TYPES,
  makesContact,
  problemStateOf,
  proposeContact,
  servicesOf,
  SIAP_GENERIC_PROBLEM,
  SIAP_MAX_QUANTITY,
  type ContactAccessType,
  type ContactMode,
  type ProblemState,
  type SiapAct,
  type SiapActKind,
  type SiapService,
} from '@mmg/domain';
import { and, asc, between, eq, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import type { Database } from '../db/client';
import {
  appointment,
  appUser,
  archive,
  clinicalEntry,
  diaryDetail,
  patient,
  patientChoice,
  ppipRecord,
  prescription,
  prescriptionLine,
  problemDetail,
  referenceDataset,
  siapContact,
  siapContactAct,
  siapContactService,
  sickLeaveCertificate,
  studio,
  supplyPrescription,
  templateCertificate,
  therapy,
  vaccinationDetail,
} from '../db/schema';
import type { Tx } from '../db/tx';
import { HttpError } from '../http/errors';
import { ppipMappings } from './ppip-mapping';
import { knownActivity, siapValues } from './values';

/**
 * Contatti del SIAP (D291): il programma li propone dagli atti del medico, per paziente e giorno;
 * il medico li conferma, li cambia o li scarta. Qui la raccolta degli atti, la proposta e le
 * scritture; la regola che classifica gli atti è in `@mmg/domain` (siap-contact).
 */

/** Il periodo di una lettura: al più un mese, per tenere leggera la pagina. */
export const MAX_PERIOD_DAYS = 31;

const isoDate = z.iso.date();

export const periodQuery = z
  .object({ dal: isoDate, al: isoDate })
  .strict()
  .refine((p) => p.dal <= p.al, { message: 'Nel periodo la data «dal» viene dopo la data «al»' })
  .refine((p) => daysBetween(p.dal, p.al) < MAX_PERIOD_DAYS, {
    message: `Il periodo è al più di ${MAX_PERIOD_DAYS} giorni`,
  });

const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** Il giorno dello studio di un istante (Europe/Rome), come testo AAAA-MM-GG. */
const romeDay = (col: PgColumn | SQL) =>
  sql<string>`to_char(${col} at time zone 'Europe/Rome', 'YYYY-MM-DD')`;
const romeDayIn = (col: PgColumn | SQL, from: string, to: string) =>
  sql`(${col} at time zone 'Europe/Rome')::date between ${from}::date and ${to}::date`;

/** La riga non viene da un altro programma: quella l'ha già contata l'altro programma (D291). */
const notImported = (table: string, id: PgColumn) =>
  sql`not exists (select 1 from import_origin o where o.table_name = ${table} and o.row_id = ${id})`;

/** Visite della ricetta specialistica: la descrizione della prestazione dice «visita» (D291). */
const VISIT = /\bvisit[ae]\b/i;
/** Vaccinazioni stagionali: il vaccino o la campagna dicono influenza o COVID-19 (D291). */
const SEASONAL = /influenz|covid|sars-cov/i;
/** Il modello del certificato di idoneità sportiva non agonistica (apps/api/modelli). */
const SPORT_TEMPLATE = 'sportivo-non-agonistico';

const DIARY_LABEL = Object.fromEntries(
  CONTACT_TYPES.map((t) => [CONTACT_KIND[t], CONTACT_LABELS[t].toLowerCase()]),
) as Record<string, string>;

const PRESCRIPTION_LABEL: Record<string, string> = {
  pharma_ssn: 'Ricetta farmaceutica SSN',
  white: 'Ricetta bianca',
  specialist_ssn: 'Ricetta specialistica SSN',
  devices: 'Ricetta dei presidi',
};

/** Un atto del medico, con il paziente, il giorno e una riga per la pagina. */
export interface CollectedAct {
  patientId: string;
  day: string;
  act: SiapAct;
  descrizione: string;
}

/** I pazienti degli archivi su cui il medico lavora con i contatti del SIAP. */
const patientsOf = (db: Database | Tx, archiveIds: readonly string[]) =>
  db
    .select({ id: patient.id })
    .from(patient)
    .where(inArray(patient.archiveId, [...archiveIds]));

const ageOn = (birth: string, day: string) => {
  const [by, bm, bd] = birth.split('-').map(Number) as [number, number, number];
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return y - by - (m < bm || (m === bm && d < bd) ? 1 : 0);
};

/**
 * Gli atti del medico nel periodo, sui pazienti degli archivi dati: note del diario, ricette
 * inviate o stampate, certificati di malattia inviati, certificati dai modelli rilasciati,
 * vaccinazioni, prestazioni aggiuntive e scelte. Non annullati e non importati (D291).
 */
export async function collectActs(
  db: Database | Tx,
  doctorId: string,
  archiveIds: readonly string[],
  from: string,
  to: string,
  onlyPatient?: string,
): Promise<CollectedAct[]> {
  if (archiveIds.length === 0) return [];
  const inScope = (col: PgColumn) =>
    onlyPatient ? eq(col, onlyPatient) : inArray(col, patientsOf(db, archiveIds));
  const acts: CollectedAct[] = [];

  const diary = await db
    .select({
      id: clinicalEntry.id,
      patientId: clinicalEntry.patientId,
      day: clinicalEntry.occurredOn,
      contactType: diaryDetail.contactType,
    })
    .from(clinicalEntry)
    .innerJoin(diaryDetail, eq(diaryDetail.entryId, clinicalEntry.id))
    .where(
      and(
        eq(clinicalEntry.kind, 'diary'),
        eq(clinicalEntry.status, 'active'),
        eq(clinicalEntry.authorUserId, doctorId),
        between(clinicalEntry.occurredOn, from, to),
        inScope(clinicalEntry.patientId),
        notImported('clinical_entry', clinicalEntry.id),
      ),
    );
  for (const r of diary)
    acts.push({
      patientId: r.patientId,
      day: r.day,
      act: { kind: 'diary', id: r.id, contactType: r.contactType },
      descrizione: `Nota del diario, ${DIARY_LABEL[r.contactType] ?? r.contactType}`,
    });

  const vaccinations = await db
    .select({
      id: clinicalEntry.id,
      patientId: clinicalEntry.patientId,
      day: clinicalEntry.occurredOn,
      vaccine: vaccinationDetail.vaccine,
      campaign: vaccinationDetail.campaign,
      birthDate: patient.birthDate,
    })
    .from(clinicalEntry)
    .innerJoin(vaccinationDetail, eq(vaccinationDetail.entryId, clinicalEntry.id))
    .innerJoin(patient, eq(patient.id, clinicalEntry.patientId))
    .where(
      and(
        eq(clinicalEntry.kind, 'vaccination'),
        eq(clinicalEntry.status, 'active'),
        eq(clinicalEntry.authorUserId, doctorId),
        between(clinicalEntry.occurredOn, from, to),
        inScope(clinicalEntry.patientId),
        notImported('clinical_entry', clinicalEntry.id),
      ),
    );
  for (const r of vaccinations)
    acts.push({
      patientId: r.patientId,
      day: r.day,
      act: {
        kind: 'vaccination',
        id: r.id,
        seasonal: SEASONAL.test(`${r.vaccine} ${r.campaign ?? ''}`),
        ageYears: ageOn(r.birthDate, r.day),
      },
      descrizione: `Vaccinazione: ${r.vaccine}`,
    });

  // Ricette inviate o stampate su carta, a nome del medico: il giorno è quello della firma.
  const signer = sql`coalesce(${prescription.signedBy}, ${prescription.paperPrintedBy})`;
  const signedAt = sql`coalesce(${prescription.signedAt}, ${prescription.paperPrintedAt})`;
  const prescriptions = await db
    .select({
      id: prescription.id,
      patientId: prescription.patientId,
      kind: prescription.kind,
      day: romeDay(signedAt),
    })
    .from(prescription)
    .where(
      and(
        inArray(prescription.status, ['sent', 'paper']),
        sql`${signer} = ${doctorId}`,
        romeDayIn(signedAt, from, to),
        inScope(prescription.patientId),
      ),
    );
  const lines = prescriptions.length
    ? await db
        .select({
          prescriptionId: prescriptionLine.prescriptionId,
          therapyKind: prescriptionLine.therapyKind,
          therapyStartOn: therapy.startOn,
          serviceDescription: prescriptionLine.serviceDescription,
        })
        .from(prescriptionLine)
        .leftJoin(therapy, eq(therapy.id, prescriptionLine.therapyId))
        .where(
          inArray(
            prescriptionLine.prescriptionId,
            prescriptions.map((p) => p.id),
          ),
        )
    : [];
  for (const p of prescriptions) {
    const own = lines.filter((l) => l.prescriptionId === p.id);
    const label = PRESCRIPTION_LABEL[p.kind] ?? 'Ricetta';
    if (p.kind === 'specialist_ssn') {
      const visits = own.filter((l) => VISIT.test(l.serviceDescription ?? '')).length;
      acts.push({
        patientId: p.patientId,
        day: p.day,
        act: { kind: 'specialist', id: p.id, visits: visits > 0, others: visits < own.length },
        descrizione: `${label}, ${own.length} ${own.length === 1 ? 'prestazione' : 'prestazioni'}`,
      });
    } else if (p.kind === 'devices') {
      acts.push({
        patientId: p.patientId,
        day: p.day,
        act: { kind: 'devices', id: p.id },
        descrizione: label,
      });
    } else {
      // Rinnovo: la riga di una terapia cronica cominciata prima del giorno della ricetta.
      const continuing = own.filter(
        (l) => l.therapyKind === 'chronic' && !!l.therapyStartOn && l.therapyStartOn < p.day,
      ).length;
      acts.push({
        patientId: p.patientId,
        day: p.day,
        act: {
          kind: 'pharma',
          id: p.id,
          continuing: continuing > 0,
          newDrugs: continuing < own.length,
        },
        descrizione: `${label}, ${own.length} ${own.length === 1 ? 'farmaco' : 'farmaci'}`,
      });
    }
  }

  // Presidi dell'assistenza integrativa prescritti dal medico di famiglia (tappa 10): il giorno è
  // quello della registrazione; anche i rinnovi, che sono una prescrizione nuova.
  const supplies = await db
    .select({
      id: supplyPrescription.id,
      patientId: supplyPrescription.patientId,
      product: supplyPrescription.product,
      day: romeDay(supplyPrescription.createdAt),
    })
    .from(supplyPrescription)
    .where(
      and(
        inArray(supplyPrescription.status, ['active', 'ended']),
        eq(supplyPrescription.prescriber, 'mmg'),
        eq(supplyPrescription.createdBy, doctorId),
        romeDayIn(supplyPrescription.createdAt, from, to),
        inScope(supplyPrescription.patientId),
        notImported('supply_prescription', supplyPrescription.id),
      ),
    );
  for (const r of supplies)
    acts.push({
      patientId: r.patientId,
      day: r.day,
      act: { kind: 'devices', id: r.id },
      descrizione: `Presidi: ${r.product}`,
    });

  // Certificati di malattia inviati (anche rettificati poi): la rettifica non è un atto nuovo.
  const sickLeave = await db
    .select({
      id: sickLeaveCertificate.id,
      patientId: sickLeaveCertificate.patientId,
      visit: sickLeaveCertificate.visit,
      day: romeDay(sickLeaveCertificate.signedAt),
    })
    .from(sickLeaveCertificate)
    .where(
      and(
        inArray(sickLeaveCertificate.status, ['sent', 'rectified']),
        isNull(sickLeaveCertificate.rectifiesId),
        eq(sickLeaveCertificate.signedBy, doctorId),
        romeDayIn(sickLeaveCertificate.signedAt, from, to),
        inScope(sickLeaveCertificate.patientId),
      ),
    );
  for (const c of sickLeave) {
    const visit = c.visit === 'A' ? 'office' : c.visit === 'D' ? 'home' : 'other';
    acts.push({
      patientId: c.patientId,
      day: c.day,
      act: { kind: 'sick_leave', id: c.id, visit },
      descrizione: `Certificato di malattia, visita ${visit === 'home' ? 'domiciliare' : visit === 'office' ? 'ambulatoriale' : 'in pronto soccorso'}`,
    });
  }

  const certificates = await db
    .select({
      id: templateCertificate.id,
      patientId: templateCertificate.patientId,
      day: templateCertificate.issuedOn,
      key: templateCertificate.templateKey,
      title: templateCertificate.templateTitle,
    })
    .from(templateCertificate)
    .where(
      and(
        eq(templateCertificate.issuedBy, doctorId),
        isNull(templateCertificate.annulledAt),
        between(templateCertificate.issuedOn, from, to),
        inScope(templateCertificate.patientId),
      ),
    );
  for (const c of certificates)
    acts.push({
      patientId: c.patientId,
      day: c.day,
      act: { kind: 'certificate', id: c.id, sport: c.key === SPORT_TEMPLATE },
      descrizione: `Certificato: ${c.title}`,
    });

  // Prestazioni aggiuntive: del medico che le ha registrate, o del titolare dell'archivio se le ha
  // registrate la segreteria, che le prepara (D212).
  const ppip = await db
    .select({
      id: ppipRecord.id,
      patientId: ppipRecord.patientId,
      day: ppipRecord.performedOn,
      code: ppipRecord.code,
      description: ppipRecord.description,
      quantity: ppipRecord.quantity,
      series: referenceDataset.series,
      createdBy: ppipRecord.createdBy,
      createdByRoles: appUser.roles,
      owner: archive.ownerUserId,
    })
    .from(ppipRecord)
    .innerJoin(referenceDataset, eq(referenceDataset.id, ppipRecord.datasetId))
    .innerJoin(appUser, eq(appUser.id, ppipRecord.createdBy))
    .innerJoin(archive, eq(archive.id, ppipRecord.archiveId))
    .where(
      and(
        eq(ppipRecord.status, 'active'),
        between(ppipRecord.performedOn, from, to),
        inScope(ppipRecord.patientId),
        notImported('ppip_record', ppipRecord.id),
      ),
    );
  const mappings = ppip.length ? ppipMappings() : null;
  for (const r of ppip) {
    const byDoctor = r.createdByRoles.some(
      (x) => x === 'owner_doctor' || x === 'substitute_doctor',
    );
    if ((byDoctor ? r.createdBy : r.owner) !== doctorId) continue;
    acts.push({
      patientId: r.patientId,
      day: r.day,
      act: {
        kind: 'ppip',
        id: r.id,
        detail: mappings!.detail(r.series, r.code),
        quantity: r.quantity,
      },
      descrizione: `Prestazione aggiuntiva ${r.code}: ${r.description}${r.quantity > 1 ? ` (${r.quantity})` : ''}`,
    });
  }

  const choices = await db
    .select({
      id: patientChoice.id,
      patientId: patientChoice.patientId,
      day: patientChoice.chosenOn,
    })
    .from(patientChoice)
    .where(
      and(
        eq(patientChoice.doctorUserId, doctorId),
        isNull(patientChoice.annulledAt),
        between(patientChoice.chosenOn, from, to),
        inScope(patientChoice.patientId),
        notImported('patient_choice', patientChoice.id),
      ),
    );
  for (const c of choices)
    acts.push({
      patientId: c.patientId,
      day: c.day,
      act: { kind: 'choice', id: c.id },
      descrizione: 'Scelta del medico, dal giorno',
    });

  return acts;
}

/** I giorni con un appuntamento del medico con il paziente, prenotato o fatto (D291). */
async function appointmentDays(
  db: Database | Tx,
  doctorId: string,
  archiveIds: readonly string[],
  from: string,
  to: string,
  onlyPatient?: string,
): Promise<Set<string>> {
  if (archiveIds.length === 0) return new Set();
  const rows = await db
    .select({ patientId: appointment.patientId, day: romeDay(appointment.startsAt) })
    .from(appointment)
    .where(
      and(
        eq(appointment.doctorUserId, doctorId),
        inArray(appointment.status, ['booked', 'done']),
        romeDayIn(appointment.startsAt, from, to),
        onlyPatient
          ? eq(appointment.patientId, onlyPatient)
          : inArray(appointment.patientId, patientsOf(db, archiveIds)),
      ),
    );
  return new Set(rows.map((r) => `${r.patientId}|${r.day}`));
}

export type ContactStatus = 'proposto' | 'confermato' | 'da_aggiornare' | 'scartato';

type ContactRow = typeof siapContact.$inferSelect;

export interface ContactView {
  id: string | null;
  paziente: { id: string; cognome: string; nome: string; codiceFiscale: string };
  giorno: string;
  stato: ContactStatus;
  /** Gli atti di oggi; per un contatto confermato, «nuovo» quelli arrivati dopo la conferma. */
  atti: { tipo: SiapActKind; id: string; descrizione: string; nuovo: boolean }[];
  /** Atti contati alla conferma che non ci sono più (annullati). */
  attiTolti: number;
  proposta: ReturnType<typeof proposeContact>;
  /** Per un contatto da aggiornare: le prestazioni di prima con quelle degli atti nuovi. */
  aggiornamento: SiapService[] | null;
  contatto: null | {
    progressivo: number | null;
    struttura: { codice: string | null; tipo: string | null };
    modalita: ContactMode | null;
    regime: string | null;
    accesso: ContactAccessType | null;
    problema: {
      codice: string | null;
      stato: ProblemState | null;
      apertoIl: string | null;
      voce: string | null;
    };
    prestazioni: SiapService[];
    motivoScarto: string | null;
    decisoIl: string;
  };
}

const keyOf = (patientId: string, day: string) => `${patientId}|${day}`;
const actKey = (kind: string, id: string) => `${kind}:${id}`;

/** Le prestazioni di prima con quelle degli atti nuovi, al più 9 per riga. */
export function mergeServices(before: readonly SiapService[], added: readonly SiapService[]) {
  const all = new Map(before.map((s) => [`${s.tipologia}.${s.dettaglio}`, { ...s }]));
  for (const s of added) {
    const k = `${s.tipologia}.${s.dettaglio}`;
    const found = all.get(k);
    if (found) found.quantita = Math.min(SIAP_MAX_QUANTITY, found.quantita + s.quantita);
    else all.set(k, { ...s });
  }
  return [...all.values()].sort((a, b) => a.tipologia - b.tipologia || a.dettaglio - b.dettaglio);
}

/** I contatti del medico nel periodo: proposti dagli atti, confermati, da aggiornare, scartati. */
export async function listContacts(
  db: Database,
  doctorId: string,
  archiveIds: readonly string[],
  from: string,
  to: string,
): Promise<ContactView[]> {
  if (archiveIds.length === 0) return [];
  const acts = await collectActs(db, doctorId, archiveIds, from, to);
  const scheduled = await appointmentDays(db, doctorId, archiveIds, from, to);
  const stored = await db
    .select()
    .from(siapContact)
    .where(
      and(
        eq(siapContact.doctorId, doctorId),
        between(siapContact.occurredOn, from, to),
        inArray(siapContact.patientId, patientsOf(db, archiveIds)),
      ),
    );
  const ids = stored.map((c) => c.id);
  const services = ids.length
    ? await db
        .select()
        .from(siapContactService)
        .where(inArray(siapContactService.contactId, ids))
        .orderBy(asc(siapContactService.typology), asc(siapContactService.detail))
    : [];
  const links = ids.length
    ? await db.select().from(siapContactAct).where(inArray(siapContactAct.contactId, ids))
    : [];

  const groups = new Map<string, CollectedAct[]>();
  for (const a of acts) {
    const k = keyOf(a.patientId, a.day);
    groups.set(k, [...(groups.get(k) ?? []), a]);
  }
  const byKey = new Map(stored.map((c) => [keyOf(c.patientId, c.occurredOn), c]));
  const keys = new Set([
    ...[...groups].filter(([, g]) => makesContact(g.map((x) => x.act))).map(([k]) => k),
    ...byKey.keys(),
  ]);
  const patientIds = [...new Set([...keys].map((k) => k.split('|')[0]!))];
  const people = patientIds.length
    ? await db
        .select({
          id: patient.id,
          cognome: patient.lastName,
          nome: patient.firstName,
          codiceFiscale: patient.fiscalCode,
        })
        .from(patient)
        .where(inArray(patient.id, patientIds))
    : [];
  const person = new Map(people.map((p) => [p.id, p]));

  const views: ContactView[] = [];
  for (const k of keys) {
    const [patientId, day] = k.split('|') as [string, string];
    const group = groups.get(k) ?? [];
    const proposal = proposeContact(
      group.map((g) => g.act),
      scheduled.has(k),
    );
    const c = byKey.get(k);
    const own = c ? links.filter((l) => l.contactId === c.id) : [];
    const counted = new Set(own.map((l) => actKey(l.kind, l.actId)));
    const current = new Set(group.map((g) => actKey(g.act.kind, g.act.id)));
    const fresh = group.filter((g) => !counted.has(actKey(g.act.kind, g.act.id)));
    const removed = own.filter((l) => !current.has(actKey(l.kind, l.actId))).length;
    const storedServices = c
      ? services
          .filter((s) => s.contactId === c.id)
          .map((s) => ({ tipologia: s.typology, dettaglio: s.detail, quantita: s.quantity }))
      : [];
    const stato: ContactStatus = !c
      ? 'proposto'
      : c.status === 'discarded'
        ? 'scartato'
        : fresh.length || removed
          ? 'da_aggiornare'
          : 'confermato';
    views.push({
      id: c?.id ?? null,
      paziente: person.get(patientId) ?? {
        id: patientId,
        cognome: '',
        nome: '',
        codiceFiscale: '',
      },
      giorno: day,
      stato,
      atti: group.map((g) => ({
        tipo: g.act.kind,
        id: g.act.id,
        descrizione: g.descrizione,
        nuovo: !!c && !counted.has(actKey(g.act.kind, g.act.id)),
      })),
      attiTolti: removed,
      proposta: proposal,
      aggiornamento:
        stato === 'da_aggiornare'
          ? mergeServices(storedServices, servicesOf(fresh.map((g) => g.act)))
          : null,
      contatto: c ? contactOf(c, storedServices) : null,
    });
  }
  return views.sort(
    (a, b) =>
      b.giorno.localeCompare(a.giorno) ||
      a.paziente.cognome.localeCompare(b.paziente.cognome, 'it') ||
      a.paziente.nome.localeCompare(b.paziente.nome, 'it'),
  );
}

const contactOf = (
  c: ContactRow,
  services: SiapService[],
): NonNullable<ContactView['contatto']> => ({
  progressivo: c.daySequence,
  struttura: { codice: c.structureCode, tipo: c.structureType },
  modalita: c.mode,
  regime: c.regime,
  accesso: c.accessType,
  problema: {
    codice: c.problemCode,
    stato: c.problemState,
    apertoIl: c.problemOpenedOn,
    voce: c.problemEntryId,
  },
  prestazioni: services,
  motivoScarto: c.discardReason,
  decisoIl: c.decidedAt.toISOString(),
});

/** I problemi attivi dei pazienti con un codice ICD-9-CM: fra questi il medico sceglie (D291). */
export async function activeProblems(db: Database, patientIds: readonly string[]) {
  if (patientIds.length === 0) return {};
  const rows = await db
    .select({
      voce: clinicalEntry.id,
      patientId: clinicalEntry.patientId,
      codice: problemDetail.icdCode,
      descrizione: problemDetail.description,
      cronico: problemDetail.chronic,
      quesito: problemDetail.openQuestion,
      inizio: sql<string>`coalesce(${problemDetail.onsetOn}, ${clinicalEntry.occurredOn})::text`,
    })
    .from(clinicalEntry)
    .innerJoin(problemDetail, eq(problemDetail.entryId, clinicalEntry.id))
    .where(problemFilter(inArray(clinicalEntry.patientId, [...patientIds])))
    .orderBy(asc(problemDetail.description));
  const out: Record<string, Omit<(typeof rows)[number], 'patientId'>[]> = {};
  for (const { patientId, ...r } of rows) (out[patientId] ??= []).push(r);
  return out;
}

/** Un problema che il contatto può avere: attivo, diagnosi, con il codice ICD-9-CM. */
const problemFilter = (extra: SQL) =>
  and(
    extra,
    eq(clinicalEntry.kind, 'problem'),
    eq(clinicalEntry.status, 'active'),
    eq(problemDetail.state, 'active'),
    eq(problemDetail.category, 'diagnosis'),
    eq(problemDetail.icdSystem, 'ICD-9-CM'),
    sql`${problemDetail.icdCode} is not null`,
  );

const serviceSchema = z
  .object({
    tipologia: z.number().int().min(0).max(99),
    dettaglio: z.number().int().min(1).max(99),
    quantita: z.number().int().min(1).max(SIAP_MAX_QUANTITY),
  })
  .strict();

/** Le scelte del medico sul contatto: tutte esplicite, dalla proposta che la pagina mostra. */
export const contactBody = z
  .object({
    modalita: z.enum(CONTACT_MODES),
    accesso: z.enum(CONTACT_ACCESS_TYPES),
    /** Il problema della cartella; vuoto per il codice generico V70.0. */
    problema: z.uuid().nullable(),
    prestazioni: z
      .array(serviceSchema)
      .min(1, 'Il contatto ha almeno un’attività')
      // Il tracciato ripete le attività e prestazioni al più 15 volte (§ 3.9.2).
      .max(15, 'Al più 15 attività e prestazioni per contatto')
      .refine((ss) => new Set(ss.map((s) => `${s.tipologia}.${s.dettaglio}`)).size === ss.length, {
        message: 'Una tipologia con lo stesso dettaglio una volta sola: si scrive la quantità',
      }),
  })
  .strict();

export const confirmBody = contactBody.extend({ paziente: z.uuid(), giorno: isoDate }).strict();
export const discardBody = z
  .object({
    paziente: z.uuid(),
    giorno: isoDate,
    motivo: z.string().trim().min(1, 'Scrivere il motivo dello scarto').max(500),
  })
  .strict();

type ContactChoice = z.infer<typeof contactBody>;

/** Ogni attività è una tipologia con un dettaglio dell'allegato 2 (valori del Ministero). */
function checkServices(services: ContactChoice['prestazioni']) {
  const values = siapValues();
  const unknown = services.filter((s) => !knownActivity(values, s.tipologia, s.dettaglio));
  if (unknown.length)
    throw new HttpError(
      400,
      `Tipologia e dettaglio non dell’allegato 2: ${unknown.map((s) => `${s.tipologia}.${s.dettaglio}`).join(', ')}`,
    );
}

/** Il problema scelto: della cartella del paziente, attivo, con il codice ICD-9-CM. */
async function problemOf(tx: Tx, patientId: string, entryId: string | null) {
  if (!entryId)
    return {
      problemCode: SIAP_GENERIC_PROBLEM,
      problemState: problemStateOf(null),
      problemOpenedOn: null,
      problemEntryId: null,
    };
  const [p] = await tx
    .select({
      code: problemDetail.icdCode,
      chronic: problemDetail.chronic,
      openQuestion: problemDetail.openQuestion,
      openedOn: sql<string>`coalesce(${problemDetail.onsetOn}, ${clinicalEntry.occurredOn})::text`,
    })
    .from(clinicalEntry)
    .innerJoin(problemDetail, eq(problemDetail.entryId, clinicalEntry.id))
    .where(
      problemFilter(and(eq(clinicalEntry.id, entryId), eq(clinicalEntry.patientId, patientId))!),
    );
  if (!p)
    throw new HttpError(
      400,
      'Il problema del contatto è uno dei problemi attivi del paziente, con il codice ICD-9-CM',
    );
  return {
    problemCode: p.code!,
    problemState: problemStateOf(p),
    problemOpenedOn: p.openedOn,
    problemEntryId: entryId,
  };
}

/** Gli atti di oggi del medico per il paziente: senza un atto che faccia un contatto, niente. */
async function actsOfDay(
  tx: Tx,
  doctorId: string,
  archiveId: string,
  patientId: string,
  day: string,
) {
  const acts = await collectActs(tx, doctorId, [archiveId], day, day, patientId);
  if (!makesContact(acts.map((a) => a.act)))
    throw new HttpError(
      409,
      'Quel giorno il medico non ha atti con il paziente: non c’è un contatto da confermare',
    );
  return acts;
}

async function writeLinks(tx: Tx, contactId: string, acts: readonly CollectedAct[]) {
  await tx.delete(siapContactAct).where(eq(siapContactAct.contactId, contactId));
  if (acts.length)
    await tx
      .insert(siapContactAct)
      .values(acts.map((a) => ({ contactId, kind: a.act.kind, actId: a.act.id })));
}

async function writeServices(tx: Tx, contactId: string, services: ContactChoice['prestazioni']) {
  await tx.delete(siapContactService).where(eq(siapContactService.contactId, contactId));
  await tx.insert(siapContactService).values(
    services.map((s) => ({
      contactId,
      typology: s.tipologia,
      detail: s.dettaglio,
      quantity: s.quantita,
    })),
  );
}

/**
 * Il progressivo del contatto nel giorno, nello studio (D291). La riga dello studio si blocca per
 * la transazione: due conferme insieme non prendono lo stesso numero.
 */
export async function nextSequence(tx: Tx, studioId: string, day: string) {
  const [s] = await tx
    .select({ code: studio.structureCode, type: studio.structureType })
    .from(studio)
    .where(eq(studio.id, studioId))
    .for('update');
  const [m] = await tx
    .select({ max: sql<number | null>`max(${siapContact.daySequence})` })
    .from(siapContact)
    .where(and(eq(siapContact.studioId, studioId), eq(siapContact.occurredOn, day)));
  const next = (m?.max ?? 0) + 1;
  // Quattro cifre dopo il codice della struttura (§ 3.9.2, campo 4).
  if (next > 9999) throw new HttpError(409, 'Nel giorno ci sono già 9999 contatti confermati');
  return { next, structure: { code: s?.code ?? null, type: s?.type ?? null } };
}

/**
 * Conferma del contatto: nuovo, o scartato prima. Prende il progressivo e ferma il codice e il tipo
 * della struttura; gli atti di oggi restano legati al contatto.
 */
export async function confirmContact(
  tx: Tx,
  input: {
    studioId: string;
    doctorId: string;
    archiveId: string;
    patientId: string;
    day: string;
    choice: ContactChoice;
    now: Date;
  },
) {
  checkServices(input.choice.prestazioni);
  const acts = await actsOfDay(tx, input.doctorId, input.archiveId, input.patientId, input.day);
  const problem = await problemOf(tx, input.patientId, input.choice.problema);
  const [existing] = await tx
    .select()
    .from(siapContact)
    .where(
      and(
        eq(siapContact.patientId, input.patientId),
        eq(siapContact.doctorId, input.doctorId),
        eq(siapContact.occurredOn, input.day),
      ),
    );
  if (existing?.status === 'confirmed')
    throw new HttpError(409, 'Il contatto è già confermato: si cambia con «Modifica»');
  const { next, structure } = await nextSequence(tx, input.studioId, input.day);
  const values = {
    status: 'confirmed' as const,
    daySequence: next,
    structureCode: structure.code,
    structureType: structure.type,
    mode: input.choice.modalita,
    regime: 'choice' as const,
    accessType: input.choice.accesso,
    ...problem,
    discardReason: null,
    decidedBy: input.doctorId,
    decidedAt: input.now,
    updatedAt: input.now,
  };
  const [row] = existing
    ? await tx.update(siapContact).set(values).where(eq(siapContact.id, existing.id)).returning()
    : await tx
        .insert(siapContact)
        .values({
          studioId: input.studioId,
          patientId: input.patientId,
          doctorId: input.doctorId,
          occurredOn: input.day,
          ...values,
        })
        .returning();
  await writeServices(tx, row!.id, input.choice.prestazioni);
  await writeLinks(tx, row!.id, acts);
  return row!;
}

/**
 * Modifica di un contatto confermato: le scelte del medico e gli atti di oggi, anche quelli
 * arrivati dopo la conferma. Il progressivo resta; il codice della struttura si ferma se mancava.
 */
export async function updateContact(
  tx: Tx,
  contact: ContactRow,
  input: { archiveId: string; choice: ContactChoice; now: Date },
) {
  if (contact.status !== 'confirmed')
    throw new HttpError(409, 'Si modifica un contatto confermato: uno scartato si conferma');
  checkServices(input.choice.prestazioni);
  const acts = await actsOfDay(
    tx,
    contact.doctorId,
    input.archiveId,
    contact.patientId,
    contact.occurredOn,
  );
  const problem = await problemOf(tx, contact.patientId, input.choice.problema);
  let structure = { structureCode: contact.structureCode, structureType: contact.structureType };
  if (!contact.structureCode) {
    const [s] = await tx
      .select({ code: studio.structureCode, type: studio.structureType })
      .from(studio)
      .where(eq(studio.id, contact.studioId));
    structure = { structureCode: s?.code ?? null, structureType: s?.type ?? null };
  }
  const [row] = await tx
    .update(siapContact)
    .set({
      ...structure,
      mode: input.choice.modalita,
      accessType: input.choice.accesso,
      ...problem,
      updatedAt: input.now,
    })
    .where(eq(siapContact.id, contact.id))
    .returning();
  await writeServices(tx, contact.id, input.choice.prestazioni);
  await writeLinks(tx, contact.id, acts);
  return row!;
}

/** Scarto, con il motivo: di un contatto proposto o confermato. Il progressivo si libera. */
export async function discardContact(
  tx: Tx,
  input: {
    studioId: string;
    doctorId: string;
    archiveId: string;
    patientId: string;
    day: string;
    reason: string;
    now: Date;
  },
) {
  const [existing] = await tx
    .select()
    .from(siapContact)
    .where(
      and(
        eq(siapContact.patientId, input.patientId),
        eq(siapContact.doctorId, input.doctorId),
        eq(siapContact.occurredOn, input.day),
      ),
    );
  if (existing?.status === 'discarded') throw new HttpError(409, 'Il contatto è già scartato');
  const acts = existing
    ? await collectActs(
        tx,
        input.doctorId,
        [input.archiveId],
        input.day,
        input.day,
        input.patientId,
      )
    : await actsOfDay(tx, input.doctorId, input.archiveId, input.patientId, input.day);
  const values = {
    status: 'discarded' as const,
    daySequence: null,
    discardReason: input.reason,
    decidedBy: input.doctorId,
    decidedAt: input.now,
    updatedAt: input.now,
  };
  const [row] = existing
    ? await tx.update(siapContact).set(values).where(eq(siapContact.id, existing.id)).returning()
    : await tx
        .insert(siapContact)
        .values({
          studioId: input.studioId,
          patientId: input.patientId,
          doctorId: input.doctorId,
          occurredOn: input.day,
          ...values,
        })
        .returning();
  await writeLinks(tx, row!.id, acts);
  return row!;
}
