import {
  can,
  cancellableState,
  DISPENSING_STATE_LABELS,
  transition,
  type PrescriptionEvent,
  type PrescriptionKind,
  type PrescriptionStatus,
  type SendErrorKind,
  type ServiceUse,
} from '@mmg/domain';
import type {
  AuthProblem,
  GatewaySystem,
  PrescriptionGateway,
  PrescriptionMessage,
  SendResult,
  ServiceAuth,
  StatusResult,
} from '@mmg/integrations';
import { systemFor } from '@mmg/integrations';
import { basePackLimit } from '@mmg/rules';
import { createHash } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { secondsText, studioSendTimeoutMs } from '../admin/studio-service';
import type { AccessAction } from '../audit/access-log';
import type { Actor } from '../auth/service';
import type { Database } from '../db/client';
import {
  appUser,
  doctorProfile,
  externalSubmission,
  prescriptionCheck,
  patient,
  prescription,
  prescriptionDocument,
  prescriptionLine,
  studio,
  therapy,
} from '../db/schema';
import { withActor } from '../db/tx';
import { HttpError } from '../http/errors';
import { guardPatient, loadArchiveContext, visibleArchives } from '../patients/access';
import { buildPromemoriaData } from '../reminders/promemoria';
import type { createCredentialService } from '../credentials/service';
import { studioDate } from './rules-check';
import { cancelSchema, draftSchema, repeatSchema } from './schemas';

export interface LineInput {
  therapyId?: string | null;
  drugAic?: string | null;
  drugName?: string | null;
  activeIngredient?: string | null;
  serviceCode?: string | null;
  serviceNationalCode?: string | null;
  serviceDescription?: string | null;
  quantity: number;
  aifaNote?: string | null;
  byActiveIngredient?: boolean;
  notSubstitutable?: boolean;
  notSubstitutableReason?: string | null;
  posologyText?: string | null;
  repeatCount?: number | null;
  validityMonths?: number | null;
}

export interface DraftInput {
  kind: PrescriptionKind;
  priority?: 'U' | 'B' | 'D' | 'P' | null;
  accessType?: 'first' | 'subsequent' | null;
  diagnosticQuestion?: string | null;
  exemptionCode?: string | null;
  requestId?: string | null;
  reminderChannel?: 'paper' | 'email' | 'pec' | 'sms' | 'messaging_app' | 'phone' | 'fse' | null;
  reminderContact?: string | null;
  obscured?: boolean;
  lines: LineInput[];
}

/** Problema trovato dai controlli prima dell'invio (le regole di prescrizione, tappa 4). */
export interface PreSendIssue {
  ruleId: string;
  /** block: ferma l'invio; warn: lo ferma finché non c'è un motivo; info: solo informazione. */
  severity: 'block' | 'warn' | 'info';
  message: string;
  lineId?: string;
  needs?: 'reason' | 'aifa_confirmation';
  source?: string;
  remedy?: string;
}

/** Ciò che il medico aggiunge al momento della firma: motivi per gli avvisi, note confermate. */
export interface SignInput {
  reasons: Record<string, string>;
  confirmedAifaNotes: string[];
}

export interface CheckOutcome {
  rulesVersion: string | null;
  issues: PreSendIssue[];
  reasonsUsed?: Record<string, string>;
  confirmedAifaNotes?: string[];
}

const signSchema = z
  .object({
    motivi: z.record(z.string(), z.string().trim().max(500)).optional(),
    confermeNote: z.array(z.uuid()).optional(),
  })
  .strict();

function parseSignInput(body: unknown): SignInput {
  const parsed = signSchema.parse(body ?? {});
  return { reasons: parsed.motivi ?? {}, confirmedAifaNotes: parsed.confermeNote ?? [] };
}

export interface PrescriptionDeps {
  db: Database;
  gateways: Record<GatewaySystem, PrescriptionGateway>;
  /**
   * Credenziali e secondo fattore del medico che firma (D100–D102): si prendono prima di ogni
   * chiamata e non entrano nei messaggi conservati.
   */
  credentials: Pick<ReturnType<typeof createCredentialService>, 'authFor' | 'authRefused'>;
  now?: () => Date;
  /**
   * Controlli prima dell'invio (regole di prescrizione, tappa 4): problemi trovati e versione
   * delle regole usata. Per difetto nessun controllo e nessuna versione.
   */
  preSendChecks?: (prescriptionId: string, actor: Actor, input: SignInput) => Promise<CheckOutcome>;
  /**
   * Tempo massimo di attesa della risposta all'invio, in millisecondi. Regione Piemonte (SIRPE,
   * «Cartelle cliniche MMG e PLS», 4.4.7): la cartella clinica ha un parametro per il tempo tra la
   * richiesta di stampa e la stampa, «al momento definiti in 6-8 secondi»; senza codice di
   * autenticazione in quel tempo si passa alla ricetta cartacea. Per difetto vale l'impostazione
   * dello studio, letta a ogni invio (`studio.sendTimeoutSeconds`, 8 secondi per difetto, D94); un
   * valore dato qui (lo usano le prove) vale sopra quello dello studio.
   */
  sendTimeoutMs?: number;
  /**
   * Catalogo regionale delle prestazioni in uso alla data (D154): dà il codice del nomenclatore
   * delle righe che hanno solo quello del catalogo. Per difetto nessun catalogo.
   */
  serviceCatalog?: (
    date: string,
  ) => Promise<((code: string) => { nationalCode: string | null } | null) | undefined>;
  /** Come si fissano i dati del promemoria all'invio: le prove ci mettono un guasto (D232). */
  buildPromemoria?: typeof buildPromemoriaData;
}

/** Quali credenziali usa ogni tipo di ricetta: RUPAR per il SAR, Sistema TS per la bianca. */
const useFor = (kind: PrescriptionMessage['kind']): ServiceUse =>
  kind === 'white' ? 'ricetta_bianca' : 'ricetta_ssn';

/** Messaggio per un rifiuto di accesso: la ricetta è giusta, l'accesso no. */
const authMessage = (problem: AuthProblem, message: string) =>
  problem === 'session'
    ? `${message}. Chiedi un nuovo codice di sessione in «Credenziali dei servizi» e rimanda.`
    : `${message}. Controlla utente, password e PIN in «Credenziali dei servizi» e rimanda.`;

type PrescriptionRow = typeof prescription.$inferSelect;

/**
 * Codice del nomenclatore di una riga di specialistica: quello scritto sulla riga, altrimenti
 * quello della voce del catalogo in uso (D154). Null se non si sa: allora R10 ferma l'invio.
 */
function nationalCodeOf(
  l: { serviceCode?: string | null; serviceNationalCode?: string | null },
  catalog: ((code: string) => { nationalCode: string | null } | null) | undefined,
): string | null {
  const written = l.serviceNationalCode?.trim();
  if (written) return written;
  return l.serviceCode ? (catalog?.(l.serviceCode)?.nationalCode ?? null) : null;
}

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
    // Le righe di specialistica conservano anche il codice del nomenclatore (D154).
    const catalog =
      input.kind === 'specialist_ssn' ? await deps.serviceCatalog?.(studioDate(now())) : undefined;
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
          reminderChannel: input.reminderChannel ?? null,
          reminderContact: input.reminderContact ?? null,
          obscured: input.obscured ?? false,
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
          serviceNationalCode: nationalCodeOf(l, catalog),
          serviceDescription: l.serviceDescription ?? null,
          quantity: l.quantity,
          aifaNote: l.aifaNote ?? null,
          byActiveIngredient: l.byActiveIngredient ?? false,
          notSubstitutable: l.notSubstitutable ?? false,
          notSubstitutableReason: l.notSubstitutableReason ?? null,
          posologyText: l.posologyText ?? null,
          repeatCount: l.repeatCount ?? null,
          validityMonths: l.validityMonths ?? null,
        })),
      );
      return p!.id;
    });
  }

  /**
   * Per un paziente deceduto la ricetta non si prepara (D199): né la bozza, né la ripetizione. Una
   * bozza fatta prima la ferma R19, ai controlli prima dell'invio.
   */
  function assertNotDeceased(p: { status: string; deceasedOn: string | null }) {
    if (p.status !== 'deceased') return;
    throw new HttpError(
      409,
      p.deceasedOn
        ? `Il paziente risulta deceduto il ${p.deceasedOn.split('-').reverse().join('/')}: la ricetta non si fa`
        : 'Il paziente risulta deceduto: la ricetta non si fa',
    );
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
    assertNotDeceased(p);
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
    assertNotDeceased(p);
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
    // Ripetizioni raggruppate (scelta della seconda fermata, D37): più terapie nella stessa
    // ricetta, se hanno lo stesso tipo di ricetta e la stessa esenzione, senza superare il
    // limite di confezioni di R2 in vigore oggi. Una terapia che da sola lo supera va in una
    // ricetta sua, e le regole decideranno (R4).
    const limit = basePackLimit(studioDate(now()));
    const ordered = [...rows].sort((a, b) => therapyIds.indexOf(a.id) - therapyIds.indexOf(b.id));
    const groups: { key: string; therapies: typeof rows; packs: number }[] = [];
    for (const t of ordered) {
      const key = `${t.notReimbursable ? 'white' : 'pharma_ssn'}|${t.habitualExemptionCode ?? ''}`;
      const open = groups.find(
        (g) => g.key === key && limit !== null && g.packs + t.packsPerPrescription <= limit,
      );
      if (open) {
        open.therapies.push(t);
        open.packs += t.packsPerPrescription;
      } else {
        groups.push({ key, therapies: [t], packs: t.packsPerPrescription });
      }
    }
    const created: string[] = [];
    for (const g of groups) {
      const first = g.therapies[0]!;
      created.push(
        await insertDraft(
          actor,
          patientId,
          p.archiveId,
          {
            kind: first.notReimbursable ? 'white' : 'pharma_ssn',
            exemptionCode: first.habitualExemptionCode,
            lines: g.therapies.map((t) => ({
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
            })),
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
    const catalog =
      p.kind === 'specialist_ssn' ? await deps.serviceCatalog?.(studioDate(now())) : undefined;
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
      obscured: p.obscured,
      lines: lines.map((l) => ({
        drugAic: l.drugAic,
        drugName: l.drugName,
        activeIngredient: l.activeIngredient,
        serviceCode: l.serviceCode,
        serviceNationalCode: nationalCodeOf(l, catalog),
        serviceDescription: l.serviceDescription,
        quantity: l.quantity,
        aifaNote: l.aifaNote,
        notSubstitutable: l.notSubstitutable,
        notSubstitutableReason: l.notSubstitutableReason,
        repeatCount: l.repeatCount,
        validityMonths: l.validityMonths,
      })),
      compiledAt: studioDate(now()),
    };
  }

  async function runChecks(p: PrescriptionRow, actor: Actor, input: SignInput) {
    const outcome = (await deps.preSendChecks?.(p.id, actor, input)) ?? {
      rulesVersion: null,
      issues: [],
    };
    const blocking = outcome.issues.filter((i) => i.severity === 'block' || i.severity === 'warn');
    return { ...outcome, blocking };
  }

  /** Controllo senza invio: i problemi si vedono prima, non dopo un rifiuto. */
  async function checkOnly(actor: Actor, id: string, body: unknown) {
    const p = await load(id, actor.studioId);
    await guardPrepare(actor, p, 'ricetta_controllo');
    const r = await runChecks(p, actor, parseSignInput(body));
    return { versioneRegole: r.rulesVersion, problemi: r.issues, bloccanti: r.blocking.length };
  }

  /** Il medico firma e invia: al SAR (SSN) o al Sistema TS (bianca). */
  async function signAndSend(actor: Actor, id: string, body?: unknown) {
    const p = await load(id, actor.studioId);
    await guardPatient(db, actor, p.patientId, 'prescription.sign_send', 'ricetta_firma_invio');
    const input = parseSignInput(body);
    check(p, 'start_sending');

    const checked = await runChecks(p, actor, input);
    const { rulesVersion, issues, blocking } = checked;
    if (rulesVersion !== null) {
      // Ogni controllo prima di un invio resta registrato, superato o no.
      await db.insert(prescriptionCheck).values({
        prescriptionId: p.id,
        userId: actor.userId,
        rulesVersion,
        outcome: blocking.length > 0 ? 'bloccato' : 'superato',
        issues,
        reasons: checked.reasonsUsed ?? {},
        confirmedAifaNotes: checked.confirmedAifaNotes ?? [],
      });
    }
    if (blocking.length > 0) {
      throw new HttpError(
        422,
        blocking
          .map((i) => `${i.ruleId}: ${i.message}${i.remedy ? ` — ${i.remedy}` : ''}`)
          .join('\n'),
        {
          versioneRegole: rulesVersion,
          problemi: issues,
        },
      );
    }

    await ensurePromemoriaPossible(p, actor);
    // Credenziali e codice di sessione di chi firma: se mancano ci si ferma qui, senza invio.
    const use = useFor(p.kind);
    const auth = await deps.credentials.authFor(actor.userId, use);

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
    // Il tempo di attesa dello studio, com'è adesso: l'amministratore può averlo appena cambiato.
    const timeoutMs = deps.sendTimeoutMs ?? (await studioSendTimeoutMs(db, actor.studioId));
    const started = Date.now();
    let result: SendResult;
    let timer: NodeJS.Timeout | undefined;
    try {
      result = await Promise.race([
        gateway.send(message, auth),
        new Promise<SendResult>((ok) => {
          timer = setTimeout(
            () =>
              ok({
                outcome: 'timeout',
                message: `Nessuna risposta entro ${secondsText(timeoutMs)}: non si sa se la ricetta è arrivata`,
              }),
            timeoutMs,
          );
        }),
      ]);
    } catch (err) {
      // Un errore imprevisto dell'adattatore: non si sa se la ricetta è arrivata.
      result = { outcome: 'timeout', message: `Errore dell'adattatore: ${String(err)}` };
    } finally {
      clearTimeout(timer);
    }
    // Ricetta SSN accettata senza codice di autenticazione: non è valida e il promemoria non si dà
    // (specifiche del Sistema TS, prescrizione, 5/12/2024). Si tratta come un rifiuto.
    const ssn = p.kind === 'pharma_ssn' || p.kind === 'specialist_ssn';
    if (result.outcome === 'accepted' && ssn && !result.authCode) {
      result = {
        outcome: 'rejected',
        code: 'SENZA_CODICE_AUTENTICAZIONE',
        message:
          'Il sistema ha risposto senza codice di autenticazione: la ricetta non è valida e il promemoria non si può dare. Rimandala; se non arriva, usa la ricetta rossa.',
        raw: result.raw,
      };
    }
    const authProblem = result.outcome === 'rejected' ? (result.authProblem ?? null) : null;
    if (result.outcome === 'rejected' && authProblem) {
      await deps.credentials.authRefused(
        actor,
        use,
        authProblem,
        `${result.code}: ${result.message}`,
      );
      result = { ...result, message: authMessage(authProblem, result.message) };
    }
    const errorKind: SendErrorKind | null =
      result.outcome === 'accepted'
        ? null
        : authProblem
          ? 'auth'
          : result.outcome === 'rejected'
            ? 'rejected'
            : result.outcome;
    // Dati del promemoria fissati ora, con il codice di autenticazione: ogni ristampa è identica.
    // Se non si riesce a fissarli, la ricetta è comunque partita: NRE e codice si scrivono lo
    // stesso, invece di lasciarla «in invio» senza numero; manca solo il promemoria (D232).
    const accepted = result.outcome === 'accepted' ? result : null;
    let promemoria: Awaited<ReturnType<typeof buildPromemoriaData>> | null = null;
    let promemoriaMissing = false;
    if (accepted && ssn) {
      try {
        promemoria = await (deps.buildPromemoria ?? buildPromemoriaData)(
          db,
          p.id,
          {
            nre: accepted.nre,
            authCode: accepted.authCode!,
            sacDoctorName: accepted.doctorName ?? null,
            compiledAt: message.compiledAt,
            messages: accepted.messages ?? null,
          },
          message.lines,
        );
      } catch {
        promemoriaMissing = true;
      }
    }

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
                authCode: result.authCode ?? null,
                sacDoctorName: result.doctorName ?? null,
                pinNrbe: result.pinNrbe ?? null,
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
      if (promemoria) {
        const content = JSON.stringify(promemoria);
        await tx.insert(prescriptionDocument).values({
          prescriptionId: p.id,
          kind: 'promemoria_dati',
          mediaType: 'application/json',
          content,
          sha256: createHash('sha256').update(content).digest('hex'),
        });
      }
      if (accepted?.reminderPdf) {
        // Ricetta bianca: il PDF del SAC si conserva così com'è; è l'unico che si consegna.
        await tx.insert(prescriptionDocument).values({
          prescriptionId: p.id,
          kind: 'promemoria_sac',
          mediaType: 'application/pdf',
          content: Buffer.from(accepted.reminderPdf).toString('base64'),
          sha256: createHash('sha256').update(accepted.reminderPdf).digest('hex'),
        });
      }
    });
    return {
      outcome: errorKind === 'auth' ? ('auth' as const) : result.outcome,
      nre: result.outcome === 'accepted' ? result.nre : null,
      messaggio:
        result.outcome === 'accepted'
          ? promemoriaMissing
            ? `Ricetta partita, NRE ${result.nre}: i dati del promemoria non si sono potuti fissare, quindi il promemoria non si stampa. Al paziente bastano il numero di ricetta e il codice fiscale.`
            : null
          : result.message,
    };
  }

  /**
   * Prima di inviare una ricetta SSN: il promemoria si deve poter fare (regione dello studio,
   * codice fiscale del medico). Meglio fermarsi prima che avere una ricetta accettata senza
   * promemoria.
   */
  async function ensurePromemoriaPossible(p: PrescriptionRow, actor: Actor) {
    if (p.kind !== 'pharma_ssn' && p.kind !== 'specialist_ssn') return;
    const [row] = await db
      .select({ region: studio.regionName, fiscalCode: doctorProfile.fiscalCode })
      .from(appUser)
      .innerJoin(studio, eq(studio.id, appUser.studioId))
      .leftJoin(doctorProfile, eq(doctorProfile.userId, appUser.id))
      .where(eq(appUser.id, actor.userId));
    if (!row?.region)
      throw new HttpError(
        409,
        'Manca la regione dello studio: serve per l’intestazione del promemoria (DM 2/11/2011, campo 1). Nessun invio fatto.',
      );
    if (!row.fiscalCode)
      throw new HttpError(
        409,
        'Manca il codice fiscale del medico nel profilo: va sul promemoria (DM 2/11/2011, campo 20). Nessun invio fatto.',
      );
  }

  /**
   * Chiede all'ente lo stato di erogazione (D70) e lo registra: la chiamata nel registro degli
   * invii, l'ultimo stato noto nella ricetta.
   */
  async function askDispensing(
    actor: Actor,
    p: PrescriptionRow,
    doctor: PrescriptionMessage['doctor'],
    auth: ServiceAuth,
  ): Promise<StatusResult> {
    const system = systemFor(p.kind);
    const gateway = deps.gateways[system];
    const request = { nre: p.nre!, doctor };
    const started = Date.now();
    let result: StatusResult;
    try {
      result = await gateway.status(request, auth);
    } catch (err) {
      result = { outcome: 'timeout', message: `Errore dell'adattatore: ${String(err)}` };
    }
    if (result.outcome === 'rejected' && result.authProblem)
      await deps.credentials.authRefused(
        actor,
        useFor(p.kind),
        result.authProblem,
        `${result.code}: ${result.message}`,
      );
    await withActor(db, actor.userId, async (tx) => {
      await tx.insert(externalSubmission).values({
        system,
        environment: gateway.environment,
        operation: 'stato',
        prescriptionId: p.id,
        userId: actor.userId,
        request,
        response: 'raw' in result ? result.raw : null,
        outcome: result.outcome,
        errorCode: result.outcome === 'rejected' ? result.code : null,
        errorMessage: result.outcome === 'ok' ? null : result.message,
        durationMs: Date.now() - started,
      });
      if (result.outcome === 'ok') {
        await tx
          .update(prescription)
          .set({ dispensingState: result.state, dispensingCheckedAt: now(), updatedAt: now() })
          .where(eq(prescription.id, p.id));
      }
    });
    return result;
  }

  /**
   * Stato di erogazione e possibilità di annullare, prima di proporre l'annullamento (D70).
   * Una ricetta non ancora inviata si annulla nel prodotto, secondo il suo ciclo.
   */
  async function dispensingStatus(actor: Actor, id: string) {
    const p = await load(id, actor.studioId);
    await guardPatient(db, actor, p.patientId, 'therapy.read', 'ricetta_stato');
    if (p.status !== 'sent') {
      const r = transition(p.status, 'cancel', { lastErrorKind: p.lastErrorKind });
      return {
        inviata: false,
        stato: null,
        etichetta: null,
        annullabile: r.ok,
        motivo: r.ok ? null : r.reason,
        controllataIl: null,
      };
    }
    let auth: ServiceAuth;
    try {
      auth = await deps.credentials.authFor(actor.userId, useFor(p.kind));
    } catch (err) {
      // Senza credenziali o codice di sessione (per esempio la segreteria) lo stato non si chiede.
      if (!(err instanceof HttpError)) throw err;
      return {
        inviata: true,
        stato: null,
        etichetta: null,
        annullabile: null,
        motivo: `Stato non disponibile: ${err.message}`,
        controllataIl: null,
      };
    }
    const result = await askDispensing(actor, p, await doctorInfo(actor.userId), auth);
    if (result.outcome !== 'ok') {
      // Lo stato non si sa: all'annullamento deciderà comunque l'ente.
      return {
        inviata: true,
        stato: null,
        etichetta: null,
        annullabile: null,
        motivo: `Stato non disponibile (${result.message}): se si chiede l'annullamento, decide l'ente`,
        controllataIl: null,
      };
    }
    const c = cancellableState(result.state);
    return {
      inviata: true,
      stato: result.state,
      etichetta: DISPENSING_STATE_LABELS[result.state],
      annullabile: c.ok,
      motivo: c.ok ? null : c.reason,
      controllataIl: now().toISOString(),
    };
  }

  /**
   * Annullamento: prima dell'invio è locale; dopo si chiede all'ente lo stato e, se l'ha già
   * lavorata (presa in carico, prenotata, erogata), non si annulla (D70). La ricetta resta sempre
   * nello storico: l'annullamento cambia solo lo stato.
   */
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
    const use = useFor(p.kind);
    const auth = await deps.credentials.authFor(actor.userId, use);
    // Prima lo stato: se l'ente ha già lavorato la ricetta non si chiede nemmeno l'annullamento.
    const status = await askDispensing(actor, p, doctor, auth);
    if (status.outcome === 'ok') {
      const c = cancellableState(status.state);
      if (!c.ok) throw new HttpError(409, c.reason);
    }
    const request = { nre: p.nre!, reason, doctor };
    const started = Date.now();
    const result = await gateway.cancel(request, auth);
    if (result.outcome === 'rejected' && result.authProblem)
      await deps.credentials.authRefused(
        actor,
        use,
        result.authProblem,
        `${result.code}: ${result.message}`,
      );
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
    if (result.outcome === 'rejected' && result.authProblem)
      throw new HttpError(422, authMessage(result.authProblem, result.message), {
        codice: result.authProblem === 'session' ? 'SESSIONE_SCADUTA' : 'CREDENZIALI_RIFIUTATE',
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
    checkOnly,
    cancel,
    printPaper,
    toSignQueue,
    failedQueue,
    listForPatient,
    dispensingStatus,
    load,
  };
}

export type PrescriptionService = ReturnType<typeof createPrescriptionService>;
