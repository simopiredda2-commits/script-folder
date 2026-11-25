import { samePackUnit, type PackUnit } from '@mmg/reference';
import { checkPrescription, type DrugFacts, type LineContext, type RuleContext } from '@mmg/rules';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Database } from '../db/client';
import type { ReferenceData } from '../reference/lookup';
import {
  archive,
  delegation,
  doctorProfile,
  exemption,
  historicalPrescription,
  patient,
  patientChoice,
  prescription,
  prescriptionLine,
  studio,
  therapeuticPlan,
  therapy,
} from '../db/schema';
import type { CheckOutcome, SignInput } from './service';

export interface RulesCheckDeps {
  db: Database;
  now?: () => Date;
  /** Banche dati pubbliche importate (tappa 5), consultate alla data della ricetta (A5). */
  reference?: ReferenceData;
  /** Sostituisce la banca dati farmaci (prove). Senza nessuna delle due, nessun farmaco è noto. */
  drugFacts?: (aic: string | null) => DrugFacts | undefined;
  /** Sostituisce il catalogo delle esenzioni (prove). */
  exemptionExists?: (code: string) => boolean | undefined;
  /** Sostituisce l'elenco regionale esenzione → prestazioni (R17, prove). */
  exemptionServices?: (code: string) => ReadonlySet<string> | undefined;
  /** Sostituisce il catalogo regionale delle prestazioni (R10, R18, prove). */
  serviceCatalog?: (code: string) => { nationalCode: string | null } | null;
}

/** Data di oggi nello studio (Europe/Rome), AAAA-MM-GG. */
export function studioDate(at: Date): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(at);
}

/** Unità al giorno scritte nella terapia («1», «0,5», «2»): altrimenti non note. */
function parseUnits(text: string | null): number | null {
  if (!text) return null;
  const n = Number(text.trim().replace(',', '.'));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Costruisce dal database tutto ciò che le regole guardano. */
export async function buildRuleContext(
  deps: RulesCheckDeps,
  prescriptionId: string,
  input: SignInput,
  /** Chi controlla: il suo telefono, o quello dello studio, va nelle note degli stupefacenti (R23). */
  actorUserId?: string,
): Promise<RuleContext> {
  const { db } = deps;
  const [p] = await db.select().from(prescription).where(eq(prescription.id, prescriptionId));
  if (!p) throw new Error('Ricetta non trovata');
  const [pt] = await db.select().from(patient).where(eq(patient.id, p.patientId));
  const lines = await db
    .select()
    .from(prescriptionLine)
    .where(eq(prescriptionLine.prescriptionId, p.id))
    .orderBy(asc(prescriptionLine.position));
  const therapyIds = lines.map((l) => l.therapyId).filter((x): x is string => !!x);
  const therapies = therapyIds.length
    ? await db.select().from(therapy).where(inArray(therapy.id, therapyIds))
    : [];
  const sent = await db
    .select({ line: prescriptionLine, sentAt: prescription.sentAt })
    .from(prescriptionLine)
    .innerJoin(prescription, eq(prescription.id, prescriptionLine.prescriptionId))
    .where(and(eq(prescription.patientId, p.patientId), eq(prescription.status, 'sent')));
  // Ricette di farmaci fatte con altri programmi e importate (D176): R6 e R11 le contano dalle
  // versioni delle regole che lo dicono (D181). Quelle annullate qui, importate per errore, no.
  const fromOtherPrograms = await db
    .select()
    .from(historicalPrescription)
    .where(
      and(
        eq(historicalPrescription.patientId, p.patientId),
        eq(historicalPrescription.kind, 'farmaco'),
        isNull(historicalPrescription.annulledAt),
      ),
    );

  const lineContexts: LineContext[] = lines.map((l) => {
    const t = therapies.find((x) => x.id === l.therapyId);
    return {
      id: l.id,
      drugAic: l.drugAic,
      drugName: l.drugName,
      activeIngredient: l.activeIngredient,
      serviceCode: l.serviceCode,
      serviceNationalCode: l.serviceNationalCode,
      quantity: l.quantity,
      aifaNote: l.aifaNote,
      notSubstitutable: l.notSubstitutable,
      notSubstitutableReason: l.notSubstitutableReason,
      posologyText: l.posologyText,
      therapy: t
        ? {
            id: t.id,
            kind: t.kind,
            startOn: t.startOn,
            unitsPerDay: parseUnits(t.unitsPerDay),
            multiPrescription: t.multiPrescription,
            therapeuticPlanId: t.therapeuticPlanId,
          }
        : null,
    };
  });

  const date = studioDate((deps.now ?? (() => new Date()))());
  let drugFacts = deps.drugFacts;
  let { exemptionExists, exemptionServices, serviceCatalog } = deps;
  if (deps.reference) {
    if (!serviceCatalog && p.kind === 'specialist_ssn') {
      serviceCatalog = await deps.reference.serviceLookup(date);
    }
    if (!drugFacts) {
      const known = await deps.reference.drugs(
        lines.map((l) => l.drugAic).filter((x): x is string => !!x),
        date,
      );
      drugFacts = (aic) => (aic ? known.get(aic)?.facts : undefined);
    }
    if (!exemptionExists || !exemptionServices) {
      const lookups = await deps.reference.exemptionLookups(date);
      exemptionExists ??= lookups.exemptionExists;
      exemptionServices ??= lookups.exemptionServices;
    }
  }

  // Le unità per confezione lette dalla descrizione AIFA contano solo se la posologia della
  // terapia è nella stessa unità (D252): 28 compresse con «1 compressa» sì; con le gocce no.
  const withUnits = drugFacts;
  if (withUnits) {
    drugFacts = (aic) => {
      const facts = withUnits(aic);
      if (!facts?.packUnit) return facts;
      const units = lines
        .filter((l) => l.drugAic === aic && l.therapyId)
        .map((l) => therapies.find((x) => x.id === l.therapyId)?.doseUnit);
      if (units.every((u) => samePackUnit(u, facts.packUnit as PackUnit))) return facts;
      const rest: DrugFacts = { ...facts };
      delete rest.unitsPerPack;
      delete rest.packUnit;
      return rest;
    };
  }

  return {
    date,
    prescription: {
      id: p.id,
      kind: p.kind,
      exemptionCode: p.exemptionCode,
      priority: p.priority,
      accessType: p.accessType,
      diagnosticQuestion: p.diagnosticQuestion,
      reminderChannel: p.reminderChannel,
      reminderContact: p.reminderContact,
      lines: lineContexts,
    },
    patient: {
      fiscalCode: pt!.fiscalCode,
      email: pt!.email,
      phone: pt!.phone,
      reminderChannel: pt!.reminderChannel,
      reminderContact: pt!.reminderContact,
      reminderChannelChosenOn: pt!.reminderChannelChosenOn,
      // Stato nella cartella e scelte del medico (R19, R20; D199).
      status: pt!.status,
      deceasedOn: pt!.deceasedOn,
    },
    choices: await db
      .select({
        chosenOn: patientChoice.chosenOn,
        expiresOn: patientChoice.expiresOn,
        endedOn: patientChoice.endedOn,
      })
      .from(patientChoice)
      .where(and(eq(patientChoice.patientId, p.patientId), isNull(patientChoice.annulledAt))),
    ...(serviceCatalog ? { serviceCatalog } : {}),
    exemptions: await db
      .select({ code: exemption.code, validFrom: exemption.validFrom, validTo: exemption.validTo })
      .from(exemption)
      // Un'esenzione annullata (per esempio tolta in AURA, D197) non vale più.
      .where(and(eq(exemption.patientId, p.patientId), isNull(exemption.annulledAt))),
    delegations: await db
      .select({
        email: delegation.delegateEmail,
        phone: delegation.delegatePhone,
        validFrom: delegation.validFrom,
        validTo: delegation.validTo,
        revokedOn: delegation.revokedOn,
      })
      .from(delegation)
      .where(eq(delegation.patientId, p.patientId)),
    plans: await db
      .select({
        id: therapeuticPlan.id,
        drugAic: therapeuticPlan.drugAic,
        activeIngredient: therapeuticPlan.activeIngredient,
        grantedOn: therapeuticPlan.grantedOn,
        expiresOn: therapeuticPlan.expiresOn,
        packsAuthorized: therapeuticPlan.packsAuthorized,
      })
      .from(therapeuticPlan)
      .where(and(eq(therapeuticPlan.patientId, p.patientId), eq(therapeuticPlan.status, 'active'))),
    sentLines: [
      ...sent
        .filter((s) => s.sentAt)
        .map((s) => ({
          therapyId: s.line.therapyId,
          drugAic: s.line.drugAic,
          activeIngredient: s.line.activeIngredient,
          quantity: s.line.quantity,
          sentOn: studioDate(s.sentAt!),
        })),
      ...fromOtherPrograms.map((h) => ({
        therapyId: null,
        drugAic: h.drugAic,
        activeIngredient: h.activeIngredient,
        quantity: h.quantity,
        sentOn: h.prescribedOn,
        otherProgram: { name: h.sourceProgram },
      })),
    ],
    drugFacts: drugFacts ?? (() => undefined),
    exemptionExists,
    exemptionServices,
    confirmedAifaNotes: new Set(input.confirmedAifaNotes),
    reasons: input.reasons,
    ...(actorUserId ? { doctorPhone: await contactPhone(db, actorUserId, p.patientId) } : {}),
  };
}

/**
 * Le note della riga per la terapia del dolore (R23, «Nota STUP», D272): posologia e telefono del
 * medico. Null se non c'è niente da scrivere.
 */
export function stupNote(posology: string | null, phone: string | null): string | null {
  const parts = [
    posology?.trim() ? `Posologia: ${posology.trim()}` : null,
    phone?.trim() ? `tel. del medico ${phone.trim()}` : null,
  ].filter((x): x is string => x !== null);
  return parts.length ? parts.join('; ') : null;
}

/**
 * Il telefono per le note della ricetta degli stupefacenti (R23, nota STUP): quello del medico,
 * altrimenti quello dello studio dell'archivio del paziente.
 */
export async function contactPhone(
  db: Database,
  userId: string,
  patientId: string,
): Promise<string | null> {
  const [doctor] = await db
    .select({ phone: doctorProfile.phone })
    .from(doctorProfile)
    .where(eq(doctorProfile.userId, userId));
  if (doctor?.phone?.trim()) return doctor.phone.trim();
  const [place] = await db
    .select({ phone: studio.phone })
    .from(patient)
    .innerJoin(archive, eq(archive.id, patient.archiveId))
    .innerJoin(studio, eq(studio.id, archive.studioId))
    .where(eq(patient.id, patientId));
  return place?.phone?.trim() || null;
}

/** Controlli prima dell'invio con le regole di prescrizione in vigore alla data. */
export function createRulesCheck(deps: RulesCheckDeps) {
  return async (
    prescriptionId: string,
    actor: { userId: string } | undefined,
    input: SignInput,
  ): Promise<CheckOutcome> => {
    const result = checkPrescription(
      await buildRuleContext(deps, prescriptionId, input, actor?.userId),
    );
    return {
      rulesVersion: result.rulesVersion,
      issues: result.issues,
      reasonsUsed: result.reasonsUsed,
      confirmedAifaNotes: result.confirmedAifaNotes,
    };
  };
}
