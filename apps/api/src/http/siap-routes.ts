import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { logAccess, logAccessForPatients } from '../audit/access-log';
import type { Actor } from '../auth/service';
import type { Database } from '../db/client';
import { patient, siapContact, studio } from '../db/schema';
import { withActor, type Tx } from '../db/tx';
import { guardPatient, visibleArchives } from '../patients/access';
import {
  activeProblems,
  confirmBody,
  confirmContact,
  contactBody,
  discardBody,
  discardContact,
  listContacts,
  periodQuery,
  updateContact,
} from '../siap/contacts';
import { siapValues } from '../siap/values';
import { HttpError } from './errors';

const ONLY_DOCTORS = 'I contatti per il SIAP li vedono e li confermano i medici, per gli atti loro';
const params = z.object({ id: z.uuid() });
const patientRef = z.object({ paziente: z.uuid() }).loose();

/**
 * Contatti del SIAP (D291): il medico vede i suoi contatti del periodo, proposti dagli atti, e li
 * conferma, li cambia o li scarta. Solo i medici, anche il sostituto per i suoi; la segreteria no
 * (regola 5). La guardia viene prima di ogni validazione del contenuto.
 */
export function registerSiapRoutes(
  app: FastifyInstance,
  deps: { db: Database; now: () => Date },
): void {
  const { db, now } = deps;

  /** Il paziente resta nell'archivio in cui la guardia ha dato il permesso fino alla fine. */
  async function held(tx: Tx, patientId: string, archiveId: string) {
    const [p] = await tx
      .select({ archiveId: patient.archiveId })
      .from(patient)
      .where(eq(patient.id, patientId))
      .for('share');
    if (p?.archiveId !== archiveId)
      throw new HttpError(
        409,
        'Nel frattempo il paziente è passato a un altro archivio: ricarica la pagina',
      );
  }

  /** Il contatto è del medico che chiede, e del paziente. */
  async function ownContact(actor: Actor, id: string) {
    const [c] = await db.select().from(siapContact).where(eq(siapContact.id, id));
    if (!c || c.studioId !== actor.studioId) throw new HttpError(404, 'Contatto non trovato');
    return c;
  }

  app.get('/api/siap/contatti', async (req) => {
    const actor = req.actor!;
    const archiveIds = await visibleArchives(db, actor, 'siap.contacts');
    if (!archiveIds.length) {
      await logAccess(db, {
        studioId: actor.studioId,
        userId: actor.userId,
        action: 'lettura_contatti_siap',
        outcome: 'negato',
        workstation: actor.workstation,
        details: { permesso: 'siap.contacts', motivo: ONLY_DOCTORS },
      });
      throw new HttpError(403, ONLY_DOCTORS);
    }
    const { dal, al } = periodQuery.parse(req.query);
    const contacts = await listContacts(db, actor.userId, archiveIds, dal, al);
    const patientIds = [...new Set(contacts.map((c) => c.paziente.id))];
    await logAccessForPatients(db, patientIds, {
      studioId: actor.studioId,
      userId: actor.userId,
      action: 'lettura_contatti_siap',
      outcome: 'consentito',
      workstation: actor.workstation,
      details: { dal, al },
    });
    const [s] = await db
      .select({ codice: studio.structureCode, tipo: studio.structureType })
      .from(studio)
      .where(eq(studio.id, actor.studioId));
    const values = siapValues();
    const domain = (d: { chiave: string; codice: number; descrizione: string }[]) =>
      d.map((x) => ({ chiave: x.chiave, codice: x.codice, descrizione: x.descrizione }));
    return {
      dal,
      al,
      struttura: s ?? { codice: null, tipo: null },
      contatti: contacts,
      problemi: await activeProblems(db, patientIds),
      tipologie: values.tipologie.map((t) => ({
        codice: t.codice,
        descrizione: t.descrizione,
        dettagli: t.dettagli,
      })),
      modalita: domain(values.modalitaContatto),
      accessi: domain(values.tipologiaAccesso),
      statiProblema: domain(values.statoProblema),
    };
  });

  app.post('/api/siap/contatti/conferma', async (req, reply) => {
    const actor = req.actor!;
    const { paziente } = patientRef.parse(req.body);
    const { patient: p } = await guardPatient(
      db,
      actor,
      paziente,
      'siap.contacts',
      'conferma_contatto_siap',
    );
    const body = confirmBody.parse(req.body);
    const row = await withActor(db, actor.userId, async (tx) => {
      await held(tx, p.id, p.archiveId);
      return confirmContact(tx, {
        studioId: actor.studioId,
        doctorId: actor.userId,
        archiveId: p.archiveId,
        patientId: p.id,
        day: body.giorno,
        choice: body,
        now: now(),
      });
    });
    return reply.status(201).send({ id: row.id, progressivo: row.daySequence });
  });

  app.put('/api/siap/contatti/:id', async (req) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    const c = await ownContact(actor, id);
    const { patient: p } = await guardPatient(
      db,
      actor,
      c.patientId,
      'siap.contacts',
      'modifica_contatto_siap',
    );
    if (c.doctorId !== actor.userId)
      throw new HttpError(403, 'Il contatto è di un altro medico: lo cambia lui');
    const body = contactBody.parse(req.body);
    const row = await withActor(db, actor.userId, async (tx) => {
      await held(tx, p.id, p.archiveId);
      const [fresh] = await tx
        .select()
        .from(siapContact)
        .where(eq(siapContact.id, id))
        .for('update');
      return updateContact(tx, fresh!, { archiveId: p.archiveId, choice: body, now: now() });
    });
    return { id: row.id, progressivo: row.daySequence };
  });

  app.post('/api/siap/contatti/scarta', async (req) => {
    const actor = req.actor!;
    const { paziente } = patientRef.parse(req.body);
    const { patient: p } = await guardPatient(
      db,
      actor,
      paziente,
      'siap.contacts',
      'scarto_contatto_siap',
    );
    const body = discardBody.parse(req.body);
    const row = await withActor(db, actor.userId, async (tx) => {
      await held(tx, p.id, p.archiveId);
      return discardContact(tx, {
        studioId: actor.studioId,
        doctorId: actor.userId,
        archiveId: p.archiveId,
        patientId: p.id,
        day: body.giorno,
        reason: body.motivo,
        now: now(),
      });
    });
    return { id: row.id };
  });
}
