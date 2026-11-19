import { createHash } from 'node:crypto';
import {
  can,
  IMPORT_DATE_FORMATS,
  IMPORT_DESTINATIONS,
  IMPORT_NUMBER_RULE,
  importDestination,
  NO_VALUES,
  suggestColumns,
  suggestDestination,
  YES_VALUES,
  type Decision,
} from '@mmg/domain';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';
import type { AdminDeps } from '../admin/deps';
import { logAccess, logAccessForPatients, type AccessAction } from '../audit/access-log';
import type { Actor } from '../auth/service';
import { appUser, archive, importBatch, importProfile } from '../db/schema';
import { withActor } from '../db/tx';
import { HttpError } from '../http/errors';
import { loadArchiveContext } from '../patients/access';
import { archiveClosedToNewPatients } from '../patients/archive-owner';
import { studioDate } from '../prescriptions/rules-check';
import { ReferenceData } from '../reference/lookup';
import { entryHandlers } from './destinations';
import { convertRow, prepareRow, rowMatches, runImport, type EngineResult } from './engine';
import { importError, sqlState } from './errors';
import {
  LOCK_TIMEOUT,
  MAX_FILE_BYTES,
  MAX_COLUMNS,
  MAX_HEADER_ROW,
  MAX_ROWS,
  PREVIEW_ROWS,
  STATEMENT_TIMEOUT,
  UPLOAD_BODY_LIMIT,
} from './limits';
import {
  describeColumns,
  headerAt,
  mappingSchema,
  resolveMapping,
  type ImportMapping,
} from './mapping';
import { readImportFile } from './read';
import { reportCsv } from './report';
import { UploadStore } from './store';
import { undoBatch } from './undo';
import { columnLetter, FileRejected, type ImportTable, type ReadFile } from './table';

/**
 * Importazione da altri programmi (tappa 15): file CSV, XLSX, JSON e la nostra esportazione,
 * mappatura delle colonne verso i campi di ogni menu della cartella, anteprima, prova senza
 * scrivere, importazione con la provenienza di ogni riga, profili riusabili.
 *
 * Solo il medico titolare, sul proprio archivio (permesso «importare», come l'esportazione: D21).
 * Il registro ha l'id dell'importazione e i conteggi, mai contenuti; una riga per paziente quando
 * la prova o la scrittura toccano una cartella che c'è già, o la scrittura ne crea una.
 */

/** Motivo nel registro del paziente di un altro archivio trovato nel file. */
const FOREIGN = 'paziente di un altro archivio: non si importa';

/** Classe del blocco consultivo: un'importazione alla volta per archivio. */
const IMPORT_LOCK_CLASS = 4620120;

export const BATCH_STATUS = {
  caricato: 'caricato',
  prova: 'prova',
  importato: 'importato',
  annullato: 'annullato',
} as const;

const SEPARATORS = { automatico: undefined, ';': ';', ',': ',', tab: '\t', '|': '|' } as const;

const uploadBody = z
  .object({
    nome: z.string().trim().min(1).max(200),
    contenuto: z
      .string()
      .max(Math.ceil((MAX_FILE_BYTES * 4) / 3) + 4)
      .regex(/^[A-Za-z0-9+/]*={0,2}$/, 'Il file non è in base64'),
    separatore: z.enum(['automatico', ';', ',', 'tab', '|']).optional(),
  })
  .strict();

const idParams = z.object({ id: z.uuid() });
/** Motivo dell'annullamento: come quello di una voce annullata a mano. */
const undoBody = z.object({ motivo: z.string().trim().min(1).max(500) }).strict();
const mappingBody = z.object({ mappatura: mappingSchema }).strict();
const columnsQuery = z
  .object({
    tabella: z.string().min(1).max(100),
    intestazione: z.coerce.number().int().min(0).max(MAX_HEADER_ROW),
    destinazione: z.string().max(40).optional(),
  })
  .strict();
const profileBody = z
  .object({
    nome: z.string().trim().min(1).max(100),
    programma: z.string().trim().max(100).nullable().optional(),
    formato: z.enum(['csv', 'xlsx', 'json', 'mmg-esportazione']),
    mappatura: mappingSchema,
  })
  .strict();

class DryRunRollback extends Error {
  constructor(readonly result: EngineResult) {
    super('prova senza scrivere: transazione annullata');
  }
}

const sha256 = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');

/** Colonne suggerite per una destinazione, come riferimenti per l'interfaccia. */
function suggestedRefs(destinationKey: string, header: string[]) {
  const d = importDestination(destinationKey);
  if (!d) return {};
  return Object.fromEntries(
    Object.entries(suggestColumns(d, header)).map(([field, col]) => [
      field,
      { lettera: columnLetter(col), nome: header[col] ?? '' },
    ]),
  );
}

/** Che cosa c'è in un foglio, per scegliere intestazione, destinazione e colonne. */
function describeTable(t: ImportTable, headerLine: number) {
  const { header, rows } = headerAt(t, headerLine);
  const guess = suggestDestination(header);
  return {
    nome: t.name,
    righe: rows.length,
    larghezza: t.width,
    intestazione: headerLine,
    // Le prime righe del foglio, accorciate: per scegliere quale è l'intestazione.
    inizio: t.records.slice(0, 8).map((r) => ({
      riga: r.line,
      celle: r.cells.map((c) => (c.length > 60 ? `${c.slice(0, 60)}…` : c)),
    })),
    colonne: describeColumns(header, rows),
    suggerimento: guess
      ? { destinazione: guess.key, campi: suggestedRefs(guess.key, header) }
      : null,
  };
}

function analysis(file: ReadFile) {
  return {
    formato: file.format,
    codifica: file.encoding ?? null,
    separatore: file.separator === '\t' ? 'tab' : (file.separator ?? null),
    note: file.notes,
    tabelle: file.tables.map((t) => describeTable(t, t.records[0]?.line ?? 0)),
    mappaturaProposta: file.proposed ?? null,
  };
}

type Batch = typeof importBatch.$inferSelect;

export function registerImportRoutes(app: FastifyInstance, deps: AdminDeps): void {
  const { db } = deps;
  const store = new UploadStore(deps.now);
  // Regola 1: fuori dalla produzione solo pazienti inventati (D12, D170).
  const onlyFictitious = deps.environment !== 'produzione';
  // Le esenzioni si controllano sul catalogo in vigore, se è importato (altrimenti nessun avviso).
  const reference = new ReferenceData(db, undefined, {
    now: deps.now,
    expectedSince: (at) => deps.referenceUpdates.expectedSince(at),
  });

  /** L'archivio di cui l'utente è titolare e la decisione sul permesso «importare». */
  async function ownArchive(
    actor: Actor,
  ): Promise<{ archiveId: string | null; decision: Decision }> {
    const [own] = await db
      .select({ id: archive.id })
      .from(archive)
      .where(and(eq(archive.studioId, actor.studioId), eq(archive.ownerUserId, actor.userId)));
    if (!own)
      return {
        archiveId: null,
        decision: { allowed: false, reason: 'Nessun archivio di cui sei titolare' },
      };
    const decision = can(actor, 'data.import', {
      ...(await loadArchiveContext(db, own.id)),
      now: deps.now(),
    });
    return { archiveId: own.id, decision };
  }

  /** Permesso e registro del rifiuto; restituisce l'archivio. */
  async function guard(actor: Actor, action: AccessAction, details: Record<string, unknown>) {
    const { archiveId, decision } = await ownArchive(actor);
    if (!decision.allowed || !archiveId) {
      await logAccess(db, {
        studioId: actor.studioId,
        userId: actor.userId,
        action,
        outcome: 'negato',
        workstation: actor.workstation,
        details: { ...details, permesso: 'data.import', motivo: decision.reason },
      });
      throw new HttpError(403, decision.reason);
    }
    return archiveId;
  }

  const log = (
    actor: Actor,
    action: AccessAction,
    outcome: 'consentito' | 'riuscito' | 'fallito',
    details: Record<string, unknown>,
  ) =>
    logAccess(db, {
      studioId: actor.studioId,
      userId: actor.userId,
      action,
      outcome,
      workstation: actor.workstation,
      details: { permesso: 'data.import', ...details },
    });

  async function loadBatch(archiveId: string, id: string): Promise<Batch> {
    const [b] = await db
      .select()
      .from(importBatch)
      .where(and(eq(importBatch.id, id), eq(importBatch.archiveId, archiveId)));
    if (!b) throw new HttpError(404, 'Importazione non trovata');
    return b;
  }

  function upload(actor: Actor, batch: Batch) {
    const u = store.get(batch.id, actor.userId);
    if (!u)
      throw new HttpError(
        410,
        batch.status === BATCH_STATUS.importato
          ? 'Questa importazione è già stata scritta: per importare di nuovo, carica il file.'
          : 'Il file non è più disponibile (è passata più di un’ora, o il servizio è ripartito): caricalo di nuovo.',
      );
    return u;
  }

  /** Errore del caricamento: 413 per il corpo troppo grande, gli altri come nel servizio. */
  const uploadErrors = (err: FastifyError, req: FastifyRequest, reply: FastifyReply) => {
    // Nei log del servizio solo il codice: il messaggio di un errore del database ha i valori.
    if (!(err instanceof HttpError) && !(err instanceof ZodError))
      req.log.error({ codice: err.code ?? sqlState(err) }, 'caricamento non riuscito');
    if (err.code === 'FST_ERR_CTP_BODY_TOO_LARGE')
      void reply.status(413).send({
        errore: `Il file supera ${MAX_FILE_BYTES / 1048576} MB: dividilo in file più piccoli.`,
      });
    else if (err instanceof HttpError)
      void reply
        .status(err.statusCode)
        .send(
          err.details === undefined
            ? { errore: err.message }
            : { errore: err.message, dettagli: err.details },
        );
    else if (err instanceof ZodError)
      void reply.status(400).send({ errore: 'Dati non validi', dettagli: err.issues });
    else void reply.status(500).send({ errore: 'Errore interno' });
  };

  /** Catalogo delle destinazioni, con i campi e le regole delle trasformazioni. */
  app.get('/api/importazioni/catalogo', async (req) => {
    const { decision } = await ownArchive(req.actor!);
    if (!decision.allowed) throw new HttpError(403, decision.reason);
    return {
      destinazioni: [...IMPORT_DESTINATIONS].sort((a, b) => a.order - b.order),
      formatiData: IMPORT_DATE_FORMATS,
      regolaNumeri: IMPORT_NUMBER_RULE,
      valoriSi: YES_VALUES,
      valoriNo: NO_VALUES,
      limiti: { dimensione: MAX_FILE_BYTES, righe: MAX_ROWS, colonne: MAX_COLUMNS },
    };
  });

  /** Caricamento: il file una volta sola, letto e descritto; il contenuto resta in memoria. */
  app.post(
    '/api/importazioni',
    { bodyLimit: UPLOAD_BODY_LIMIT, errorHandler: uploadErrors },
    async (req, reply) => {
      const actor = req.actor!;
      const archiveId = await guard(actor, 'importazione', { fase: 'caricamento' });
      const body = uploadBody.parse(req.body);
      if (body.contenuto.length % 4 !== 0) throw new HttpError(400, 'Il file non è in base64');
      const bytes = new Uint8Array(Buffer.from(body.contenuto, 'base64'));
      const impronta = sha256(bytes);
      let file: ReadFile;
      try {
        file = readImportFile(bytes, { separator: SEPARATORS[body.separatore ?? 'automatico'] });
      } catch (e) {
        if (!(e instanceof FileRejected)) throw e;
        await log(actor, 'importazione', 'fallito', {
          fase: 'caricamento',
          dimensione: bytes.length,
          impronta,
          motivo: 'file non leggibile',
        });
        throw new HttpError(e.statusCode, e.message);
      }
      const previous = await db
        .select({ at: importBatch.finishedAt })
        .from(importBatch)
        .where(
          and(
            eq(importBatch.archiveId, archiveId),
            eq(importBatch.fileSha256, impronta),
            eq(importBatch.status, BATCH_STATUS.importato),
          ),
        )
        .orderBy(desc(importBatch.finishedAt))
        .limit(1);
      const [batch] = await withActor(db, actor.userId, (tx) =>
        tx
          .insert(importBatch)
          .values({
            studioId: actor.studioId,
            archiveId,
            userId: actor.userId,
            fileName: body.nome,
            fileSha256: impronta,
            fileSize: bytes.length,
            format: file.format,
            destination: 'da_scegliere',
            status: BATCH_STATUS.caricato,
            createdAt: deps.now(),
          })
          .returning(),
      );
      store.put({ batchId: batch!.id, archiveId, userId: actor.userId, file, size: bytes.length });
      const rows = file.tables.reduce((n, t) => n + t.records.length, 0);
      await log(actor, 'importazione', 'consentito', {
        fase: 'caricamento',
        importazione: batch!.id,
        formato: file.format,
        dimensione: bytes.length,
        tabelle: file.tables.length,
        righe: rows,
      });
      return reply.status(201).send({
        id: batch!.id,
        file: { nome: body.nome, dimensione: bytes.length, impronta },
        giaImportatoIl: previous[0]?.at?.toISOString() ?? null,
        ...analysis(file),
      });
    },
  );

  /** Colonne e suggerimenti di un foglio con un'altra riga d'intestazione, o per una destinazione. */
  app.get('/api/importazioni/:id/colonne', async (req) => {
    const actor = req.actor!;
    const { id } = idParams.parse(req.params);
    const { archiveId, decision } = await ownArchive(actor);
    if (!decision.allowed || !archiveId) throw new HttpError(403, decision.reason);
    const q = columnsQuery.parse(req.query);
    const u = upload(actor, await loadBatch(archiveId, id));
    const table = u.file.tables.find((t) => t.name === q.tabella);
    if (!table) throw new HttpError(404, 'Foglio non trovato nel file');
    const described = describeTable(table, q.intestazione);
    const { header } = headerAt(table, q.intestazione);
    return {
      ...described,
      campi: q.destinazione ? suggestedRefs(q.destinazione, header) : null,
    };
  });

  /** Anteprima delle prime righe trasformate e controllate, senza toccare le cartelle. */
  app.post('/api/importazioni/:id/anteprima', async (req) => {
    const actor = req.actor!;
    const { id } = idParams.parse(req.params);
    const { archiveId, decision } = await ownArchive(actor);
    if (!decision.allowed || !archiveId) throw new HttpError(403, decision.reason);
    const u = upload(actor, await loadBatch(archiveId, id));
    const { mappatura } = mappingBody.parse(req.body);
    const parts = resolveMapping(u.file.tables, mappatura);
    const today = studioDate(deps.now());
    const handlers = entryHandlers();
    return {
      parti: parts.map((p) => {
        const matching = p.rows.filter((r) => rowMatches(p, r.cells));
        return {
          indice: p.index,
          destinazione: p.destination.key,
          tabella: p.table.name,
          totale: matching.length,
          righe: matching.slice(0, PREVIEW_ROWS).map((r) => {
            const converted = convertRow(p, r.cells, r.kinds, { date1904: !!u.file.date1904 });
            const prep = prepareRow(p, converted, today, onlyFictitious, handlers);
            return {
              riga: r.line,
              valori: converted.values,
              errori: prep.ok ? [] : prep.errors,
              avvisi: prep.warnings,
            };
          }),
        };
      }),
    };
  });

  /** Prova e scrittura: lo stesso codice; la prova annulla la transazione. */
  async function execute(
    req: FastifyRequest,
    actor: Actor,
    archiveId: string,
    batch: Batch,
    mapping: ImportMapping,
    mode: 'prova' | 'scrittura',
  ) {
    const u = upload(actor, batch);
    const parts = resolveMapping(u.file.tables, mapping);
    const mappingHash = sha256(JSON.stringify(mapping));
    const options = batch.options as { mappatura?: string; piano?: string };
    if (mode === 'scrittura') {
      if (batch.status === BATCH_STATUS.importato)
        throw new HttpError(409, 'Questa importazione è già stata scritta.');
      if (batch.status !== BATCH_STATUS.prova || options.mappatura !== mappingHash)
        throw new HttpError(
          409,
          'Prima la prova senza scrivere, con questa stessa mappatura: poi l’importazione.',
        );
    }
    const today = studioDate(deps.now());
    const lookups = await reference.exemptionLookups(today);
    const destinations = [...new Set(parts.map((p) => p.destination.key))].join(',');
    const action: AccessAction = mode === 'prova' ? 'prova_importazione' : 'importazione';
    let result: EngineResult;
    try {
      result = await withActor(db, actor.userId, async (tx) => {
        await tx.execute(sql`select set_config('lock_timeout', ${LOCK_TIMEOUT}, true)`);
        await tx.execute(sql`select set_config('statement_timeout', ${STATEMENT_TIMEOUT}, true)`);
        const lock = await tx.execute<{ ok: boolean }>(
          sql`select pg_try_advisory_xact_lock(${IMPORT_LOCK_CLASS}, hashtext(${archiveId})) as ok`,
        );
        if (!lock.rows[0]?.ok)
          throw new HttpError(
            409,
            'Un’altra importazione è in corso su questo archivio: riprova tra poco.',
          );
        // Il titolare si ricontrolla sotto il blocco della riga dell'archivio, tenuto fino alla
        // fine: una sospensione arrivata un istante prima ferma l'importazione, una che arriva
        // durante aspetta e poi vede i pazienti nuovi (gara inversa della sospensione, tappa 14).
        const closed = await archiveClosedToNewPatients(tx, archiveId);
        if (closed) throw new HttpError(409, closed);
        const r = await runImport(
          {
            tx,
            userId: actor.userId,
            studioId: actor.studioId,
            archiveId,
            batchId: batch.id,
            today,
            now: deps.now(),
            sourceProgram: mapping.programma ?? null,
            date1904: !!u.file.date1904,
            exemptionExists: lookups.exemptionExists,
            onlyFictitious,
          },
          parts,
        );
        if (mode === 'prova') throw new DryRunRollback(r);
        if (r.planHash !== options.piano)
          throw new HttpError(
            409,
            'Dalla prova a ora i dati in cartella sono cambiati: rifai la prova senza scrivere, poi importa.',
          );
        // Storia e registro in fondo, subito prima del commit: il blocco della catena del registro
        // resta preso solo per questo ultimo tratto (migrazione 0002).
        await tx
          .update(importBatch)
          .set({
            status: BATCH_STATUS.importato,
            destination: destinations,
            counts: { ...r.counts },
            report: r.report,
            options: { ...options, rapportoTroncato: r.truncated },
            finishedAt: deps.now(),
          })
          .where(eq(importBatch.id, batch.id));
        // Una riga per paziente, ma in un comando solo per esito (logAccessForPatients).
        await logAccessForPatients(tx, [...r.newPatients, ...r.existingPatients], {
          studioId: actor.studioId,
          userId: actor.userId,
          action,
          outcome: 'consentito',
          workstation: actor.workstation,
          details: { permesso: 'data.import', importazione: batch.id },
        });
        await logAccessForPatients(tx, [...r.foreignPatients], {
          studioId: actor.studioId,
          userId: actor.userId,
          action,
          outcome: 'negato',
          workstation: actor.workstation,
          details: { permesso: 'data.import', importazione: batch.id, motivo: FOREIGN },
        });
        await logAccess(tx, {
          studioId: actor.studioId,
          userId: actor.userId,
          action,
          outcome: 'riuscito',
          workstation: actor.workstation,
          details: {
            permesso: 'data.import',
            fase: 'scrittura',
            importazione: batch.id,
            conteggi: r.counts,
          },
        });
        return r;
      });
    } catch (e) {
      if (e instanceof DryRunRollback) result = e.result;
      else {
        const err = importError(e, mode);
        // Nei log del servizio solo il codice: mai il messaggio del database (ha i valori).
        if (!(e instanceof HttpError))
          req.log.error(
            { importazione: batch.id, stato: err.statusCode },
            'importazione non riuscita',
          );
        await log(actor, action, 'fallito', {
          importazione: batch.id,
          fase: mode,
          motivo: err.statusCode === 409 ? 'conflitto' : 'errore',
        });
        throw err;
      }
    }
    if (mode === 'prova') {
      await withActor(db, actor.userId, (tx) =>
        tx
          .update(importBatch)
          .set({
            status: BATCH_STATUS.prova,
            destination: destinations,
            sourceProgram: mapping.programma ?? null,
            mapping: mapping,
            options: {
              mappatura: mappingHash,
              piano: result.planHash,
              rapportoTroncato: result.truncated,
            },
            counts: { ...result.counts },
            report: result.report,
            finishedAt: deps.now(),
          })
          .where(eq(importBatch.id, batch.id)),
      );
      for (const patientId of result.existingPatients)
        await logAccess(db, {
          studioId: actor.studioId,
          userId: actor.userId,
          patientId,
          action,
          outcome: 'consentito',
          workstation: actor.workstation,
          details: { permesso: 'data.import', importazione: batch.id },
        });
      for (const patientId of result.foreignPatients)
        await logAccess(db, {
          studioId: actor.studioId,
          userId: actor.userId,
          patientId,
          action,
          outcome: 'negato',
          workstation: actor.workstation,
          details: { permesso: 'data.import', importazione: batch.id, motivo: FOREIGN },
        });
      await log(actor, action, 'riuscito', {
        fase: 'prova',
        importazione: batch.id,
        conteggi: result.counts,
      });
    } else store.delete(batch.id);
    return {
      id: batch.id,
      stato: mode === 'prova' ? BATCH_STATUS.prova : BATCH_STATUS.importato,
      conteggi: result.counts,
      rapporto: result.report,
      rapportoTroncato: result.truncated,
    };
  }

  app.post('/api/importazioni/:id/prova', async (req) => {
    const actor = req.actor!;
    const { id } = idParams.parse(req.params);
    const archiveId = await guard(actor, 'prova_importazione', { importazione: id });
    const batch = await loadBatch(archiveId, id);
    const { mappatura } = mappingBody.parse(req.body);
    if (batch.status === BATCH_STATUS.importato)
      throw new HttpError(409, 'Questa importazione è già stata scritta.');
    return execute(req, actor, archiveId, batch, mappatura, 'prova');
  });

  app.post('/api/importazioni/:id/importa', async (req) => {
    const actor = req.actor!;
    const { id } = idParams.parse(req.params);
    const archiveId = await guard(actor, 'importazione', { fase: 'scrittura', importazione: id });
    const batch = await loadBatch(archiveId, id);
    const { mappatura } = mappingBody.parse(req.body);
    return execute(req, actor, archiveId, batch, mappatura, 'scrittura');
  });

  const summary = (b: Batch & { chi: string | null }) => ({
    id: b.id,
    creatoIl: b.createdAt.toISOString(),
    finitoIl: b.finishedAt?.toISOString() ?? null,
    file: { nome: b.fileName, dimensione: b.fileSize, impronta: b.fileSha256 },
    formato: b.format,
    destinazioni:
      b.destination === 'da_scegliere'
        ? []
        : b.destination
            .split(',')
            .map((k) => ({ chiave: k, nome: importDestination(k)?.label ?? k })),
    programma: b.sourceProgram,
    stato: b.status,
    conteggi: b.counts,
    chi: b.chi,
  });

  /** Storia delle importazioni dell'archivio. */
  app.get('/api/importazioni', async (req) => {
    const actor = req.actor!;
    const archiveId = await guard(actor, 'lettura_importazioni', { elenco: true });
    const rows = await db
      .select({ b: importBatch, chi: appUser.displayName })
      .from(importBatch)
      .leftJoin(appUser, eq(appUser.id, importBatch.userId))
      .where(eq(importBatch.archiveId, archiveId))
      .orderBy(desc(importBatch.createdAt))
      .limit(200);
    await log(actor, 'lettura_importazioni', 'consentito', { elenco: true, righe: rows.length });
    return { importazioni: rows.map((r) => summary({ ...r.b, chi: r.chi })) };
  });

  /** Un'importazione con il rapporto riga per riga e la mappatura usata. */
  app.get('/api/importazioni/:id', async (req) => {
    const actor = req.actor!;
    const { id } = idParams.parse(req.params);
    const archiveId = await guard(actor, 'lettura_importazioni', { importazione: id });
    const b = await loadBatch(archiveId, id);
    const [who] = await db
      .select({ chi: appUser.displayName })
      .from(appUser)
      .where(eq(appUser.id, b.userId));
    await log(actor, 'lettura_importazioni', 'consentito', { importazione: id });
    const u = store.get(b.id, actor.userId);
    return {
      ...summary({ ...b, chi: who?.chi ?? null }),
      mappatura: b.status === BATCH_STATUS.caricato ? null : b.mapping,
      rapporto: b.report,
      rapportoTroncato: !!(b.options as { rapportoTroncato?: boolean }).rapportoTroncato,
      fileDisponibile: !!u,
      ...(u ? { analisi: analysis(u.file) } : {}),
    };
  });

  /** Rapporto in CSV, da scaricare: righe, esiti e motivi, senza valori del file. */
  app.get('/api/importazioni/:id/rapporto', async (req, reply) => {
    const actor = req.actor!;
    const { id } = idParams.parse(req.params);
    const archiveId = await guard(actor, 'lettura_importazioni', {
      importazione: id,
      formato: 'csv',
    });
    const b = await loadBatch(archiveId, id);
    await log(actor, 'lettura_importazioni', 'consentito', { importazione: id, formato: 'csv' });
    reply.header('content-type', 'text/csv; charset=utf-8');
    reply.header(
      'content-disposition',
      `attachment; filename="rapporto-importazione-${b.createdAt.toISOString().slice(0, 10)}.csv"`,
    );
    return reportCsv(b.report as Parameters<typeof reportCsv>[0]);
  });

  /**
   * Annullamento di un'importazione scritta, con un motivo: le voci e le ricette passate si
   * annullano, nulla si cancella; solo finché nessuna è stata modificata dopo.
   */
  app.post('/api/importazioni/:id/annulla', async (req) => {
    const actor = req.actor!;
    const { id } = idParams.parse(req.params);
    const archiveId = await guard(actor, 'importazione', {
      fase: 'annullamento',
      importazione: id,
    });
    const batch = await loadBatch(archiveId, id);
    const { motivo } = undoBody.parse(req.body);
    try {
      const done = await undoBatch(db, actor, batch, motivo, deps.now());
      return { id, stato: 'annullato', ...done };
    } catch (e) {
      if (!(e instanceof HttpError)) throw importError(e, 'scrittura');
      await log(actor, 'importazione', 'fallito', {
        fase: 'annullamento',
        importazione: id,
        motivo: 'non annullabile',
      });
      throw e;
    }
  });

  /* Profili d'importazione ----------------------------------------------------------------- */

  const profileView = (p: typeof importProfile.$inferSelect & { chi: string | null }) => ({
    id: p.id,
    nome: p.name,
    programma: p.sourceProgram,
    formato: p.format,
    destinazioni: p.destination
      .split(',')
      .filter(Boolean)
      .map((k) => ({ chiave: k, nome: importDestination(k)?.label ?? k })),
    mappatura: p.mapping,
    creatoIl: p.createdAt.toISOString(),
    chi: p.chi,
    archiviatoIl: p.archivedAt?.toISOString() ?? null,
  });

  async function profileGuard(actor: Actor) {
    const { decision } = await ownArchive(actor);
    if (!decision.allowed) throw new HttpError(403, decision.reason);
  }

  /** Profili dello studio: mappature salvate, senza dati dei pazienti. */
  app.get('/api/importazioni/profili', async (req) => {
    const actor = req.actor!;
    await profileGuard(actor);
    const all = z.object({ archiviati: z.enum(['si', 'no']).default('no') }).parse(req.query);
    const rows = await db
      .select({ p: importProfile, chi: appUser.displayName })
      .from(importProfile)
      .leftJoin(appUser, eq(appUser.id, importProfile.createdBy))
      .where(
        all.archiviati === 'si'
          ? eq(importProfile.studioId, actor.studioId)
          : and(eq(importProfile.studioId, actor.studioId), isNull(importProfile.archivedAt)),
      )
      .orderBy(importProfile.name);
    return { profili: rows.map((r) => profileView({ ...r.p, chi: r.chi })) };
  });

  app.post('/api/importazioni/profili', async (req, reply) => {
    const actor = req.actor!;
    await profileGuard(actor);
    const body = profileBody.parse(req.body);
    const [row] = await withActor(db, actor.userId, (tx) =>
      tx
        .insert(importProfile)
        .values({
          studioId: actor.studioId,
          name: body.nome,
          sourceProgram: body.programma ?? null,
          format: body.formato,
          destination: [...new Set(body.mappatura.parti.map((p) => p.destinazione))].join(','),
          mapping: body.mappatura,
          createdBy: actor.userId,
          createdAt: deps.now(),
        })
        .returning(),
    );
    return reply.status(201).send(profileView({ ...row!, chi: actor.displayName }));
  });

  app.post('/api/importazioni/profili/:id/archivia', async (req) => {
    const actor = req.actor!;
    await profileGuard(actor);
    const { id } = idParams.parse(req.params);
    const [row] = await withActor(db, actor.userId, (tx) =>
      tx
        .update(importProfile)
        .set({ archivedAt: deps.now() })
        .where(
          and(
            eq(importProfile.id, id),
            eq(importProfile.studioId, actor.studioId),
            isNull(importProfile.archivedAt),
          ),
        )
        .returning(),
    );
    if (!row) throw new HttpError(404, 'Profilo non trovato o già archiviato');
    return profileView({ ...row, chi: null });
  });
}
