import { rulesetAt, value } from '@mmg/rules';
import { and, asc, count, eq, gte, inArray, lt, lte, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Database } from '../db/client';
import { appointment, patient, patientRequest, prescription, therapeuticPlan } from '../db/schema';
import { visibleArchives } from '../patients/access';
import { studioDate } from '../prescriptions/rules-check';

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
export function registerTodayRoutes(app: FastifyInstance, db: Database, now: () => Date) {
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

    return {
      data: date,
      appuntamenti: appointments
        .filter((a) => !a.pazienteId || registry.includes(a.archivio!))
        .map(({ archivio: _a, ...rest }) => rest),
      code: {
        daFirmare: await countStatus(signArchives, 'to_sign'),
        nonInviate: await countStatus(signArchives.length ? signArchives : draftArchives, 'error'),
        richiesteAperte: openRequests,
        pianiInScadenza: plans,
        giorniAvvisoPiani: warnDays,
      },
    };
  });
}
