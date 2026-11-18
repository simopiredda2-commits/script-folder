import { can } from '@mmg/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { annulBody, assertNoIssues } from '../clinical/entries';
import type { Database } from '../db/client';
import { withActor } from '../db/tx';
import { guardPatient } from '../patients/access';
import {
  annulPlan,
  insertPlan,
  listPlans,
  loadPlan,
  planBody,
  planIssues,
  updatePlan,
} from '../patients/plans';
import {
  consentBody,
  consentIssues,
  delegationBody,
  delegationIssues,
  insertConsent,
  insertDelegation,
  privacyOf,
  revokeBody,
  revokeConsent,
  revokeDelegation,
} from '../patients/privacy';
import { studioDate } from '../prescriptions/rules-check';

const params = z.object({ id: z.uuid() });
const consentParams = z.object({ id: z.uuid(), consensoId: z.uuid() });
const delegationParams = z.object({ id: z.uuid(), delegaId: z.uuid() });
const planParams = z.object({ id: z.uuid(), pianoId: z.uuid() });

/**
 * Privacy (consensi e deleghe: chi gestisce l'anagrafica, segreteria compresa) e piani
 * terapeutici (chi modifica le terapie). La guardia viene prima di ogni validazione.
 */
export function registerPrivacyRoutes(app: FastifyInstance, db: Database, now: () => Date) {
  const scoped = { config: { patientScoped: true } };

  app.get('/api/pazienti/:id/privacy', scoped, async (req) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    const { context } = await guardPatient(db, actor, id, 'registry.read', 'lettura_privacy');
    return {
      ...(await privacyOf(db, id, studioDate(now()))),
      puoScrivere: can(actor, 'registry.write', { ...context, now: now() }).allowed,
    };
  });

  app.post('/api/pazienti/:id/consensi', scoped, async (req, reply) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    await guardPatient(db, actor, id, 'registry.write', 'nuovo_consenso');
    const body = consentBody.parse(req.body);
    assertNoIssues(consentIssues(body, studioDate(now())));
    const consentId = await withActor(db, actor.userId, (tx) =>
      insertConsent(tx, id, actor.userId, body, now()),
    );
    return reply.status(201).send({ id: consentId });
  });

  app.post('/api/pazienti/:id/consensi/:consensoId/revoca', scoped, async (req) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    await guardPatient(db, actor, id, 'registry.write', 'revoca_consenso');
    const { consensoId } = consentParams.parse(req.params);
    const { data } = revokeBody.parse(req.body);
    await withActor(db, actor.userId, (tx) =>
      revokeConsent(tx, id, consensoId, data, studioDate(now())),
    );
    return { id: consensoId, stato: 'revocato' };
  });

  app.post('/api/pazienti/:id/deleghe', scoped, async (req, reply) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    await guardPatient(db, actor, id, 'registry.write', 'nuova_delega');
    const body = delegationBody.parse(req.body);
    assertNoIssues(delegationIssues(body));
    const delegationId = await withActor(db, actor.userId, (tx) => insertDelegation(tx, id, body));
    return reply.status(201).send({ id: delegationId });
  });

  app.post('/api/pazienti/:id/deleghe/:delegaId/revoca', scoped, async (req) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    await guardPatient(db, actor, id, 'registry.write', 'revoca_delega');
    const { delegaId } = delegationParams.parse(req.params);
    const { data } = revokeBody.parse(req.body);
    await withActor(db, actor.userId, (tx) =>
      revokeDelegation(tx, id, delegaId, data, studioDate(now())),
    );
    return { id: delegaId, stato: 'revocata' };
  });

  app.get('/api/pazienti/:id/piani', scoped, async (req) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    const { context } = await guardPatient(db, actor, id, 'therapy.read', 'lettura_piani');
    const at = { ...context, now: now() };
    return {
      piani: await listPlans(db, id, can(actor, 'reserved.read', at).allowed, studioDate(now())),
      puoScrivere: can(actor, 'therapy.write', at).allowed,
    };
  });

  app.post('/api/pazienti/:id/piani', scoped, async (req, reply) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    await guardPatient(db, actor, id, 'therapy.write', 'nuovo_piano');
    const body = planBody.parse(req.body);
    assertNoIssues(planIssues(body, studioDate(now())));
    const planId = await withActor(db, actor.userId, (tx) =>
      insertPlan(tx, id, actor.userId, body),
    );
    return reply.status(201).send({ id: planId });
  });

  app.put('/api/pazienti/:id/piani/:pianoId', scoped, async (req) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    const { context } = await guardPatient(db, actor, id, 'therapy.write', 'modifica_piano');
    const { pianoId } = planParams.parse(req.params);
    const body = planBody.parse(req.body);
    assertNoIssues(planIssues(body, studioDate(now())));
    const reservedAllowed = can(actor, 'reserved.read', { ...context, now: now() }).allowed;
    await withActor(db, actor.userId, async (tx) => {
      const plan = await loadPlan(tx, id, pianoId, reservedAllowed);
      await updatePlan(tx, plan, body, now());
    });
    return { id: pianoId };
  });

  app.post('/api/pazienti/:id/piani/:pianoId/annulla', scoped, async (req) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    const { context } = await guardPatient(db, actor, id, 'therapy.write', 'annullamento_piano');
    const { pianoId } = planParams.parse(req.params);
    const { motivo } = annulBody.parse(req.body);
    const reservedAllowed = can(actor, 'reserved.read', { ...context, now: now() }).allowed;
    await withActor(db, actor.userId, async (tx) => {
      const plan = await loadPlan(tx, id, pianoId, reservedAllowed);
      await annulPlan(tx, plan, actor.userId, motivo, now());
    });
    return { id: pianoId, stato: 'annullato' };
  });
}
