import { can, type Action } from '@mmg/domain';
import type { AdditionalServicesPortal } from '@mmg/integrations';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { logAccess, logAccessForPatients, type AccessAction } from '../audit/access-log';
import type { Actor } from '../auth/service';
import { annulBody } from '../clinical/entries';
import type { Database } from '../db/client';
import { archive, studio } from '../db/schema';
import { withActor } from '../db/tx';
import { guardPatient, loadArchiveContext, visibleArchives } from '../patients/access';
import { distintaCsv, formatById, loadFormats } from '../ppip/formats';
import {
  annulPpip,
  archiveScope,
  byService,
  catalogItem,
  deliverMonth,
  INTERRUPTED_AFTER_MINUTES,
  insertPpip,
  listPpip,
  lockPpip,
  monthRows,
  monthSchema,
  ppipBody,
  reportDeadline,
  reportsOf,
  sendingAvailable,
  sendMonth,
  settleInterrupted,
  totalOf,
} from '../ppip/service';
import { studioDate } from '../prescriptions/rules-check';
import type { ReferenceData, ReferenceScope } from '../reference/lookup';
import { HttpError } from './errors';

const params = z.object({ id: z.uuid() });
const recordParams = z.object({ id: z.uuid(), ppipId: z.uuid() });
const monthQuery = z.object({ mese: monthSchema }).strict();
const exportQuery = z
  .object({ mese: monthSchema, formato: z.string().max(60).optional() })
  .strict();
const isoDate = z.iso.date();
/** Le prestazioni da inviare che il titolare ha controllato nella distinta (D232). */
const seenRows = z.array(z.uuid()).max(5000);
const sendBody = z.object({ mese: monthSchema, righe: seenRows }).strict();
const reference = z.string().trim().max(200).optional();
const deliveryBody = z
  .object({ mese: monthSchema, righe: seenRows, riferimento: reference })
  .strict();
const settleBody = z
  .object({
    mese: monthSchema,
    esito: z.enum(['arrivata', 'non_arrivata']),
    riferimento: reference,
  })
  .strict();

/**
 * Prestazioni aggiuntive (PPIP, D212): catalogo in vigore, registrazione in cartella, distinta del
 * mese per archivio con il CSV, invio all'ASL (oggi con il simulatore) o consegna fuori dal
 * programma. Le registrano i medici e la segreteria, che prepara; la distinta la leggono il
 * titolare e la segreteria, la manda il titolare (regola 5, D232). La guardia viene prima di ogni
 * validazione.
 */
export function registerPpipRoutes(
  app: FastifyInstance,
  deps: {
    db: Database;
    now: () => Date;
    reference?: ReferenceData;
    portal: AdditionalServicesPortal;
    environment: 'prova' | 'produzione';
  },
): void {
  const { db, now, reference, portal, environment } = deps;
  const scoped = { config: { patientScoped: true } };

  /**
   * Il catalogo è una banca dati pubblica: nessun dato dei pazienti. Con l'archivio, anche gli
   * accordi della sua regione e della sua ASL (D232); senza, quelli della regione dello studio.
   */
  app.get('/api/prestazioni-aggiuntive/catalogo', async (req) => {
    const actor = req.actor!;
    const q = z
      .object({ data: isoDate.optional(), archivio: z.uuid().optional() })
      .strict()
      .parse(req.query ?? {});
    const date = q.data ?? studioDate(now());
    let scope: ReferenceScope;
    if (q.archivio) {
      const [a] = await db
        .select({ id: archive.id })
        .from(archive)
        .where(and(eq(archive.id, q.archivio), eq(archive.studioId, actor.studioId)));
      if (!a) throw new HttpError(404, 'Archivio non trovato');
      scope = await archiveScope(db, a.id);
    } else {
      const [st] = await db
        .select({ region: studio.regionName })
        .from(studio)
        .where(eq(studio.id, actor.studioId));
      scope = { region: st?.region ?? null };
    }
    const items = reference ? await reference.additionalServices(date, scope) : [];
    return {
      data: date,
      voci: items.map((i) => ({
        codice: i.code,
        sezione: i.section,
        descrizione: i.description,
        autorizzazione: i.authorization,
        compenso: i.compensation,
        note: i.notes,
        atto: i.act,
        inVigoreDal: i.validFrom,
      })),
    };
  });

  app.get('/api/pazienti/:id/ppip', scoped, async (req) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    const { patient: p, context } = await guardPatient(db, actor, id, 'ppip.read', 'lettura_ppip');
    return {
      prestazioni: await listPpip(db, id, p.archiveId),
      puoScrivere: can(actor, 'ppip.write', { ...context, now: now() }).allowed,
      // Per il catalogo: gli accordi della regione e dell'ASL dell'archivio (D232).
      archivio: p.archiveId,
    };
  });

  app.post('/api/pazienti/:id/ppip', scoped, async (req, reply) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    const { patient: p } = await guardPatient(db, actor, id, 'ppip.write', 'nuova_ppip');
    const body = ppipBody.parse(req.body);
    if (!reference) throw new HttpError(409, 'Le banche dati non sono disponibili');
    const item = await catalogItem(
      reference,
      body,
      studioDate(now()),
      p.deceasedOn ?? null,
      await archiveScope(db, p.archiveId),
    );
    // Nell'archivio in cui la guardia ha dato il permesso: lì va la distinta (D232).
    const recordId = await withActor(db, actor.userId, (tx) =>
      insertPpip(tx, { patientId: id, archiveId: p.archiveId }, actor.userId, body, item),
    );
    return reply.status(201).send({ id: recordId });
  });

  app.post('/api/pazienti/:id/ppip/:ppipId/annulla', scoped, async (req) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    const { patient: p } = await guardPatient(db, actor, id, 'ppip.write', 'annullamento_ppip');
    const { ppipId } = recordParams.parse(req.params);
    const { motivo } = annulBody.parse(req.body);
    await withActor(db, actor.userId, async (tx) => {
      const r = await lockPpip(tx, ppipId, { patientId: id });
      // Registrata prima che il paziente cambiasse medico: è nella distinta dell'altro archivio.
      if (r.archiveId !== p.archiveId)
        throw new HttpError(
          409,
          'La prestazione è nella distinta dell’archivio in cui è stata registrata: si annulla da quella distinta',
        );
      await annulPpip(tx, r, actor.userId, motivo, now());
    });
    return { id: ppipId, stato: 'annullata' };
  });

  /** Prima il permesso, anche per una richiesta sbagliata: un no resta nel registro. */
  async function guardArchive(
    actor: Actor,
    archiveId: string,
    permission: Action,
    action: AccessAction,
  ) {
    const ctx = await loadArchiveContext(db, archiveId);
    const decision = can(actor, permission, { ...ctx, now: now() });
    if (decision.allowed) return ctx;
    await logAccess(db, {
      studioId: actor.studioId,
      userId: actor.userId,
      action,
      outcome: 'negato',
      workstation: actor.workstation,
      details: { archivio: archiveId, permesso: permission, motivo: decision.reason },
    });
    throw new HttpError(403, decision.reason);
  }

  /** Gli archivi di cui chi guarda legge la distinta delle prestazioni aggiuntive. */
  app.get('/api/ppip/archivi', async (req) => {
    const actor = req.actor!;
    const ids = await visibleArchives(db, actor, 'ppip.report');
    const rows = ids.length
      ? await db
          .select({ id: archive.id, nome: archive.name })
          .from(archive)
          .where(and(eq(archive.studioId, actor.studioId), inArray(archive.id, ids)))
          .orderBy(asc(archive.name))
      : [];
    return { archivi: rows };
  });

  app.get('/api/archivi/:id/ppip', async (req) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    const ctx = await guardArchive(actor, id, 'ppip.report', 'distinta_ppip');
    const { mese } = monthQuery.parse(req.query ?? {});
    const rows = await monthRows(db, id, mese);
    const sending = rows.flatMap((r) => (r.inInvioDal ? [Date.parse(r.inInvioDal)] : []));
    const since = sending.length ? Math.max(...sending) : null;
    const allowed = (a: Action) => can(actor, a, { ...ctx, now: now() }).allowed;
    // La distinta ha i nomi: una riga del registro per paziente.
    await logAccessForPatients(db, [...new Set(rows.map((r) => r.patientId))], {
      studioId: actor.studioId,
      userId: actor.userId,
      action: 'distinta_ppip',
      outcome: 'consentito',
      workstation: actor.workstation,
      details: { archivio: id, mese },
    });
    return {
      mese,
      scadenza: reportDeadline(mese),
      righe: rows.map(({ patientId, ...r }) => ({ ...r, paziente: patientId })),
      perVoce: byService(rows),
      totale: totalOf(rows),
      daInviare: rows.filter((r) => !r.inviata && !r.inInvioDal).length,
      // Un invio della distinta in corso, o rimasto senza risposta: l'esito lo segna il titolare.
      inInvio:
        since === null
          ? null
          : {
              dal: new Date(since).toISOString(),
              interrotto: now().getTime() - since >= INTERRUPTED_AFTER_MINUTES * 60_000,
              righe: sending.length,
            },
      invii: await reportsOf(db, id, mese),
      puoInviare: allowed('ppip.send'),
      puoAnnullare: allowed('ppip.write'),
      // Con il simulatore in produzione l'invio è spento: resta la consegna fuori dal programma.
      invioAttivo: sendingAvailable(portal, environment),
      invioSimulato: portal.environment === 'simulator',
      formati: loadFormats().formati.map((f) => ({ id: f.id, titolo: f.titolo, fonte: f.fonte })),
    };
  });

  app.get('/api/archivi/:id/ppip/esportazione', async (req, reply) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    await guardArchive(actor, id, 'ppip.report', 'esportazione_distinta_ppip');
    const { mese, formato } = exportQuery.parse(req.query ?? {});
    const format = formatById(formato);
    if (!format) throw new HttpError(400, `Formato della distinta sconosciuto: ${formato}`);
    const rows = await monthRows(db, id, mese);
    await logAccessForPatients(db, [...new Set(rows.map((r) => r.patientId))], {
      studioId: actor.studioId,
      userId: actor.userId,
      action: 'esportazione_distinta_ppip',
      outcome: 'consentito',
      workstation: actor.workstation,
      details: { archivio: id, mese, formato: format.id, righe: rows.length },
    });
    void reply.header('content-type', 'text/csv; charset=utf-8');
    void reply.header(
      'content-disposition',
      `attachment; filename="distinta-ppip-${mese}-${format.id}.csv"`,
    );
    return distintaCsv(rows, format);
  });

  app.post('/api/archivi/:id/ppip/invio', async (req) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    await guardArchive(actor, id, 'ppip.send', 'invio_distinta_ppip');
    const { mese, righe } = sendBody.parse(req.body ?? {});
    const result = await sendMonth({
      db,
      portal,
      environment,
      actor,
      archiveId: id,
      month: mese,
      seen: righe,
      today: studioDate(now()),
      at: now(),
    });
    return result;
  });

  /** La distinta consegnata all'ASL fuori dal programma, per esempio con il CSV (D232). */
  app.post('/api/archivi/:id/ppip/consegna', async (req) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    await guardArchive(actor, id, 'ppip.send', 'consegna_distinta_ppip');
    const { mese, righe, riferimento } = deliveryBody.parse(req.body ?? {});
    return deliverMonth({
      db,
      actor,
      archiveId: id,
      month: mese,
      seen: righe,
      reference: riferimento || null,
      today: studioDate(now()),
      at: now(),
    });
  });

  /** L'esito di un invio rimasto senza risposta, chiesto all'ASL (D232). */
  app.post('/api/archivi/:id/ppip/esito', async (req) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    await guardArchive(actor, id, 'ppip.send', 'esito_distinta_ppip');
    const { mese, esito, riferimento } = settleBody.parse(req.body ?? {});
    return settleInterrupted({
      db,
      actor,
      archiveId: id,
      month: mese,
      arrived: esito === 'arrivata',
      reference: riferimento || null,
      at: now(),
    });
  });

  /**
   * Annullamento dalla distinta: per chi lavora sull'archivio in cui la prestazione è registrata,
   * anche se il paziente è passato a un altro medico e la sua cartella non è più qui (D232).
   */
  app.post('/api/archivi/:id/ppip/:ppipId/annulla', async (req) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    await guardArchive(actor, id, 'ppip.write', 'annullamento_ppip');
    const { ppipId } = recordParams.parse(req.params);
    const { motivo } = annulBody.parse(req.body);
    await withActor(db, actor.userId, async (tx) => {
      const r = await lockPpip(tx, ppipId, { archiveId: id });
      await annulPpip(tx, r, actor.userId, motivo, now());
      await logAccess(tx, {
        studioId: actor.studioId,
        userId: actor.userId,
        patientId: r.patientId,
        action: 'annullamento_ppip',
        outcome: 'consentito',
        workstation: actor.workstation,
        details: { archivio: id, prestazione: ppipId, dallaDistinta: true },
      });
    });
    return { id: ppipId, stato: 'annullata' };
  });
}
