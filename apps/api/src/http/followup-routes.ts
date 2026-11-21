import { SUPPLY_CATEGORIES, advancedDressingIssues, can } from '@mmg/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { annulBody, assertNoIssues } from '../clinical/entries';
import {
  annulExecution,
  decodeFile,
  executionBody,
  executionIssues,
  FILE_BODY_LIMIT,
  insertExecution,
  loadAttachment,
  loadServiceLine,
  serviceFollowUp,
} from '../clinical/followup';
import {
  advancedCodesOf,
  annulSupply,
  bodyIssues,
  checkIndication,
  insertSupply,
  listSupplies,
  loadSupply,
  renewalOf,
  renewBody,
  renewSupply,
  supplyBody,
} from '../clinical/supplies';
import type { Database } from '../db/client';
import { withActor } from '../db/tx';
import { guardPatient } from '../patients/access';
import { studioDate } from '../prescriptions/rules-check';
import { ReferenceData, type SupplyCatalogItem } from '../reference/lookup';

const params = z.object({ id: z.uuid() });
const executionParams = z.object({ id: z.uuid(), esecuzioneId: z.uuid() });
const attachmentParams = z.object({ id: z.uuid(), allegatoId: z.uuid() });
const supplyParams = z.object({ id: z.uuid(), presidioId: z.uuid() });

/**
 * Tappa 10: seguito delle prestazioni prescritte (esecuzione, struttura, esito, sedute, referto)
 * e presidi e assistenza integrativa. Il seguito lo scrive il medico e lo legge chi legge il
 * diario; i presidi stanno con le terapie. La guardia viene prima di ogni validazione.
 */
export function registerFollowUpRoutes(app: FastifyInstance, db: Database, now: () => Date) {
  const scoped = { config: { patientScoped: true } };

  app.get('/api/pazienti/:id/seguito', scoped, async (req) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    const { context } = await guardPatient(db, actor, id, 'clinical.diary.read', 'lettura_seguito');
    return {
      prestazioni: await serviceFollowUp(db, id),
      puoScrivere: can(actor, 'clinical.write', { ...context, now: now() }).allowed,
    };
  });

  app.post(
    '/api/pazienti/:id/seguito',
    { ...scoped, bodyLimit: FILE_BODY_LIMIT },
    async (req, reply) => {
      const actor = req.actor!;
      const { id } = params.parse(req.params);
      await guardPatient(db, actor, id, 'clinical.write', 'nuova_esecuzione');
      const body = executionBody.parse(req.body);
      const line = await loadServiceLine(db, id, body.rigaId);
      assertNoIssues(await executionIssues(db, line, body, studioDate(now())));
      const file = body.referto ? decodeFile(body.referto) : null;
      const executionId = await withActor(db, actor.userId, (tx) =>
        insertExecution(tx, id, actor.userId, line, body, file),
      );
      return reply.status(201).send({ id: executionId });
    },
  );

  app.post('/api/pazienti/:id/seguito/:esecuzioneId/annulla', scoped, async (req) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    await guardPatient(db, actor, id, 'clinical.write', 'annullamento_esecuzione');
    const { esecuzioneId } = executionParams.parse(req.params);
    const { motivo } = annulBody.parse(req.body);
    await withActor(db, actor.userId, (tx) =>
      annulExecution(tx, id, esecuzioneId, actor.userId, motivo, now()),
    );
    return { id: esecuzioneId, stato: 'annullata' };
  });

  /** Il file di un allegato (referto), con il tipo controllato all'arrivo e senza script. */
  app.get('/api/pazienti/:id/allegati/:allegatoId', scoped, async (req, reply) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    const { context } = await guardPatient(
      db,
      actor,
      id,
      'clinical.diary.read',
      'lettura_allegato',
    );
    const { allegatoId } = attachmentParams.parse(req.params);
    const reservedAllowed = can(actor, 'reserved.read', { ...context, now: now() }).allowed;
    const { a, c } = await loadAttachment(db, id, allegatoId, reservedAllowed);
    return reply
      .header('content-type', a.mediaType)
      .header('content-disposition', `inline; filename*=UTF-8''${encodeURIComponent(a.filename)}`)
      .header('content-security-policy', 'sandbox')
      .header('cache-control', 'no-store')
      .send(c.content);
  });

  app.get('/api/presidi/categorie', () => ({
    categorie: SUPPLY_CATEGORIES.map((c) => ({
      chiave: c.key,
      nome: c.label,
      fonte: c.source,
      allegato: 'annex' in c ? c.annex : null,
    })),
  }));

  /**
   * Il nomenclatore dei presidi del DPCM LEA in vigore oggi (D218): dati pubblici, come le
   * categorie. Vuoto finché la trascrizione non è controllata e importata (A8).
   */
  app.get('/api/presidi/nomenclatore', async () => {
    const items = await new ReferenceData(db).supplyCatalog(studioDate(now()));
    const out = (type: SupplyCatalogItem['entryType']) =>
      items
        .filter((i) => i.entryType === type)
        .map((i) => ({
          codice: i.code,
          descrizione: i.description,
          gruppo: i.group,
          allegato: i.annex,
          quantita: i.quantity,
          intestazioneQuantita: i.quantityHeading,
          atto: i.act,
        }));
    return { presidi: out('presidio'), malattieRare: out('malattia_rara') };
  });

  app.get('/api/pazienti/:id/presidi', scoped, async (req) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    const { patient: p, context } = await guardPatient(
      db,
      actor,
      id,
      'therapy.read',
      'lettura_presidi',
    );
    const at = { ...context, now: now() };
    return {
      presidi: await listSupplies(
        db,
        id,
        can(actor, 'reserved.read', at).allowed,
        studioDate(now()),
      ),
      puoScrivere: can(actor, 'therapy.write', at).allowed,
      // Le voci che il titolare considera medicazioni avanzate (D237).
      medicazioniAvanzate: await advancedCodesOf(db, p.archiveId),
    };
  });

  app.post('/api/pazienti/:id/presidi', scoped, async (req, reply) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    const { patient: p } = await guardPatient(db, actor, id, 'therapy.write', 'nuovo_presidio');
    const body = supplyBody.parse(req.body);
    assertNoIssues([
      ...bodyIssues(body),
      ...advancedDressingIssues(
        { category: body.categoria, code: body.codice },
        await advancedCodesOf(db, p.archiveId),
      ),
    ]);
    await checkIndication(db, id, body.indicazione);
    const supplyId = await withActor(db, actor.userId, (tx) =>
      insertSupply(tx, id, actor.userId, body),
    );
    return reply.status(201).send({ id: supplyId });
  });

  app.post('/api/pazienti/:id/presidi/:presidioId/rinnova', scoped, async (req, reply) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    const { patient: p, context } = await guardPatient(
      db,
      actor,
      id,
      'therapy.write',
      'rinnovo_presidio',
    );
    const { presidioId } = supplyParams.parse(req.params);
    const r = renewBody.parse(req.body ?? {});
    const reservedAllowed = can(actor, 'reserved.read', { ...context, now: now() }).allowed;
    const newId = await withActor(db, actor.userId, async (tx) => {
      const s = await loadSupply(tx, id, presidioId, reservedAllowed);
      const body = renewalOf(s, r);
      // Anche il rinnovo: una voce scelta come medicazione avanzata dopo la prima prescrizione si
      // prescrive di nuovo in quella categoria (D237).
      assertNoIssues([
        ...bodyIssues(body),
        ...advancedDressingIssues(
          { category: body.categoria, code: body.codice },
          await advancedCodesOf(tx, p.archiveId),
        ),
      ]);
      return renewSupply(tx, s, actor.userId, body, now());
    });
    return reply.status(201).send({ id: newId });
  });

  app.post('/api/pazienti/:id/presidi/:presidioId/annulla', scoped, async (req) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    const { context } = await guardPatient(db, actor, id, 'therapy.write', 'annullamento_presidio');
    const { presidioId } = supplyParams.parse(req.params);
    const { motivo } = annulBody.parse(req.body);
    const reservedAllowed = can(actor, 'reserved.read', { ...context, now: now() }).allowed;
    await withActor(db, actor.userId, async (tx) => {
      const s = await loadSupply(tx, id, presidioId, reservedAllowed);
      await annulSupply(tx, s, actor.userId, motivo, now());
    });
    return { id: presidioId, stato: 'annullata' };
  });
}
