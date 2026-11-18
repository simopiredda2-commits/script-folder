import {
  ANAMNESIS_LABELS,
  ANAMNESIS_SECTIONS,
  CONSENT_KINDS,
  CONTACT_LABELS,
  CONTACT_TYPES,
  ENTRY_TYPE_LABELS,
  ENTRY_TYPES,
  LIFESTYLE_FACTORS,
  MEASURES,
  can,
} from '@mmg/domain';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  annulBody,
  annulEntry,
  assertNoIssues,
  entryIssues,
  entryPatchBody,
  insertEntry,
  listEntries,
  listQuery,
  loadEntry,
  measurementSeries,
  newEntryBody,
  newMeasurementsBody,
  patchEntry,
} from '../clinical/entries';
import type { Database } from '../db/client';
import { withActor } from '../db/tx';
import { guardPatient } from '../patients/access';
import { studioDate } from '../prescriptions/rules-check';

const params = z.object({ id: z.uuid() });
const entryParams = z.object({ id: z.uuid(), voceId: z.uuid() });

/**
 * Voci cliniche dalla cartella (tappa 9): le scrive il medico (clinical.write), le legge chi
 * legge il diario. Ogni richiesta passa prima dalla guardia, che la registra; poi si valida.
 */
export function registerClinicalRoutes(app: FastifyInstance, db: Database, now: () => Date) {
  const scoped = { config: { patientScoped: true } };

  /** Tipi, parametri e consensi con i loro nomi: un'unica fonte, il dominio. */
  app.get('/api/voci-cliniche/catalogo', () => ({
    tipi: ENTRY_TYPES.map((k) => ({ chiave: k, nome: ENTRY_TYPE_LABELS[k] })),
    contatti: CONTACT_TYPES.map((k) => ({ chiave: k, nome: CONTACT_LABELS[k] })),
    sezioniAnamnesi: ANAMNESIS_SECTIONS.map((k) => ({ chiave: k, nome: ANAMNESIS_LABELS[k] })),
    parametri: MEASURES.map((m) => ({
      chiave: m.key,
      nome: m.label,
      unita: m.unit,
      massimo: 'max' in m ? m.max : null,
    })),
    fattori: [...LIFESTYLE_FACTORS],
    consensi: CONSENT_KINDS.map((k) => ({ chiave: k.key, nome: k.label, fonte: k.source })),
  }));

  app.get('/api/pazienti/:id/voci', scoped, async (req) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    const { context } = await guardPatient(db, actor, id, 'clinical.diary.read', 'lettura_voci');
    const q = listQuery.parse(req.query ?? {});
    const at = { ...context, now: now() };
    const voci = await listEntries(db, id, {
      tipo: q.tipo,
      reservedAllowed: can(actor, 'reserved.read', at).allowed,
      includeAnnulled: q.annullate === 'si',
    });
    return { voci, puoScrivere: can(actor, 'clinical.write', at).allowed };
  });

  app.post('/api/pazienti/:id/voci', scoped, async (req, reply) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    await guardPatient(db, actor, id, 'clinical.write', 'nuova_voce');
    const body = newEntryBody.parse(req.body);
    assertNoIssues(entryIssues(body, studioDate(now())));
    const entryId = await withActor(db, actor.userId, (tx) =>
      insertEntry(tx, id, actor.userId, body),
    );
    return reply.status(201).send({ id: entryId });
  });

  /** Parametri della stessa visita, scritti insieme: una voce per parametro. */
  app.post('/api/pazienti/:id/parametri', scoped, async (req, reply) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    await guardPatient(db, actor, id, 'clinical.write', 'nuovi_parametri');
    const body = newMeasurementsBody.parse(req.body);
    const today = studioDate(now());
    const entries = body.misure.map((m) => ({
      tipo: 'misura' as const,
      data: body.data,
      note: body.note,
      riservata: body.riservata,
      parametro: m.parametro,
      valore: m.valore,
    }));
    assertNoIssues(entries.flatMap((e) => entryIssues(e, today)));
    const ids = await withActor(db, actor.userId, async (tx) => {
      const out: string[] = [];
      for (const e of entries) out.push(await insertEntry(tx, id, actor.userId, e));
      return out;
    });
    return reply.status(201).send({ ids });
  });

  app.get('/api/pazienti/:id/parametri', scoped, async (req) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    const { context } = await guardPatient(
      db,
      actor,
      id,
      'clinical.diary.read',
      'lettura_parametri',
    );
    const at = { ...context, now: now() };
    return {
      parametri: await measurementSeries(db, id, can(actor, 'reserved.read', at).allowed),
      puoScrivere: can(actor, 'clinical.write', at).allowed,
    };
  });

  app.patch('/api/pazienti/:id/voci/:voceId', scoped, async (req) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    const { context } = await guardPatient(db, actor, id, 'clinical.write', 'modifica_voce');
    const { voceId } = entryParams.parse(req.params);
    const patch = entryPatchBody.parse(req.body);
    const reservedAllowed = can(actor, 'reserved.read', { ...context, now: now() }).allowed;
    await withActor(db, actor.userId, async (tx) => {
      const entry = await loadEntry(tx, id, voceId, reservedAllowed);
      await patchEntry(tx, entry, patch, studioDate(now()));
    });
    return { id: voceId };
  });

  app.post('/api/pazienti/:id/voci/:voceId/annulla', scoped, async (req) => {
    const actor = req.actor!;
    const { id } = params.parse(req.params);
    const { context } = await guardPatient(db, actor, id, 'clinical.write', 'annullamento_voce');
    const { voceId } = entryParams.parse(req.params);
    const { motivo } = annulBody.parse(req.body);
    const reservedAllowed = can(actor, 'reserved.read', { ...context, now: now() }).allowed;
    await withActor(db, actor.userId, async (tx) => {
      const entry = await loadEntry(tx, id, voceId, reservedAllowed);
      await annulEntry(tx, entry, actor.userId, motivo, now());
    });
    return { id: voceId, stato: 'annullata' };
  });
}
