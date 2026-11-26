import { can, DISPENSING_STATE_LABELS, type DispensingState } from '@mmg/domain';
import { desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Actor } from '../auth/service';
import type { Database } from '../db/client';
import {
  appUser,
  externalSubmission,
  prescription,
  prescriptionCheck,
  prescriptionLine,
  therapy,
} from '../db/schema';
import { HttpError } from '../http/errors';
import { guardPatient } from '../patients/access';
import { historicalLine, historicalViews, pastCounts, visibleHistorical } from './historical';

/**
 * Storico delle prescrizioni di un farmaco o di una prestazione (D65, D66): tutte le ricette
 * del paziente che lo contengono, con la riga, chi ha preparato e firmato, e i controlli.
 */
export const historyQuery = z
  .object({
    /** Terapia della scheda: le sue righe e, per le righe senza terapia, stesso AIC o principio. */
    terapia: z.uuid().optional(),
    aic: z
      .string()
      .regex(/^\d{9}$/)
      .optional(),
    principio: z.string().trim().min(1).max(300).optional(),
    /** Farmaco scritto a mano, senza AIC né principio attivo: il nome (D152). */
    farmaco: z.string().trim().min(1).max(300).optional(),
    /** Prestazione: codice regionale; per le righe senza codice, la descrizione. */
    prestazione: z.string().trim().min(1).max(40).optional(),
    descrizione: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .refine((q) => Object.values(q).some((v) => v !== undefined), {
    message: 'Indica una terapia, un farmaco o una prestazione',
  });

/** Stati in cui la ricetta è stata davvero prescritta (inviata o stampata su carta). */
const PRESCRIBED = new Set(['sent', 'paper']);
const MONTHS_FOR_TOTAL = 12;

const lower = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

/** Che cosa apre lo storico: una terapia, un farmaco o una prestazione. */
export interface HistoryTarget {
  therapyId: string | null;
  aic: string | null;
  ingredient: string | null;
  /** Il nome, solo per le righe senza AIC né principio attivo (D152). */
  name: string | null;
  serviceCode: string | null;
  serviceDescription: string | null;
}

export type LineFields = Pick<
  typeof prescriptionLine.$inferSelect,
  'therapyId' | 'drugAic' | 'drugName' | 'activeIngredient' | 'serviceCode' | 'serviceDescription'
>;

/** Riga di prestazione (specialistica) o di farmaco. */
export const isServiceLine = (l: LineFields) => !!(l.serviceCode || l.serviceDescription);

export const emptyTarget = (): HistoryTarget => ({
  therapyId: null,
  aic: null,
  ingredient: null,
  name: null,
  serviceCode: null,
  serviceDescription: null,
});

/** Lo storico di una terapia: le sue righe e quelle senza terapia dello stesso farmaco. */
export const therapyTarget = (t: {
  id: string;
  drugAic: string | null;
  activeIngredient: string | null;
  drugName: string;
}): HistoryTarget => ({
  ...emptyTarget(),
  therapyId: t.id,
  aic: t.drugAic,
  ingredient: t.activeIngredient,
  name: t.drugName,
});

/**
 * Le regole di D65 e D66, una sola volta: valgono per lo storico e per gli elenchi della
 * cartella (D152), così il numero di ricette di un elenco è quello che lo storico mostra.
 * - Una riga con terapia appartiene solo alla sua terapia.
 * - Prestazioni: per codice regionale; le righe senza codice, per descrizione.
 * - Farmaci senza terapia: per AIC se la riga ce l'ha; altrimenti per principio attivo; le righe
 *   senza AIC né principio (scritte a mano), per nome.
 */
export function matchesTarget(t: HistoryTarget, line: LineFields): boolean {
  if (t.therapyId && line.therapyId) return line.therapyId === t.therapyId;
  if (t.serviceCode || t.serviceDescription) {
    if (t.serviceCode && line.serviceCode) return line.serviceCode === t.serviceCode;
    return (
      !!t.serviceDescription &&
      !line.serviceCode &&
      lower(line.serviceDescription) === lower(t.serviceDescription)
    );
  }
  if (isServiceLine(line)) return false;
  if (t.aic && line.drugAic) return line.drugAic === t.aic;
  if (t.ingredient) return lower(line.activeIngredient) === lower(t.ingredient);
  if (t.name && !line.drugAic && !line.activeIngredient) {
    return lower(line.drugName) === lower(t.name);
  }
  return false;
}

export async function prescriptionHistory(
  db: Database,
  now: () => Date,
  actor: Actor,
  patientId: string,
  rawQuery: unknown,
) {
  const { context } = await guardPatient(
    db,
    actor,
    patientId,
    'therapy.read',
    'lettura_storico_prescrizioni',
  );
  const q = historyQuery.parse(rawQuery);
  const reservedAllowed = can(actor, 'reserved.read', { ...context, now: now() }).allowed;
  const therapies = await db.select().from(therapy).where(eq(therapy.patientId, patientId));
  const reservedIds = new Set(therapies.filter((t) => t.reserved).map((t) => t.id));

  let target: HistoryTarget = {
    ...emptyTarget(),
    aic: q.aic ?? null,
    ingredient: q.principio ?? null,
    name: q.farmaco ?? null,
    serviceCode: q.prestazione ?? null,
    serviceDescription: q.descrizione ?? null,
  };
  if (q.terapia) {
    const t = therapies.find((x) => x.id === q.terapia);
    if (!t || (t.reserved && !reservedAllowed)) throw new HttpError(404, 'Terapia non trovata');
    const own = therapyTarget(t);
    target = {
      ...target,
      therapyId: t.id,
      aic: target.aic ?? own.aic,
      ingredient: target.ingredient ?? own.ingredient,
      name: target.name ?? own.name,
    };
  }

  const rows = await db
    .select({ line: prescriptionLine, p: prescription })
    .from(prescriptionLine)
    .innerJoin(prescription, eq(prescription.id, prescriptionLine.prescriptionId))
    .where(eq(prescription.patientId, patientId))
    .orderBy(desc(prescription.preparedAt));

  const matches = rows.filter(({ line }) => {
    if (line.therapyId && reservedIds.has(line.therapyId) && !reservedAllowed) return false;
    return matchesTarget(target, line);
  });

  const ids = [...new Set(matches.map((m) => m.p.id))];
  const userIds = [
    ...new Set(
      matches.flatMap((m) => [m.p.preparedBy, m.p.signedBy, m.p.cancelledBy].filter(Boolean)),
    ),
  ] as string[];
  const users = userIds.length
    ? new Map(
        (
          await db
            .select({ id: appUser.id, name: appUser.displayName })
            .from(appUser)
            .where(inArray(appUser.id, userIds))
        ).map((u) => [u.id, u.name]),
      )
    : new Map<string, string>();
  const checks = ids.length
    ? await db
        .select()
        .from(prescriptionCheck)
        .where(inArray(prescriptionCheck.prescriptionId, ids))
        .orderBy(prescriptionCheck.at)
    : [];

  // Passaggi con l'ente (invio, stato, annullamento), dal registro degli invii che non si modifica.
  const exchanges = ids.length
    ? await db
        .select()
        .from(externalSubmission)
        .where(inArray(externalSubmission.prescriptionId, ids))
        .orderBy(externalSubmission.at)
    : [];

  const since = new Date(now());
  since.setMonth(since.getMonth() - MONTHS_FOR_TOTAL);
  const recent = matches.filter(({ p }) => (p.sentAt ?? p.paperPrintedAt ?? p.preparedAt) >= since);
  const total = recent
    .filter(({ p }) => PRESCRIBED.has(p.status))
    .reduce((n, { line }) => n + line.quantity, 0);
  // Le annullate restano nello storico e si contano a parte: prescritte, ma poi annullate.
  const cancelled = recent
    .filter(({ p }) => p.status === 'cancelled' && p.sentAt)
    .reduce((n, { line }) => n + line.quantity, 0);

  // Ricette fatte con un altro programma (tappa 15): stesse regole, elenco e conti a parte.
  const past = (await visibleHistorical(db, patientId, reservedAllowed)).filter((h) =>
    matchesTarget(target, historicalLine(h)),
  );

  return {
    /** Confezioni (o quantità) prescritte negli ultimi 12 mesi, ricette inviate o su carta. */
    ultimi12Mesi: total,
    /** Inviate e poi annullate negli ultimi 12 mesi: restano nello storico (D70). */
    annullateUltimi12Mesi: cancelled,
    /** Ricette fatte con un altro programma, anche le annullate; non si ripetono. */
    ricettePassate: await historicalViews(db, past),
    altroProgramma: pastCounts(past),
    voci: matches.map(({ line, p }) => ({
      ricetta: {
        id: p.id,
        tipo: p.kind,
        stato: p.status,
        nre: p.nre,
        preparataIl: p.preparedAt,
        preparataDa: users.get(p.preparedBy) ?? null,
        firmataIl: p.signedAt,
        firmataDa: p.signedBy ? (users.get(p.signedBy) ?? null) : null,
        inviataIl: p.sentAt,
        cartaceaIl: p.paperPrintedAt,
        esenzione: p.exemptionCode,
        priorita: p.priority,
        accesso: p.accessType,
        quesito: p.diagnosticQuestion,
        /** La condizione RAO scelta dal medico, com'era alla scelta (D285). */
        condizioneRao: p.raoConditionKey
          ? {
              testo: p.raoConditionText,
              classe: p.raoConditionPriority,
              fonte: p.raoConditionSource,
            }
          : null,
        versioneRegole: p.rulesVersion,
        annullataIl: p.cancelledAt,
        annullataDa: p.cancelledBy ? (users.get(p.cancelledBy) ?? null) : null,
        motivoAnnullamento: p.cancelReason,
        /** Ultimo stato di erogazione noto presso l'ente (D70). */
        statoErogazione: p.dispensingState,
        etichettaErogazione: p.dispensingState
          ? DISPENSING_STATE_LABELS[p.dispensingState as DispensingState]
          : null,
        statoVerificatoIl: p.dispensingCheckedAt,
        errore: p.lastErrorMessage,
      },
      riga: {
        id: line.id,
        terapia: line.therapyId,
        aic: line.drugAic,
        farmaco: line.drugName,
        principioAttivo: line.activeIngredient,
        codicePrestazione: line.serviceCode,
        prestazione: line.serviceDescription,
        quantita: line.quantity,
        posologia: line.posologyText,
        notaAifa: line.aifaNote,
        perPrincipioAttivo: line.byActiveIngredient,
        nonSostituibile: line.notSubstitutable,
        motivoNonSostituibile: line.notSubstitutableReason,
        codiceMotivazione: line.notSubstitutableCode,
      },
      enti: exchanges
        .filter((x) => x.prescriptionId === p.id)
        .map((x) => ({
          il: x.at,
          ente: x.system,
          operazione: x.operation,
          esito: x.outcome,
          messaggio: x.errorMessage,
        })),
      controlli: checks
        .filter((c) => c.prescriptionId === p.id)
        .map((c) => ({
          il: c.at,
          esito: c.outcome,
          versioneRegole: c.rulesVersion,
          problemi: c.issues,
          motivi: c.reasons,
          noteConfermate: c.confirmedAifaNotes,
        })),
    })),
  };
}
