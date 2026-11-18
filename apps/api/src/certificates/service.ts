import {
  AVAILABILITY_NAME_PATTERN,
  BENEFITS,
  canCancelSickLeave,
  canRectify,
  CERTIFICATE_STATUS_LABELS,
  certificateTransition,
  checkSickLeave,
  checkSickLeaveAddress,
  DOCTOR_ROLES,
  NO_HOUSE_NUMBER,
  nextDay,
  prognosisDays,
  SICK_LEAVE_TYPE_LABELS,
  SICK_LEAVE_TYPES,
  VISIT_TYPE_LABELS,
  VISIT_TYPES,
  type Benefit,
  type CertificateErrorKind,
  type CertificateEvent,
  type CertificateStatus,
  type DoctorRole,
  type SickLeaveIssue,
  type SickLeaveType,
  type VisitType,
} from '@mmg/domain';
import type {
  DeliveryResult,
  ReminderSender,
  SickLeaveAddress,
  SickLeaveGateway,
  SickLeaveMessage,
  SickLeaveResult,
} from '@mmg/integrations';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { AccessAction } from '../audit/access-log';
import type { Actor } from '../auth/service';
import type { createCredentialService } from '../credentials/service';
import type { Database } from '../db/client';
import {
  appUser,
  certificateDelivery,
  certificateSubmission,
  doctorProfile,
  patient,
  sickLeaveCertificate,
  studio,
} from '../db/schema';
import { withActor } from '../db/tx';
import { HttpError } from '../http/errors';
import { guardPatient } from '../patients/access';
import { studioDate } from '../prescriptions/rules-check';
import type { ReferenceData } from '../reference/lookup';
import {
  renderEmployerCertificate,
  renderWorkerCopy,
  type CertificateAddress,
  type CertificatePrintData,
} from './pdf';

/**
 * Certificati di malattia telematici (tappa 8). Il medico prepara, controlla e invia all'INPS
 * tramite il Sistema TS (simulato); poi stampa o manda al lavoratore la copia (allegato A) e
 * l'attestato (allegato B). Rettifica entro la fine della prognosi, annullamento entro il giorno
 * dopo il rilascio (DM 26/2/2010, 3.3 e 3.4). Al datore di lavoro solo il protocollo, se il
 * lavoratore lo chiede (D88). Tutto passa dalla guardia e finisce nel registro degli accessi.
 */

type Row = typeof sickLeaveCertificate.$inferSelect;
type PatientRow = typeof patient.$inferSelect;
interface Availability {
  name: string | null;
  address: CertificateAddress | null;
}
interface Snapshot {
  worker: CertificatePrintData['worker'];
  doctor: CertificatePrintData['doctor'];
  place: string | null;
}

export interface CertificateDeps {
  db: Database;
  gateway: SickLeaveGateway;
  sender: ReminderSender;
  credentials: Pick<ReturnType<typeof createCredentialService>, 'authFor' | 'authRefused'>;
  /** Banca dati dei comuni, per la provincia di nascita sulla copia. */
  reference?: Pick<ReferenceData, 'municipality'>;
  now?: () => Date;
  /** Tempo massimo di attesa dell'INPS (D105): per difetto lo stesso delle ricette, 8 secondi. */
  sendTimeoutMs?: number;
}

export const DEFAULT_CERTIFICATE_TIMEOUT_MS = 8000;

const addressBody = z
  .object({
    via: z.string().trim().max(50),
    civico: z.string().trim().max(15).optional(),
    cap: z.string().trim().max(5),
    comune: z.string().trim().max(25),
    provincia: z.string().trim().max(2),
  })
  .strict();

const fields = {
  tipo: z.enum(SICK_LEAVE_TYPES).optional(),
  visita: z.enum(VISIT_TYPES).optional(),
  ruolo: z.enum(DOCTOR_ROLES).optional(),
  dataRilascio: z.iso.date().optional(),
  dataInizio: z.iso.date().optional(),
  dataFine: z.iso.date().optional(),
  codiceDiagnosi: z.string().trim().max(10).nullish(),
  noteDiagnosi: z.string().trim().max(1000).nullish(),
  giornataLavorata: z.boolean().optional(),
  trauma: z.boolean().optional(),
  agevolazioni: z.enum(BENEFITS).nullish(),
  residenza: addressBody.optional(),
  reperibilita: z
    .object({ nominativo: z.string().trim().max(24).nullish(), indirizzo: addressBody.nullish() })
    .strict()
    .nullish(),
};
const createBody = z.object({ ...fields, continuaDa: z.uuid().optional() }).strict();
const updateBody = z.object(fields).strict();
const rectifyBody = z.object({ dataFine: z.iso.date() }).strict();
const cancelBody = z.object({ motivo: z.string().trim().min(3).max(500) }).strict();
const deliverBody = z
  .object({
    canale: z.enum(['email', 'sms', 'email_datore']),
    /** Al datore di lavoro solo se lo chiede il lavoratore (D88). */
    richiestaDelLavoratore: z.literal(true).optional(),
  })
  .strict();

const toAddress = (a: z.infer<typeof addressBody>): CertificateAddress => ({
  street: a.via,
  number: a.civico ?? '',
  postalCode: a.cap,
  town: a.comune,
  province: a.provincia.toUpperCase(),
});
const fromAddress = (a: CertificateAddress | null | undefined) =>
  a
    ? { via: a.street, civico: a.number, cap: a.postalCode, comune: a.town, provincia: a.province }
    : null;
const toAvailability = (r: z.infer<typeof fields.reperibilita>): Availability | null =>
  r && (r.nominativo || r.indirizzo)
    ? { name: r.nominativo || null, address: r.indirizzo ? toAddress(r.indirizzo) : null }
    : null;
/** Per l'INPS: senza numero civico vale «SNC» (specifiche, elemento civico). */
const forInps = (a: CertificateAddress): SickLeaveAddress => ({
  ...a,
  number: a.number.trim() || NO_HOUSE_NUMBER,
});
const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

export function createCertificateService(deps: CertificateDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());
  const today = () => studioDate(now());

  async function load(id: string, studioId: string): Promise<Row> {
    const [row] = await db
      .select({ c: sickLeaveCertificate })
      .from(sickLeaveCertificate)
      .innerJoin(patient, eq(patient.id, sickLeaveCertificate.patientId))
      .where(and(eq(sickLeaveCertificate.id, id), eq(patient.studioId, studioId)));
    if (!row) throw new HttpError(404, 'Certificato non trovato');
    return row.c;
  }

  /** I certificati contengono la diagnosi: solo il medico, con il registro degli accessi. */
  const guard = (actor: Actor, patientId: string, act: AccessAction) =>
    guardPatient(db, actor, patientId, 'certificate.sign_send', act);

  function check(c: Row, event: CertificateEvent): CertificateStatus {
    const r = certificateTransition(c.status, event, {
      lastErrorKind: c.lastErrorKind,
    });
    if (!r.ok) throw new HttpError(409, r.reason);
    return r.to;
  }

  async function patientRow(id: string): Promise<PatientRow> {
    const [p] = await db.select().from(patient).where(eq(patient.id, id));
    return p!;
  }

  async function profileOf(userId: string) {
    const [p] = await db.select().from(doctorProfile).where(eq(doctorProfile.userId, userId));
    return p ?? null;
  }

  const residenceOf = (p: PatientRow): CertificateAddress => ({
    street: p.residenceStreet ?? '',
    number: p.residenceNumber ?? '',
    postalCode: p.residencePostalCode ?? '',
    town: p.residenceTown ?? '',
    province: (p.residenceProvince ?? '').toUpperCase(),
  });

  async function protocolsOf(ids: (string | null)[]) {
    const wanted = ids.filter((x): x is string => !!x);
    if (!wanted.length) return new Map<string, string | null>();
    const rows = await db
      .select({ id: sickLeaveCertificate.id, protocol: sickLeaveCertificate.protocol })
      .from(sickLeaveCertificate)
      .where(inArray(sickLeaveCertificate.id, wanted));
    return new Map(rows.map((r) => [r.id, r.protocol]));
  }

  function view(c: Row, rectifiedProtocol: string | null) {
    const t = today();
    const cancel = certificateTransition(c.status, 'cancel', {
      lastErrorKind: c.lastErrorKind,
    });
    const availability = c.availability as Availability | null;
    return {
      id: c.id,
      stato: c.status,
      etichettaStato: CERTIFICATE_STATUS_LABELS[c.status],
      tipo: c.type,
      etichettaTipo: SICK_LEAVE_TYPE_LABELS[c.type as SickLeaveType],
      visita: c.visit,
      etichettaVisita: VISIT_TYPE_LABELS[c.visit as VisitType],
      ruolo: c.role,
      dataRilascio: c.releaseDate,
      dataInizio: c.startDate,
      dataFine: c.endDate,
      giorni: prognosisDays(c.startDate, c.endDate),
      codiceDiagnosi: c.diagnosisCode,
      noteDiagnosi: c.diagnosisNotes,
      giornataLavorata: c.workedDay,
      trauma: c.trauma,
      agevolazioni: c.benefits,
      residenza: fromAddress(c.residence as CertificateAddress),
      reperibilita: availability
        ? { nominativo: availability.name, indirizzo: fromAddress(availability.address) }
        : null,
      protocollo: c.protocol,
      ricevutoIl: c.receivedAt,
      rettificaDi: rectifiedProtocol,
      annullamento: c.cancelledAt
        ? { protocollo: c.cancelProtocol, il: c.cancelledAt, motivo: c.cancelReason }
        : null,
      errore:
        c.status === 'error'
          ? { tipo: c.lastErrorKind, codice: c.lastErrorCode, messaggio: c.lastErrorMessage }
          : null,
      annullabile:
        c.status === 'sent' ? canCancelSickLeave({ releaseDate: c.releaseDate }, t).ok : cancel.ok,
      rettificabile: c.status === 'sent' && t <= c.endDate,
      continuabile: c.status === 'sent',
    };
  }

  async function viewOne(c: Row) {
    const protocols = await protocolsOf([c.rectifiesId]);
    return view(c, c.rectifiesId ? (protocols.get(c.rectifiesId) ?? null) : null);
  }

  /** Certificati del paziente, con i recapiti per le consegne (presenti o no). */
  async function list(actor: Actor, patientId: string) {
    const { patient: p } = await guard(actor, patientId, 'lettura_certificati');
    const rows = await db
      .select()
      .from(sickLeaveCertificate)
      .where(eq(sickLeaveCertificate.patientId, patientId))
      .orderBy(desc(sickLeaveCertificate.releaseDate), desc(sickLeaveCertificate.createdAt));
    const protocols = await protocolsOf(rows.map((r) => r.rectifiesId));
    return {
      certificati: rows.map((r) =>
        view(r, r.rectifiesId ? (protocols.get(r.rectifiesId) ?? null) : null),
      ),
      residenza: fromAddress(residenceOf(p)),
      recapiti: { email: !!p.email, telefono: !!p.phone, emailDatore: !!p.employerEmail },
    };
  }

  async function get(actor: Actor, id: string) {
    const c = await load(id, actor.studioId);
    await guard(actor, c.patientId, 'lettura_certificati');
    return viewOne(c);
  }

  async function create(actor: Actor, patientId: string, body: unknown) {
    const { patient: p } = await guard(actor, patientId, 'certificato_bozza');
    const b = createBody.parse(body ?? {});
    let base: Partial<Row> = {};
    if (b.continuaDa) {
      const prev = await load(b.continuaDa, actor.studioId);
      if (prev.patientId !== patientId)
        throw new HttpError(400, 'Il certificato da continuare è di un altro paziente');
      if (prev.status !== 'sent')
        throw new HttpError(409, 'Si continua solo un certificato inviato');
      // Continuazione: dal giorno dopo la fine della prognosi precedente, con gli stessi dati.
      base = {
        type: 'C',
        visit: prev.visit,
        startDate: nextDay(prev.endDate),
        endDate: nextDay(prev.endDate),
        diagnosisCode: prev.diagnosisCode,
        diagnosisNotes: prev.diagnosisNotes,
        benefits: prev.benefits,
        residence: prev.residence,
        availability: prev.availability,
      };
    }
    const t = today();
    const start = b.dataInizio ?? base.startDate ?? t;
    const [row] = await withActor(db, actor.userId, (tx) =>
      tx
        .insert(sickLeaveCertificate)
        .values({
          patientId,
          archiveId: p.archiveId,
          preparedBy: actor.userId,
          type: b.tipo ?? base.type ?? 'I',
          visit: b.visita ?? base.visit ?? 'A',
          role: b.ruolo ?? 'S',
          releaseDate: b.dataRilascio ?? t,
          startDate: start,
          endDate: b.dataFine ?? base.endDate ?? start,
          diagnosisCode: b.codiceDiagnosi ?? base.diagnosisCode ?? null,
          diagnosisNotes: b.noteDiagnosi ?? base.diagnosisNotes ?? null,
          workedDay: b.giornataLavorata ?? false,
          trauma: b.trauma ?? false,
          benefits: b.agevolazioni ?? base.benefits ?? null,
          residence: b.residenza ? toAddress(b.residenza) : (base.residence ?? residenceOf(p)),
          availability:
            b.reperibilita !== undefined
              ? toAvailability(b.reperibilita)
              : (base.availability ?? null),
        })
        .returning(),
    );
    return viewOne(row!);
  }

  async function update(actor: Actor, id: string, body: unknown) {
    const c = await load(id, actor.studioId);
    await guard(actor, c.patientId, 'certificato_modifica');
    const to = check(c, 'edit');
    const b = updateBody.parse(body ?? {});
    const set: Partial<typeof sickLeaveCertificate.$inferInsert> = {
      status: to,
      updatedAt: now(),
      ...(c.status === 'error'
        ? { lastErrorKind: null, lastErrorCode: null, lastErrorMessage: null }
        : {}),
      ...(b.tipo ? { type: b.tipo } : {}),
      ...(b.visita ? { visit: b.visita } : {}),
      ...(b.ruolo ? { role: b.ruolo } : {}),
      ...(b.dataRilascio ? { releaseDate: b.dataRilascio } : {}),
      ...(b.dataInizio ? { startDate: b.dataInizio } : {}),
      ...(b.dataFine ? { endDate: b.dataFine } : {}),
      ...(b.codiceDiagnosi !== undefined ? { diagnosisCode: b.codiceDiagnosi || null } : {}),
      ...(b.noteDiagnosi !== undefined ? { diagnosisNotes: b.noteDiagnosi || null } : {}),
      ...(b.giornataLavorata !== undefined ? { workedDay: b.giornataLavorata } : {}),
      ...(b.trauma !== undefined ? { trauma: b.trauma } : {}),
      ...(b.agevolazioni !== undefined ? { benefits: b.agevolazioni ?? null } : {}),
      ...(b.residenza ? { residence: toAddress(b.residenza) } : {}),
      ...(b.reperibilita !== undefined ? { availability: toAvailability(b.reperibilita) } : {}),
    };
    const rows = await withActor(db, actor.userId, (tx) =>
      tx
        .update(sickLeaveCertificate)
        .set(set)
        .where(and(eq(sickLeaveCertificate.id, c.id), eq(sickLeaveCertificate.status, c.status)))
        .returning(),
    );
    if (!rows.length) throw new HttpError(409, 'Il certificato è cambiato nel frattempo: ricarica');
    return viewOne(rows[0]!);
  }

  /** I controlli dell'INPS ripetuti qui, con i suoi codici: l'errore si vede prima dell'invio. */
  function issuesOf(
    c: Row,
    p: PatientRow,
    profile: Awaited<ReturnType<typeof profileOf>>,
  ): SickLeaveIssue[] {
    const issues = checkSickLeave(
      {
        type: c.type as SickLeaveType,
        visit: c.visit as VisitType,
        releaseDate: c.releaseDate,
        startDate: c.startDate,
        endDate: c.endDate,
        diagnosisCode: c.diagnosisCode,
        diagnosisNotes: c.diagnosisNotes,
        workedDay: c.workedDay,
      },
      { today: today(), workerBirthDate: p.birthDate },
    );
    if (c.endDate < c.startDate)
      issues.push({
        code: '543',
        message: 'Data di fine prognosi: non può essere prima dell’inizio',
      });
    issues.push(...checkSickLeaveAddress(c.residence as CertificateAddress, 'residenza'));
    const availability = c.availability as Availability | null;
    if (availability?.name && !AVAILABILITY_NAME_PATTERN.test(availability.name))
      issues.push({
        code: '491',
        message:
          'Nominativo presso l’abitazione: da 2 a 24 lettere, spazi o apostrofo, senza accenti (reperibilità)',
      });
    if (availability?.address)
      issues.push(...checkSickLeaveAddress(availability.address, 'reperibilita'));
    if (!profile?.fiscalCode)
      issues.push({ code: '233', message: 'Manca il codice fiscale del medico nel profilo' });
    return issues;
  }

  async function checkOnly(actor: Actor, id: string) {
    const c = await load(id, actor.studioId);
    await guard(actor, c.patientId, 'certificato_controllo');
    const issues = issuesOf(c, await patientRow(c.patientId), await profileOf(actor.userId));
    return { problemi: issues };
  }

  async function snapshotOf(c: Row, p: PatientRow, actor: Actor): Promise<Snapshot> {
    const profile = await profileOf(actor.userId);
    let birthProvince: string | null = null;
    if (p.birthPlaceCode && deps.reference) {
      try {
        birthProvince =
          (await deps.reference.municipality(p.birthPlaceCode, today()))?.provinceAbbr ?? null;
      } catch {
        birthProvince = null;
      }
    }
    const [st] = await db
      .select({ address: studio.address })
      .from(studio)
      .where(eq(studio.id, actor.studioId));
    const availability = c.availability as Availability | null;
    // Luogo del fac-simile: lo studio per la visita ambulatoriale, la casa per la domiciliare (D106).
    const place =
      c.visit === 'A'
        ? (st?.address ?? null)
        : c.visit === 'D'
          ? (availability?.address?.town ?? (c.residence as CertificateAddress).town)
          : null;
    return {
      worker: {
        lastName: p.lastName,
        firstName: p.firstName,
        fiscalCode: p.fiscalCode,
        birthDate: p.birthDate,
        birthPlace: p.birthPlaceName,
        birthProvince,
      },
      doctor: {
        name: actor.displayName,
        regionalCode: profile?.regionalCode ?? null,
        asl: profile?.asl ?? null,
      },
      place,
    };
  }

  async function doctorOf(actor: Actor): Promise<SickLeaveMessage['doctor']> {
    const profile = await profileOf(actor.userId);
    return {
      userId: actor.userId,
      name: actor.displayName,
      fiscalCode: profile?.fiscalCode ?? '',
      regionalCode: profile?.regionalCode ?? null,
    };
  }

  /** Risposta entro il tempo massimo, altrimenti esito incerto. */
  async function inTime(call: () => Promise<SickLeaveResult>): Promise<SickLeaveResult> {
    const ms = deps.sendTimeoutMs ?? DEFAULT_CERTIFICATE_TIMEOUT_MS;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        call(),
        new Promise<SickLeaveResult>((ok) => {
          timer = setTimeout(
            () =>
              ok({
                outcome: 'timeout',
                message: `Nessuna risposta entro ${ms / 1000} secondi: non si sa se è arrivato all’INPS`,
              }),
            ms,
          );
        }),
      ]);
    } catch (err) {
      return { outcome: 'timeout', message: `Errore dell'adattatore: ${String(err)}` };
    } finally {
      clearTimeout(timer);
    }
  }

  async function record(
    actor: Actor,
    certificateId: string,
    operation: 'invio' | 'rettifica' | 'annullamento',
    request: unknown,
    result: SickLeaveResult,
    started: number,
  ) {
    await db.insert(certificateSubmission).values({
      certificateId,
      operation,
      environment: deps.gateway.environment,
      userId: actor.userId,
      request,
      response: 'raw' in result ? result.raw : null,
      outcome: result.outcome,
      errorCode: result.outcome === 'rejected' ? result.code : null,
      errorMessage: result.outcome === 'accepted' ? null : result.message,
      durationMs: Date.now() - started,
    });
  }

  /** Esito non riuscito di rettifica o annullamento, detto in chiaro. */
  async function refused(actor: Actor, result: Exclude<SickLeaveResult, { outcome: 'accepted' }>) {
    if (result.outcome === 'rejected' && result.authProblem) {
      await deps.credentials.authRefused(
        actor,
        'certificato_inps',
        result.authProblem,
        `${result.code}: ${result.message}`,
      );
      throw new HttpError(
        422,
        `${result.message}. Controlla utente, password e PIN del Sistema TS in «Credenziali dei servizi».`,
        { codice: 'CREDENZIALI_RIFIUTATE', servizio: 'sistema-ts' },
      );
    }
    if (result.outcome === 'rejected')
      throw new HttpError(409, `L’INPS ha rifiutato (${result.code}): ${result.message}`);
    throw new HttpError(503, result.message);
  }

  async function send(actor: Actor, id: string) {
    const c = await load(id, actor.studioId);
    await guard(actor, c.patientId, 'certificato_invio');
    const p = await patientRow(c.patientId);
    const issues = issuesOf(c, p, await profileOf(actor.userId));
    if (issues.length)
      throw new HttpError(422, issues.map((i) => `${i.code}: ${i.message}`).join('\n'), {
        problemi: issues,
      });
    check(c, 'start_sending');
    const auth = await deps.credentials.authFor(actor.userId, 'certificato_inps');
    const claimed = await withActor(db, actor.userId, (tx) =>
      tx
        .update(sickLeaveCertificate)
        .set({ status: 'sending', signedBy: actor.userId, signedAt: now(), updatedAt: now() })
        .where(and(eq(sickLeaveCertificate.id, c.id), eq(sickLeaveCertificate.status, c.status)))
        .returning({ id: sickLeaveCertificate.id }),
    );
    if (!claimed.length)
      throw new HttpError(409, 'Il certificato è cambiato nel frattempo: ricarica');

    const snapshot = await snapshotOf(c, p, actor);
    const availability = c.availability as Availability | null;
    const message: SickLeaveMessage = {
      localId: c.id,
      doctor: await doctorOf(actor),
      workerFiscalCode: p.fiscalCode,
      residence: forInps(c.residence as CertificateAddress),
      availability: availability
        ? {
            name: availability.name,
            address: availability.address ? forInps(availability.address) : null,
          }
        : null,
      sickness: {
        role: c.role as DoctorRole,
        releaseDate: c.releaseDate,
        startDate: c.startDate,
        endDate: c.endDate,
        visit: c.visit as VisitType,
        type: c.type as SickLeaveType,
        diagnosisCode: c.diagnosisCode,
        diagnosisNotes: c.diagnosisNotes,
        workedDay: c.workedDay,
        trauma: c.trauma,
        benefits: c.benefits as Benefit | null,
      },
    };
    const started = Date.now();
    let result = await inTime(() => deps.gateway.send(message, auth));
    const authProblem = result.outcome === 'rejected' ? (result.authProblem ?? null) : null;
    if (result.outcome === 'rejected' && authProblem) {
      await deps.credentials.authRefused(
        actor,
        'certificato_inps',
        authProblem,
        `${result.code}: ${result.message}`,
      );
      result = {
        ...result,
        message: `${result.message}. Controlla utente, password e PIN del Sistema TS in «Credenziali dei servizi» e rimanda.`,
      };
    }
    await record(actor, c.id, 'invio', message, result, started);
    const kind: CertificateErrorKind | null =
      result.outcome === 'accepted'
        ? null
        : authProblem
          ? 'auth'
          : result.outcome === 'rejected'
            ? 'rejected'
            : result.outcome;
    await withActor(db, actor.userId, (tx) =>
      tx
        .update(sickLeaveCertificate)
        .set(
          result.outcome === 'accepted'
            ? {
                status: 'sent',
                protocol: result.protocol,
                receivedAt: new Date(result.receivedAt),
                snapshot,
                lastErrorKind: null,
                lastErrorCode: null,
                lastErrorMessage: null,
                updatedAt: now(),
              }
            : {
                status: 'error',
                lastErrorKind: kind,
                lastErrorCode: result.outcome === 'rejected' ? result.code : null,
                lastErrorMessage: result.message,
                updatedAt: now(),
              },
        )
        .where(eq(sickLeaveCertificate.id, c.id)),
    );
    return {
      esito: kind ?? 'accepted',
      protocollo: result.outcome === 'accepted' ? result.protocol : null,
      ricevutoIl: result.outcome === 'accepted' ? result.receivedAt : null,
      messaggio: result.outcome === 'accepted' ? null : result.message,
    };
  }

  /** Rettifica: anticipa la fine della prognosi; certificato nuovo con protocollo nuovo (3.3). */
  async function rectify(actor: Actor, id: string, body: unknown) {
    const c = await load(id, actor.studioId);
    await guard(actor, c.patientId, 'certificato_rettifica');
    const { dataFine } = rectifyBody.parse(body ?? {});
    check(c, 'rectify');
    const allowed = canRectify({ endDate: c.endDate }, dataFine, today());
    if (!allowed.ok) throw new HttpError(409, allowed.reason);
    if (dataFine < c.releaseDate || dataFine < c.startDate)
      throw new HttpError(
        422,
        '24: La nuova fine della prognosi non può essere prima del rilascio né dell’inizio della malattia',
      );
    const auth = await deps.credentials.authFor(actor.userId, 'certificato_inps');
    const p = await patientRow(c.patientId);
    const request = {
      protocol: c.protocol!,
      endDate: dataFine,
      workerFiscalCode: p.fiscalCode,
      doctor: await doctorOf(actor),
    };
    const started = Date.now();
    const result = await inTime(() => deps.gateway.rectify(request, auth));
    await record(actor, c.id, 'rettifica', request, result, started);
    if (result.outcome !== 'accepted') return refused(actor, result);
    const [created] = await withActor(db, actor.userId, async (tx) => {
      const rows = await tx
        .insert(sickLeaveCertificate)
        .values({
          ...c,
          id: undefined,
          status: 'sent',
          endDate: dataFine,
          protocol: result.protocol,
          receivedAt: new Date(result.receivedAt),
          rectifiesId: c.id,
          preparedBy: actor.userId,
          signedBy: actor.userId,
          signedAt: now(),
          createdAt: now(),
          updatedAt: now(),
        })
        .returning();
      await tx
        .update(sickLeaveCertificate)
        .set({ status: 'rectified', updatedAt: now() })
        .where(eq(sickLeaveCertificate.id, c.id));
      return rows;
    });
    return { esito: 'accepted' as const, protocollo: result.protocol, certificato: created!.id };
  }

  /** Annullamento: prima dell'invio è locale; dopo, solo entro il giorno successivo al rilascio. */
  async function cancel(actor: Actor, id: string, body: unknown) {
    const c = await load(id, actor.studioId);
    await guard(actor, c.patientId, 'certificato_annullamento');
    const { motivo } = cancelBody.parse(body ?? {});
    const to = check(c, 'cancel');
    const local = {
      status: to,
      cancelledAt: now(),
      cancelledBy: actor.userId,
      cancelReason: motivo,
      updatedAt: now(),
    };
    if (c.status !== 'sent') {
      await withActor(db, actor.userId, (tx) =>
        tx.update(sickLeaveCertificate).set(local).where(eq(sickLeaveCertificate.id, c.id)),
      );
      return { esito: 'accepted' as const, protocollo: null };
    }
    const allowed = canCancelSickLeave({ releaseDate: c.releaseDate }, today());
    if (!allowed.ok) throw new HttpError(409, allowed.reason);
    const auth = await deps.credentials.authFor(actor.userId, 'certificato_inps');
    const p = await patientRow(c.patientId);
    const request = {
      protocol: c.protocol!,
      workerFiscalCode: p.fiscalCode,
      doctor: await doctorOf(actor),
    };
    const started = Date.now();
    const result = await inTime(() => deps.gateway.cancel(request, auth));
    await record(actor, c.id, 'annullamento', request, result, started);
    if (result.outcome !== 'accepted') return refused(actor, result);
    await withActor(db, actor.userId, (tx) =>
      tx
        .update(sickLeaveCertificate)
        .set({ ...local, cancelProtocol: result.protocol })
        .where(eq(sickLeaveCertificate.id, c.id)),
    );
    return { esito: 'accepted' as const, protocollo: result.protocol };
  }

  async function printData(c: Row): Promise<CertificatePrintData> {
    if (c.status !== 'sent' || !c.protocol || !c.receivedAt || !c.snapshot)
      throw new HttpError(
        409,
        'Copia e attestato si stampano solo per un certificato inviato e ancora valido',
      );
    const snapshot = c.snapshot as Snapshot;
    const availability = c.availability as Availability | null;
    const protocols = await protocolsOf([c.rectifiesId]);
    return {
      protocol: c.protocol,
      releaseDate: c.releaseDate,
      place: snapshot.place,
      receivedAt: c.receivedAt.toISOString(),
      rectifiedProtocol: c.rectifiesId ? (protocols.get(c.rectifiesId) ?? null) : null,
      doctor: snapshot.doctor,
      type: c.type as SickLeaveType,
      visit: c.visit as VisitType,
      startDate: c.startDate,
      endDate: c.endDate,
      diagnosisCode: c.diagnosisCode,
      diagnosisNotes: c.diagnosisNotes,
      workedDay: c.workedDay,
      trauma: c.trauma,
      benefits: c.benefits as Benefit | null,
      worker: snapshot.worker,
      // La copia riporta i dati come li ha ricevuti l'INPS: senza civico, «SNC».
      residence: forInps(c.residence as CertificateAddress),
      availability: availability
        ? {
            name: availability.name,
            address: availability.address ? forInps(availability.address) : null,
          }
        : null,
    };
  }

  async function deliveryRow(
    actor: Actor,
    c: Row,
    channel: string,
    recipient: string | null,
    outcome: string,
    extra: { messageId?: string | null; errorMessage?: string | null; environment?: string } = {},
  ) {
    await db.insert(certificateDelivery).values({
      certificateId: c.id,
      userId: actor.userId,
      channel,
      recipient,
      environment: extra.environment ?? null,
      outcome,
      messageId: extra.messageId ?? null,
      errorMessage: extra.errorMessage ?? null,
    });
  }

  /** Copia per il lavoratore (allegato A) o attestato (allegato B), in PDF. */
  async function pdf(actor: Actor, id: string, which: 'copia' | 'attestato') {
    const c = await load(id, actor.studioId);
    await guard(actor, c.patientId, 'stampa_certificato');
    const data = await printData(c);
    const bytes =
      which === 'copia' ? await renderWorkerCopy(data) : await renderEmployerCertificate(data);
    await deliveryRow(
      actor,
      c,
      which === 'copia' ? 'stampa_copia' : 'stampa_attestato',
      null,
      'stampato',
    );
    return {
      bytes,
      name: `${which === 'copia' ? 'certificato' : 'attestato'}-${c.protocol}.pdf`,
    };
  }

  /**
   * Consegna (DM 26/2/2010, 4.2): al lavoratore copia e attestato per email, oppure un SMS con i
   * dati essenziali dell'attestato; al datore di lavoro solo il protocollo, se il lavoratore lo
   * chiede (D88).
   */
  async function deliver(actor: Actor, id: string, body: unknown) {
    const c = await load(id, actor.studioId);
    await guard(actor, c.patientId, 'consegna_certificato');
    const b = deliverBody.parse(body ?? {});
    const data = await printData(c);
    const p = await patientRow(c.patientId);
    const worker = `${data.worker.firstName} ${data.worker.lastName}`;
    let to: string | null;
    let channel: string;
    let result: DeliveryResult;
    if (b.canale === 'email_datore') {
      if (!b.richiestaDelLavoratore)
        throw new HttpError(
          400,
          'Al datore di lavoro si manda il protocollo solo se lo chiede il lavoratore',
        );
      to = p.employerEmail;
      channel = 'email_datore';
      if (!to) throw new HttpError(422, 'Nessuna email del datore di lavoro in anagrafica');
      result = await deps.sender.sendEmail({
        to,
        subject: `Certificato di malattia telematico: protocollo ${c.protocol}`,
        text: `Numero di protocollo del certificato di malattia telematico: ${c.protocol}.\nIl lavoratore ha chiesto di comunicarlo; l’attestato di malattia è a disposizione presso l’INPS.`,
        attachments: [],
      });
    } else if (b.canale === 'email') {
      to = p.email;
      channel = 'email_lavoratore';
      if (!to) throw new HttpError(422, 'Nessuna email del lavoratore in anagrafica');
      const [copy, attestato] = await Promise.all([
        renderWorkerCopy(data),
        renderEmployerCertificate(data),
      ]);
      result = await deps.sender.sendEmail({
        to,
        subject: `Certificato di malattia telematico: protocollo ${c.protocol}`,
        text: `In allegato la copia del certificato di malattia telematico e l’attestato di malattia, protocollo ${c.protocol}, rilasciato il ${ddmmyyyy(c.releaseDate)} da ${data.doctor.name}.\nL’attestato è a disposizione del datore di lavoro presso l’INPS.`,
        attachments: [
          {
            filename: `certificato-${c.protocol}.pdf`,
            contentType: 'application/pdf',
            content: copy,
          },
          {
            filename: `attestato-${c.protocol}.pdf`,
            contentType: 'application/pdf',
            content: attestato,
          },
        ],
      });
    } else {
      to = p.phone;
      channel = 'sms_lavoratore';
      if (!to) throw new HttpError(422, 'Nessun telefono del lavoratore in anagrafica');
      const days = prognosisDays(c.startDate, c.endDate);
      result = await deps.sender.sendSms({
        to,
        text: `Certificato di malattia INPS prot. ${c.protocol}, rilasciato il ${ddmmyyyy(c.releaseDate)}, prognosi dal ${ddmmyyyy(c.startDate)} al ${ddmmyyyy(c.endDate)} (${days} ${days === 1 ? 'giorno' : 'giorni'}). Lavoratore: ${worker}. Medico: ${data.doctor.name}.`,
      });
    }
    await deliveryRow(
      actor,
      c,
      channel,
      to,
      result.outcome === 'sent'
        ? 'consegnato'
        : result.outcome === 'rejected'
          ? 'rifiutato'
          : 'non_raggiungibile',
      {
        environment: deps.sender.environment,
        messageId: result.outcome === 'sent' ? result.messageId : null,
        errorMessage: result.outcome === 'sent' ? null : result.message,
      },
    );
    if (result.outcome !== 'sent')
      throw new HttpError(502, `Consegna non riuscita: ${result.message}`);
    return { esito: 'consegnato', recapito: to };
  }

  async function deliveries(actor: Actor, id: string) {
    const c = await load(id, actor.studioId);
    await guard(actor, c.patientId, 'lettura_consegne_certificato');
    const rows = await db
      .select({
        il: certificateDelivery.at,
        canale: certificateDelivery.channel,
        recapito: certificateDelivery.recipient,
        esito: certificateDelivery.outcome,
        errore: certificateDelivery.errorMessage,
        da: appUser.displayName,
      })
      .from(certificateDelivery)
      .innerJoin(appUser, eq(appUser.id, certificateDelivery.userId))
      .where(eq(certificateDelivery.certificateId, c.id))
      .orderBy(asc(certificateDelivery.at));
    return { consegne: rows };
  }

  return {
    list,
    get,
    create,
    update,
    checkOnly,
    send,
    rectify,
    cancel,
    pdf,
    deliver,
    deliveries,
  };
}
