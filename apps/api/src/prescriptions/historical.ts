import { AIC_PATTERN, ATC_PATTERN } from '@mmg/domain';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client';
import { appUser, historicalPrescription, therapy } from '../db/schema';
import type { Tx } from '../db/tx';
import { HttpError } from '../http/errors';
// Solo il tipo: history.ts legge da qui, e un import vero farebbe un giro tra i due moduli.
import type { LineFields } from './history';

/**
 * Ricette fatte con un altro programma (tappa 15), scritte a mano o arrivate dall'importazione.
 * Servono allo storico dei farmaci e delle prestazioni prescritti (D152) e alla cronologia.
 *
 * Non sono ricette di questo programma: non entrano mai nella macchina degli stati delle ricette
 * (non si firmano, non si inviano, non si annullano verso il SAR) e non si ripetono. Sono dati
 * del paziente: non si cancellano; se registrate per errore si annullano con un motivo, e lo
 * storico delle modifiche (trigger della migrazione 0023) dice chi e quando.
 */

export const HISTORICAL_KINDS = ['farmaco', 'prestazione'] as const;
export type HistoricalKind = (typeof HISTORICAL_KINDS)[number];

/** Quantità: lo stesso limite tecnico delle righe delle ricette di questo programma (1–99). */
export const HISTORICAL_QUANTITY_MAX = 99;
/**
 * NRE: il formato ufficiale non è ancora verificato sulle specifiche (docs/avanzamento.md,
 * «formato dell'NRE»), quindi solo un limite tecnico di lunghezza, senza controllo del formato.
 */
export const NRE_MAX_LENGTH = 20;

const isoDate = z.iso.date();
const optionalText = (max: number) => z.string().trim().max(max).optional();

/** Campi comuni: data, quantità, NRE se c'è, prescrittore come testo, note, programma d'origine. */
const common = {
  data: isoDate,
  quantita: z.number().int().min(1).max(HISTORICAL_QUANTITY_MAX).optional(),
  nre: z.string().trim().toUpperCase().max(NRE_MAX_LENGTH).optional(),
  /** Chi l'ha prescritta, come lo scrive il programma d'origine: non è un utente di qui. */
  prescrittore: optionalText(200),
  note: optionalText(2000),
  /** Programma con cui è stata fatta, come lo scrive chi la registra. */
  programma: optionalText(100),
};

const drugBody = z
  .object({
    tipo: z.literal('farmaco'),
    ...common,
    /** AIC della confezione (9 cifre): si controlla in `historicalIssues`, con un messaggio chiaro. */
    aic: z.string().trim().max(20).optional(),
    farmaco: optionalText(300),
    principioAttivo: optionalText(300),
    atc: z.string().trim().toUpperCase().max(10).optional(),
    posologia: optionalText(500),
  })
  .strict();

const serviceBody = z
  .object({
    tipo: z.literal('prestazione'),
    ...common,
    /** Codice della prestazione nel catalogo regionale (o nel nomenclatore), come in origine. */
    codice: z.string().trim().toUpperCase().max(40).optional(),
    descrizione: optionalText(500),
  })
  .strict();

export const newHistoricalBody = z.discriminatedUnion('tipo', [drugBody, serviceBody]);
export type NewHistorical = z.infer<typeof newHistoricalBody>;

export const annulHistoricalBody = z.object({ motivo: z.string().trim().min(1).max(500) }).strict();

/** Errori formali di una ricetta passata, in italiano; vuoto se va bene. */
export function historicalIssues(h: NewHistorical, today: string): string[] {
  const out: string[] = [];
  if (h.data > today) out.push('Data della ricetta: è nel futuro');
  if (h.tipo === 'farmaco') {
    if (!h.farmaco && !h.principioAttivo && !h.aic)
      out.push('Farmaco: scrivi almeno il nome, il principio attivo o il codice AIC');
    if (h.aic && !AIC_PATTERN.test(h.aic)) out.push('Codice AIC: sono 9 cifre');
    if (h.atc && !ATC_PATTERN.test(h.atc))
      out.push('Codice ATC: non è nel formato ATC (per esempio C08CA01)');
  } else if (!h.codice && !h.descrizione) {
    out.push('Prestazione: scrivi il codice o la descrizione');
  }
  return out;
}

/** Di chi è la ricetta passata e chi la registra. */
export interface HistoricalOwner {
  patientId: string;
  archiveId: string;
  recordedBy: string;
  /** L'importazione da cui arriva (tappa 15); vuoto se scritta a mano. */
  importBatchId?: string | null;
}

/**
 * Scrive la ricetta passata, nella transazione dell'utente (storico delle modifiche). La usano la
 * rotta e l'importazione: prima si controlla con `historicalIssues`.
 */
export async function insertHistorical(
  tx: Tx,
  owner: HistoricalOwner,
  h: NewHistorical,
): Promise<string> {
  const what =
    h.tipo === 'farmaco'
      ? {
          drugAic: h.aic || null,
          drugName: h.farmaco || null,
          activeIngredient: h.principioAttivo || null,
          atcCode: h.atc || null,
          posologyText: h.posologia || null,
          serviceCode: null,
          serviceDescription: null,
        }
      : {
          drugAic: null,
          drugName: null,
          activeIngredient: null,
          atcCode: null,
          posologyText: null,
          serviceCode: h.codice || null,
          serviceDescription: h.descrizione || null,
        };
  const [row] = await tx
    .insert(historicalPrescription)
    .values({
      patientId: owner.patientId,
      archiveId: owner.archiveId,
      kind: h.tipo,
      prescribedOn: h.data,
      ...what,
      quantity: h.quantita ?? null,
      nre: h.nre || null,
      prescriberName: h.prescrittore || null,
      notes: h.note || null,
      sourceProgram: h.programma || null,
      importBatchId: owner.importBatchId ?? null,
      recordedBy: owner.recordedBy,
    })
    .returning({ id: historicalPrescription.id });
  return row!.id;
}

type Row = typeof historicalPrescription.$inferSelect;

/** La ricetta passata del paziente; 404 se non c'è o non si può vedere. */
export async function loadHistorical(
  db: Database | Tx,
  patientId: string,
  id: string,
  reservedAllowed: boolean,
): Promise<Row> {
  const visible = await visibleHistorical(db, patientId, reservedAllowed);
  const row = visible.find((r) => r.id === id);
  if (!row) throw new HttpError(404, 'Ricetta fatta con un altro programma non trovata');
  return row;
}

/** Annullamento con motivo: la ricetta resta, segnata; il SAR non c'entra. */
export async function annulHistorical(tx: Tx, row: Row, reason: string, at: Date): Promise<void> {
  if (row.annulledAt) throw new HttpError(409, 'La ricetta è già annullata');
  await tx
    .update(historicalPrescription)
    .set({ annulledAt: at, annulReason: reason })
    .where(eq(historicalPrescription.id, row.id));
}

/**
 * La ricetta passata come una riga di ricetta, per le regole dello storico (D65, D66, D152): non
 * ha mai una terapia, e il suo tipo dice quali campi contano.
 */
export function historicalLine(r: Row): LineFields {
  const drug = r.kind === 'farmaco';
  return {
    therapyId: null,
    drugAic: drug ? r.drugAic : null,
    drugName: drug ? r.drugName : null,
    activeIngredient: drug ? r.activeIngredient : null,
    serviceCode: drug ? null : r.serviceCode,
    serviceDescription: drug ? null : r.serviceDescription,
  };
}

const lower = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
const same = (a: string | null | undefined, b: string | null | undefined) =>
  !!lower(a) && lower(a) === lower(b);

/**
 * Le ricette passate del paziente che chi chiede può vedere, dalla più recente, annullate
 * comprese. Non hanno l'opzione «riservata»: a chi non legge le voci riservate si nascondono
 * quelle con lo stesso AIC, lo stesso principio attivo o lo stesso nome di una terapia riservata,
 * perché non la rivelino sotto un altro nome.
 */
export async function visibleHistorical(
  db: Database | Tx,
  patientId: string,
  reservedAllowed: boolean,
): Promise<Row[]> {
  const rows = await db
    .select()
    .from(historicalPrescription)
    .where(eq(historicalPrescription.patientId, patientId))
    .orderBy(desc(historicalPrescription.prescribedOn), desc(historicalPrescription.createdAt));
  if (reservedAllowed || rows.length === 0) return rows;
  const reserved = await db
    .select()
    .from(therapy)
    .where(and(eq(therapy.patientId, patientId), eq(therapy.reserved, true)));
  return rows.filter((r) => {
    const l = historicalLine(r);
    // Le prestazioni non sono mai di una terapia.
    if (r.kind === 'prestazione') return true;
    return !reserved.some(
      (t) =>
        same(t.drugAic, l.drugAic) ||
        same(t.activeIngredient, l.activeIngredient) ||
        same(t.drugName, l.drugName),
    );
  });
}

/** Le ricette passate ancora valide (non annullate) di un elenco: quelle che si contano. */
export const activeHistorical = (rows: Row[]) => rows.filter((r) => !r.annulledAt);

/** Quante sono e quando l'ultima: il conto «fatte con un altro programma» di una voce. */
export interface PastCounts {
  ricette: number;
  ultimaIl: string | null;
}

export function pastCounts(rows: Row[]): PastCounts {
  const dates = activeHistorical(rows)
    .map((r) => r.prescribedOn)
    .sort();
  return { ricette: dates.length, ultimaIl: dates.at(-1) ?? null };
}

/** Una ricetta passata nell'interfaccia, con le parole dei requisiti. */
export interface HistoricalView {
  id: string;
  tipo: HistoricalKind;
  data: string;
  aic: string | null;
  farmaco: string | null;
  principioAttivo: string | null;
  atc: string | null;
  codice: string | null;
  descrizione: string | null;
  quantita: number | null;
  posologia: string | null;
  nre: string | null;
  prescrittore: string | null;
  note: string | null;
  programma: string | null;
  /** Arrivata da un'importazione, non scritta a mano. */
  importata: boolean;
  registrataDa: string | null;
  registrataIl: Date;
  stato: 'attiva' | 'annullata';
  annullataIl: Date | null;
  motivoAnnullamento: string | null;
}

export async function historicalViews(db: Database | Tx, rows: Row[]): Promise<HistoricalView[]> {
  const userIds = [...new Set(rows.map((r) => r.recordedBy))];
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
  return rows.map((r) => ({
    id: r.id,
    tipo: r.kind === 'prestazione' ? 'prestazione' : 'farmaco',
    data: r.prescribedOn,
    aic: r.drugAic,
    farmaco: r.drugName,
    principioAttivo: r.activeIngredient,
    atc: r.atcCode,
    codice: r.serviceCode,
    descrizione: r.serviceDescription,
    quantita: r.quantity,
    posologia: r.posologyText,
    nre: r.nre,
    prescrittore: r.prescriberName,
    note: r.notes,
    programma: r.sourceProgram,
    importata: !!r.importBatchId,
    registrataDa: users.get(r.recordedBy) ?? null,
    registrataIl: r.createdAt,
    stato: r.annulledAt ? 'annullata' : 'attiva',
    annullataIl: r.annulledAt,
    motivoAnnullamento: r.annulReason,
  }));
}

/** Che cosa dice una ricetta passata, in una riga: per la cronologia. */
export function historicalSummary(r: Row): string {
  const what =
    r.kind === 'prestazione'
      ? (r.serviceDescription ?? r.serviceCode ?? '')
      : (r.drugName ?? r.activeIngredient ?? (r.drugAic ? `AIC ${r.drugAic}` : ''));
  return [
    r.quantity ? `${what} × ${r.quantity}` : what,
    r.posologyText,
    r.nre && `NRE ${r.nre}`,
    r.prescriberName && `prescritta da ${r.prescriberName}`,
    r.sourceProgram && `con ${r.sourceProgram}`,
  ]
    .filter(Boolean)
    .join(' · ');
}
