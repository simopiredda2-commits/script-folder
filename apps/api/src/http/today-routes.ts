import { INTERRUPTED_SEND_AFTER_MINUTES } from '@mmg/domain';
import { rulesetAt, value } from '@mmg/rules';
import { and, asc, count, eq, gte, inArray, isNotNull, lt, lte, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client';
import {
  appointment,
  patient,
  patientRequest,
  prescription,
  therapeuticPlan,
  therapy,
} from '../db/schema';
import { visibleArchives } from '../patients/access';
import { studioDate } from '../prescriptions/rules-check';
import type { AifaChange, DrugShortage, ReferenceData } from '../reference/lookup';

/** Un farmaco carente in terapia, con i pazienti che lo prendono (A7, D202). */
interface ShortDrug {
  aic: string;
  farmaco: string;
  testo: string;
  pazienti: { id: string; nome: string; cognome: string }[];
}

/** Una variazione AIFA su un farmaco in terapia, con i pazienti interessati (A7, D205). */
interface ChangedDrug extends ShortDrug {
  tipo: AifaChange['kind'];
}

const MS_PER_DAY = 86_400_000;

/** Mezzanotte del giorno AAAA-MM-GG nel fuso dello studio, come istante. */
export function startOfStudioDay(date: string): Date {
  // Alle 00:00 UTC del giorno l'ora di Roma ha ancora lo scarto della sua mezzanotte: i cambi
  // d'ora avvengono alle 2 o alle 3 di notte, ora locale.
  const probe = new Date(`${date}T00:00:00Z`);
  const name = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Rome',
    timeZoneName: 'longOffset',
  })
    .formatToParts(probe)
    .find((p) => p.type === 'timeZoneName')!.value;
  const offset = name === 'GMT' ? '+00:00' : name.slice(3);
  return new Date(`${date}T00:00:00${offset}`);
}

/**
 * «Oggi»: appuntamenti del giorno e code di lavoro. Le code non sono tabelle ma viste calcolate,
 * come dicono i requisiti; l'anagrafica dei pazienti in agenda non apre la cartella.
 */
export function registerTodayRoutes(
  app: FastifyInstance,
  db: Database,
  now: () => Date,
  reference?: ReferenceData,
) {
  app.get('/api/oggi', async (req) => {
    const actor = req.actor!;
    const date = studioDate(now());
    const from = startOfStudioDay(date);
    const to = new Date(from.getTime() + MS_PER_DAY);
    const registry = await visibleArchives(db, actor, 'registry.read');
    const doctor =
      actor.roles.includes('owner_doctor') || actor.roles.includes('substitute_doctor');

    const appointments = await db
      .select({
        id: appointment.id,
        inizio: appointment.startsAt,
        fine: appointment.endsAt,
        tipo: appointment.kind,
        stato: appointment.status,
        note: appointment.notes,
        pazienteId: patient.id,
        nome: patient.firstName,
        cognome: patient.lastName,
        dataNascita: patient.birthDate,
        archivio: patient.archiveId,
      })
      .from(appointment)
      .leftJoin(patient, eq(patient.id, appointment.patientId))
      .where(
        and(
          eq(appointment.studioId, actor.studioId),
          gte(appointment.startsAt, from),
          lt(appointment.startsAt, to),
          doctor ? eq(appointment.doctorUserId, actor.userId) : undefined,
        ),
      )
      .orderBy(asc(appointment.startsAt));

    const signArchives = await visibleArchives(db, actor, 'prescription.sign_send');
    const draftArchives = await visibleArchives(db, actor, 'prescription.draft_repeat');
    const countStatus = async (archives: string[], status: 'to_sign' | 'error') =>
      archives.length
        ? ((
            await db
              .select({ n: count() })
              .from(prescription)
              .where(
                and(inArray(prescription.archiveId, archives), eq(prescription.status, status)),
              )
          )[0]?.n ?? 0)
        : null;
    // Ricette «in invio» da più di INTERRUPTED_SEND_AFTER_MINUTES: l'esito lo segna il medico (D233).
    const interruptedBefore = new Date(now().getTime() - INTERRUPTED_SEND_AFTER_MINUTES * 60_000);
    const countInterrupted = async (archives: string[]) =>
      archives.length
        ? ((
            await db
              .select({ n: count() })
              .from(prescription)
              .where(
                and(
                  inArray(prescription.archiveId, archives),
                  eq(prescription.status, 'sending'),
                  lt(prescription.signedAt, interruptedBefore),
                ),
              )
          )[0]?.n ?? 0)
        : null;

    const requestArchives = await visibleArchives(db, actor, 'patient_request.manage');
    const openRequests = requestArchives.length
      ? ((
          await db
            .select({ n: count() })
            .from(patientRequest)
            .innerJoin(patient, eq(patient.id, patientRequest.patientId))
            .where(
              and(inArray(patient.archiveId, requestArchives), eq(patientRequest.status, 'open')),
            )
        )[0]?.n ?? 0)
      : null;

    // Piani che scadono entro i giorni di avviso di R5, letti dalle regole in vigore oggi.
    const r5 = rulesetAt(date).rules.find((r) => r.id === 'R5');
    const warnDays = r5 ? value(r5, 'expiryWarningDays') : null;
    const summaryArchives = await visibleArchives(db, actor, 'clinical.summary.read');
    // I piani riservati, come le terapie riservate, solo a chi le legge (tappa 9).
    const reservedArchives = await visibleArchives(db, actor, 'reserved.read');
    const plans =
      warnDays !== null && summaryArchives.length
        ? await db
            .select({
              pazienteId: patient.id,
              nome: patient.firstName,
              cognome: patient.lastName,
              farmaco: therapeuticPlan.drugName,
              scadenza: therapeuticPlan.expiresOn,
            })
            .from(therapeuticPlan)
            .innerJoin(patient, eq(patient.id, therapeuticPlan.patientId))
            .where(
              and(
                inArray(patient.archiveId, summaryArchives),
                eq(therapeuticPlan.status, 'active'),
                reservedArchives.length
                  ? or(
                      eq(therapeuticPlan.reserved, false),
                      inArray(patient.archiveId, reservedArchives),
                    )
                  : eq(therapeuticPlan.reserved, false),
                gte(therapeuticPlan.expiresOn, date),
                lte(
                  therapeuticPlan.expiresOn,
                  new Date(Date.parse(`${date}T12:00:00Z`) + warnDays * MS_PER_DAY)
                    .toISOString()
                    .slice(0, 10),
                ),
              ),
            )
            .orderBy(asc(therapeuticPlan.expiresOn))
        : [];

    // A7 dei requisiti, per le carenze (D202): i farmaci delle terapie in corso che sono
    // nell'elenco AIFA dei carenti in vigore oggi, con i pazienti interessati. A chi legge le
    // terapie dell'archivio (anche la segreteria, che prepara le ripetizioni), e le terapie
    // riservate solo a chi le legge.
    const therapyArchives = reference ? await visibleArchives(db, actor, 'therapy.read') : [];
    const inTherapy =
      reference && therapyArchives.length
        ? await db
            .select({
              id: therapy.id,
              aic: therapy.drugAic,
              farmaco: therapy.drugName,
              drugClass: therapy.drugClass,
              aifaNote: therapy.aifaNote,
              activeIngredient: therapy.activeIngredient,
              atc: therapy.atc,
              planId: therapy.therapeuticPlanId,
              pazienteId: patient.id,
              nome: patient.firstName,
              cognome: patient.lastName,
            })
            .from(therapy)
            .innerJoin(patient, eq(patient.id, therapy.patientId))
            .where(
              and(
                inArray(patient.archiveId, therapyArchives),
                eq(therapy.status, 'active'),
                isNotNull(therapy.drugAic),
                reservedArchives.length
                  ? or(eq(therapy.reserved, false), inArray(patient.archiveId, reservedArchives))
                  : eq(therapy.reserved, false),
              ),
            )
            // A parità di paziente, il nome del farmaco: lo stesso elenco a ogni lettura.
            .orderBy(asc(patient.lastName), asc(patient.firstName), asc(therapy.drugName))
        : [];
    const shortages = reference
      ? await reference.shortages(
          inTherapy.map((t) => t.aic!),
          date,
        )
      : new Map<string, DrugShortage>();
    const shortDrugs = new Map<string, ShortDrug>();
    for (const t of inTherapy) {
      const s = shortages.get(t.aic!);
      if (!s) continue;
      const entry: ShortDrug = shortDrugs.get(t.aic!) ?? {
        aic: t.aic!,
        farmaco: t.farmaco,
        testo: s.text,
        pazienti: [],
      };
      // Lo stesso paziente con due terapie dello stesso farmaco compare una volta.
      if (!entry.pazienti.some((p) => p.id === t.pazienteId))
        entry.pazienti.push({ id: t.pazienteId, nome: t.nome, cognome: t.cognome });
      shortDrugs.set(t.aic!, entry);
    }
    // Le altre variazioni di A7 (D205): confezione sospesa o uscita dall'anagrafica, classe, nota
    // e piano. Una voce per farmaco e variazione, con i pazienti.
    const changes = reference
      ? await reference.aifaChanges(
          inTherapy.map((t) => ({
            id: t.id,
            drugAic: t.aic,
            drugClass: t.drugClass,
            aifaNote: t.aifaNote,
            activeIngredient: t.activeIngredient,
            atc: t.atc,
            hasPlan: t.planId !== null,
          })),
          date,
        )
      : new Map<string, AifaChange[]>();
    const changedDrugs = new Map<string, ChangedDrug>();
    for (const t of inTherapy) {
      for (const c of changes.get(t.id) ?? []) {
        const key = `${t.aic}\u0000${c.kind}\u0000${c.text}`;
        const entry: ChangedDrug = changedDrugs.get(key) ?? {
          aic: t.aic!,
          farmaco: t.farmaco,
          tipo: c.kind,
          testo: c.text,
          pazienti: [],
        };
        if (!entry.pazienti.some((p) => p.id === t.pazienteId))
          entry.pazienti.push({ id: t.pazienteId, nome: t.nome, cognome: t.cognome });
        changedDrugs.set(key, entry);
      }
    }

    return {
      data: date,
      appuntamenti: appointments
        .filter((a) => !a.pazienteId || registry.includes(a.archivio!))
        .map(({ archivio: _a, ...rest }) => rest),
      code: {
        daFirmare: await countStatus(signArchives, 'to_sign'),
        nonInviate: await countStatus(signArchives.length ? signArchives : draftArchives, 'error'),
        senzaRisposta: await countInterrupted(signArchives),
        richiesteAperte: openRequests,
        pianiInScadenza: plans,
        giorniAvvisoPiani: warnDays,
        farmaciCarenti: [...shortDrugs.values()].sort((a, b) =>
          a.farmaco.localeCompare(b.farmaco, 'it'),
        ),
        variazioniAifa: [...changedDrugs.values()].sort(
          (a, b) =>
            a.farmaco.localeCompare(b.farmaco, 'it') ||
            a.tipo.localeCompare(b.tipo) ||
            a.testo.localeCompare(b.testo, 'it'),
        ),
      },
    };
  });
}
