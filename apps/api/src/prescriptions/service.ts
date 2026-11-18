import {
  can,
  transition,
  type PrescriptionEvent,
  type PrescriptionKind,
  type PrescriptionStatus,
  type SendErrorKind,
} from '@mmg/domain';
import type {
  GatewaySystem,
  PrescriptionGateway,
  PrescriptionMessage,
  SendResult,
} from '@mmg/integrations';
import { systemFor } from '@mmg/integrations';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { AccessAction } from '../audit/access-log';
import type { Actor } from '../auth/service';
import type { Database } from '../db/client';
import {
  appUser,
  doctorProfile,
  externalSubmission,
  patient,
  prescription,
  prescriptionLine,
  therapy,
} from '../db/schema';
import { withActor } from '../db/tx';
import { HttpError } from '../http/errors';
import { guardPatient, loadArchiveContext, visibleArchives } from '../patients/access';
import { cancelSchema, draftSchema, repeatSchema } from './schemas';

export interface LineInput {
  therapyId?: string | null;
  drugAic?: string | null;
  drugName?: string | null;
  activeIngredient?: string | null;
  serviceCode?: string | null;
  serviceDescription?: string | null;
  quantity: number;
  aifaNote?: string | null;
  byActiveIngredient?: boolean;
  notSubstitutable?: boolean;
  notSubstitutableReason?: string | null;
  posologyText?: string | null;
}

export interface DraftInput {
  kind: PrescriptionKind;
  priority?: 'U' | 'B' | 'D' | 'P' | null;
  accessType?: 'first' | 'subsequent' | null;
  diagnosticQuestion?: string | null;
  exemptionCode?: string | null;
  requestId?: string | null;
  lines: LineInput[];
}

/** Problema trovato dai controlli prima dell'invio (le regole di prescrizione, tappa 4). */
export interface PreSendIssue {
  ruleId: string;
  severity: 'block' | 'warn';
  message: string;
}

export interface PrescriptionDeps {
  db: Database;
  gateways: Record<GatewaySystem, PrescriptionGateway>;
  now?: () => Date;
  /**
   * Controlli prima dell'invio (regole di prescrizione, tappa 4): problemi trovati e versione
   * delle regole usata. Per difetto nessun controllo e nessuna versione.
   */
  preSendChecks?: (
    prescriptionId: string,
    actor: Actor,
  ) => Promise<{ issues: PreSendIssue[]; rulesVersion: string | null }>;
}

type PrescriptionRow = typeof prescription.$inferSelect;

export function createPrescriptionService(deps: PrescriptionDeps) {
  const { db } = deps;
  const now = deps.now ?? (() => new Date());

  async function load(id: string, studioId: string): Promise<PrescriptionRow> {
    const [row] = await db
      .select({ p: prescription })
      .from(prescription)
      .innerJoin(patient, eq(patient.id, prescription.patientId))
      .where(and(eq(prescription.id, id), eq(patient.studioId, studioId)));
    if (!row) throw new HttpError(404, 'Ricetta non trovata');
    return row.p;
  }

  function check(p: PrescriptionRow, event: PrescriptionEvent): PrescriptionStatus {
    const r = transition(p.status, event, { lastErrorKind: p.lastErrorKind });
    if (!r.ok) throw new HttpError(409, r.reason);
    return r.to;
  }

  /** Chi prepara: il medico (qualsiasi ricetta) o la segreteria (ripetizioni). */
  async function guardPrepare(actor: Actor, p: PrescriptionRow, logAction: AccessAction) {
    const ctx = await loadArchiveContext(db, p.archiveId);
    const action = can(actor, 'prescription.draft', { ...ctx, now: now() }).allowed
      ? 'prescription.draft'
      : 'prescription.draft_repeat';
    // La ripetizione della segreteria è ammessa solo per terapie croniche: le righe lo dicono.
    const resource =
      action === 'prescription.draft_repeat' ? await repeatResource(p.id) : undefined;
    return guardPatient(db, actor, p.patientId, action, logAction, resource);
  }

  async function repeatResource(prescriptionId: string) {
    const rows = await db
      .select({ kind: therapy.kind, reserved: therapy.reserved })
      .from(prescriptionLine)
      .leftJoin(therapy, eq(therapy.id, prescriptionLine.therapyId))
      .where(eq(prescriptionLine.prescriptionId, prescriptionId));
    const allChronic = rows.length > 0 && rows.every((r) => r.kind === 'chronic');
    return {
      therapyKind: allChronic ? ('chronic' as const) : ('as_needed' as const),
      reserved: rows.some((r) => r.reserved === true),
    };
  }

  async function insertDraft(
    actor: Actor,
    patientId: string,
    archiveId: string,
    input: DraftInput,
    status: PrescriptionStatus,
  ): Promise<string> {
    if (input.lines.length === 0) throw new HttpError(400, 'La ricetta non ha righe');
    return withActor(db, actor.userId, async (tx) => {
      const [p] = await tx
        .insert(prescription)
        .values({
          patientId,
          archiveId,
          kind: input.kind,
          status,
          priority: input.priority ?? null,
          accessType: input.accessType ?? null,
          diagnosticQuestion: input.diagnosticQuestion ?? null,
          exemptionCode: input.exemptionCode ?? null,
          requestId: input.requestId ?? null,
          preparedBy: actor.userId,
          preparedAt: now(),
          updatedAt: now(),
        })
        .returning({ id: prescription.id });
      await tx.insert(prescriptionLine).values(
        input.lines.map((l, i) => ({
          prescriptionId: p!.id,
          position: i + 1,
          therapyId: l.therapyId ?? null,
          drugAic: l.drugAic ?? null,
          drugName: l.drugName ?? null,
          activeIngredient: l.activeIngredient ?? null,
          serviceCode: l.serviceCode ?? null,
          serviceDescription: l.serviceDescription ?? null,
          quantity: l.quantity,
          aifaNote: l.aifaNote ?? null,
          byActiveIngredient: l.byActiveIngredient ?? false,
          notSubstitutable: l.notSubstitutable ?? false,
          notSubstitutableReason: l.notSubstitutableReason ?? null,
          posologyText: l.posologyText ?? null,
        })),
      );
      return p!.id;
    });
  }

  /** Il medico prepara una ricetta nuova (bozza). Il corpo si valida dopo la guardia. */
  async function createDraft(actor: Actor, patientId: string, body: unknown) {
    const { patient: p } = await guardPatient(
      db,
      actor,
      patientId,
      'prescription.draft',
      'ricetta_bozza',
    );
    return insertDraft(actor, patientId, p.archiveId, draftSchema.parse(body), 'draft');
  }

  /**
   * Ripetizione di terapie croniche: una ricetta per terapia (D37). La segreteria la mette
   * direttamente nella coda «da firmare» del medico; il medico la trova in bozza.
   */
  async function prepareRepeat(actor: Actor, patientId: string, body: unknown) {
    // Un solo passaggio dalla guardia per la richiesta; poi ogni terapia si controlla con le
    // stesse regole (cronica, non riservata) e un rifiuto si registra.
    const { patient: p, context } = await guardPatient(
      db,
      actor,
      patientId,
      'prescription.draft_repeat',
      'ricetta_ripetizione',
      { therapyKind: 'chronic' },
    );
    const { terapie: therapyIds } = repeatSchema.parse(body);
    const rows = await db
      .select()
      .from(therapy)
      .where(and(eq(therapy.patientId, patientId), inArray(therapy.id, therapyIds)));
    if (rows.length !== new Set(therapyIds).size) throw new HttpError(404, 'Terapia non trovata');
    const isDoctor = can(actor, 'prescription.draft', { ...context, now: now() }).allowed;
    for (const t of rows) {
      const decision = can(actor, 'prescription.draft_repeat', {
        ...context,
        resource: { therapyKind: t.kind, reserved: t.reserved },
        now: now(),
      });
      if (!decision.allowed) {
        await guardPatient(
          db,
          actor,
          patientId,
          'prescription.draft_repeat',
          'ricetta_ripetizione',
          {
            therapyKind: t.kind,
            reserved: t.reserved,
          },
        );
      }
      if (t.status !== 'active') throw new HttpError(409, `Terapia non attiva: ${t.drugName}`);
    }
    const created: string[] = [];
    for (const t of rows) {
      created.push(
        await insertDraft(
          actor,
          patientId,
          p.archiveId,
          {
            kind: t.notReimbursable ? 'white' : 'pharma_ssn',
            exemptionCode: t.habitualExemptionCode,
            lines: [
              {
                therapyId: t.id,
                drugAic: t.drugAic,
                drugName: t.drugName,
                activeIngredient: t.activeIngredient,
                quantity: t.packsPerPrescription,
                aifaNote: t.aifaNote,
                byActiveIngredient: t.byActiveIngredient,
                notSubstitutable: t.notSubstitutable,
                notSubstitutableReason: t.notSubstitutableReason,
                posologyText: [t.dose, t.doseUnit, t.frequency].filter(Boolean).join(' ') || null,
              },
            ],
          },
          isDoctor ? 'draft' : 'to_sign',
        ),
      );
    }
    return created;
  }

  async function setStatus(
    actor: Actor,
    p: PrescriptionRow,
    to: PrescriptionStatus,
    extra: Partial<typeof prescription.$inferInsert> = {},
  ) {
    await withActor(db, actor.userId, (tx) =>
      tx
        .update(prescription)
        .set({ status: to, updatedAt: now(), ...extra })
        .where(and(eq(prescription.id, p.id), eq(prescription.status, p.status))),
    );
  }

  async function submitForSigning(actor: Actor, id: string) {
    const p = await load(id, actor.studioId);
    await guardPrepare(actor, p, 'ricetta_da_firmare');
    await setStatus(actor, p, check(p, 'submit_for_signing'));
  }

  async function backToDraft(actor: Actor, id: string) {
    const p = await load(id, actor.studioId);
    await guardPrepare(actor, p, 'ricetta_modifica');
    await setStatus(actor, p, check(p, 'edit'), {
      lastErrorKind: null,
      lastErrorCode: null,
      lastErrorMessage: null,
    });
  }

  async function doctorInfo(userId: string) {
    const [d] = await db
      .select({ name: appUser.displayName, regionalCode: doctorProfile.regionalCode })
      .from(appUser)
      .leftJoin(doctorProfile, eq(doctorProfile.userId, appUser.id))
      .where(eq(appUser.id, userId));
    return { userId, name: d!.name, regionalCode: d!.regionalCode ?? null };
  }

  async function buildMessage(p: PrescriptionRow, actor: Actor): Promise<PrescriptionMessage> {
    const [pt] = await db.select().from(patient).where(eq(patient.id, p.patientId));
    const lines = await db
      .select()
      .from(prescriptionLine)
      .where(eq(prescriptionLine.prescriptionId, p.id))
      .orderBy(asc(prescriptionLine.position));
    return {
      localId: p.id,
      kind: p.kind,
      patientFiscalCode: pt!.fiscalCode,
      doctor: await doctorInfo(actor.userId),
      exemptionCode: p.exemptionCode,
      priority: p.priority,
      accessType: p.accessType,
      diagnosticQuestion: p.diagnosticQuestion,
      lines: lines.map((l) => ({
        drugAic: l.drugAic,
        drugName: l.drugName,
        activeIngredient: l.activeIngredient,
        serviceCode: l.serviceCode,
        serviceDescription: l.serviceDescription,
        quantity: l.quantity,
        aifaNote: l.aifaNote,
        notSubstitutable: l.notSubstitutable,
        notSubstitutableReason: l.notSubstitutableReason,
      })),
      compiledAt: now().toISOString().slice(0, 10),
    };
  }

  /** Il medico firma e invia: al SAR (SSN) o al Sistema TS (bianca). */
  async function signAndSend(actor: Actor, id: string) {
    const p = await load(id, actor.studioId);
    await guardPatient(db, actor, p.patientId, 'prescription.sign_send', 'ricetta_firma_invio');
    check(p, 'start_sending');

    const { issues, rulesVersion } = (await deps.preSendChecks?.(p.id, actor)) ?? {
      issues: [],
      rulesVersion: null,
    };
    const blocking = issues.filter((i) => i.severity === 'block');
    if (blocking.length > 0) {
      throw new HttpError(422, blocking.map((i) => `${i.ruleId}: ${i.message}`).join('\n'));
    }

    // Passaggio atomico a «in invio»: se due richieste arrivano insieme, ne passa una sola.
    const claimed = await withActor(db, actor.userId, (tx) =>
      tx
        .update(prescription)
        .set({ status: 'sending', signedBy: actor.userId, signedAt: now(), updatedAt: now() })
        .where(and(eq(prescription.id, p.id), eq(prescription.status, p.status)))
        .returning({ id: prescription.id }),
    );
    if (claimed.length === 0)
      throw new HttpError(409, 'La ricetta è cambiata nel frattempo: ricarica');

    const message = await buildMessage(p, actor);
    const system = systemFor(p.kind);
    const gateway = deps.gateways[system];
    const started = Date.now();
    let result: SendResult;
    try {
      result = await gateway.send(message);
    } catch (err) {
      // Un errore imprevisto dell'adattatore: non si sa se la ricetta è arrivata.
      result = { outcome: 'timeout', message: `Errore dell'adattatore: ${String(err)}` };
    }
    const errorKind: SendErrorKind | null =
      result.outcome === 'accepted'
        ? null
        : result.outcome === 'rejected'
          ? 'rejected'
          : result.outcome;

    await withActor(db, actor.userId, async (tx) => {
      await tx.insert(externalSubmission).values({
        system,
        environment: gateway.environment,
        operation: 'invio',
        prescriptionId: p.id,
        userId: actor.userId,
        request: message,
        response: 'raw' in result ? result.raw : null,
        outcome: result.outcome,
        errorCode: result.outcome === 'rejected' ? result.code : null,
        errorMessage: result.outcome === 'accepted' ? null : result.message,
        durationMs: Date.now() - started,
      });
      await tx
        .update(prescription)
        .set(
          result.outcome === 'accepted'
            ? {
                status: 'sent',
                nre: result.nre,
                sentAt: now(),
                lastErrorKind: null,
                lastErrorCode: null,
                lastErrorMessage: null,
                rulesVersion,
                updatedAt: now(),
              }
            : {
                status: 'error',
                lastErrorKind: errorKind,
                lastErrorCode: result.outcome === 'rejected' ? result.code : null,
                lastErrorMessage: result.message,
                updatedAt: now(),
              },
        )
        .where(eq(prescription.id, p.id));
    });
    return { outcome: result.outcome, nre: result.outcome === 'accepted' ? result.nre : null };
  }

  /** Annullamento: prima dell'invio è locale; dopo passa dal SAR, nei casi ammessi. */
  async function cancel(actor: Actor, id: string, body: unknown) {
    const p = await load(id, actor.studioId);
    if (p.status !== 'sent') {
      await guardPrepare(actor, p, 'ricetta_annullamento');
      const reason = cancelSchema.parse(body).motivo;
      const to = check(p, 'cancel');
      await setStatus(actor, p, to, {
        cancelledAt: now(),
        cancelledBy: actor.userId,
        cancelReason: reason,
      });
      return { outcome: 'accepted' as const };
    }
    await guardPatient(db, actor, p.patientId, 'prescription.sign_send', 'ricetta_annullamento');
    const reason = cancelSchema.parse(body).motivo;
    const to = check(p, 'cancel');
    const system = systemFor(p.kind);
    const gateway = deps.gateways[system];
    const doctor = await doctorInfo(actor.userId);
    const request = { nre: p.nre!, reason, doctor };
    const started = Date.now();
    const result = await gateway.cancel(request);
    await withActor(db, actor.userId, async (tx) => {
      await tx.insert(externalSubmission).values({
        system,
        environment: gateway.environment,
        operation: 'annullamento',
        prescriptionId: p.id,
        userId: actor.userId,
        request,
        response: 'raw' in result ? result.raw : null,
        outcome: result.outcome,
        errorCode: result.outcome === 'rejected' ? result.code : null,
        errorMessage: result.outcome === 'accepted' ? null : result.message,
        durationMs: Date.now() - started,
      });
      if (result.outcome === 'accepted') {
        await tx
          .update(prescription)
          .set({
            status: to,
            cancelledAt: now(),
            cancelledBy: actor.userId,
            cancelReason: reason,
            updatedAt: now(),
          })
          .where(and(eq(prescription.id, p.id), eq(prescription.status, 'sent')));
      }
    });
    if (result.outcome !== 'accepted') {
      throw new HttpError(result.outcome === 'rejected' ? 409 : 503, result.message);
    }
    return { outcome: 'accepted' as const };
  }

  /**
   * Ripiego sulla ricetta rossa: quando SAR o Sistema TS non rispondono. Restituisce i dati da
   * stampare; il modulo di stampa conforme alle specifiche è da completare.
   */
  async function printPaper(actor: Actor, id: string) {
    const p = await load(id, actor.studioId);
    await guardPatient(db, actor, p.patientId, 'prescription.sign_send', 'ricetta_cartacea');
    const to = check(p, 'print_paper');
    await setStatus(actor, p, to, {
      paperPrintedAt: now(),
      paperPrintedBy: actor.userId,
      signedBy: actor.userId,
      signedAt: now(),
    });
    return {
      stampa: await buildMessage(p, actor),
      avviso: 'Modulo di stampa conforme: da completare',
    };
  }

  /** Coda «da firmare» del medico, raggruppata per paziente. */
  async function toSignQueue(actor: Actor) {
    return queue(actor, 'to_sign');
  }

  /** «Invii non riusciti»: ricette in errore, con il motivo. */
  async function failedQueue(actor: Actor) {
    return queue(actor, 'error');
  }

  async function queue(actor: Actor, status: PrescriptionStatus) {
    const archives = await visibleArchives(db, actor, 'prescription.sign_send');
    if (archives.length === 0) return [];
    const rows = await db
      .select({
        id: prescription.id,
        patientId: patient.id,
        nome: patient.firstName,
        cognome: patient.lastName,
        codiceFiscale: patient.fiscalCode,
        tipo: prescription.kind,
        preparataIl: prescription.preparedAt,
        preparataDa: appUser.displayName,
        errore: prescription.lastErrorMessage,
        tipoErrore: prescription.lastErrorKind,
        righe: sql<number>`(select count(*)::int from prescription_line l where l.prescription_id = ${prescription.id})`,
      })
      .from(prescription)
      .innerJoin(patient, eq(patient.id, prescription.patientId))
      .innerJoin(appUser, eq(appUser.id, prescription.preparedBy))
      .where(and(inArray(prescription.archiveId, archives), eq(prescription.status, status)))
      .orderBy(patient.lastName, patient.firstName, prescription.preparedAt);
    const groups = new Map<
      string,
      {
        paziente: { id: string; nome: string; cognome: string; codiceFiscale: string };
        ricette: unknown[];
      }
    >();
    for (const r of rows) {
      const g = groups.get(r.patientId) ?? {
        paziente: {
          id: r.patientId,
          nome: r.nome,
          cognome: r.cognome,
          codiceFiscale: r.codiceFiscale,
        },
        ricette: [],
      };
      g.ricette.push({
        id: r.id,
        tipo: r.tipo,
        preparataIl: r.preparataIl,
        preparataDa: r.preparataDa,
        righe: r.righe,
        errore: r.errore,
        tipoErrore: r.tipoErrore,
      });
      groups.set(r.patientId, g);
    }
    return [...groups.values()];
  }

  /** Ricette di un paziente, con le righe. */
  async function listForPatient(actor: Actor, patientId: string) {
    const { context } = await guardPatient(db, actor, patientId, 'therapy.read', 'lettura_ricette');
    const reservedAllowed = can(actor, 'reserved.read', { ...context, now: now() }).allowed;
    const rows = await db
      .select()
      .from(prescription)
      .where(eq(prescription.patientId, patientId))
      .orderBy(sql`${prescription.preparedAt} desc`);
    const lines = rows.length
      ? await db
          .select()
          .from(prescriptionLine)
          .where(
            inArray(
              prescriptionLine.prescriptionId,
              rows.map((r) => r.id),
            ),
          )
          .orderBy(asc(prescriptionLine.position))
      : [];
    const reservedTherapies = reservedAllowed
      ? new Set<string>()
      : new Set(
          (
            await db
              .select({ id: therapy.id })
              .from(therapy)
              .where(and(eq(therapy.patientId, patientId), eq(therapy.reserved, true)))
          ).map((t) => t.id),
        );
    return rows
      .map((r) => ({ ...r, righe: lines.filter((l) => l.prescriptionId === r.id) }))
      .filter((r) => !r.righe.some((l) => l.therapyId && reservedTherapies.has(l.therapyId)));
  }

  return {
    createDraft,
    prepareRepeat,
    submitForSigning,
    backToDraft,
    signAndSend,
    cancel,
    printPaper,
    toSignQueue,
    failedQueue,
    listForPatient,
    load,
  };
}

export type PrescriptionService = ReturnType<typeof createPrescriptionService>;
