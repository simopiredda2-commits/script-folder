import { can, type Action } from '@mmg/domain';
import type { AdditionalServicesPortal } from '@mmg/integrations';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { logAccess, logAccessForPatients, type AccessAction } from '../audit/access-log';
import type { Actor } from '../auth/service';
import { annulBody } from '../clinical/entries';
import type { Database } from '../db/client';
import { archive } from '../db/schema';
import { withActor } from '../db/tx';
import { guardPatient, loadArchiveContext, visibleArchives } from '../patients/access';
import { distintaCsv, formatById, loadFormats } from '../ppip/formats';
import {
  annulPpip,
  byService,
  catalogItem,
  insertPpip,
  listPpip,
  loadPpip,
  monthRows,
  monthSchema,
  ppipBody,
  reportDeadline,
  reportsOf,
  sendMonth,
  totalOf,
} from '../ppip/service';
import { studioDate } from '../prescriptions/rules-check';
import type { ReferenceData } from '../reference/lookup';
import { HttpError } from './errors';

const params = z.object({ id: z.uuid() });
const recordParams = z.object({ id: z.uuid(), ppipId: z.uuid() });
const monthQuery = z.object({ mese: monthSchema }).strict();
const exportQuery = z
  .object({ mese: monthSchema, formato: z.string().max(60).optional() })
  .strict();
const isoDate = z.iso.date();

/**
 * Prestazioni aggiuntive (PPIP, D212): catalogo in vigore, registrazione in cartella, distinta del
 * mese per archivio con il CSV, invio all'ASL (oggi con il simulatore). Le registrano i medici e la
 * segreteria, che prepara; la distinta la manda il titolare (regola 5). La guardia viene prima di
 * ogni validazione.
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

  /** Il catalogo è una banca dati pubblica: nessun dato dei pazienti. */
  app.get('/api/prestazioni-aggiuntive/catalogo', async (req) => {
    const q = z
      .object({ data: isoDate.optional() })
      .strict()
      .parse(req.query ?? {});
    const date = q.data ?? studioDate(now());
    const items = reference ? await reference.additionalServices(date) : [];
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
    const { context } = await guardPatient(db, actor, id, 'ppip.read', 'lettura_ppip');
    return {
      prestazioni: await listPpip(db, id),
      puoScrivere: can(actor, 'ppip.write', { ...context, now: now() }).allowed,
    };
  });

  app.post('/api/pazienti/:id/ppip', scoped, async (req, reply) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    const { patient: p } = await guardPatient(db, actor, id, 'ppip.write', 'nuova_ppip');
    const body = ppipBody.parse(req.body);
    if (!reference) throw new HttpError(409, 'Le banche dati non sono disponibili');
    const item = await catalogItem(reference, body, studioDate(now()), p.deceasedOn ?? null);
    const recordId = await withActor(db, actor.userId, (tx) =>
      insertPpip(tx, id, actor.userId, body, item),
    );
    return reply.status(201).send({ id: recordId });
  });

  app.post('/api/pazienti/:id/ppip/:ppipId/annulla', scoped, async (req) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    await guardPatient(db, actor, id, 'ppip.write', 'annullamento_ppip');
    const { ppipId } = recordParams.parse(req.params);
    const { motivo } = annulBody.parse(req.body);
    await withActor(db, actor.userId, async (tx) => {
      const r = await loadPpip(tx, id, ppipId);
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

  /** Gli archivi di cui chi guarda legge le prestazioni aggiuntive. */
  app.get('/api/ppip/archivi', async (req) => {
    const actor = req.actor!;
    const ids = await visibleArchives(db, actor, 'ppip.read');
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
    const ctx = await guardArchive(actor, id, 'ppip.read', 'distinta_ppip');
    const { mese } = monthQuery.parse(req.query ?? {});
    const rows = await monthRows(db, id, mese);
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
      daInviare: rows.filter((r) => !r.inviata).length,
      invii: await reportsOf(db, id, mese),
      puoInviare: can(actor, 'ppip.send', { ...ctx, now: now() }).allowed,
      invioSimulato: portal.environment === 'simulator',
      formati: loadFormats().formati.map((f) => ({ id: f.id, titolo: f.titolo, fonte: f.fonte })),
    };
  });

  app.get('/api/archivi/:id/ppip/esportazione', async (req, reply) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    await guardArchive(actor, id, 'ppip.read', 'esportazione_distinta_ppip');
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
    const { mese } = monthQuery.parse(req.body ?? {});
    const result = await sendMonth({
      db,
      portal,
      environment,
      archiveId: id,
      month: mese,
      today: studioDate(now()),
      userId: actor.userId,
      at: now(),
    });
    await logAccessForPatients(db, result.pazienti, {
      studioId: actor.studioId,
      userId: actor.userId,
      action: 'invio_distinta_ppip',
      outcome: result.esito === 'accepted' ? 'riuscito' : 'fallito',
      workstation: actor.workstation,
      details: { archivio: id, mese, esito: result.esito, righe: result.righe },
    });
    return {
      id: result.id,
      esito: result.esito,
      protocollo: result.protocollo,
      messaggio: result.messaggio,
      righe: result.righe,
      totale: result.totale,
    };
  });
}
