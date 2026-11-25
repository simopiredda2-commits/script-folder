import {
  can,
  cancellableState,
  DISPENSING_STATE_LABELS,
  INTERRUPTED_SEND_AFTER_MINUTES,
  normalizePrescriptionNumber,
  nrbeProblem,
  nreProblem,
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
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
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
import {
  buildPromemoriaData,
  promemoriaPatientOf,
  type PromemoriaPatient,
} from '../reminders/promemoria';
import type { createCredentialService } from '../credentials/service';
import { studioDate } from './rules-check';
import type { NreLots } from './nre-lots';
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

/**
 * Esito di un invio rimasto senza risposta (D233), come lo dice l'ente al medico. Il numero si
 * scrive senza spazi e in maiuscolo, come lo vuole il codice a barre del promemoria (D239); la sua
 * forma (NRE di 15 caratteri, NRBE di 12) si controlla poi secondo il tipo di ricetta, con le
 * specifiche del Sistema TS (`nreProblem`, `nrbeProblem`, audit D259). Per la ricetta SSN serve
 * anche il codice di autenticazione: senza, la ricetta non è valida (specifiche del Sistema TS,
 * D240). Per la ricetta bianca il Sistema TS dà NRBE e PIN (D239). Codice e PIN non hanno un
 * formato nelle specifiche lette: lettere e cifre, da completare (D259).
 */
const settleSchema = z.discriminatedUnion('esito', [
  z.object({ esito: z.literal('non_arrivata') }).strict(),
  z
    .object({
      esito: z.literal('arrivata'),
      nre: z
        .string()
        .transform(normalizePrescriptionNumber)
        .pipe(
          z
            .string()
            .regex(/^[A-Z0-9]{1,30}$/, 'Il numero di ricetta ha solo lettere e cifre, al più 30'),
        ),
      codiceAutenticazione: z
        .string()
        .trim()
        .regex(
          /^[A-Za-z0-9]{1,64}$/,
          'Il codice di autenticazione ha solo lettere e cifre, al più 64',
        )
        .nullish(),
      pin: z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9]{1,20}$/, 'Il PIN ha solo lettere e cifre, al più 20')
        .nullish(),
    })
    .strict(),
]);

/** L'invio fotografato alla firma (D239): messaggio mandato e paziente per il promemoria. */
interface SendingSnapshot {
  message: PrescriptionMessage;
  paziente: PromemoriaPatient;
}

/** Ambiente degli esiti segnati a mano dal medico, nel registro degli invii (D233). */
export const MANUAL_ENVIRONMENT = 'manuale';

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
   * Tempo massimo di attesa della risposta all'invio, in millisecondi. Regione Piemonte (SIRPED,
   * «Cartelle cliniche MMG e PLS», V06 del 10/04/2026, 3.5.2 e 4.3.1): la cartella clinica ha un
   * parametro per il tempo tra la richiesta di stampa e la stampa, «al momento definiti in 8
   * secondi»; senza codice di autenticazione in quel tempo si passa alla ricetta cartacea. Per difetto vale l'impostazione
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
  /**
   * Lotti di NRE del medico (D269): con questi la cartella numera le ricette che vanno al SAR.
   * Senza, l'NRE lo dà il servizio che riceve la ricetta, come i simulatori di prima.
   */
  nreLots?: NreLots;
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
      // Il paziente resta fermo fino alla fine (D239): «Sposta» insieme a una ricetta nuova aspetta
      // e la trova aperta; oppure la ricetta trova lo spostamento già fatto e si ferma.
      const [locked] = await tx
        .select({ archiveId: patient.archiveId })
        .from(patient)
        .where(eq(patient.id, patientId))
        .for('share');
      if (locked?.archiveId !== archiveId)
        throw new HttpError(
          409,
          'Il paziente è passato a un altro archivio nel frattempo: ricarica la pagina',
        );
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

  /**
   * Una ricetta nuova (bozza). Il medico la prepara come vuole; la segreteria solo come ripetizione
   * di terapie croniche (requisiti, «Ruoli»), anche dalla «Nuova ricetta» (audit, D259). Il corpo si
   * valida dopo la guardia.
   */
  async function createDraft(actor: Actor, patientId: string, body: unknown) {
    const [row] = await db
      .select({ archiveId: patient.archiveId })
      .from(patient)
      .where(and(eq(patient.id, patientId), eq(patient.studioId, actor.studioId)));
    const doctor =
      !row ||
      can(actor, 'prescription.draft', {
        ...(await loadArchiveContext(db, row.archiveId)),
        now: now(),
      }).allowed;
    if (!doctor) return createRepeatDraft(actor, patientId, body);
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
   * La bozza della segreteria dalla «Nuova ricetta» (D259): ogni riga è una terapia cronica in
   * corso del paziente, non riservata, come in «Ripeti le terapie scelte». Della riga contano la
   * terapia e le confezioni; farmaco, nota AIFA e posologia vengono dalla scheda della terapia,
   * non da ciò che manda il browser. Le regole (R2–R4) controllano le confezioni prima della firma.
   */
  async function createRepeatDraft(actor: Actor, patientId: string, body: unknown) {
    const { patient: p, context } = await guardPatient(
      db,
      actor,
      patientId,
      'prescription.draft_repeat',
      'ricetta_ripetizione',
      { therapyKind: 'chronic' },
    );
    assertNotDeceased(p);
    const input = draftSchema.parse(body);
    if (input.kind === 'specialist_ssn')
      // Registrata come richiesta negata: la ricetta specialistica la prepara il medico.
      await guardPatient(db, actor, patientId, 'prescription.draft', 'ricetta_bozza');
    const ids = input.lines.map((l) => l.therapyId);
    if (ids.some((id) => !id))
      throw new HttpError(
        403,
        'La segreteria prepara solo le ripetizioni delle terapie croniche in corso: si aggiungono dai farmaci prescritti',
      );
    const rows = await db
      .select()
      .from(therapy)
      .where(and(eq(therapy.patientId, patientId), inArray(therapy.id, ids as string[])));
    const byId = new Map(rows.map((t) => [t.id, t]));
    const lines = [];
    for (const l of input.lines) {
      const t = byId.get(l.therapyId!);
      if (!t) throw new HttpError(404, 'Terapia non trovata');
      const decision = can(actor, 'prescription.draft_repeat', {
        ...context,
        resource: { therapyKind: t.kind, reserved: t.reserved },
        now: now(),
      });
      if (!decision.allowed)
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
      if (t.status !== 'active') throw new HttpError(409, `Terapia non attiva: ${t.drugName}`);
      if ((input.kind === 'white') !== t.notReimbursable)
        throw new HttpError(
          400,
          `${t.drugName}: la terapia va in ricetta ${t.notReimbursable ? 'bianca' : 'SSN'}`,
        );
      lines.push({
        therapyId: t.id,
        drugAic: t.drugAic,
        drugName: t.drugName,
        activeIngredient: t.activeIngredient,
        quantity: l.quantity,
        aifaNote: t.aifaNote,
        byActiveIngredient: t.byActiveIngredient,
        notSubstitutable: t.notSubstitutable,
        notSubstitutableReason: t.notSubstitutableReason,
        posologyText: [t.dose, t.doseUnit, t.frequency].filter(Boolean).join(' ') || null,
      });
    }
    return insertDraft(actor, patientId, p.archiveId, { ...input, lines }, 'draft');
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
      .select({
        name: appUser.displayName,
        regionalCode: doctorProfile.regionalCode,
        fiscalCode: doctorProfile.fiscalCode,
      })
      .from(appUser)
      .leftJoin(doctorProfile, eq(doctorProfile.userId, appUser.id))
      .where(eq(appUser.id, userId));
    return {
      userId,
      name: d!.name,
      regionalCode: d!.regionalCode ?? null,
      fiscalCode: d!.fiscalCode ?? null,
    };
  }

  /**
   * Il messaggio della ricetta, a nome del medico `doctorUserId`: chi firma ora, oppure chi aveva
   * firmato l'invio rimasto senza risposta (D233), con la data di quell'invio.
   */
  async function buildMessage(
    p: PrescriptionRow,
    doctorUserId: string,
    compiledAt: string = studioDate(now()),
  ): Promise<PrescriptionMessage> {
    const [pt] = await db.select().from(patient).where(eq(patient.id, p.patientId));
    const catalog =
      p.kind === 'specialist_ssn' ? await deps.serviceCatalog?.(compiledAt) : undefined;
    const lines = await db
      .select()
      .from(prescriptionLine)
      .where(eq(prescriptionLine.prescriptionId, p.id))
      .orderBy(asc(prescriptionLine.position));
    return {
      localId: p.id,
      kind: p.kind,
      patientFiscalCode: pt!.fiscalCode,
      doctor: await doctorInfo(doctorUserId),
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
      compiledAt,
      // L'NRE preso dal lotto del medico alla prima firma, se c'è (D269).
      nre: p.assignedNre ?? null,
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
    const system = systemFor(p.kind);
    // Le ricette per il SAR hanno l'NRE dal lotto del medico (D269): alla prima firma se ne prende
    // uno; dopo un rifiuto si rimanda lo stesso (V06, 4.3.1, caso 3). Se i numeri sono pochi si
    // chiede prima il lotto successivo; senza numeri e senza lotto la ricetta non parte.
    const lots = system === 'sar' ? deps.nreLots : undefined;
    const lotNotice =
      lots && !p.assignedNre ? await lots.ensureNumbers(actor, p.id) : { warning: null };

    // Il messaggio e il paziente come partono: restano con la ricetta finché l'invio è in corso,
    // per l'esito segnato a mano se il servizio si ferma (D239).
    const built = await buildMessage(p, actor.userId);
    const [sendingPatient] = await db.select().from(patient).where(eq(patient.id, p.patientId));
    // Passaggio atomico a «in invio»: se due richieste arrivano insieme, ne passa una sola. L'ora
    // della firma segna questo invio: l'esito si scrive solo se è ancora lui (D233). L'NRE del
    // lotto si prende nella stessa transazione: se la ricetta è cambiata, il numero torna al lotto.
    const claimedAt = now();
    const message = await withActor(db, actor.userId, async (tx) => {
      let assigned = p.assignedNre ? { nre: p.assignedNre, lotId: p.nreLotId } : null;
      if (lots && !assigned) {
        assigned = await lots.take(tx, actor.userId);
        if (!assigned)
          throw new HttpError(
            409,
            'I numeri di ricetta (NRE) del medico sono finiti proprio adesso: riprova «Firma e invia», si chiede un lotto nuovo',
          );
      }
      const sent: PrescriptionMessage = lots ? { ...built, nre: assigned!.nre } : built;
      const snapshot: SendingSnapshot = {
        message: sent,
        paziente: promemoriaPatientOf(sendingPatient!),
      };
      const rows = await tx
        .update(prescription)
        .set({
          status: 'sending',
          signedBy: actor.userId,
          signedAt: claimedAt,
          sendingSnapshot: snapshot,
          ...(lots ? { assignedNre: assigned!.nre, nreLotId: assigned!.lotId } : {}),
          updatedAt: now(),
        })
        .where(and(eq(prescription.id, p.id), eq(prescription.status, p.status)))
        .returning({ id: prescription.id });
      if (rows.length === 0)
        throw new HttpError(409, 'La ricetta è cambiata nel frattempo: ricarica');
      return sent;
    });

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
    // Eccezione di sistema del SAR (V06, 4.3.1, caso 4): come il tempo scaduto (caso 5), non si sa
    // se la ricetta c'è. Nel registro degli invii resta l'eccezione; la ricetta ha l'esito incerto
    // e si rimanda con lo stesso NRE (D269).
    const errorKind: SendErrorKind | null =
      result.outcome === 'accepted'
        ? null
        : authProblem
          ? 'auth'
          : result.outcome === 'rejected'
            ? 'rejected'
            : result.outcome === 'fault'
              ? 'timeout'
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

    // Se intanto il medico ha segnato a mano l'esito di questo invio, rimasto senza risposta per
    // più di INTERRUPTED_SEND_AFTER_MINUTES, la risposta arrivata ora resta nel registro degli
    // invii e non cambia più la ricetta (D233).
    const applied = await withActor(db, actor.userId, async (tx) => {
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
      const updated = await tx
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
                sendingSnapshot: null,
                updatedAt: now(),
              }
            : {
                status: 'error',
                lastErrorKind: errorKind,
                lastErrorCode: result.outcome === 'rejected' ? result.code : null,
                lastErrorMessage: result.message,
                sendingSnapshot: null,
                updatedAt: now(),
              },
        )
        .where(
          and(
            eq(prescription.id, p.id),
            eq(prescription.status, 'sending'),
            eq(prescription.signedBy, actor.userId),
            eq(prescription.signedAt, claimedAt),
          ),
        )
        .returning({ id: prescription.id });
      if (!updated.length) return false;
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
      return true;
    });
    if (!applied)
      throw new HttpError(
        409,
        'Nel frattempo l’esito di questo invio è stato segnato a mano: la risposta arrivata ora resta nel registro degli invii. Ricarica la pagina per vedere la ricetta',
      );
    return {
      outcome:
        errorKind === 'auth'
          ? ('auth' as const)
          : result.outcome === 'fault'
            ? ('timeout' as const)
            : result.outcome,
      nre: result.outcome === 'accepted' ? result.nre : null,
      /** Il lotto successivo di NRE non è arrivato, ma restano numeri (D269). */
      avviso: lotNotice.warning,
      messaggio:
        result.outcome === 'accepted'
          ? promemoriaMissing
            ? `Ricetta partita, NRE ${result.nre}: i dati del promemoria non si sono potuti fissare, quindi il promemoria non si stampa. Al paziente bastano il numero di ricetta e il codice fiscale.`
            : null
          : result.message,
    };
  }

  /** Una ricetta «in invio» da più di INTERRUPTED_SEND_AFTER_MINUTES: l'invio si è interrotto. */
  const interrupted = (p: { status: string; signedAt: Date | null }) =>
    p.status === 'sending' &&
    p.signedAt !== null &&
    now().getTime() - p.signedAt.getTime() >= INTERRUPTED_SEND_AFTER_MINUTES * 60_000;

  /**
   * Esito di un invio rimasto senza risposta (D233). La ricetta è «in invio» da più di
   * INTERRUPTED_SEND_AFTER_MINUTES: il servizio si è fermato mentre aspettava l'ente. Il medico gli
   * ha chiesto se la ricetta è arrivata e segna la risposta:
   * - non arrivata: la ricetta torna in errore, come quando l'ente non risponde; si rimanda o si
   *   stampa la ricetta rossa;
   * - arrivata: con l'NRE e, per la ricetta SSN, il codice di autenticazione. Senza il codice la
   *   ricetta SSN non è valida, come nell'invio (D240): non si segna come arrivata.
   * La ricetta resta bloccata finché l'esito non è scritto: due esiti insieme non passano tutti e
   * due, e l'invio di prima, se poi risponde, non scrive sopra.
   */
  async function settleInterrupted(actor: Actor, id: string, body: unknown) {
    const p = await load(id, actor.studioId);
    await guardPatient(db, actor, p.patientId, 'prescription.sign_send', 'ricetta_esito_invio');
    const input = settleSchema.parse(body ?? {});
    check(p, input.esito === 'arrivata' ? 'settle_arrived' : 'settle_not_arrived');
    if (!interrupted(p))
      throw new HttpError(
        409,
        `L’invio è cominciato da meno di ${INTERRUPTED_SEND_AFTER_MINUTES} minuti: potrebbe essere ancora in corso. Aspetta, poi segna l’esito`,
      );
    const signedAt = p.signedAt!;
    const arrived = input.esito === 'arrivata' ? input : null;
    const white = p.kind === 'white';
    // Il messaggio partito con quell'invio, fotografato alla firma (D239): è la richiesta che resta
    // nel registro degli invii, e le sue righe e il paziente di allora vanno sul promemoria. Per
    // una ricetta firmata prima della fotografia, come l'aveva firmato chi l'ha mandata.
    const snapshot = p.sendingSnapshot as SendingSnapshot | null;
    const message = snapshot?.message ?? (await buildMessage(p, p.signedBy!, studioDate(signedAt)));
    // La forma del numero, prima di tutto (audit D259): NRE di 15 caratteri secondo le specifiche
    // del Sistema TS del 5/12/2024; NRBE di 12, che per il paziente con il codice fiscale comincia
    // con la lettera di controllo del codice fiscale mandato con la ricetta (DM 1/12/2022).
    const shape = !arrived
      ? null
      : white
        ? nrbeProblem(arrived.nre, message.patientFiscalCode)
        : nreProblem(arrived.nre);
    if (shape) throw new HttpError(400, shape);
    // L'NRE preso dal lotto del medico è partito con la ricetta (D269): l'ente non può averne dato
    // un altro.
    const lotNre = white ? null : (message.nre ?? p.assignedNre ?? null);
    if (arrived && lotNre && arrived.nre !== lotNre)
      throw new HttpError(
        400,
        `Il numero di questa ricetta è ${lotNre}, preso dal lotto del medico e partito con l’invio: l’ente non può averne dato un altro. Controlla il numero`,
      );
    if (arrived && white && !arrived.pin)
      throw new HttpError(
        400,
        'Per la ricetta bianca servono il numero (NRBE) e il PIN dati dal Sistema TS',
      );
    const authCode = white ? null : (arrived?.codiceAutenticazione ?? null);
    const ssn = p.kind === 'pharma_ssn' || p.kind === 'specialist_ssn';
    // Come nell'invio: una ricetta SSN senza il codice di autenticazione non è valida (specifiche
    // del Sistema TS, prescrizione, 5/12/2024). Scelta di Simone del 21/11/2026 (D240).
    if (arrived && ssn && !authCode)
      throw new HttpError(
        400,
        'Senza il codice di autenticazione la ricetta SSN non è valida: chiedi all’ente il numero (NRE) e il codice. Se l’ente non li dà, segna «Non è arrivata»',
      );
    let promemoria: Awaited<ReturnType<typeof buildPromemoriaData>> | null = null;
    // Il promemoria manca solo se i dati non si sono potuti fissare: il codice c'è sempre (D240).
    let notFixed = false;
    if (arrived && ssn && authCode) {
      try {
        promemoria = await (deps.buildPromemoria ?? buildPromemoriaData)(
          db,
          p.id,
          {
            nre: arrived.nre,
            authCode,
            sacDoctorName: null,
            compiledAt: message.compiledAt,
            messages: null,
          },
          message.lines,
          snapshot?.paziente ?? null,
        );
      } catch {
        notFixed = true;
      }
    }
    // La versione delle regole dell'ultimo controllo prima di quell'invio.
    const [lastCheck] = await db
      .select({ rulesVersion: prescriptionCheck.rulesVersion })
      .from(prescriptionCheck)
      .where(eq(prescriptionCheck.prescriptionId, p.id))
      .orderBy(sql`${prescriptionCheck.at} desc`)
      .limit(1);
    const notArrived =
      'Non arrivata all’ente, secondo l’ente: si può rimandare o stampare la ricetta rossa';

    await withActor(db, actor.userId, async (tx) => {
      const [row] = await tx
        .select({ status: prescription.status, signedAt: prescription.signedAt })
        .from(prescription)
        .where(eq(prescription.id, p.id))
        .for('update', { of: prescription });
      if (row?.status !== 'sending' || row.signedAt?.getTime() !== signedAt.getTime())
        throw new HttpError(409, 'La ricetta è cambiata nel frattempo: ricarica la pagina');
      await tx.insert(externalSubmission).values({
        system: systemFor(p.kind),
        environment: MANUAL_ENVIRONMENT,
        operation: 'esito',
        prescriptionId: p.id,
        userId: actor.userId,
        request: arrived
          ? {
              esito: 'arrivata',
              nre: arrived.nre,
              codiceAutenticazione: authCode,
              ...(white ? { pin: arrived.pin } : {}),
              ricetta: message,
            }
          : { esito: 'non_arrivata', ricetta: message },
        response: null,
        outcome: arrived ? 'accepted' : 'unreachable',
        errorCode: null,
        errorMessage: arrived ? null : notArrived,
        durationMs: null,
      });
      await tx
        .update(prescription)
        .set(
          arrived
            ? {
                status: 'sent',
                nre: arrived.nre,
                authCode,
                sacDoctorName: null,
                pinNrbe: white ? (arrived.pin ?? null) : null,
                sendingSnapshot: null,
                // È arrivata con quell'invio: per i riepiloghi conta il suo giorno (D201).
                sentAt: signedAt,
                lastErrorKind: null,
                lastErrorCode: null,
                lastErrorMessage: null,
                rulesVersion: lastCheck?.rulesVersion ?? null,
                updatedAt: now(),
              }
            : {
                status: 'error',
                lastErrorKind: 'unreachable',
                lastErrorCode: null,
                lastErrorMessage: notArrived,
                sendingSnapshot: null,
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
    });
    return {
      stato: arrived ? ('sent' as const) : ('error' as const),
      nre: arrived?.nre ?? null,
      messaggio: arrived
        ? white
          ? `Ricetta bianca segnata come arrivata, NRBE ${arrived.nre}: il promemoria del Sistema TS non c’è, perché la risposta dell’invio non è arrivata. NRBE e PIN si dettano al paziente o gli si mandano per SMS.`
          : notFixed
            ? `Ricetta segnata come arrivata, NRE ${arrived.nre}: i dati del promemoria non si sono potuti fissare, quindi il promemoria non si stampa. Al paziente bastano il numero di ricetta e il codice fiscale.`
            : null
        : notArrived,
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
      stampa: await buildMessage(p, actor.userId),
      avviso: 'Modulo di stampa conforme: da completare',
    };
  }

  /** Coda «da firmare» del medico, raggruppata per paziente. */
  async function toSignQueue(actor: Actor) {
    return queue(actor, 'to_sign');
  }

  /**
   * «In bozza» (audit, D259): le bozze che chi guarda ha preparato e non ha ancora mandato, così
   * una ricetta salvata non si dimentica. Le bozze degli altri restano loro.
   */
  async function draftQueue(actor: Actor) {
    return queue(actor, 'draft', { mine: true });
  }

  /** «Invii non riusciti»: ricette in errore, con il motivo. */
  async function failedQueue(actor: Actor) {
    return queue(actor, 'error');
  }

  /**
   * «Invii senza risposta»: ricette «in invio», di cui il medico segna l'esito chiesto all'ente
   * dopo INTERRUPTED_SEND_AFTER_MINUTES (D233). Anche quelle più recenti, con l'ora da cui l'esito
   * si segna: chi ricarica la pagina mentre l'invio è in corso vede dov'è la ricetta, e non la rifà
   * (D239). Il conto di Oggi resta per quelle da chiudere.
   */
  async function interruptedQueue(actor: Actor) {
    return queue(actor, 'sending', { signer: true });
  }

  /**
   * «Confermate» (D254): le ricette inviate o stampate su carta e non ancora archiviate, con il
   * menu di stampa e invio del promemoria nella pagina Ricette.
   */
  async function confirmedQueue(actor: Actor) {
    return queue(actor, ['sent', 'paper'], { signer: true, confirmed: true });
  }

  /**
   * «Archivia ricette confermate» (D254): le confermate che chi lo chiede vede escono
   * dall'elenco della pagina Ricette, per tutto lo studio; restano nello storico del paziente.
   */
  async function archiveConfirmed(actor: Actor) {
    const ids = (await confirmedQueue(actor)).flatMap((g) =>
      g.ricette.map((r) => (r as { id: string }).id),
    );
    if (ids.length === 0) return { archiviate: 0 };
    const done = await withActor(db, actor.userId, (tx) =>
      tx
        .update(prescription)
        .set({ archivedAt: now(), archivedBy: actor.userId, updatedAt: now() })
        .where(
          and(
            inArray(prescription.id, ids),
            // Due richieste insieme: la seconda non conta di nuovo ciò che la prima ha archiviato.
            isNull(prescription.archivedAt),
          ),
        )
        .returning({ id: prescription.id }),
    );
    return { archiviate: done.length };
  }

  /**
   * Le ricette di una coda, raggruppate per paziente. Chi firma le vede negli archivi dove firma;
   * chi legge la terapia dell'archivio senza firmare, la segreteria, le vede in sola lettura
   * (`firmabile` falso), senza quelle con una terapia riservata, come nella cartella (D242).
   */
  async function queue(
    actor: Actor,
    status: PrescriptionStatus | PrescriptionStatus[],
    opts: { signer?: boolean; confirmed?: boolean; mine?: boolean } = {},
  ) {
    const statuses = Array.isArray(status) ? status : [status];
    const signable = new Set(await visibleArchives(db, actor, 'prescription.sign_send'));
    const archives = [
      ...new Set([...signable, ...(await visibleArchives(db, actor, 'therapy.read'))]),
    ];
    if (archives.length === 0) return [];
    const reservedAllowed = new Set(await visibleArchives(db, actor, 'reserved.read'));
    const found = await db
      .select({
        id: prescription.id,
        archiveId: prescription.archiveId,
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
        firmataIl: prescription.signedAt,
        stato: prescription.status,
        nre: prescription.nre,
        inviataIl: prescription.sentAt,
        cartaceaIl: prescription.paperPrintedAt,
        firmataDa: sql<
          string | null
        >`(select u.display_name from app_user u where u.id = ${prescription.signedBy})`,
        // Le consegne del promemoria riuscite (anche le stampe di prima dell'audit): «Archivia
        // ricette confermate» chiede prima di archiviare quelle senza (suggerimento S7, D259).
        consegne: sql<number>`(select count(*)::int from reminder_delivery d where d.prescription_id = ${prescription.id} and d.outcome in ('consegnato', 'stampato'))`,
        // Il codice fiscale partito con l'invio (D239): con quello si controlla l'NRBE (D259).
        codiceFiscaleInviato: sql<
          string | null
        >`${prescription.sendingSnapshot}->'message'->>'patientFiscalCode'`,
      })
      .from(prescription)
      .innerJoin(patient, eq(patient.id, prescription.patientId))
      .innerJoin(appUser, eq(appUser.id, prescription.preparedBy))
      .where(
        and(
          inArray(prescription.archiveId, archives),
          inArray(prescription.status, statuses),
          opts.confirmed ? isNull(prescription.archivedAt) : undefined,
          opts.mine ? eq(prescription.preparedBy, actor.userId) : undefined,
        ),
      )
      .orderBy(patient.lastName, patient.firstName, prescription.preparedAt);
    // Le ricette con una terapia riservata non si vedono dove le riservate non si leggono.
    const unsure = found.filter((r) => !reservedAllowed.has(r.archiveId)).map((r) => r.id);
    const reserved = new Set(
      unsure.length
        ? (
            await db
              .selectDistinct({ id: prescriptionLine.prescriptionId })
              .from(prescriptionLine)
              .innerJoin(therapy, eq(therapy.id, prescriptionLine.therapyId))
              .where(
                and(eq(therapy.reserved, true), inArray(prescriptionLine.prescriptionId, unsure)),
              )
          ).map((r) => r.id)
        : [],
    );
    const rows = found.filter((r) => !reserved.has(r.id));
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
        firmabile: signable.has(r.archiveId),
        ...(opts.confirmed
          ? {
              stato: r.stato,
              nre: r.nre,
              inviataIl: r.inviataIl,
              cartaceaIl: r.cartaceaIl,
              consegne: r.consegne,
            }
          : {}),
        ...(opts.signer
          ? {
              firmataIl: r.firmataIl,
              firmataDa: r.firmataDa,
              esitoDal: r.firmataIl
                ? new Date(
                    r.firmataIl.getTime() + INTERRUPTED_SEND_AFTER_MINUTES * 60_000,
                  ).toISOString()
                : null,
              ...(statuses.includes('sending')
                ? { codiceFiscaleInviato: r.codiceFiscaleInviato ?? r.codiceFiscale }
                : {}),
            }
          : {}),
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
    settleInterrupted,
    checkOnly,
    cancel,
    printPaper,
    toSignQueue,
    draftQueue,
    failedQueue,
    interruptedQueue,
    confirmedQueue,
    archiveConfirmed,
    listForPatient,
    dispensingStatus,
    load,
  };
}

export type PrescriptionService = ReturnType<typeof createPrescriptionService>;
