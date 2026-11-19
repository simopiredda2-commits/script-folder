import { can } from '@mmg/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Database } from '../db/client';
import { withActor } from '../db/tx';
import { guardPatient } from '../patients/access';
import {
  annulHistorical,
  annulHistoricalBody,
  historicalIssues,
  insertHistorical,
  loadHistorical,
  newHistoricalBody,
} from '../prescriptions/historical';
import { studioDate } from '../prescriptions/rules-check';
import { HttpError } from './errors';

const params = z.object({ id: z.uuid() });
const historicalParams = z.object({ id: z.uuid(), ricettaId: z.uuid() });

/**
 * Ricette fatte con un altro programma (tappa 15): le registra il medico (clinical.write), come le
 * voci cliniche. Si leggono negli elenchi dei farmaci e delle prestazioni prescritti, nel loro
 * storico e nella cronologia. Ogni richiesta passa prima dalla guardia, che la registra; poi si
 * valida il resto.
 */
export function registerHistoricalPrescriptionRoutes(
  app: FastifyInstance,
  db: Database,
  now: () => Date,
) {
  const scoped = { config: { patientScoped: true } };

  app.post('/api/pazienti/:id/ricette-passate', scoped, async (req, reply) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    const { patient } = await guardPatient(
      db,
      actor,
      id,
      'clinical.write',
      'nuova_ricetta_passata',
    );
    const body = newHistoricalBody.parse(req.body);
    const issues = historicalIssues(body, studioDate(now()));
    if (issues.length) throw new HttpError(400, issues.join('. '), { problemi: issues });
    const ricettaId = await withActor(db, actor.userId, (tx) =>
      insertHistorical(
        tx,
        { patientId: id, archiveId: patient.archiveId, recordedBy: actor.userId },
        body,
      ),
    );
    return reply.status(201).send({ id: ricettaId });
  });

  /** Annullamento con motivo, per una ricetta registrata per errore: resta, segnata. */
  app.post('/api/pazienti/:id/ricette-passate/:ricettaId/annulla', scoped, async (req) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    const { context } = await guardPatient(
      db,
      actor,
      id,
      'clinical.write',
      'annullamento_ricetta_passata',
    );
    const { ricettaId } = historicalParams.parse(req.params);
    const { motivo } = annulHistoricalBody.parse(req.body);
    const reservedAllowed = can(actor, 'reserved.read', { ...context, now: now() }).allowed;
    await withActor(db, actor.userId, async (tx) => {
      const row = await loadHistorical(tx, id, ricettaId, reservedAllowed);
      await annulHistorical(tx, row, motivo, now());
    });
    return { id: ricettaId, stato: 'annullata' };
  });
}
