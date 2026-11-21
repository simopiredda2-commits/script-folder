import type { ReminderSender } from '@mmg/integrations';
import { delegationValidOn } from '@mmg/domain';
import { and, asc, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AccessAction } from '../audit/access-log';
import type { Actor } from '../auth/service';
import type { Database } from '../db/client';
import {
  appUser,
  delegation,
  patient,
  prescription,
  prescriptionDocument,
  reminderDelivery,
} from '../db/schema';
import { HttpError } from '../http/errors';
import { guardPatient } from '../patients/access';
import { studioDate } from '../prescriptions/rules-check';
import { printSettingsFor } from '../admin/print-service';
import { DEFAULT_REMINDER_PAPER, renderPromemoria, renderSoloNre } from './pdf';
import type { PromemoriaData } from './promemoria';

export interface ReminderDeps {
  db: Database;
  sender: ReminderSender;
  now?: () => Date;
}

const sendSchema = z
  .object({
    canale: z.enum(['email', 'sms']),
    destinatario: z.enum(['paziente', 'delegato']),
    delega: z.uuid().optional(),
  })
  .strict()
  .refine((b) => b.destinatario !== 'delegato' || !!b.delega, {
    message: 'Per un delegato serve la delega registrata',
    path: ['delega'],
  });

const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/**
 * Consegna del promemoria. Ricetta SSN: dai dati fissati all'invio, completo oppure solo NRE, e
 * mai prima del codice di autenticazione. Ricetta bianca: solo il PDF prodotto dal SAC, così com'è
 * («non sono ammesse stampe prodotte in proprio dai gestionali dei medici», Disciplinare tecnico,
 * 1/12/2022). Email e SMS solo a un recapito del paziente o di un delegato registrato (R16).
 */
export function createReminderService(deps: ReminderDeps) {
  const { db, sender } = deps;
  const now = deps.now ?? (() => new Date());

  /** La ricetta dello studio, dopo la guardia del paziente: anche il rifiuto entra nel registro. */
  async function guarded(actor: Actor, id: string, action: AccessAction) {
    const [row] = await db
      .select({ p: prescription })
      .from(prescription)
      .innerJoin(patient, eq(patient.id, prescription.patientId))
      .where(and(eq(prescription.id, id), eq(patient.studioId, actor.studioId)));
    if (!row) throw new HttpError(404, 'Ricetta non trovata');
    const { patient: pt } = await guardPatient(
      db,
      actor,
      row.p.patientId,
      'reminder.print',
      action,
    );
    return { p: row.p, pt };
  }

  function requireSent(p: typeof prescription.$inferSelect) {
    if (p.status !== 'sent' || !p.nre)
      throw new HttpError(
        409,
        'Il promemoria si consegna solo per una ricetta inviata e accettata',
      );
  }

  async function document(prescriptionId: string, kind: 'promemoria_dati' | 'promemoria_sac') {
    const [doc] = await db
      .select()
      .from(prescriptionDocument)
      .where(
        and(
          eq(prescriptionDocument.prescriptionId, prescriptionId),
          eq(prescriptionDocument.kind, kind),
        ),
      )
      .orderBy(asc(prescriptionDocument.createdAt))
      .limit(1);
    return doc ?? null;
  }

  /**
   * Il PDF da consegnare: per la bianca quello del SAC, per la SSN il nostro dai dati fissati, sulla
   * carta della postazione di chi lo chiede (preferenze di stampa, D180 e D222).
   */
  async function pdfFor(
    actor: Actor,
    p: typeof prescription.$inferSelect,
    format: 'completo' | 'nre',
  ) {
    if (p.kind === 'white') {
      if (format === 'nre')
        throw new HttpError(
          409,
          'Per la ricetta bianca si consegna solo il promemoria prodotto dal SAC: NRBE e PIN si possono dettare o mandare per SMS',
        );
      const doc = await document(p.id, 'promemoria_sac');
      if (!doc) throw new HttpError(409, 'Il SAC non ha prodotto il promemoria di questa ricetta');
      return {
        bytes: new Uint8Array(Buffer.from(doc.content, 'base64')),
        name: `promemoria-${p.nre}.pdf`,
      };
    }
    if (!p.authCode)
      throw new HttpError(
        409,
        'Manca il codice di autenticazione del SAC: la ricetta non è valida e il promemoria non si dà',
      );
    const doc = await document(p.id, 'promemoria_dati');
    if (!doc) throw new HttpError(409, 'Mancano i dati del promemoria fissati all’invio');
    const data = JSON.parse(doc.content) as PromemoriaData;
    const paper = await chosenPaper(actor);
    const bytes =
      format === 'nre' ? await renderSoloNre(data, paper) : await renderPromemoria(data, paper);
    return { bytes, name: `${format === 'nre' ? 'nre' : 'promemoria'}-${p.nre}.pdf` };
  }

  /** Stampa: il PDF, e la consegna registrata. */
  async function print(actor: Actor, id: string, query: unknown) {
    const { p } = await guarded(actor, id, 'stampa_promemoria');
    const { formato } = z
      .object({ formato: z.enum(['completo', 'nre']).default('completo') })
      .parse(query);
    requireSent(p);
    const pdf = await pdfFor(actor, p, formato);
    await db.insert(reminderDelivery).values({
      prescriptionId: p.id,
      userId: actor.userId,
      at: now(),
      channel: formato === 'nre' ? 'stampa_nre' : 'stampa_promemoria',
      outcome: 'stampato',
    });
    return pdf;
  }

  /** A chi va: il recapito del paziente, oppure quello di una delega valida oggi (R16). */
  async function recipient(
    pt: typeof patient.$inferSelect,
    channel: 'email' | 'sms',
    who: 'paziente' | 'delegato',
    delegationId?: string,
  ) {
    if (who === 'paziente') {
      const to = channel === 'email' ? pt.email : pt.phone;
      if (!to)
        throw new HttpError(
          409,
          channel === 'email'
            ? 'Il paziente non ha un’email in anagrafica'
            : 'Il paziente non ha un telefono in anagrafica',
        );
      return { to, kind: 'paziente' as const, delegationId: null };
    }
    const today = studioDate(now());
    const [d] = await db
      .select()
      .from(delegation)
      .where(and(eq(delegation.id, delegationId!), eq(delegation.patientId, pt.id)));
    const valid = d && delegationValidOn(d, today);
    if (!valid) throw new HttpError(409, 'La delega non è registrata o non è valida oggi (R16)');
    const to = channel === 'email' ? d.delegateEmail : d.delegatePhone;
    if (!to)
      throw new HttpError(
        409,
        channel === 'email'
          ? 'Il delegato non ha un’email registrata'
          : 'Il delegato non ha un telefono registrato',
      );
    return { to, kind: 'delegato' as const, delegationId: d.id };
  }

  /** Invio per email (con il promemoria allegato) o SMS (solo il numero di ricetta). */
  async function send(actor: Actor, id: string, body: unknown) {
    const { p, pt } = await guarded(actor, id, 'invio_promemoria');
    const input = sendSchema.parse(body);
    requireSent(p);
    const to = await recipient(pt, input.canale, input.destinatario, input.delega);
    const date = ddmmyyyy(studioDate(p.sentAt ?? now()));
    let result;
    if (input.canale === 'email') {
      const pdf = await pdfFor(actor, p, 'completo');
      result = await sender.sendEmail({
        to: to.to,
        subject: `Promemoria della ricetta del ${date}`,
        text: `In allegato il promemoria della ricetta del ${date}. Per la farmacia o la prenotazione servono il numero di ricetta e il codice fiscale.`,
        attachments: [{ filename: pdf.name, contentType: 'application/pdf', content: pdf.bytes }],
      });
    } else {
      if (p.kind !== 'white' && !p.authCode)
        throw new HttpError(
          409,
          'Manca il codice di autenticazione del SAC: la ricetta non è valida',
        );
      result = await sender.sendSms({
        to: to.to,
        text:
          p.kind === 'white'
            ? `Ricetta bianca elettronica del ${date}: NRBE ${p.nre}, PIN ${p.pinNrbe ?? '-'}. Serve anche il codice fiscale.`
            : `Ricetta elettronica del ${date}: NRE ${p.nre}. Serve anche il codice fiscale.`,
      });
    }
    const outcome =
      result.outcome === 'sent'
        ? 'consegnato'
        : result.outcome === 'rejected'
          ? 'rifiutato'
          : 'non_raggiungibile';
    await db.insert(reminderDelivery).values({
      prescriptionId: p.id,
      userId: actor.userId,
      at: now(),
      channel: input.canale,
      recipientKind: to.kind,
      delegationId: to.delegationId,
      recipient: to.to,
      environment: sender.environment,
      outcome,
      messageId: result.outcome === 'sent' ? result.messageId : null,
      errorMessage: result.outcome === 'sent' ? null : result.message,
    });
    if (result.outcome !== 'sent') throw new HttpError(502, result.message);
    return { esito: outcome, recapito: to.to, destinatario: to.kind };
  }

  /** La carta scelta per il promemoria nella postazione e nello studio di chi stampa (D222). */
  async function chosenPaper(actor: Actor) {
    return (await printSettingsFor(db, actor, 'promemoria')).paper ?? DEFAULT_REMINDER_PAPER;
  }

  /**
   * La carta su cui esce il promemoria di questa ricetta: quella scelta per il modello del 2024,
   * sempre A4 per i dati della versione 1, che si ristampano com'erano (D217, D232).
   */
  async function paperOf(actor: Actor, p: typeof prescription.$inferSelect) {
    if (p.kind === 'white' || !p.authCode) return null;
    const doc = await document(p.id, 'promemoria_dati');
    if (!doc) return null;
    const data = JSON.parse(doc.content) as PromemoriaData;
    return data.versione === 1 ? 'A4' : await chosenPaper(actor);
  }

  /** Le consegne di una ricetta, dalla più recente, e la carta del suo promemoria. */
  async function deliveries(actor: Actor, id: string) {
    const { p } = await guarded(actor, id, 'lettura_consegne_promemoria');
    const rows = await db
      .select({
        il: reminderDelivery.at,
        canale: reminderDelivery.channel,
        destinatario: reminderDelivery.recipientKind,
        recapito: reminderDelivery.recipient,
        esito: reminderDelivery.outcome,
        errore: reminderDelivery.errorMessage,
        da: appUser.displayName,
      })
      .from(reminderDelivery)
      .innerJoin(appUser, eq(appUser.id, reminderDelivery.userId))
      .where(eq(reminderDelivery.prescriptionId, p.id))
      .orderBy(desc(reminderDelivery.id));
    return { consegne: rows, carta: await paperOf(actor, p) };
  }

  /** Recapiti per il promemoria: quelli del paziente e le deleghe, con la validità di oggi (R16). */
  async function contacts(actor: Actor, patientId: string) {
    const { patient: pt } = await guardPatient(
      db,
      actor,
      patientId,
      'reminder.print',
      'lettura_recapiti_promemoria',
    );
    const today = studioDate(now());
    const rows = await db
      .select()
      .from(delegation)
      .where(eq(delegation.patientId, pt.id))
      .orderBy(asc(delegation.delegateName));
    return {
      paziente: { email: pt.email, telefono: pt.phone },
      deleghe: rows.map((d) => ({
        id: d.id,
        nome: d.delegateName,
        email: d.delegateEmail,
        telefono: d.delegatePhone,
        valida: !d.revokedOn && d.validFrom <= today && (d.validTo === null || today <= d.validTo),
      })),
    };
  }

  return { print, send, deliveries, contacts };
}
