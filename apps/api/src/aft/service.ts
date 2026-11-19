import {
  AFT_ACTIVITY_KEYS,
  AFT_ACTIVITY_KINDS,
  AFT_COMMON_REASONS,
  AFT_CONSENT_KEY,
  AFT_PREVIOUS_CONSENT_KEY,
  AFT_REASON_MIN,
  aftAccess,
  type AftMembership,
  currentConsents,
} from '@mmg/domain';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { logAccess } from '../audit/access-log';
import type { Actor } from '../auth/service';
import type { Database } from '../db/client';
import {
  accessLog,
  aft,
  aftActivity,
  aftMember,
  appUser,
  archive,
  clinicalEntry,
  consent,
  doctorProfile,
  patient,
  studio,
} from '../db/schema';
import { withActor } from '../db/tx';
import { composePss } from '../fse/compose';
import { HttpError } from '../http/errors';
import { guardPatient } from '../patients/access';
import { studioDate } from '../prescriptions/rules-check';

/**
 * Condivisione tra i medici dell'AFT che usano il programma (tappa 12, D161). Le regole di chi
 * vede che cosa sono in `@mmg/domain` (`aftAccess`); qui si leggono i dati, si registra ogni
 * consultazione nel registro del medico curante e si compone il riepilogo.
 */

export const createBody = z
  .object({
    nome: z.string().trim().min(3).max(120),
    asl: z.string().trim().max(120).optional(),
    codice: z.string().trim().max(40).optional(),
  })
  .strict();
/**
 * Modifica dei dati dell'AFT (tappa 14): solo i campi presenti. ASL e codice vuoti si tolgono;
 * il nome resta obbligatorio, con gli stessi limiti della creazione.
 */
export const updateBody = z
  .object({
    nome: z.string().trim().min(3).max(120).optional(),
    asl: z.string().trim().max(120).optional(),
    codice: z.string().trim().max(40).optional(),
  })
  .strict()
  .refine((b) => Object.values(b).some((v) => v !== undefined), 'Niente da salvare');
export const inviteBody = z.object({ codiceRegionale: z.string().trim().min(1).max(40) }).strict();
export const sharingBody = z.object({ condivide: z.boolean() }).strict();
export const activityBody = z
  .object({
    codiceFiscale: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{16}$/, 'Codice fiscale di 16 caratteri'),
    tipologia: z.enum(AFT_ACTIVITY_KEYS),
    esito: z.string().trim().min(3).max(500),
    note: z.string().trim().max(2000).optional(),
    /** Data e ora dell'attività; per difetto adesso. */
    quando: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();
export const consultBody = z
  .object({
    codiceFiscale: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9]{16}$/, 'Codice fiscale di 16 caratteri'),
    motivo: z.string().trim().max(300),
  })
  .strict();

const isOwnerDoctor = (actor: Actor) => actor.roles.includes('owner_doctor');

function requireOwnerDoctor(actor: Actor) {
  if (!isOwnerDoctor(actor))
    throw new HttpError(403, 'L’AFT riguarda i medici titolari dello studio');
}

/** Le righe aperte (invito in attesa o membro) di un medico. */
async function openRowsOf(db: Database, userId: string) {
  return db
    .select()
    .from(aftMember)
    .where(
      and(eq(aftMember.userId, userId), isNull(aftMember.leftAt), isNull(aftMember.declinedAt)),
    );
}

/** Il medico è membro (invito accettato, non uscito) di questa AFT. */
async function activeMember(db: Database, aftId: string, userId: string) {
  const rows = await openRowsOf(db, userId);
  return rows.find((r) => r.aftId === aftId && r.joinedAt !== null) ?? null;
}

/** Le appartenenze attive, per le regole del dominio. */
function membershipsOf(rows: (typeof aftMember.$inferSelect)[]): AftMembership[] {
  return rows
    .filter((r) => r.joinedAt !== null && r.declinedAt === null)
    .map((r) => ({
      aftId: r.aftId,
      userId: r.userId,
      since: r.joinedAt!,
      until: r.leftAt,
      sharing: r.sharing,
    }));
}

export function createAftService({ db, now }: { db: Database; now: () => Date }) {
  /** La mia AFT: membri, inviti in attesa, la mia condivisione; e gli inviti che ho ricevuto. */
  async function overview(actor: Actor) {
    const mine = await openRowsOf(db, actor.userId);
    const member = mine.find((r) => r.joinedAt !== null) ?? null;
    const invitations = mine.filter((r) => r.joinedAt === null);
    const invitationAfts = invitations.length
      ? await db
          .select({ a: aft, inviter: appUser.displayName })
          .from(aft)
          .leftJoin(appUser, eq(appUser.id, aft.createdBy))
          .where(
            inArray(
              aft.id,
              invitations.map((i) => i.aftId),
            ),
          )
      : [];
    const inviti = invitations.map((i) => {
      const a = invitationAfts.find((x) => x.a.id === i.aftId)!;
      return { id: i.id, aft: a.a.name, asl: a.a.asl, invitatoIl: i.invitedAt };
    });
    // Tipologie dell'attività e motivi comuni, per i moduli dell'interfaccia.
    const lists = {
      tipologieAttivita: AFT_ACTIVITY_KINDS.map((k) => ({ codice: k.key, nome: k.label })),
      motiviComuni: [...AFT_COMMON_REASONS],
    };
    if (!member) return { aft: null, inviti, puoCreare: isOwnerDoctor(actor), ...lists };
    const [a] = await db.select().from(aft).where(eq(aft.id, member.aftId));
    const rows = await db
      .select({
        m: aftMember,
        name: appUser.displayName,
        studio: studio.name,
        regionalCode: doctorProfile.regionalCode,
      })
      .from(aftMember)
      .innerJoin(appUser, eq(appUser.id, aftMember.userId))
      .innerJoin(studio, eq(studio.id, appUser.studioId))
      .leftJoin(doctorProfile, eq(doctorProfile.userId, aftMember.userId))
      .where(
        and(
          eq(aftMember.aftId, member.aftId),
          isNull(aftMember.leftAt),
          isNull(aftMember.declinedAt),
        ),
      )
      .orderBy(appUser.displayName);
    return {
      aft: {
        id: a!.id,
        nome: a!.name,
        asl: a!.asl,
        codice: a!.code,
        condivido: member.sharing,
        dal: member.joinedAt,
        membri: rows.map((r) => ({
          nome: r.name,
          studio: r.studio,
          codiceRegionale: r.regionalCode,
          stato: r.m.joinedAt ? 'membro' : 'invitato',
          condivide: r.m.joinedAt ? r.m.sharing : false,
          io: r.m.userId === actor.userId,
        })),
      },
      inviti,
      puoCreare: false,
      ...lists,
    };
  }

  async function create(actor: Actor, body: z.infer<typeof createBody>) {
    requireOwnerDoctor(actor);
    if ((await openRowsOf(db, actor.userId)).some((r) => r.joinedAt !== null))
      throw new HttpError(409, 'Sei già in un’AFT: per crearne un’altra esci prima da questa');
    const at = now();
    return withActor(db, actor.userId, async (tx) => {
      const [a] = await tx
        .insert(aft)
        .values({
          name: body.nome,
          asl: body.asl || null,
          code: body.codice || null,
          createdBy: actor.userId,
          createdAt: at,
        })
        .returning();
      await tx
        .insert(aftMember)
        .values({ aftId: a!.id, userId: actor.userId, invitedAt: at, joinedAt: at });
      return a!.id;
    });
  }

  /**
   * Nome, ASL e codice dell'AFT (tappa 14): li cambia un medico titolare che ne fa parte. Il
   * registro dice quali campi sono cambiati; i valori di prima restano nello storico della tabella.
   * Ogni rifiuto va nel registro.
   */
  async function update(actor: Actor, aftId: string, body: z.infer<typeof updateBody>) {
    const refuse = async (motivo: string, message: string) => {
      await logAccess(db, {
        studioId: actor.studioId,
        userId: actor.userId,
        action: 'impostazioni_aft',
        outcome: 'negato',
        workstation: actor.workstation,
        details: { aft: aftId, azione: 'modifica', motivo },
      });
      return new HttpError(403, message);
    };
    if (!isOwnerDoctor(actor))
      throw await refuse(
        'non è un medico titolare',
        'L’AFT riguarda i medici titolari dello studio',
      );
    if (!(await activeMember(db, aftId, actor.userId)))
      throw await refuse(
        'non è membro dell’AFT',
        'I dati dell’AFT li cambia solo un medico che ne fa parte',
      );
    const [a] = await db.select().from(aft).where(eq(aft.id, aftId));
    if (!a) throw new HttpError(404, 'AFT non trovata');
    const next = {
      name: body.nome ?? a.name,
      asl: body.asl === undefined ? a.asl : body.asl || null,
      code: body.codice === undefined ? a.code : body.codice || null,
    };
    const campi = (
      [
        ['nome', 'name'],
        ['asl', 'asl'],
        ['codice', 'code'],
      ] as const
    )
      .filter(([, column]) => next[column] !== a[column])
      .map(([field]) => field);
    const view = (r: typeof a) => ({ id: r.id, nome: r.name, asl: r.asl, codice: r.code });
    if (campi.length === 0) return view(a);
    const saved = await withActor(db, actor.userId, async (tx) => {
      const [row] = await tx.update(aft).set(next).where(eq(aft.id, aftId)).returning();
      await logAccess(tx, {
        studioId: actor.studioId,
        userId: actor.userId,
        action: 'impostazioni_aft',
        outcome: 'riuscito',
        workstation: actor.workstation,
        details: { aft: aftId, azione: 'modifica', campi },
      });
      return row!;
    });
    return view(saved);
  }

  /** Invito di un medico titolare, con il suo codice regionale. Entra solo se accetta. */
  async function invite(actor: Actor, aftId: string, body: z.infer<typeof inviteBody>) {
    requireOwnerDoctor(actor);
    if (!(await activeMember(db, aftId, actor.userId)))
      throw new HttpError(403, 'Invita nell’AFT solo chi ne fa parte');
    const doctors = await db
      .select({
        id: appUser.id,
        roles: appUser.roles,
        status: appUser.status,
        awaiting: appUser.awaitingConfirmation,
      })
      .from(doctorProfile)
      .innerJoin(appUser, eq(appUser.id, doctorProfile.userId))
      .where(eq(doctorProfile.regionalCode, body.codiceRegionale));
    // Solo titolari attivi e confermati (D179): un titolare creato dall'amministratore di un altro
    // studio, e mai confermato, con il codice regionale di un medico non ne blocca gli inviti e non
    // li riceve al suo posto (terza revisione).
    const titolari = doctors.filter(
      (d) => d.roles.includes('owner_doctor') && d.status === 'active' && !d.awaiting,
    );
    if (titolari.length > 1)
      throw new HttpError(409, 'Più medici con questo codice regionale: invito non possibile');
    const doctor = titolari[0];
    if (!doctor)
      throw new HttpError(404, 'Nessun medico titolare con questo codice regionale nel programma');
    if (doctor.id === actor.userId) throw new HttpError(409, 'Sei già nell’AFT');
    const open = await openRowsOf(db, doctor.id);
    if (open.some((r) => r.aftId === aftId))
      throw new HttpError(409, 'Il medico è già nell’AFT o ha già un invito in attesa');
    if (open.some((r) => r.joinedAt !== null))
      throw new HttpError(409, 'Il medico è già in un’altra AFT');
    await withActor(db, actor.userId, (tx) =>
      tx
        .insert(aftMember)
        .values({ aftId, userId: doctor.id, invitedBy: actor.userId, invitedAt: now() }),
    );
  }

  /** Risposta all'invito: solo l'invitato accetta o rifiuta. */
  async function respond(actor: Actor, invitationId: string, accept: boolean) {
    requireOwnerDoctor(actor);
    const [row] = await db.select().from(aftMember).where(eq(aftMember.id, invitationId));
    if (!row || row.userId !== actor.userId) throw new HttpError(404, 'Invito non trovato');
    if (row.joinedAt || row.declinedAt || row.leftAt)
      throw new HttpError(409, 'L’invito non è più in attesa');
    if (accept && (await openRowsOf(db, actor.userId)).some((r) => r.joinedAt !== null))
      throw new HttpError(409, 'Sei già in un’AFT: per entrare in questa esci prima dall’altra');
    await withActor(db, actor.userId, (tx) =>
      tx
        .update(aftMember)
        .set(accept ? { joinedAt: now() } : { declinedAt: now() })
        .where(eq(aftMember.id, invitationId)),
    );
  }

  /** Il titolare decide se condividere i suoi pazienti che hanno dato il consenso. */
  async function setSharing(actor: Actor, aftId: string, on: boolean) {
    requireOwnerDoctor(actor);
    const row = await activeMember(db, aftId, actor.userId);
    if (!row) throw new HttpError(403, 'Non sei in questa AFT');
    await withActor(db, actor.userId, (tx) =>
      tx
        .update(aftMember)
        .set({ sharing: on, sharingChangedAt: now() })
        .where(eq(aftMember.id, row.id)),
    );
    await logAccess(db, {
      studioId: actor.studioId,
      userId: actor.userId,
      action: 'impostazioni_aft',
      outcome: 'riuscito',
      workstation: actor.workstation,
      details: { aft: aftId, condivisione: on },
    });
  }

  /** Uscita dall'AFT: la condivisione finisce subito, la storia resta. */
  async function leave(actor: Actor, aftId: string) {
    requireOwnerDoctor(actor);
    const row = await activeMember(db, aftId, actor.userId);
    if (!row) throw new HttpError(403, 'Non sei in questa AFT');
    await withActor(db, actor.userId, (tx) =>
      tx
        .update(aftMember)
        .set({ leftAt: now(), sharing: false, sharingChangedAt: now() })
        .where(eq(aftMember.id, row.id)),
    );
  }

  /**
   * Consensi del paziente alla condivisione nell'AFT: l'ultima espressione di ciascuno, con la
   * data del consenso alla condivisione (per i dati precedenti, vedi `AFT_PREVIOUS_CONSENT_KEY`).
   */
  async function consentInfo(patientId: string) {
    const rows = await db
      .select()
      .from(consent)
      .where(
        and(
          eq(consent.patientId, patientId),
          inArray(consent.kind, [AFT_CONSENT_KEY, AFT_PREVIOUS_CONSENT_KEY]),
        ),
      );
    const current = currentConsents(rows);
    const main = current.get(AFT_CONSENT_KEY);
    return {
      state: main?.status ?? null,
      givenOn: main?.status === 'given' ? main.givenOn : null,
      previous: current.get(AFT_PREVIOUS_CONSENT_KEY)?.status ?? null,
    };
  }

  const NOT_SHARED =
    'Nessun riepilogo condiviso con questo codice fiscale: il paziente non è di un collega dell’AFT che condivide, oppure non ha dato il consenso.';

  /**
   * Trova il paziente di un collega con il codice fiscale e decide l'accesso. Chi consulta non sa
   * se il paziente c'è finché l'accesso non è consentito: la risposta negativa è la stessa per
   * tutti i casi, il motivo preciso va nel registro del medico curante. Ogni tentativo, consentito
   * o negato, va nel registro.
   */
  async function locate(
    actor: Actor,
    fiscalCode: string,
    reason: string,
    action: 'consultazione_aft' | 'attivita_aft',
  ) {
    const at = now();
    const mine = membershipsOf(await openRowsOf(db, actor.userId)).filter((m) => !m.until);
    const aftIds = mine.map((m) => m.aftId);
    if (!aftIds.length) throw new HttpError(403, 'Non sei in un’AFT');
    if (reason.trim().length < AFT_REASON_MIN)
      throw new HttpError(
        400,
        `Scrivi il motivo dell’accesso (almeno ${AFT_REASON_MIN} caratteri)`,
      );
    const colleagues = await db
      .select()
      .from(aftMember)
      .where(and(inArray(aftMember.aftId, aftIds), isNull(aftMember.declinedAt)));
    const colleagueIds = [...new Set(colleagues.map((c) => c.userId))].filter(
      (id) => id !== actor.userId,
    );
    const found = colleagueIds.length
      ? await db
          .select({ p: patient, ownerUserId: archive.ownerUserId })
          .from(patient)
          .innerJoin(archive, eq(archive.id, patient.archiveId))
          .where(
            and(eq(patient.fiscalCode, fiscalCode), inArray(archive.ownerUserId, colleagueIds)),
          )
      : [];
    if (!found.length) {
      await logAccess(db, {
        studioId: actor.studioId,
        userId: actor.userId,
        action,
        outcome: 'negato',
        workstation: actor.workstation,
        details: { motivo: 'nessun paziente di un collega dell’AFT con questo codice fiscale' },
      });
      throw new HttpError(404, NOT_SHARED);
    }
    const [actorStudio] = await db
      .select({ name: studio.name })
      .from(studio)
      .where(eq(studio.id, actor.studioId));
    for (const { p, ownerUserId } of found) {
      const consents = await consentInfo(p.id);
      const decision = aftAccess({
        actor: { userId: actor.userId, ownerDoctor: isOwnerDoctor(actor) },
        ownerUserId,
        memberships: membershipsOf(colleagues).concat(mine),
        consent: consents.state,
        reason,
        now: at,
      });
      // Nel registro del medico curante: chi, da quale studio, perché, con quale esito.
      await logAccess(db, {
        studioId: p.studioId,
        userId: actor.userId,
        patientId: p.id,
        action,
        outcome: decision.allowed ? 'consentito' : 'negato',
        workstation: actor.workstation,
        details: {
          aft: decision.aftId ?? null,
          medico: actor.displayName,
          studio: actorStudio?.name ?? null,
          motivoDellAccesso: reason,
          regola: decision.reason,
        },
      });
      if (decision.allowed) return { p, ownerUserId, aftId: decision.aftId!, consents, at };
    }
    throw new HttpError(404, NOT_SHARED);
  }

  /** Consultazione del riepilogo di un paziente di un collega (D161). */
  async function consult(actor: Actor, body: z.infer<typeof consultBody>) {
    const { p, ownerUserId, consents, at } = await locate(
      actor,
      body.codiceFiscale,
      body.motivo,
      'consultazione_aft',
    );
    const [owner] = await db
      .select({ name: appUser.displayName })
      .from(appUser)
      .where(eq(appUser.id, ownerUserId));
    // Le voci vengono dalla composizione del Profilo sanitario, che lascia fuori le oscurate e
    // le riservate; qui con il loro stato clinico, non con la scelta per il Profilo.
    const composed = await composePss(db, p.id, studioDate(at));
    const s = composed.sezioni;
    // Senza il consenso per il pregresso, solo le voci dalla data del consenso (Garante, par. 3).
    const since = consents.previous === 'given' ? null : consents.givenOn;
    const entryDates = new Map<string, string>();
    if (since) {
      const ids = [...s.allergie, ...s.problemi].map((i) => i.id);
      if (ids.length)
        for (const e of await db
          .select({ id: clinicalEntry.id, on: clinicalEntry.occurredOn })
          .from(clinicalEntry)
          .where(inArray(clinicalEntry.id, ids)))
          entryDates.set(e.id, e.on);
    }
    const recent = (date: string | null | undefined) => !since || (!!date && date >= since);
    const itDate = (iso: string) => iso.split('-').reverse().join('/');
    return {
      paziente: {
        cognome: p.lastName,
        nome: p.firstName,
        codiceFiscale: p.fiscalCode,
        nascita: p.birthDate,
      },
      medicoCurante: owner?.name ?? null,
      consultatoIl: at,
      // Solo i dati dal giorno del consenso: si dice, perché chi consulta lo sappia.
      soloDal: since,
      riepilogo: {
        allergie: s.allergie
          .filter((i) => recent(entryDates.get(i.id)))
          .map((i) => `${i.etichetta}${i.dati.status === 'active' ? '' : ' (non più attiva)'}`),
        problemi: s.problemi
          .filter((i) => recent(entryDates.get(i.id)))
          .map(
            (i) =>
              `${i.etichetta}${i.dati.chronic ? ', cronico' : ''}${i.dati.state === 'active' ? '' : ' (non attivo)'}`,
          ),
        terapie: s.terapie
          .filter((i) => recent(i.dati.startOn))
          .map(
            (i) =>
              `${i.etichetta}${i.dati.dosage ? `: ${i.dati.dosage}` : ''}, dal ${itDate(i.dati.startOn)}`,
          ),
        parametri: s.parametri.filter((i) => recent(i.dati.measuredOn)).map((i) => i.etichetta),
      },
      // Niente conteggi delle voci escluse: chi consulta non deve sapere che il paziente ha
      // oscurato qualcosa (D161; Garante, par. 5.1, «oscuramento dell'oscuramento»).
    };
  }

  /**
   * Attività svolta da un collega dell'AFT per un paziente di un altro medico, nel registro di
   * AFT e nella cronologia della cartella del medico curante (DGR Piemonte 31-8647/2024, art. 22).
   * Valgono le stesse condizioni della consultazione.
   */
  async function recordActivity(actor: Actor, body: z.infer<typeof activityBody>) {
    const label = AFT_ACTIVITY_KINDS.find((k) => k.key === body.tipologia)!.label;
    const { p, ownerUserId, aftId, at } = await locate(
      actor,
      body.codiceFiscale,
      `${label}: ${body.esito}`,
      'attivita_aft',
    );
    const performedAt = body.quando ? new Date(body.quando) : at;
    if (performedAt.getTime() > at.getTime())
      throw new HttpError(400, 'L’attività non può essere nel futuro');
    const [row] = await withActor(db, actor.userId, (tx) =>
      tx
        .insert(aftActivity)
        .values({
          aftId,
          patientId: p.id,
          ownerUserId,
          doctorUserId: actor.userId,
          performedAt,
          kind: body.tipologia,
          outcome: body.esito,
          notes: body.note || null,
        })
        .returning(),
    );
    return { id: row!.id };
  }

  /** Le attività dei colleghi dell'AFT sui miei pazienti. */
  async function activitiesOf(actor: Actor) {
    requireOwnerDoctor(actor);
    const rows = await db
      .select({ a: aftActivity, p: patient, doctor: appUser.displayName })
      .from(aftActivity)
      .innerJoin(patient, eq(patient.id, aftActivity.patientId))
      .innerJoin(appUser, eq(appUser.id, aftActivity.doctorUserId))
      .where(eq(aftActivity.ownerUserId, actor.userId))
      .orderBy(desc(aftActivity.performedAt))
      .limit(200);
    return rows.map(({ a, p, doctor }) => ({
      quando: a.performedAt,
      paziente: `${p.lastName} ${p.firstName}`,
      medico: doctor,
      tipologia: AFT_ACTIVITY_KINDS.find((k) => k.key === a.kind)?.label ?? a.kind,
      esito: a.outcome,
      note: a.notes,
    }));
  }

  /**
   * Le consultazioni dei colleghi su un paziente: per rispondere alla sua richiesta di sapere chi
   * ha visto i suoi dati, quando e da quale studio (Garante, par. 5.2). Le legge il titolare.
   */
  async function patientConsultations(actor: Actor, patientId: string) {
    await guardPatient(db, actor, patientId, 'access_log.read', 'lettura_registro');
    const rows = await db
      .select()
      .from(accessLog)
      .where(
        and(
          eq(accessLog.patientId, patientId),
          inArray(accessLog.action, ['consultazione_aft', 'attivita_aft']),
        ),
      )
      .orderBy(desc(accessLog.seq));
    return rows.map((log) => {
      const d = log.details as Record<string, string | null>;
      return {
        quando: log.at,
        azione: log.action === 'attivita_aft' ? 'Attività registrata' : 'Consultazione',
        esito: log.outcome,
        medico: d.medico ?? null,
        studio: d.studio ?? null,
        motivo: d.motivoDellAccesso ?? null,
      };
    });
  }

  /** Le consultazioni dei colleghi dell'AFT sui miei pazienti: dal mio registro degli accessi. */
  async function consultationsOf(actor: Actor) {
    requireOwnerDoctor(actor);
    const rows = await db
      .select({ log: accessLog, p: patient })
      .from(accessLog)
      .innerJoin(patient, eq(patient.id, accessLog.patientId))
      .innerJoin(archive, eq(archive.id, patient.archiveId))
      .where(and(eq(accessLog.action, 'consultazione_aft'), eq(archive.ownerUserId, actor.userId)))
      .orderBy(desc(accessLog.seq))
      .limit(200);
    return rows.map(({ log, p }) => {
      const d = log.details as Record<string, string | null>;
      return {
        quando: log.at,
        esito: log.outcome,
        paziente: `${p.lastName} ${p.firstName}`,
        medico: d.medico ?? null,
        studio: d.studio ?? null,
        motivo: d.motivoDellAccesso ?? null,
        regola: d.regola ?? null,
      };
    });
  }

  return {
    overview,
    create,
    update,
    invite,
    respond,
    setSharing,
    leave,
    consult,
    consultationsOf,
    recordActivity,
    activitiesOf,
    patientConsultations,
  };
}

export type AftService = ReturnType<typeof createAftService>;
