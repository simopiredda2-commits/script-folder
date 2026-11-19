import {
  fiscalCodeCoherence,
  fiscalCodeProblem,
  PATIENT_SEXES,
  PATIENT_STATUSES,
  REMINDER_CHANNELS,
} from '@mmg/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AdminDeps } from '../admin/deps';
import { guardPatient } from '../patients/access';
import {
  addChoice,
  addExemption,
  adminView,
  correctIdentity,
  createPatient,
  endChoice,
  identityCheckSchema,
  proposedArchive,
  renameFamily,
  setFamily,
  updateAdmin,
  updateExemption,
  writableArchives,
} from '../patients/admin';

const idParams = z.object({ id: z.uuid() });
const exemptionParams = z.object({ id: z.uuid(), eid: z.uuid() });
const choiceParams = z.object({ id: z.uuid(), cid: z.uuid() });

/**
 * Pannello amministrativo del paziente (tappa 15): nuovo paziente, anagrafica completa con la
 * correzione dell'identità, dati SSN, stato, stranieri, lavoro, canale del promemoria, nucleo
 * familiare, esenzioni, scelta del medico.
 *
 * Le rotte su un paziente passano dalla guardia prima di ogni validazione: ogni richiesta lascia la
 * sua riga nel registro, anche quando è negata o i dati non vanno. Dopo una modifica riuscita dei
 * dati amministrativi o dell'identità una seconda riga dice che cosa è cambiato.
 */
export function registerPatientAdminRoutes(app: FastifyInstance, deps: AdminDeps): void {
  const { db, now } = deps;
  const scoped = { config: { patientScoped: true } };

  /** Che cosa serve al modulo del nuovo paziente: gli archivi possibili e quello proposto. */
  app.get('/api/pazienti/nuovo', async (req) => {
    const archives = await writableArchives(db, req.actor!, now());
    return {
      archivi: archives,
      archivioProposto: proposedArchive(archives),
      sessi: PATIENT_SEXES.map((s) => ({ chiave: s.key, nome: s.label })),
      stati: PATIENT_STATUSES.map((s) => ({ chiave: s.key, nome: s.label })),
      canali: REMINDER_CHANNELS.map((c) => ({ chiave: c.key, nome: c.label })),
    };
  });

  /**
   * Controllo dell'identità mentre si scrive: problema formale del codice fiscale e coerenza con
   * i dati. Non legge né scrive dati dei pazienti (i doppioni si scoprono al salvataggio).
   */
  app.post('/api/pazienti/verifica', (req, reply) => {
    const input = identityCheckSchema.parse(req.body);
    const problema = fiscalCodeProblem(input.codiceFiscale);
    return reply.send({ problema, avvisi: problema ? [] : fiscalCodeCoherence(input) });
  });

  app.post('/api/pazienti', async (req, reply) => {
    const created = await createPatient(db, req.actor!, req.body, now());
    return reply.status(201).send(created);
  });

  app.get('/api/pazienti/:id/amministrazione', scoped, async (req) => {
    const actor = req.actor!;
    const { id } = idParams.parse(req.params);
    const { patient, context } = await guardPatient(
      db,
      actor,
      id,
      'registry.read',
      'lettura_dati_amministrativi',
    );
    return adminView(db, actor, patient, context, now());
  });

  app.patch('/api/pazienti/:id/amministrazione', scoped, async (req) => {
    const actor = req.actor!;
    const { id } = idParams.parse(req.params);
    const { patient } = await guardPatient(
      db,
      actor,
      id,
      'registry.write',
      'modifica_dati_amministrativi',
    );
    return updateAdmin(db, actor, patient, req.body, now());
  });

  app.post('/api/pazienti/:id/identita', scoped, async (req) => {
    const actor = req.actor!;
    const { id } = idParams.parse(req.params);
    const { patient } = await guardPatient(db, actor, id, 'registry.write', 'correzione_identita');
    return correctIdentity(db, actor, patient, req.body, now());
  });

  app.post('/api/pazienti/:id/esenzioni', scoped, async (req, reply) => {
    const actor = req.actor!;
    const { id } = idParams.parse(req.params);
    const { patient } = await guardPatient(db, actor, id, 'registry.write', 'nuova_esenzione');
    return reply.status(201).send(await addExemption(db, actor, patient, req.body, now()));
  });

  app.patch('/api/pazienti/:id/esenzioni/:eid', scoped, async (req) => {
    const actor = req.actor!;
    const { id } = idParams.parse(req.params);
    const { patient } = await guardPatient(db, actor, id, 'registry.write', 'modifica_esenzione');
    const { eid } = exemptionParams.parse(req.params);
    return updateExemption(db, actor, patient, eid, req.body, now());
  });

  app.post('/api/pazienti/:id/scelte', scoped, async (req, reply) => {
    const actor = req.actor!;
    const { id } = idParams.parse(req.params);
    const { patient } = await guardPatient(db, actor, id, 'registry.write', 'nuova_scelta');
    return reply.status(201).send(await addChoice(db, actor, patient, req.body, now()));
  });

  app.patch('/api/pazienti/:id/scelte/:cid', scoped, async (req) => {
    const actor = req.actor!;
    const { id } = idParams.parse(req.params);
    const { patient } = await guardPatient(db, actor, id, 'registry.write', 'modifica_scelta');
    const { cid } = choiceParams.parse(req.params);
    return endChoice(db, actor, patient, cid, req.body, now());
  });

  /** Nucleo familiare: nuovo con un'etichetta, quello di un altro paziente, oppure nessuno. */
  app.put('/api/pazienti/:id/nucleo', scoped, async (req) => {
    const actor = req.actor!;
    const { id } = idParams.parse(req.params);
    const { patient } = await guardPatient(
      db,
      actor,
      id,
      'registry.write',
      'modifica_dati_amministrativi',
    );
    return setFamily(db, actor, patient, req.body, now(), async (otherId) => {
      const other = await guardPatient(
        db,
        actor,
        otherId,
        'registry.read',
        'lettura_dati_amministrativi',
      );
      return other.patient;
    });
  });

  app.patch('/api/pazienti/:id/nucleo', scoped, async (req) => {
    const actor = req.actor!;
    const { id } = idParams.parse(req.params);
    const { patient } = await guardPatient(
      db,
      actor,
      id,
      'registry.write',
      'modifica_dati_amministrativi',
    );
    return renameFamily(db, actor, patient, req.body);
  });
}
