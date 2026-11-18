import {
  CONSENT_KEYS,
  CONSENT_STATUS,
  checkFiscalCode,
  consentKind,
  currentConsents,
  delegationValidOn,
  keyOf,
} from '@mmg/domain';
import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client';
import { appUser, consent, delegation } from '../db/schema';
import type { Tx } from '../db/tx';
import { HttpError } from '../http/errors';

const isoDate = z.iso.date();
const optionalText = (max: number) => z.string().trim().max(max).optional();

export const consentBody = z
  .object({
    tipo: z.enum(CONSENT_KEYS),
    /** Per «Altro consenso»: che cosa si consente. */
    descrizione: optionalText(300),
    stato: z.enum(['dato', 'negato']),
    data: isoDate,
    /** Se non è il paziente: genitore, tutore, amministratore di sostegno, delegato. */
    espressoDa: optionalText(200),
    note: optionalText(1000),
  })
  .strict()
  .refine((c) => c.tipo !== 'altro' || !!c.descrizione, {
    message: 'Altro consenso: scrivi che cosa si consente',
    path: ['descrizione'],
  });

export const revokeBody = z.object({ data: isoDate }).strict();

export const delegationBody = z
  .object({
    nome: z.string().trim().min(1).max(200),
    codiceFiscale: z.string().trim().toUpperCase().max(16).optional(),
    telefono: optionalText(40),
    email: z.email().max(200).optional(),
    /** Per che cosa vale: ritiro di ricette e promemoria, ricezione del promemoria, … */
    ambito: z.string().trim().min(1).max(300),
    dal: isoDate,
    al: isoDate.optional(),
  })
  .strict();

export function consentIssues(c: z.infer<typeof consentBody>, today: string): string[] {
  return c.data > today ? ['Data del consenso: è nel futuro'] : [];
}

export function delegationIssues(d: z.infer<typeof delegationBody>): string[] {
  const out: string[] = [];
  if (d.codiceFiscale && !checkFiscalCode(d.codiceFiscale).valid)
    out.push('Codice fiscale del delegato: non è valido');
  if (d.al && d.al < d.dal) out.push('La fine della delega non può venire prima dell’inizio');
  return out;
}

export async function insertConsent(
  tx: Tx,
  patientId: string,
  userId: string,
  c: z.infer<typeof consentBody>,
  at: Date,
) {
  const [row] = await tx
    .insert(consent)
    .values({
      patientId,
      kind: c.tipo,
      description: c.tipo === 'altro' ? c.descrizione! : null,
      status: CONSENT_STATUS[c.stato],
      givenOn: c.data,
      expressedBy: c.espressoDa || null,
      notes: c.note || null,
      recordedBy: userId,
      recordedAt: at,
    })
    .returning({ id: consent.id });
  return row!.id;
}

/** Revoca di un consenso dato: la riga resta, con la data della revoca. */
export async function revokeConsent(
  tx: Tx,
  patientId: string,
  consentId: string,
  date: string,
  today: string,
) {
  const [c] = await tx
    .select()
    .from(consent)
    .where(and(eq(consent.id, consentId), eq(consent.patientId, patientId)));
  if (!c) throw new HttpError(404, 'Consenso non trovato');
  if (c.status !== 'given') throw new HttpError(409, 'Si revoca solo un consenso dato');
  if (date > today) throw new HttpError(400, 'Data della revoca: è nel futuro');
  if (c.givenOn && date < c.givenOn)
    throw new HttpError(400, 'La revoca non può venire prima del consenso');
  await tx
    .update(consent)
    .set({ status: 'revoked', revokedOn: date })
    .where(eq(consent.id, consentId));
}

export async function insertDelegation(
  tx: Tx,
  patientId: string,
  d: z.infer<typeof delegationBody>,
) {
  const [row] = await tx
    .insert(delegation)
    .values({
      patientId,
      delegateName: d.nome,
      delegateFiscalCode: d.codiceFiscale || null,
      delegatePhone: d.telefono || null,
      delegateEmail: d.email || null,
      scope: d.ambito,
      validFrom: d.dal,
      validTo: d.al ?? null,
    })
    .returning({ id: delegation.id });
  return row!.id;
}

/** Revoca di una delega: da quel giorno non vale più (R16). */
export async function revokeDelegation(
  tx: Tx,
  patientId: string,
  delegationId: string,
  date: string,
  today: string,
) {
  const [d] = await tx
    .select()
    .from(delegation)
    .where(and(eq(delegation.id, delegationId), eq(delegation.patientId, patientId)));
  if (!d) throw new HttpError(404, 'Delega non trovata');
  if (d.revokedOn) throw new HttpError(409, 'La delega è già revocata');
  if (date > today) throw new HttpError(400, 'Data della revoca: è nel futuro');
  await tx.update(delegation).set({ revokedOn: date }).where(eq(delegation.id, delegationId));
}

/** Consensi (in vigore e storia) e deleghe del paziente, per la pagina della privacy. */
export async function privacyOf(db: Database, patientId: string, today: string) {
  const consents = await db
    .select({ c: consent, recordedByName: appUser.displayName })
    .from(consent)
    .leftJoin(appUser, eq(appUser.id, consent.recordedBy))
    .where(eq(consent.patientId, patientId))
    .orderBy(desc(consent.givenOn), desc(consent.recordedAt));
  const current = currentConsents(consents.map((r) => r.c));
  const view = ({ c, recordedByName }: (typeof consents)[number]) => ({
    id: c.id,
    tipo: c.kind,
    nome: c.kind === 'altro' ? (c.description ?? 'Altro consenso') : consentKind(c.kind)?.label,
    fonte: consentKind(c.kind)?.source ?? null,
    stato: keyOf(CONSENT_STATUS, c.status)!,
    data: c.givenOn,
    revocatoIl: c.revokedOn,
    espressoDa: c.expressedBy,
    note: c.notes,
    registratoDa: recordedByName,
    inVigore: c.kind === 'altro' ? c.status === 'given' : current.get(c.kind)?.id === c.id,
  });
  const delegations = await db
    .select()
    .from(delegation)
    .where(eq(delegation.patientId, patientId))
    .orderBy(asc(delegation.delegateName), desc(delegation.validFrom));
  return {
    consensi: consents.map(view),
    deleghe: delegations.map((d) => ({
      id: d.id,
      nome: d.delegateName,
      codiceFiscale: d.delegateFiscalCode,
      telefono: d.delegatePhone,
      email: d.delegateEmail,
      ambito: d.scope,
      dal: d.validFrom,
      al: d.validTo,
      revocataIl: d.revokedOn,
      validaOggi: delegationValidOn(d, today),
    })),
  };
}
