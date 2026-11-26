import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client';
import { prescriptionLine, therapy } from '../db/schema';
import type { Tx } from '../db/tx';
import { HttpError } from '../http/errors';

/**
 * Il tipo di terapia segnato sulla riga della ricetta (D282, D283). Il medico segna sulla riga del
 * farmaco il tipo (cronica, ciclo, al bisogno), la tipologia S o H e «Non rimborsabile SSN»; alla
 * firma il programma crea la terapia, o aggiorna quella collegata. La segreteria segna una
 * proposta, che il medico conferma o no quando firma: il tipo di terapia lo decide il medico
 * (requisiti, «Terapia»).
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data nella forma AAAA-MM-GG');

/** La scelta come arriva con la riga. */
export const therapyChoiceSchema = z
  .object({
    kind: z.enum(['chronic', 'as_needed', 'cycle']),
    /** Fine del ciclo: obbligatoria per il ciclo, come nella scheda della terapia. */
    endOn: isoDate.nullable().optional(),
    typology: z.enum(['S', 'H']).nullable().optional(),
    notReimbursable: z.boolean().optional(),
    suggestedByName: z.string().trim().max(200).nullable().optional(),
    suggestedByFacility: z.string().trim().max(200).nullable().optional(),
    suggestedOn: isoDate.nullable().optional(),
  })
  .strict()
  .refine((c) => c.kind !== 'cycle' || !!c.endOn, {
    message: 'Ciclo: manca la data di fine',
    path: ['endOn'],
  })
  .refine((c) => c.typology !== 'S' || !!c.suggestedByName?.trim(), {
    message: 'Suggerita (S): servono i dati del medico suggeritore',
    path: ['suggestedByName'],
  });

export type TherapyChoiceInput = z.infer<typeof therapyChoiceSchema>;

/**
 * La scelta come resta sulla riga. La fine conta solo per il ciclo e il medico suggeritore solo con
 * la S: fuori da lì la terapia collegata li tiene com'erano.
 */
export interface TherapyChoice {
  kind: 'chronic' | 'as_needed' | 'cycle';
  endOn: string | null;
  typology: 'S' | 'H' | null;
  notReimbursable: boolean;
  suggestedByName: string | null;
  suggestedByFacility: string | null;
  suggestedOn: string | null;
}

export function normalizeChoice(c: TherapyChoiceInput): TherapyChoice {
  const s = c.typology === 'S';
  return {
    kind: c.kind,
    endOn: c.kind === 'cycle' ? (c.endOn ?? null) : null,
    typology: c.typology ?? null,
    notReimbursable: c.notReimbursable ?? false,
    suggestedByName: s ? c.suggestedByName?.trim() || null : null,
    suggestedByFacility: s ? c.suggestedByFacility?.trim() || null : null,
    suggestedOn: s ? (c.suggestedOn ?? null) : null,
  };
}

type TherapyRow = typeof therapy.$inferSelect;
type LineRow = typeof prescriptionLine.$inferSelect;

export const therapyTypologyOf = (t: { suggestedS: boolean; hospitalH: boolean }) =>
  t.suggestedS ? ('S' as const) : t.hospitalH ? ('H' as const) : null;

/** La scelta non cambia niente della terapia collegata: allora la riga non la porta. */
export function sameAsTherapy(c: TherapyChoice, t: TherapyRow): boolean {
  return (
    c.kind === t.kind &&
    (c.kind !== 'cycle' || c.endOn === t.endOn) &&
    c.typology === therapyTypologyOf(t) &&
    c.notReimbursable === t.notReimbursable &&
    (c.typology !== 'S' ||
      (c.suggestedByName === t.suggestedByName &&
        c.suggestedByFacility === t.suggestedByFacility &&
        c.suggestedOn === t.suggestedOn))
  );
}

/** Le colonne della riga per una scelta (o nessuna scelta). */
export function choiceColumns(c: TherapyChoice | null, proposedBy: string | null) {
  return {
    therapyKind: c?.kind ?? null,
    therapyEndOn: c?.endOn ?? null,
    therapyTypology: c?.typology ?? null,
    therapyNotReimbursable: c ? c.notReimbursable : null,
    therapySuggestedByName: c?.suggestedByName ?? null,
    therapySuggestedByFacility: c?.suggestedByFacility ?? null,
    therapySuggestedOn: c?.suggestedOn ?? null,
    therapyProposedBy: c ? proposedBy : null,
  };
}

/** La scelta scritta sulla riga, com'è: anche una proposta non ancora decisa. */
export function storedChoice(l: LineRow): TherapyChoice | null {
  if (!l.therapyKind) return null;
  return {
    kind: l.therapyKind,
    endOn: l.therapyEndOn,
    typology: l.therapyTypology === 'S' || l.therapyTypology === 'H' ? l.therapyTypology : null,
    notReimbursable: l.therapyNotReimbursable ?? false,
    suggestedByName: l.therapySuggestedByName,
    suggestedByFacility: l.therapySuggestedByFacility,
    suggestedOn: l.therapySuggestedOn,
  };
}

/** Decisioni del medico sulle proposte della segreteria, per riga. */
export type ProposalDecisions = Readonly<Record<string, 'confirmed' | 'declined'>>;

/** La proposta della riga, se c'è, e la decisione: quella scritta, o quella data adesso. */
export function proposalDecision(
  l: LineRow,
  decisions: ProposalDecisions = {},
): 'confirmed' | 'declined' | 'pending' | null {
  if (!l.therapyKind || !l.therapyProposedBy) return null;
  const d = l.therapyProposalDecision ?? decisions[l.id];
  return d === 'confirmed' || d === 'declined' ? d : 'pending';
}

/**
 * La scelta che vale per la ricetta: quella del medico, o la proposta confermata. Una proposta non
 * ancora decisa, o non applicata, non vale: la ricetta va con la terapia com'è.
 */
export function effectiveChoice(
  l: LineRow,
  decisions: ProposalDecisions = {},
): TherapyChoice | null {
  const d = proposalDecision(l, decisions);
  if (d === 'pending' || d === 'declined') return null;
  return storedChoice(l);
}

const KIND_LABEL = { chronic: 'cronica', as_needed: 'al bisogno', cycle: 'ciclo' } as const;
const itDate = (d: string) => d.split('-').reverse().join('/');

/** La scelta in parole, come la legge il medico: «cronica, S (Dr. …), non rimborsabile SSN». */
export function choiceText(c: TherapyChoice): string {
  return [
    c.kind === 'cycle' && c.endOn ? `ciclo fino al ${itDate(c.endOn)}` : KIND_LABEL[c.kind],
    c.typology === 'S'
      ? `suggerita (S) da ${[c.suggestedByName, c.suggestedByFacility].filter(Boolean).join(', ')}`
      : c.typology === 'H'
        ? 'ricovero (H)'
        : null,
    c.notReimbursable ? 'non rimborsabile SSN' : null,
  ]
    .filter(Boolean)
    .join(', ');
}

/** Il problema da mostrare ai controlli prima dell'invio, come gli altri (PreSendIssue). */
export interface ProposalIssue {
  ruleId: 'PROPOSTA';
  severity: 'warn' | 'info';
  message: string;
  lineId: string;
  needs?: 'therapy_decision';
}

/**
 * Le proposte della segreteria ai controlli prima dell'invio: da decidere (ferma l'invio finché il
 * medico non sceglie), o già decise (restano scritte nel controllo).
 */
export function proposalIssues(
  lines: readonly LineRow[],
  decisions: ProposalDecisions = {},
): ProposalIssue[] {
  const out: ProposalIssue[] = [];
  for (const l of lines) {
    const d = proposalDecision(l, decisions);
    const c = storedChoice(l);
    if (!d || !c) continue;
    const what = `${l.drugName ?? l.activeIngredient ?? 'Farmaco'}: ${choiceText(c)}`;
    out.push(
      d === 'pending'
        ? {
            ruleId: 'PROPOSTA',
            severity: 'warn',
            message: `La segreteria propone per la terapia: ${what}. Il medico la conferma o no`,
            lineId: l.id,
            needs: 'therapy_decision',
          }
        : {
            ruleId: 'PROPOSTA',
            severity: 'info',
            message:
              d === 'confirmed'
                ? `Proposta della segreteria confermata: ${what}`
                : `Proposta della segreteria non applicata: ${what}`,
            lineId: l.id,
          },
    );
  }
  return out;
}

/**
 * La posologia della riga nella terapia nuova. La riga ha un testo; la scheda ha dose, unità e
 * frequenza. Il testo non si spezza (niente valori ricostruiti): va nella frequenza, come per le
 * terapie importate da altri programmi, così la ripetizione lo riporta uguale; se è troppo lungo
 * per la frequenza, nelle istruzioni per il paziente. Dose, unità e unità al giorno si completano
 * nella scheda.
 */
export function posologyFields(text: string | null): {
  frequency?: string;
  patientInstructions?: string;
} {
  const t = text?.trim();
  if (!t) return {};
  return t.length <= 100 ? { frequency: t } : { patientInstructions: t };
}

/** I dati del farmaco presi dalla banca dati alla firma, per la scheda nuova. */
export interface DrugCard {
  atc: string | null;
  drugClass: string | null;
  equivalenceGroup: string | null;
  dpc: boolean;
}

/**
 * Alla firma: le decisioni del medico sulle proposte restano sulla riga, e le scelte che valgono
 * passano alla terapia, una volta sola. Una terapia collegata si aggiorna; senza terapia se ne crea
 * una e la riga la prende. Le terapie sono sempre del paziente della ricetta.
 */
export async function applyTherapyChoices(
  tx: Tx,
  input: {
    patientId: string;
    exemptionCode: string | null;
    actorUserId: string;
    today: string;
    at: Date;
    decisions: ProposalDecisions;
    drugCards?: ReadonlyMap<string, DrugCard>;
  },
  lines: readonly LineRow[],
): Promise<void> {
  for (const l of lines) {
    const d = proposalDecision(l, input.decisions);
    if (d === 'confirmed' || d === 'declined') {
      if (!l.therapyProposalDecision)
        await tx
          .update(prescriptionLine)
          .set({ therapyProposalDecision: d })
          .where(eq(prescriptionLine.id, l.id));
    }
    const c = effectiveChoice(l, input.decisions);
    if (!c || l.therapyChoiceAppliedAt) continue;
    if (l.therapyId) {
      const [t] = await tx
        .select()
        .from(therapy)
        .where(and(eq(therapy.id, l.therapyId), eq(therapy.patientId, input.patientId)))
        .for('update');
      if (!t) throw new HttpError(404, 'Terapia non trovata');
      if (c.kind === 'cycle' && c.endOn && c.endOn < t.startOn)
        throw new HttpError(
          409,
          `${t.drugName}: la fine del ciclo viene prima dell’inizio della terapia`,
        );
      await tx
        .update(therapy)
        .set({
          kind: c.kind,
          ...(c.kind === 'cycle' ? { endOn: c.endOn } : {}),
          suggestedS: c.typology === 'S',
          hospitalH: c.typology === 'H',
          ...(c.typology === 'S'
            ? {
                suggestedByName: c.suggestedByName,
                suggestedByFacility: c.suggestedByFacility,
                suggestedOn: c.suggestedOn,
              }
            : {}),
          notReimbursable: c.notReimbursable,
          updatedAt: input.at,
        })
        .where(eq(therapy.id, t.id));
      await tx
        .update(prescriptionLine)
        .set({ therapyChoiceAppliedAt: input.at })
        .where(eq(prescriptionLine.id, l.id));
      continue;
    }
    if (!l.drugName?.trim())
      throw new HttpError(400, 'Per creare la terapia serve il nome del farmaco');
    if (c.kind === 'cycle' && c.endOn && c.endOn < input.today)
      throw new HttpError(
        409,
        `${l.drugName}: il ciclo finisce prima di oggi, correggi la data di fine`,
      );
    const card = l.drugAic ? input.drugCards?.get(l.drugAic) : undefined;
    const [created] = await tx
      .insert(therapy)
      .values({
        patientId: input.patientId,
        drugAic: l.drugAic,
        drugName: l.drugName.trim(),
        activeIngredient: l.activeIngredient,
        atc: card?.atc ?? null,
        drugClass: card?.drugClass ?? null,
        equivalenceGroup: card?.equivalenceGroup ?? null,
        dpc: card?.dpc ?? false,
        ...posologyFields(l.posologyText),
        kind: c.kind,
        startOn: input.today,
        endOn: c.endOn,
        packsPerPrescription: l.quantity,
        habitualExemptionCode: input.exemptionCode,
        aifaNote: l.aifaNote,
        suggestedByName: c.suggestedByName,
        suggestedByFacility: c.suggestedByFacility,
        suggestedOn: c.suggestedOn,
        notReimbursable: c.notReimbursable,
        byActiveIngredient: l.byActiveIngredient,
        notSubstitutable: l.notSubstitutable,
        notSubstitutableReason: l.notSubstitutableReason,
        notSubstitutableCode: l.notSubstitutable ? l.notSubstitutableCode : null,
        suggestedS: c.typology === 'S',
        hospitalH: c.typology === 'H',
        createdBy: input.actorUserId,
        createdAt: input.at,
        updatedAt: input.at,
      })
      .returning({ id: therapy.id });
    await tx
      .update(prescriptionLine)
      .set({ therapyId: created!.id, therapyChoiceAppliedAt: input.at })
      .where(eq(prescriptionLine.id, l.id));
  }
}

/**
 * Le terapie collegate alle righe con una scelta, del paziente: per controllare la scelta e per
 * non portare una scelta che non cambia niente.
 */
export async function linkedTherapies(
  db: Database | Tx,
  patientId: string,
  ids: readonly string[],
): Promise<Map<string, TherapyRow>> {
  if (!ids.length) return new Map();
  const rows = await db
    .select()
    .from(therapy)
    .where(and(eq(therapy.patientId, patientId), inArray(therapy.id, [...ids])));
  return new Map(rows.map((t) => [t.id, t]));
}
