import { can, fiscalCodeFacts } from '@mmg/domain';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { newPatientBody } from '../aura/new-patients';
import { adminBodyFor, REGISTRY_FIELD_KEYS } from '../aura/registry';
import type { AuraService } from '../aura/service';
import type { Actor } from '../auth/service';
import { logAccess, logAccessForPatients, type AccessAction } from '../audit/access-log';
import type { Database } from '../db/client';
import { auraDoctorChange, auraNewPatient } from '../db/schema';
import { withActor } from '../db/tx';
import { guardPatient, loadArchiveContext, visibleArchives } from '../patients/access';
import { createPatientIn, settleNewPatientError, updateAdmin } from '../patients/admin';
import { studioDate } from '../prescriptions/rules-check';
import type { ReferenceData } from '../reference/lookup';
import { HttpError } from './errors';

const idParams = z.object({ id: z.uuid() });
/** Il cambio di medico come l'ha visto chi decide (D200): se AURA nel frattempo cambia, si ricarica. */
const seenBody = z
  .object({ medico: z.uuid(), sceltaDal: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) })
  .strict();
const changesQuery = z.object({ giorni: z.coerce.number().int().min(1).max(90).default(7) });
/** Per ogni differenza: il valore di AURA che si è visto, e se usarlo o no. */
const choicesBody = z
  .object({
    scelte: z
      .array(
        z
          .object({
            campo: z.enum(REGISTRY_FIELD_KEYS),
            inAura: z.string().trim().min(1).max(300),
            usa: z.boolean(),
          })
          .strict(),
      )
      .min(1)
      .max(REGISTRY_FIELD_KEYS.length),
  })
  .strict();

/**
 * AURA, l'anagrafe regionale degli assistiti (D197): stato del collegamento e variazioni di un
 * paziente, controllo subito («Aggiorna da AURA»), variazioni recenti dello studio. Ogni rotta su un
 * paziente passa dalla guardia dell'archivio e lascia la sua riga nel registro.
 */
export function registerAuraRoutes(
  app: FastifyInstance,
  deps: { db: Database; aura: AuraService; now: () => Date; reference?: ReferenceData },
): void {
  const { db, aura, now, reference } = deps;
  const scoped = { config: { patientScoped: true } };

  /** Un nuovo assistito dello studio di chi chiede (D199); 404 se non c'è. */
  async function candidate(actor: Actor, id: string) {
    const [c] = await db
      .select()
      .from(auraNewPatient)
      .where(and(eq(auraNewPatient.id, id), eq(auraNewPatient.studioId, actor.studioId)));
    if (!c) throw new HttpError(404, 'Nuovo assistito non trovato');
    return c;
  }

  /** Prima il permesso: scrivere l'anagrafica nell'archivio del medico scelto. Un no si registra. */
  async function guardCandidate(
    actor: Actor,
    c: typeof auraNewPatient.$inferSelect,
    action: AccessAction,
  ) {
    const decision = can(actor, 'registry.write', {
      ...(await loadArchiveContext(db, c.archiveId)),
      now: now(),
    });
    if (decision.allowed) return;
    await logAccess(db, {
      studioId: actor.studioId,
      userId: actor.userId,
      action,
      outcome: 'negato',
      workstation: actor.workstation,
      details: { permesso: 'registry.write', nuovoAssistito: c.id, motivo: decision.reason },
    });
    throw new HttpError(403, decision.reason);
  }

  /**
   * Nuovi assistiti segnalati da AURA (D199): chi ha scelto un medico dello studio e non è ancora
   * nel suo archivio, negli archivi dove chi legge può registrare pazienti. La lettura si registra.
   */
  app.get('/api/aura/nuovi', async (req) => {
    const actor = req.actor!;
    const archives = await visibleArchives(db, actor, 'registry.write');
    const rows = await aura.newPatientsFor(actor.studioId, archives);
    if (rows.length)
      await logAccess(db, {
        studioId: actor.studioId,
        userId: actor.userId,
        action: 'lettura_nuovi_assistiti_aura',
        outcome: 'consentito',
        workstation: actor.workstation,
        details: { nuoviAssistiti: rows.map((r) => r.c.id) },
      });
    return {
      disponibile: aura.available(),
      nuovi: rows.map(({ c, doctor }) => ({
        id: c.id,
        cognome: c.lastName,
        nome: c.firstName,
        nascita: c.birthDate,
        codiceFiscale: c.fiscalCode,
        medico: doctor,
        sceltaDal: c.chosenOn,
        scadenza: c.expiresOn,
        segnalatoIl: c.notifiedAt.toISOString(),
      })),
    };
  });

  /**
   * «Registra» (D199): il paziente entra nell'archivio del medico con i dati di AURA e i controlli
   * di «Nuovo paziente», poi si collega ad AURA, che porta esenzioni e scelte. Un assistito alla
   * volta, insieme alle notifiche: due clic non registrano due volte. Chi arriva mentre un altro
   * registra non aspetta il blocco (terrebbe occupata una connessione al database): lo si dice.
   *
   * Una transazione sola (D226): il paziente e l'assistito «registrato» entrano insieme o per niente.
   * Il comune di nascita si legge prima, dalla banca dati; dentro, tutto passa da `tx`. I rifiuti
   * entrano nel registro dopo il ritorno indietro.
   */
  app.post('/api/aura/nuovi/:id/registra', async (req, reply) => {
    const actor = req.actor!;
    const { id } = idParams.parse(req.params);
    const first = await candidate(actor, id);
    await guardCandidate(actor, first, 'nuovo_paziente');
    const at = now();
    const facts = fiscalCodeFacts(first.fiscalCode);
    const place = facts ? await reference?.municipality(facts.placeCode, studioDate(at)) : null;
    let created: { id: string; avvisi: string[] };
    try {
      created = await withActor(db, actor.userId, async (tx) => {
        const lock = await tx.execute<{ preso: boolean }>(
          sql`select pg_try_advisory_xact_lock(hashtextextended(${`aura-nuovo:${first.auraId}`}, 0)) as preso`,
        );
        if (!lock.rows[0]?.preso)
          throw new HttpError(409, 'Registrazione già in corso: ricarica la pagina tra poco');
        // Bloccato fino alla fine: «Non registrare» aspetta e poi trova l'assistito registrato,
        // invece di uscire dall'elenco mentre il paziente entra (D232).
        const [c] = await tx
          .select()
          .from(auraNewPatient)
          .where(eq(auraNewPatient.id, id))
          .for('update');
        if (c!.status !== 'da_registrare')
          throw new HttpError(
            409,
            c!.status === 'registrato'
              ? 'Già registrato'
              : 'Non è più fra i nuovi assistiti: ricarica la pagina',
            c!.patientId ? { paziente: { id: c!.patientId } } : undefined,
          );
        // Il comune di nascita viene dal codice fiscale letto prima: se AURA l'ha cambiato, si ricarica.
        if (c!.fiscalCode !== first.fiscalCode)
          throw new HttpError(409, 'AURA ha cambiato il codice fiscale: ricarica la pagina');
        const p = await createPatientIn(tx, actor, newPatientBody(c!, place?.name ?? null), at, {
          details: { fonte: 'AURA', nuovoAssistito: c!.id },
          choiceFromAura: true,
        });
        const done = await tx
          .update(auraNewPatient)
          .set({ status: 'registrato', patientId: p.id, decidedBy: actor.userId, decidedAt: at })
          .where(and(eq(auraNewPatient.id, id), eq(auraNewPatient.status, 'da_registrare')))
          .returning({ id: auraNewPatient.id });
        if (!done.length)
          throw new HttpError(409, 'Non è più fra i nuovi assistiti: ricarica la pagina');
        return p;
      });
    } catch (thrown) {
      const err = await settleNewPatientError(db, thrown);
      // Il codice fiscale c'è già nello studio: l'assistito esce dall'elenco, e lo si dice.
      const details = err instanceof HttpError ? (err.details as { paziente?: unknown }) : null;
      if (err instanceof HttpError && err.statusCode === 409 && details && 'paziente' in details)
        await withActor(db, actor.userId, (tx) =>
          tx
            .update(auraNewPatient)
            .set({ status: 'superato' })
            .where(and(eq(auraNewPatient.id, id), eq(auraNewPatient.status, 'da_registrare'))),
        );
      throw err;
    }
    const sync = await aura.syncPatient(created.id, 'manuale', actor.userId);
    void reply.code(201);
    return {
      id: created.id,
      avvisi: created.avvisi,
      aura: { esito: sync.outcome, messaggio: sync.message, variazioni: sync.changes },
    };
  });

  /** «Non registrare» (D199): esce dall'elenco e non si ripropone finché AURA non manda una scelta nuova. */
  app.post('/api/aura/nuovi/:id/non-registrare', async (req) => {
    const actor = req.actor!;
    const { id } = idParams.parse(req.params);
    const c = await candidate(actor, id);
    await guardCandidate(actor, c, 'nuovo_assistito_non_registrato');
    const at = now();
    // La riga dell'assistito è bloccata da un «Registra» in corso: si aspetta, e poi si vede com'è.
    // La scelta e la sua riga del registro entrano insieme (D232). Vale solo per l'archivio e il
    // medico su cui si è controllato il permesso: se intanto AURA ha cambiato la scelta, non passa
    // (D239).
    await withActor(db, actor.userId, async (tx) => {
      const done = await tx
        .update(auraNewPatient)
        .set({ status: 'non_registrato', decidedBy: actor.userId, decidedAt: at })
        .where(
          and(
            eq(auraNewPatient.id, id),
            eq(auraNewPatient.status, 'da_registrare'),
            eq(auraNewPatient.archiveId, c.archiveId),
            eq(auraNewPatient.doctorUserId, c.doctorUserId),
          ),
        )
        .returning({ id: auraNewPatient.id });
      if (done.length === 0)
        throw new HttpError(
          409,
          'Non è più fra i nuovi assistiti di questo medico: ricarica la pagina',
        );
      await logAccess(tx, {
        studioId: actor.studioId,
        userId: actor.userId,
        action: 'nuovo_assistito_non_registrato',
        outcome: 'riuscito',
        workstation: actor.workstation,
        details: { nuovoAssistito: id, archivio: c.archiveId },
      });
    });
    return { id, stato: 'non_registrato' };
  });

  /** Un cambio di medico dello studio di chi chiede (D200); 404 se non c'è. */
  async function doctorChange(actor: Actor, id: string) {
    const [c] = await db
      .select()
      .from(auraDoctorChange)
      .where(and(eq(auraDoctorChange.id, id), eq(auraDoctorChange.studioId, actor.studioId)));
    if (!c) throw new HttpError(404, 'Cambio di medico non trovato');
    return c;
  }

  /** Decide solo il titolare dell'archivio dove il paziente sta (archive.transfer). Un no si registra. */
  async function guardDoctorChange(
    actor: Actor,
    c: typeof auraDoctorChange.$inferSelect,
    action: AccessAction,
  ) {
    const decision = can(actor, 'archive.transfer', {
      ...(await loadArchiveContext(db, c.fromArchiveId)),
      now: now(),
    });
    if (decision.allowed) return;
    await logAccess(db, {
      studioId: actor.studioId,
      userId: actor.userId,
      patientId: c.patientId,
      action,
      outcome: 'negato',
      workstation: actor.workstation,
      details: { permesso: 'archive.transfer', cambio: c.id, motivo: decision.reason },
    });
    throw new HttpError(403, decision.reason);
  }

  /**
   * Cambi di medico dentro lo studio (D200): per il titolare dell'archivio dove il paziente sta,
   * quelli da decidere; per il medico scelto, chi l'ha scelto e chi decide, senza il collegamento
   * alla cartella (non è nel suo archivio). Le letture restano nel registro, paziente per paziente.
   */
  app.get('/api/aura/cambi-medico', async (req) => {
    const actor = req.actor!;
    const own = new Set(await visibleArchives(db, actor, 'archive.transfer'));
    const rows = await aura.pendingDoctorChanges(actor.studioId);
    const toDecide = rows.filter((r) => own.has(r.c.fromArchiveId));
    const incoming = rows.filter(
      (r) => !own.has(r.c.fromArchiveId) && r.c.toDoctorUserId === actor.userId,
    );
    await logAccessForPatients(
      db,
      [...new Set([...toDecide, ...incoming].map((r) => r.c.patientId))],
      {
        studioId: actor.studioId,
        userId: actor.userId,
        action: 'lettura_cambi_medico',
        outcome: 'consentito',
        workstation: actor.workstation,
      },
    );
    return {
      disponibile: aura.available(),
      daDecidere: toDecide.map((r) => ({
        id: r.c.id,
        paziente: { id: r.c.patientId, cognome: r.lastName, nome: r.firstName },
        medico: r.toName,
        medicoId: r.c.toDoctorUserId,
        sceltaDal: r.c.chosenOn,
      })),
      inArrivo: incoming.map((r) => ({
        id: r.c.id,
        paziente: { cognome: r.lastName, nome: r.firstName },
        daMedico: r.fromName,
        sceltaDal: r.c.chosenOn,
      })),
    };
  });

  /** «Sposta» (D200): il paziente passa nell'archivio del medico scelto in AURA. */
  app.post('/api/aura/cambi-medico/:id/sposta', async (req) => {
    const actor = req.actor!;
    const { id } = idParams.parse(req.params);
    const c = await doctorChange(actor, id);
    // Prima la guardia: anche una richiesta sbagliata lascia la sua riga nel registro.
    await guardDoctorChange(actor, c, 'spostamento_archivio');
    const seen = seenBody.parse(req.body);
    const r = await aura.moveToChosenDoctor(id, actor, {
      doctorUserId: seen.medico,
      chosenOn: seen.sceltaDal,
    });
    return {
      id,
      stato: 'spostato',
      paziente: { id: r.patientId, archivio: r.archiveId },
      statoPaziente: r.status,
    };
  });

  /** «Non spostare» (D200): resta nell'archivio, e non si ripropone senza una scelta nuova. */
  app.post('/api/aura/cambi-medico/:id/non-spostare', async (req) => {
    const actor = req.actor!;
    const { id } = idParams.parse(req.params);
    const c = await doctorChange(actor, id);
    await guardDoctorChange(actor, c, 'cambio_medico_non_spostato');
    const seen = seenBody.parse(req.body);
    await aura.keepInArchive(id, actor, { doctorUserId: seen.medico, chosenOn: seen.sceltaDal });
    return { id, stato: 'non_spostato' };
  });

  app.get('/api/pazienti/:id/aura', scoped, async (req) => {
    const { id } = idParams.parse(req.params);
    await guardPatient(db, req.actor!, id, 'registry.read', 'lettura_dati_amministrativi');
    return aura.patientState(id);
  });

  app.post('/api/pazienti/:id/aura', scoped, async (req) => {
    const actor = req.actor!;
    const { id } = idParams.parse(req.params);
    await guardPatient(db, actor, id, 'registry.write', 'aggiornamento_aura');
    if (!aura.available()) throw new HttpError(409, 'AURA non è ancora collegata al servizio vero');
    const r = await aura.syncPatient(id, 'manuale', actor.userId);
    return {
      esito: r.outcome,
      messaggio: r.message,
      variazioni: r.changes,
      stato: await aura.patientState(id),
    };
  });

  /**
   * Anagrafica da AURA (D198): medico o segreteria usano il valore di AURA (con i controlli del
   * pannello amministrativo) o scelgono di non usarlo. Si risponde solo alle differenze di adesso,
   * con il valore che si è visto: se AURA nel frattempo ha cambiato, si ricarica.
   */
  app.post('/api/pazienti/:id/aura/differenze', scoped, async (req) => {
    const actor = req.actor!;
    const { id } = idParams.parse(req.params);
    // Prima la guardia: anche una richiesta sbagliata lascia la sua riga nel registro.
    const { patient, context } = await guardPatient(
      db,
      actor,
      id,
      'registry.write',
      'modifica_dati_amministrativi',
    );
    const { scelte } = choicesBody.parse(req.body);
    const current = await aura.differences(id);
    const chosen = scelte.map((s) => {
      const d = current.find((c) => c.campo === s.campo);
      if (!d || d.inAura !== s.inAura)
        throw new HttpError(
          409,
          'I dati di AURA sono cambiati, o la differenza non c’è più: ricarica il pannello',
        );
      return { ...d, usa: s.usa };
    });
    const used = chosen.filter((c) => c.usa);
    const notUsed = chosen.filter((c) => !c.usa);
    const r = used.length
      ? await updateAdmin(db, actor, patient, context, adminBodyFor(used), now(), {
          fonte: 'AURA',
        })
      : { campi: [] };
    if (notUsed.length) {
      await aura.dismiss(id, notUsed);
      await logAccess(db, {
        studioId: actor.studioId,
        userId: actor.userId,
        patientId: id,
        action: 'aggiornamento_aura',
        outcome: 'riuscito',
        workstation: actor.workstation,
        details: { nonUsati: notUsed.map((c) => c.campo) },
      });
    }
    return {
      campi: r.campi,
      nonUsati: notUsed.map((c) => c.campo),
      stato: await aura.patientState(id),
    };
  });

  /**
   * Variazioni arrivate da AURA negli ultimi giorni e anagrafiche da confermare (il decesso per
   * primo), dei pazienti che l'utente può vedere.
   */
  app.get('/api/aura/variazioni', async (req) => {
    const actor = req.actor!;
    const { giorni } = changesQuery.parse(req.query);
    const archives = await visibleArchives(db, actor, 'registry.read');
    const rows = await aura.recentChanges(actor.studioId, archives, giorni);
    const pending = await aura.pendingForArchives(actor.studioId, archives);
    const shown = [...rows.map((r) => r.pazienteId), ...pending.map((r) => r.pazienteId)];
    await logAccessForPatients(db, [...new Set(shown)], {
      studioId: actor.studioId,
      userId: actor.userId,
      action: 'lettura_variazioni_aura',
      outcome: 'consentito',
      workstation: actor.workstation,
      details: { giorni },
    });
    return {
      disponibile: aura.available(),
      giorni,
      variazioni: rows.map((r) => ({
        quando: r.quando.toISOString(),
        tipo: r.tipo,
        variazione: r.variazione,
        descrizione: r.descrizione,
        paziente: { id: r.pazienteId, cognome: r.cognome, nome: r.nome },
      })),
      daConfermare: pending.map((r) => ({
        paziente: { id: r.pazienteId, cognome: r.cognome, nome: r.nome },
        campi: r.campi,
        decesso: r.decesso,
      })),
    };
  });
}
