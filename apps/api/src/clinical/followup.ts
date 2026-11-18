import { createHash } from 'node:crypto';
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_TYPES, sniffAttachmentType } from '@mmg/domain';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client';
import {
  appUser,
  attachment,
  attachmentContent,
  clinicalEntry,
  prescription,
  prescriptionLine,
  reportDetail,
  serviceExecution,
} from '../db/schema';
import type { Tx } from '../db/tx';
import { HttpError } from '../http/errors';
import { studioDate } from '../prescriptions/rules-check';

const isoDate = z.iso.date();
const optionalText = (max: number) => z.string().trim().max(max).optional();

/** Un file in base64, come arriva dal browser: PDF o immagine, al più 5 MB. */
export const fileBody = z
  .object({
    nome: z.string().trim().min(1).max(200),
    tipo: z.enum(ATTACHMENT_TYPES),
    contenuto: z
      .string()
      .max(Math.ceil((ATTACHMENT_MAX_BYTES * 4) / 3) + 4)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/, 'Il file non è in base64'),
  })
  .strict();

/** Esecuzione di una prestazione prescritta: data, struttura, esito, seduta, referto. */
export const executionBody = z
  .object({
    rigaId: z.uuid(),
    data: isoDate,
    struttura: optionalText(200),
    esito: optionalText(5000),
    /** Seduta del ciclo (es. la 3 di 10); vuota per le prestazioni singole. */
    seduta: z.number().int().min(1).max(999).optional(),
    note: optionalText(1000),
    referto: fileBody.optional(),
  })
  .strict();

/** Corpo massimo delle richieste con un file: 5 MB in base64 e il resto. */
export const FILE_BODY_LIMIT = Math.ceil((ATTACHMENT_MAX_BYTES * 4) / 3) + 64 * 1024;

/** Il file decodificato e controllato: dimensione e firma dei primi byte. */
export function decodeFile(f: z.infer<typeof fileBody>): Buffer {
  if (f.contenuto.length % 4 !== 0) throw new HttpError(400, 'Il file non è in base64');
  const bytes = Buffer.from(f.contenuto, 'base64');
  if (bytes.length === 0) throw new HttpError(400, 'Il file è vuoto');
  if (bytes.length > ATTACHMENT_MAX_BYTES)
    throw new HttpError(400, 'Il file supera 5 MB: va ridotto prima di allegarlo');
  if (sniffAttachmentType(bytes) !== f.tipo)
    throw new HttpError(400, 'Il file non è del tipo dichiarato: si accettano PDF, JPEG e PNG');
  return bytes;
}

/** Salva un allegato su una voce: metadati, impronta e contenuto nel database. */
export async function storeAttachment(
  tx: Tx,
  entryId: string,
  f: z.infer<typeof fileBody>,
  bytes: Buffer,
) {
  const [row] = await tx
    .insert(attachment)
    .values({
      entryId,
      filename: f.nome,
      mediaType: f.tipo,
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      storageKey: 'database',
    })
    .returning({ id: attachment.id });
  await tx.insert(attachmentContent).values({ attachmentId: row!.id, content: bytes });
  return row!.id;
}

/** La riga di ricetta specialistica del paziente, inviata o su carta; altrimenti un errore chiaro. */
export async function loadServiceLine(db: Database | Tx, patientId: string, lineId: string) {
  const [r] = await db
    .select({ line: prescriptionLine, p: prescription })
    .from(prescriptionLine)
    .innerJoin(prescription, eq(prescription.id, prescriptionLine.prescriptionId))
    .where(and(eq(prescriptionLine.id, lineId), eq(prescription.patientId, patientId)));
  if (!r) throw new HttpError(404, 'Prestazione non trovata');
  if (r.p.kind !== 'specialist_ssn')
    throw new HttpError(400, 'Il seguito vale per le prestazioni della ricetta specialistica');
  if (r.p.status !== 'sent' && r.p.status !== 'paper')
    throw new HttpError(
      409,
      'La ricetta non è stata inviata né stampata: la prestazione non è prescritta',
    );
  return r;
}

/** Giorno della prescrizione, nel fuso dello studio. */
const prescribedOn = (p: typeof prescription.$inferSelect) =>
  studioDate(p.sentAt ?? p.paperPrintedAt ?? p.preparedAt);

export async function executionIssues(
  db: Database | Tx,
  r: Awaited<ReturnType<typeof loadServiceLine>>,
  e: z.infer<typeof executionBody>,
  today: string,
): Promise<string[]> {
  const out: string[] = [];
  if (e.data > today) out.push('Data dell’esecuzione: è nel futuro');
  if (e.data < prescribedOn(r.p)) out.push('L’esecuzione non può venire prima della prescrizione');
  if (e.seduta !== undefined) {
    if (e.seduta > r.line.quantity)
      out.push(`Seduta ${e.seduta}: la prescrizione ne prevede ${r.line.quantity}`);
    const [same] = await db
      .select({ id: serviceExecution.id })
      .from(serviceExecution)
      .where(
        and(
          eq(serviceExecution.prescriptionLineId, r.line.id),
          eq(serviceExecution.sessionNumber, e.seduta),
          eq(serviceExecution.status, 'active'),
        ),
      );
    if (same) out.push(`Seduta ${e.seduta}: è già registrata`);
  }
  return out;
}

/** Registra l'esecuzione; con il referto, anche la voce «referto» con l'allegato. */
export async function insertExecution(
  tx: Tx,
  patientId: string,
  userId: string,
  r: Awaited<ReturnType<typeof loadServiceLine>>,
  e: z.infer<typeof executionBody>,
  file: Buffer | null,
) {
  let reportEntryId: string | null = null;
  if (e.referto && file) {
    const [entry] = await tx
      .insert(clinicalEntry)
      .values({
        patientId,
        kind: 'report',
        occurredOn: e.data,
        authorUserId: userId,
        notes: e.esito || null,
      })
      .returning({ id: clinicalEntry.id });
    reportEntryId = entry!.id;
    await tx.insert(reportDetail).values({
      entryId: reportEntryId,
      title: r.line.serviceDescription ?? r.line.serviceCode ?? 'Referto',
      facility: e.struttura || null,
    });
    await storeAttachment(tx, reportEntryId, e.referto, file);
  }
  const [row] = await tx
    .insert(serviceExecution)
    .values({
      patientId,
      prescriptionId: r.p.id,
      prescriptionLineId: r.line.id,
      executedOn: e.data,
      facility: e.struttura || null,
      outcome: e.esito || null,
      sessionNumber: e.seduta ?? null,
      reportEntryId,
      notes: e.note || null,
      recordedBy: userId,
    })
    .returning({ id: serviceExecution.id });
  return row!.id;
}

/** Annullamento con motivo: anche il referto collegato si annulla, con lo stesso motivo. */
export async function annulExecution(
  tx: Tx,
  patientId: string,
  executionId: string,
  userId: string,
  reason: string,
  at: Date,
) {
  const [x] = await tx
    .select()
    .from(serviceExecution)
    .where(and(eq(serviceExecution.id, executionId), eq(serviceExecution.patientId, patientId)));
  if (!x) throw new HttpError(404, 'Esecuzione non trovata');
  if (x.status === 'annulled') throw new HttpError(409, 'L’esecuzione è già annullata');
  await tx
    .update(serviceExecution)
    .set({ status: 'annulled', annulledAt: at, annulledBy: userId, annulReason: reason })
    .where(eq(serviceExecution.id, executionId));
  if (x.reportEntryId)
    await tx
      .update(clinicalEntry)
      .set({ status: 'annulled', annulledAt: at, annulledBy: userId, annulReason: reason })
      .where(and(eq(clinicalEntry.id, x.reportEntryId), eq(clinicalEntry.status, 'active')));
}

/** Le prestazioni prescritte al paziente, dalla più recente, con le esecuzioni e i referti. */
export async function serviceFollowUp(db: Database, patientId: string) {
  const lines = await db
    .select({ line: prescriptionLine, p: prescription })
    .from(prescriptionLine)
    .innerJoin(prescription, eq(prescription.id, prescriptionLine.prescriptionId))
    .where(
      and(
        eq(prescription.patientId, patientId),
        eq(prescription.kind, 'specialist_ssn'),
        inArray(prescription.status, ['sent', 'paper']),
      ),
    )
    .orderBy(desc(prescription.preparedAt), asc(prescriptionLine.position));
  const executions = lines.length
    ? await db
        .select({ x: serviceExecution, by: appUser.displayName })
        .from(serviceExecution)
        .innerJoin(appUser, eq(appUser.id, serviceExecution.recordedBy))
        .where(
          inArray(
            serviceExecution.prescriptionLineId,
            lines.map((l) => l.line.id),
          ),
        )
        .orderBy(asc(serviceExecution.executedOn), asc(serviceExecution.recordedAt))
    : [];
  const reportIds = executions.map((e) => e.x.reportEntryId).filter((v): v is string => !!v);
  const files = reportIds.length
    ? await db.select().from(attachment).where(inArray(attachment.entryId, reportIds))
    : [];
  return lines.map(({ line, p }) => {
    const mine = executions.filter((e) => e.x.prescriptionLineId === line.id);
    return {
      rigaId: line.id,
      ricettaId: p.id,
      nre: p.nre,
      prescrittaIl: prescribedOn(p),
      codice: line.serviceCode,
      descrizione: line.serviceDescription ?? line.serviceCode ?? '',
      quantita: line.quantity,
      eseguite: mine.filter((e) => e.x.status === 'active').length,
      esecuzioni: mine.map(({ x, by }) => {
        const f = files.find((a) => a.entryId === x.reportEntryId);
        return {
          id: x.id,
          data: x.executedOn,
          struttura: x.facility,
          esito: x.outcome,
          seduta: x.sessionNumber,
          note: x.notes,
          stato: x.status === 'annulled' ? ('annullata' as const) : ('attiva' as const),
          motivoAnnullamento: x.annulReason,
          registrataDa: by,
          referto: f
            ? { allegatoId: f.id, nome: f.filename, tipo: f.mediaType, dimensione: f.sizeBytes }
            : null,
        };
      }),
    };
  });
}

/** Un allegato del paziente, con il contenuto; le voci riservate solo a chi le legge. */
export async function loadAttachment(
  db: Database,
  patientId: string,
  attachmentId: string,
  reservedAllowed: boolean,
) {
  const [r] = await db
    .select({ a: attachment, e: clinicalEntry, c: attachmentContent })
    .from(attachment)
    .innerJoin(clinicalEntry, eq(clinicalEntry.id, attachment.entryId))
    .innerJoin(attachmentContent, eq(attachmentContent.attachmentId, attachment.id))
    .where(and(eq(attachment.id, attachmentId), eq(clinicalEntry.patientId, patientId)));
  if (!r || (r.e.reserved && !reservedAllowed)) throw new HttpError(404, 'Allegato non trovato');
  return r;
}
