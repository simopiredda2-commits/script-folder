import {
  REGIONAL_NOTHING_TO_DELETE,
  REGIONAL_REGIMES,
  type RegionalAuthor,
  type RegionalFailure,
  type RegionalFseClient,
  type RegionalOutcomeResult,
  type RegionalPssMetadata,
  type RegionalRegime,
  type RegionalSearchResult,
  type RegionalSendResult,
} from '@mmg/integrations';
import { and, asc, desc, eq, inArray, isNull, lt, lte, or } from 'drizzle-orm';
import type { ServiceAuth } from '@mmg/integrations';
import type { createCredentialService } from '../credentials/service';
import type { Database } from '../db/client';
import {
  appUser,
  doctorProfile,
  fseRegionalSend,
  fseSetting,
  fseTransmission,
  patient,
  pssDocument,
  pssFile,
} from '../db/schema';
import { withActor } from '../db/tx';
import { HttpError } from '../http/errors';
import { unrefTimer } from '../timers';

/**
 * Coda degli invii al Fascicolo regionale (D280), con le politiche della Regione per chi manda
 * messaggi al Fascicolo (FSE-INT-SRS-01-V02):
 * - niente invii dalle 00:00 alle 07:00, quando il Fascicolo è fermo per manutenzione (3.2);
 * - in ordine di emissione, un messaggio alla volta, almeno 3 secondi fra due invii (3.1, 3.5, 4.3);
 * - tempo scaduto, risposta senza un esito positivo esplicito, FSE_ER_000 o errori di sistema di
 *   INI: si rimanda dopo almeno 5 minuti, fino a tre volte a 5 minuti; poi un tentativo al giorno
 *   per dieci giorni, dalle 07:00 alle 00:00; poi si segnala al supporto del CSI (4.1, 4.2);
 * - gli altri errori: si rimanda solo dopo la correzione (2.1, 4.1); il medico chiede di
 *   rimandare il singolo messaggio quando vuole (3.3);
 * - invii sospesi dall'amministratore, per esempio su richiesta del supporto del CSI (3.4, 4.5);
 * - ogni messaggio e ogni risposta nel registro degli invii, senza credenziali (3.6, 4.4).
 */

export const RETRY_DELAY_MS = 5 * 60_000;
/** Tentativi a 5 minuti dopo il primo invio fallito (4.1). */
export const RETRIES = 3;
/** Giorni della coda dei messaggi falliti, un tentativo al giorno (4.2). */
export const FALLBACK_DAYS = 10;
/** Fra due messaggi, negli invii in serie (4.3). */
export const MIN_INTERVAL_MS = 3000;
/** Il Fascicolo è fermo dalle 00 alle 07 (3.2). */
export const QUIET_UNTIL_HOUR = 7;
/** Le credenziali RUPAR del medico, senza secondo fattore (V09, 3.2.1). */
export const REGIONAL_USE = 'profilo_sanitario' as const;
/** Quanto a lungo un giro tiene un messaggio prima che un altro giro lo possa riprendere. */
export const LEASE_MS = 5 * 60_000;

const DAY_MS = 86_400_000;

/** Ora, minuti e data nel fuso di Roma. */
function romeParts(d: Date) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/Rome',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZoneName: 'longOffset',
    })
      .formatToParts(d)
      .map((x) => [x.type, x.value]),
  );
  const offset = /GMT([+-])(\d{2}):?(\d{2})?/.exec(p.timeZoneName ?? '');
  const minutes = offset
    ? (offset[1] === '-' ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3] ?? 0))
    : 0;
  return {
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    offsetMinutes: minutes,
  };
}

/** Fra le 00 e le 07 di Roma il Fascicolo regionale non riceve. */
export const inQuietHours = (d: Date) => romeParts(d).hour < QUIET_UNTIL_HOUR;

/** Le 07:00 di Roma del giorno (di Roma) di `d`. */
export function romeSeven(d: Date): Date {
  const r = romeParts(d);
  const guess = Date.UTC(r.year, r.month - 1, r.day, QUIET_UNTIL_HOUR) - r.offsetMinutes * 60_000;
  // Al cambio d'ora l'offset delle 07 può essere diverso da quello di `d`.
  const at = romeParts(new Date(guess));
  return new Date(
    Date.UTC(r.year, r.month - 1, r.day, QUIET_UNTIL_HOUR) - at.offsetMinutes * 60_000,
  );
}

/** Il primo momento utile da `d`: se cade fra le 00 e le 07 di Roma, le 07. */
export const outsideQuietHours = (d: Date) => (inQuietHours(d) ? romeSeven(d) : d);

export interface RetryState {
  attempts: number;
  phase: string;
  queuedSince: Date | null;
}

/**
 * Dopo un tentativo fallito che si può ripetere (4.1, 4.2): il primo invio e tre ripetizioni a 5
 * minuti, poi dieci tentativi, uno al giorno, poi «failed».
 */
export function nextAttempt(
  s: RetryState,
  now: Date,
  usable: (d: Date) => Date = outsideQuietHours,
):
  | { attempts: number; phase: 'ripetizione' | 'coda'; queuedSince: Date | null; at: Date }
  | 'failed' {
  if (s.phase !== 'coda') {
    const attempts = s.attempts + 1;
    if (attempts <= RETRIES)
      return {
        attempts,
        phase: 'ripetizione',
        queuedSince: null,
        at: usable(new Date(now.getTime() + RETRY_DELAY_MS)),
      };
    return {
      attempts: 0,
      phase: 'coda',
      queuedSince: now,
      at: usable(new Date(now.getTime() + DAY_MS)),
    };
  }
  const attempts = s.attempts + 1;
  if (attempts >= FALLBACK_DAYS) return 'failed';
  return {
    attempts,
    phase: 'coda',
    queuedSince: s.queuedSince ?? now,
    at: usable(new Date(now.getTime() + DAY_MS)),
  };
}

/** Con «ELAB» si richiede l'esito: dopo 1 minuto, poi 2, 3… fino a un'ora. */
export const elabDelayMs = (polls: number) => Math.min(Math.max(polls, 1), 60) * 60_000;

/** Che cosa dire del fallimento, con i codici della Regione. */
export function describeFailure(r: RegionalFailure): string {
  if (r.outcome !== 'rejected') return r.message;
  const parts = r.errors.map((e) => `${e.code}: ${e.message}`.trim()).filter(Boolean);
  return parts.length ? parts.join('; ') : `Esito ${r.esito || 'assente'}`;
}

type SendRow = typeof fseRegionalSend.$inferSelect;
type Tx = Parameters<Parameters<typeof withActor>[2]>[0];

export interface RegionalQueueDeps {
  db: Database;
  client: RegionalFseClient;
  credentials: Pick<ReturnType<typeof createCredentialService>, 'authFor' | 'authRefused'>;
  now: () => Date;
  /** Per difetto 3 secondi con il servizio vero, niente con il simulatore. */
  minIntervalMs?: number;
  /**
   * Il fermo dalle 00 alle 07 è del Fascicolo vero: per difetto vale con il servizio vero, non con
   * il simulatore (che non si ferma). Le prove lo accendono per provarlo con un'ora fissata.
   */
  quietHours?: boolean;
  log?: (message: string, err: unknown) => void;
}

/** Il medico autore, per i servizi della V09; i problemi da correggere prima dell'invio. */
export function regionalAuthorIssues(d: {
  fiscalCode?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  aslCode?: string | null;
}): string[] {
  const out: string[] = [];
  if (!d.aslCode || !/^\d{3}$/.test(d.aslCode))
    out.push(
      'Medico: manca il codice ASL nel profilo (tre cifre): il Fascicolo regionale lo vuole con il codice della regione (IstituzioneAutore)',
    );
  if (!d.fiscalCode || !d.firstName || !d.lastName)
    out.push('Medico: mancano codice fiscale, nome o cognome nel profilo');
  return out;
}

/** Il regime per la Regione: un codice della tabella dei regimi della V09. */
export const regionalRegimeOf = (v: string | null | undefined): RegionalRegime | null =>
  v && Object.hasOwn(REGIONAL_REGIMES, v) ? (v as RegionalRegime) : null;

export type RegionalQueue = ReturnType<typeof createRegionalQueue>;

export function createRegionalQueue(deps: RegionalQueueDeps) {
  const { db, client, now } = deps;
  const simulated = client.environment === 'simulator';
  const minInterval = deps.minIntervalMs ?? (simulated ? 0 : MIN_INTERVAL_MS);
  const quiet = deps.quietHours ?? !simulated;
  /** Fuori dal fermo notturno, se il fermo vale. */
  const usable = (d: Date) => (quiet ? outsideQuietHours(d) : d);
  let lastSent = -Infinity;
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;

  /** Nessun giro tiene la riga, o il giro che la teneva si è interrotto. */
  const free = (t: Date) =>
    or(isNull(fseRegionalSend.leaseUntil), lt(fseRegionalSend.leaseUntil, t));

  /**
   * La riga si prende prima di mandare, come nella coda della ricetta rossa: un altro giro, anche
   * di un'altra istanza del servizio, non la manda nello stesso momento.
   */
  async function claim(row: SendRow): Promise<SendRow | null> {
    const t = now();
    const [mine] = await db
      .update(fseRegionalSend)
      .set({ leaseUntil: new Date(t.getTime() + LEASE_MS) })
      .where(
        and(
          eq(fseRegionalSend.id, row.id),
          inArray(fseRegionalSend.status, ['queued', 'waiting']),
          lte(fseRegionalSend.nextAttemptAt, t),
          free(t),
        ),
      )
      .returning();
    return mine ?? null;
  }

  /** Lo stato dopo il lavoro del giro: la riga torna libera, se non si dice altro. */
  async function update(id: string, set: Partial<SendRow>) {
    await db
      .update(fseRegionalSend)
      .set({ leaseUntil: null, ...set })
      .where(eq(fseRegionalSend.id, id));
  }
  /** La stessa scrittura dentro una transazione aperta: solo con `tx` (D228). */
  async function updateIn(tx: Tx, id: string, set: Partial<SendRow>) {
    await tx
      .update(fseRegionalSend)
      .set({ leaseUntil: null, ...set })
      .where(eq(fseRegionalSend.id, id));
  }

  /** Nel registro: il messaggio senza credenziali, con il documento indicato dall'impronta. */
  async function record(
    row: SendRow,
    operation: (typeof fseTransmission.$inferInsert)['operation'],
    r: RegionalSendResult | RegionalOutcomeResult | RegionalSearchResult,
    sha: string | null,
    size: number | null,
  ) {
    const sent = r.sent.replace(
      /<documento>[^<]*<\/documento>/,
      `<documento>[documento: sha256 ${sha ?? '?'}, ${size ?? '?'} byte, in pss_file]</documento>`,
    );
    const failure =
      r.outcome === 'rejected' || r.outcome === 'unreachable' || r.outcome === 'timeout' ? r : null;
    await db.insert(fseTransmission).values({
      documentId: row.documentId,
      operation,
      outcome:
        r.outcome === 'unreachable' || r.outcome === 'timeout'
          ? r.outcome
          : r.outcome === 'rejected'
            ? 'problem'
            : 'ok',
      problemType: r.outcome === 'rejected' ? (r.errors[0]?.code ?? r.esito) : null,
      problemTitle: r.outcome === 'rejected' ? r.esito : null,
      problemDetail: failure ? describeFailure(failure) : null,
      request: sent,
      response: r.received,
      actorUserId: row.doctorUserId,
      at: now(),
    });
  }

  /** Da correggere: si rimanda solo con «Riprova», dopo la correzione. */
  async function toFix(row: SendRow, message: string, errors: unknown = null) {
    await update(row.id, {
      status: 'to_fix',
      lastAttemptAt: now(),
      lastError: message,
      errors: errors,
    });
  }

  /** Un fallimento: si ripete secondo le politiche, o si corregge. */
  async function failed(row: SendRow, r: RegionalFailure) {
    const message = describeFailure(r);
    if (r.outcome === 'rejected' && !r.retryable) {
      if (r.authProblem)
        await deps.credentials.authRefused(
          { userId: row.doctorUserId },
          REGIONAL_USE,
          'credentials',
          `Fascicolo regionale: ${message}`,
        );
      return toFix(
        row,
        r.authProblem
          ? `${message}. Controlla utente, password e PIN RUPAR in «Credenziali dei servizi», poi «Riprova»`
          : message,
        r.errors,
      );
    }
    const next = nextAttempt(row, now(), usable);
    if (next === 'failed')
      return update(row.id, {
        status: 'failed',
        lastAttemptAt: now(),
        lastError: `${message}. Dopo dieci giorni di tentativi il messaggio non è arrivato: va segnalato al supporto del Fascicolo del CSI Piemonte (supporto.fse@csi.it) con data e ora dell'invio, codice fiscale dell'assistito, tipo di messaggio e documento`,
        errors: r.outcome === 'rejected' ? r.errors : null,
      });
    await update(row.id, {
      attempts: next.attempts,
      phase: next.phase,
      queuedSince: next.queuedSince,
      nextAttemptAt: next.at,
      lastAttemptAt: now(),
      lastError: message,
      errors: r.outcome === 'rejected' ? r.errors : null,
    });
  }

  /** Documento, assistito, autore e impostazioni dello studio, o che cosa manca. */
  async function contextOf(row: SendRow) {
    const [d] = await db.select().from(pssDocument).where(eq(pssDocument.id, row.documentId));
    const [pt] = await db
      .select({ fiscalCode: patient.fiscalCode })
      .from(patient)
      .where(eq(patient.id, d!.patientId));
    const [u] = await db
      .select({ studioId: appUser.studioId, p: doctorProfile })
      .from(appUser)
      .leftJoin(doctorProfile, eq(doctorProfile.userId, appUser.id))
      .where(eq(appUser.id, row.doctorUserId));
    const [s] = await db.select().from(fseSetting).where(eq(fseSetting.studioId, u!.studioId));
    const p = u?.p;
    const issues = regionalAuthorIssues({
      fiscalCode: p?.fiscalCode,
      firstName: p?.firstName,
      lastName: p?.lastName,
      aslCode: p?.aslCode,
    });
    const regime = regionalRegimeOf(s?.administrativeRequest);
    if (!regime)
      issues.push(
        'Impostazioni del Fascicolo: il regime va scelto fra quelli della Regione (SSN, SSR, ricovero, privato, donatori)',
      );
    const author: RegionalAuthor = {
      fiscalCode: p?.fiscalCode ?? '',
      firstName: p?.firstName ?? '',
      lastName: p?.lastName ?? '',
      aslCode: p?.aslCode ?? '',
    };
    return {
      doc: d!,
      patientFiscalCode: pt!.fiscalCode,
      author,
      settings: s,
      regime: regime ?? 'SSN',
      issues,
      suspended: s?.regionalSendingSuspended ?? false,
    };
  }

  async function authOf(userId: string): Promise<ServiceAuth | { error: string }> {
    try {
      return await deps.credentials.authFor(userId, REGIONAL_USE);
    } catch (err) {
      if (err instanceof HttpError)
        return {
          error: `${err.message}. Per il Fascicolo regionale servono utente, password e PIN RUPAR del medico (V09, 3.2.1): inseriscili in «Credenziali dei servizi», poi «Riprova»`,
        };
      throw err;
    }
  }

  /** Al più un messaggio ogni 3 secondi (4.3). */
  async function pace() {
    const wait = lastSent + minInterval - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastSent = Date.now();
  }

  async function step(candidate: SendRow) {
    const t = now();
    if (quiet && inQuietHours(t)) {
      // Fino alle 07 non parte niente; la riga di un giro ancora in corso resta sua.
      await db
        .update(fseRegionalSend)
        .set({ nextAttemptAt: romeSeven(t) })
        .where(and(eq(fseRegionalSend.id, candidate.id), free(t)));
      return;
    }
    // In ordine: un messaggio aspetta quelli fatti prima per lo stesso documento (3.1).
    const [earlier] = await db
      .select({ id: fseRegionalSend.id })
      .from(fseRegionalSend)
      .where(
        and(
          eq(fseRegionalSend.documentId, candidate.documentId),
          inArray(fseRegionalSend.status, ['queued', 'waiting']),
          lt(fseRegionalSend.createdAt, candidate.createdAt),
        ),
      )
      .limit(1);
    if (earlier) return;
    const ctx = await contextOf(candidate);
    if (ctx.suspended) return;
    const row = await claim(candidate);
    if (!row) return;
    if (ctx.issues.length) return toFix(row, ctx.issues.join('. '));
    const auth = await authOf(row.doctorUserId);
    if ('error' in auth) return toFix(row, auth.error);
    const metadata = (confidentiality: 'N' | 'V'): RegionalPssMetadata => ({
      patientFiscalCode: ctx.patientFiscalCode,
      confidentiality,
      writtenAt: ctx.doc.validatedAt ?? ctx.doc.createdAt,
      regime: ctx.regime,
      signed: true,
    });
    if (row.status === 'waiting') return poll(row, ctx, auth);
    if (row.operation === 'update') {
      await pace();
      const r = await client.update(
        {
          author: ctx.author,
          metadata: metadata(row.confidentiality === 'V' ? 'V' : 'N'),
          documentOid: ctx.doc.regionalOid!,
        },
        auth,
      );
      await record(row, 'regional_update', r, null, null);
      if (r.outcome !== 'accepted') return failed(row, r);
      await withActor(db, row.doctorUserId, async (tx) => {
        await updateIn(tx, row.id, {
          status: 'done',
          doneAt: now(),
          lastAttemptAt: now(),
          lastError: null,
          errors: r.warnings,
        });
        await tx
          .update(pssDocument)
          .set({ confidentiality: row.confidentiality === 'V' ? 'V' : 'N' })
          .where(eq(pssDocument.id, row.documentId));
      });
      return;
    }
    if (row.operation === 'delete') {
      await pace();
      const r = await client.remove(
        {
          author: ctx.author,
          patientFiscalCode: ctx.patientFiscalCode,
          documentId: ctx.doc.regionalOid!,
        },
        auth,
      );
      await record(row, 'regional_delete', r, null, null);
      // «Nessun metadato trovato da cancellare» dopo un tentativo senza risposta: è già cancellato.
      const gone =
        r.outcome === 'rejected' &&
        row.lastAttemptAt !== null &&
        r.errors.some((e) => e.code === REGIONAL_NOTHING_TO_DELETE);
      if (r.outcome !== 'accepted' && !gone) return failed(row, r);
      await withActor(db, row.doctorUserId, async (tx) => {
        await updateIn(tx, row.id, {
          status: 'done',
          doneAt: now(),
          lastAttemptAt: now(),
          lastError: gone
            ? 'La Regione dice che non c’è niente da cancellare: il documento non è più nel Fascicolo'
            : null,
        });
        await tx
          .update(pssDocument)
          .set({ status: 'deleted', deletedAt: now() })
          .where(eq(pssDocument.id, row.documentId));
      });
      return;
    }
    // CREATE o REPLACE: il PDF firmato, validato sul Gateway.
    const [signed] = await db
      .select()
      .from(pssFile)
      .where(and(eq(pssFile.documentId, row.documentId), eq(pssFile.kind, 'signed_pdf')));
    if (!signed) return toFix(row, 'Manca il PDF firmato del Profilo');
    const document = new Uint8Array(signed.content);
    const part = {
      author: ctx.author,
      metadata: metadata(ctx.doc.confidentiality === 'V' ? 'V' : 'N'),
      document,
      workflowInstanceId: ctx.doc.workflowInstanceId ?? '',
      locality: ctx.settings?.locality ?? '',
    };
    let r;
    if (row.operation === 'replace') {
      const [previous] = await db
        .select()
        .from(pssDocument)
        .where(eq(pssDocument.id, ctx.doc.replacesId!));
      await pace();
      const found = await client.search(
        {
          author: ctx.author,
          patientFiscalCode: ctx.patientFiscalCode,
          documentOid: previous!.regionalOid!,
        },
        auth,
      );
      await record(row, 'regional_search', found, null, null);
      // La versione da sostituire è pubblicata per il programma ma la Regione non la trova: non
      // lo può correggere il medico.
      if (found.outcome === 'not-found')
        return toFix(
          row,
          `La versione precedente del Profilo (${previous!.regionalOid}) non risulta nel Fascicolo regionale, e senza di lei la sostituzione non si può fare: va segnalato al supporto del Fascicolo del CSI Piemonte (supporto.fse@csi.it); dopo la loro risposta, «Riprova»`,
          found.warnings,
        );
      if (found.outcome !== 'found') return failed(row, found);
      await pace();
      r = await client.replace({ ...part, target: found.uuid }, auth);
      await record(row, 'regional_replace', r, signed.sha256, document.byteLength);
    } else {
      await pace();
      r = await client.create(part, auth);
      await record(row, 'regional_create', r, signed.sha256, document.byteLength);
    }
    if (r.outcome !== 'accepted') return failed(row, r);
    if (!r.temporaryId)
      return failed(row, {
        outcome: 'rejected',
        esito: r.esito,
        errors: [
          {
            code: 'FSE_ER_000',
            message: 'Presa in carico senza identificativo temporaneo',
            kind: 'Bloccante',
            source: 'programma',
          },
        ],
        retryable: true,
      });
    const accepted = now();
    await withActor(db, row.doctorUserId, async (tx) => {
      await updateIn(tx, row.id, {
        status: 'waiting',
        // L'esito si chiede subito, in questo giro: la riga resta sua.
        leaseUntil: new Date(accepted.getTime() + LEASE_MS),
        temporaryId: r.temporaryId,
        acceptedAt: accepted,
        attempts: 0,
        phase: 'ripetizione',
        queuedSince: null,
        polls: 0,
        nextAttemptAt: accepted,
        lastAttemptAt: accepted,
        lastError: null,
        errors: r.warnings,
      });
      await tx
        .update(pssDocument)
        .set({ status: 'submitted', submittedAt: accepted, lastProblem: null })
        .where(and(eq(pssDocument.id, row.documentId), eq(pssDocument.status, 'signed')));
    });
    const [fresh] = await db.select().from(fseRegionalSend).where(eq(fseRegionalSend.id, row.id));
    return poll(fresh!, ctx, auth);
  }

  /** L'esito del caricamento (V09, 5.4): OK con l'OID, KO con la motivazione, ELAB. */
  async function poll(row: SendRow, ctx: Awaited<ReturnType<typeof contextOf>>, auth: ServiceAuth) {
    const accepted = row.acceptedAt ?? row.createdAt;
    await pace();
    const r = await client.outcome(
      {
        author: ctx.author,
        temporaryId: row.temporaryId!,
        from: new Date(accepted.getTime() - 3_600_000),
        to: now(),
      },
      auth,
    );
    await record(row, 'regional_outcome', r, null, null);
    if (r.outcome !== 'checked') return failed(row, r);
    if (r.state === 'ELAB') {
      const polls = row.polls + 1;
      if (now().getTime() - accepted.getTime() > FALLBACK_DAYS * DAY_MS)
        return update(row.id, {
          status: 'failed',
          polls,
          lastAttemptAt: now(),
          lastError:
            'Dopo dieci giorni il Fascicolo regionale dice ancora «in elaborazione»: va segnalato al supporto del Fascicolo del CSI Piemonte (supporto.fse@csi.it)',
        });
      return update(row.id, {
        polls,
        lastAttemptAt: now(),
        lastError: null,
        nextAttemptAt: usable(new Date(now().getTime() + elabDelayMs(polls))),
      });
    }
    if (r.state === 'KO') {
      // La risposta della Regione è definitiva: il messaggio è chiuso, il Profilo scartato; se ne
      // prepara una versione nuova.
      const reason = r.reason ?? 'senza motivazione';
      await withActor(db, row.doctorUserId, async (tx) => {
        await updateIn(tx, row.id, {
          status: 'done',
          doneAt: now(),
          lastAttemptAt: now(),
          lastError: `Scartato dal Fascicolo regionale: ${reason}`,
          errors: r.warnings,
        });
        await tx
          .update(pssDocument)
          .set({
            status: 'rejected',
            rejectedAt: now(),
            lastProblem: {
              type: 'fascicolo-regionale',
              title: 'Scartato dal Fascicolo regionale',
              detail: reason,
              status: 0,
            },
          })
          .where(and(eq(pssDocument.id, row.documentId), eq(pssDocument.status, 'submitted')));
      });
      return;
    }
    if (!r.oid)
      return failed(row, {
        outcome: 'rejected',
        esito: '',
        errors: [
          {
            code: 'FSE_ER_000',
            message: 'Esito «OK» senza OID',
            kind: 'Bloccante',
            source: 'programma',
          },
        ],
        retryable: true,
      });
    const at = now();
    await withActor(db, row.doctorUserId, async (tx) => {
      await updateIn(tx, row.id, {
        status: 'done',
        oid: r.oid,
        doneAt: at,
        lastAttemptAt: at,
        lastError: null,
        errors: r.warnings,
      });
      await tx
        .update(pssDocument)
        .set({ status: 'published', publishedAt: at, regionalOid: r.oid })
        .where(eq(pssDocument.id, row.documentId));
      if (row.operation === 'replace' && ctx.doc.replacesId)
        await tx
          .update(pssDocument)
          .set({ status: 'replaced', replacedAt: at })
          .where(and(eq(pssDocument.id, ctx.doc.replacesId), eq(pssDocument.status, 'published')));
    });
  }

  async function runOnce(filter?: { documentId?: string }) {
    const rows = await db
      .select()
      .from(fseRegionalSend)
      .where(
        and(
          inArray(fseRegionalSend.status, ['queued', 'waiting']),
          lte(fseRegionalSend.nextAttemptAt, now()),
          free(now()),
          filter?.documentId ? eq(fseRegionalSend.documentId, filter.documentId) : undefined,
        ),
      )
      .orderBy(asc(fseRegionalSend.createdAt));
    for (const row of rows) {
      try {
        await step(row);
      } catch (err) {
        deps.log?.('Coda del Fascicolo regionale: errore su un messaggio', err);
      }
    }
  }

  /** Fa partire un giro, se non ce n'è già uno; restituisce il giro in corso. */
  function kick(filter?: { documentId?: string }): Promise<void> {
    running ??= runOnce(filter)
      .catch((err) => deps.log?.('Coda del Fascicolo regionale interrotta', err))
      .finally(() => {
        running = null;
      });
    return running;
  }

  return {
    /**
     * Un messaggio nuovo in coda, se `allowed` lo ammette con i messaggi del documento (per
     * difetto: nessuno in coda o in attesa dell'esito); altrimenti null. Il documento resta
     * bloccato fino alla fine della transazione: due richieste insieme non mettono in coda due
     * messaggi. Il messaggio viene sempre dopo quelli già fatti per lo stesso documento, anche con
     * l'orologio fermo: l'ordine di invio (3.1) e l'ultimo messaggio si leggono dall'ora di creazione.
     */
    async enqueue(
      tx: Tx,
      v: {
        documentId: string;
        doctorUserId: string;
        operation: SendRow['operation'];
        confidentiality?: 'N' | 'V';
      },
      allowed: (sends: SendRow[]) => boolean = (sends) =>
        !sends.some((s) => s.status === 'queued' || s.status === 'waiting'),
    ): Promise<SendRow | null> {
      await tx
        .select({ id: pssDocument.id })
        .from(pssDocument)
        .where(eq(pssDocument.id, v.documentId))
        .for('update');
      const sends = await tx
        .select()
        .from(fseRegionalSend)
        .where(eq(fseRegionalSend.documentId, v.documentId))
        .orderBy(desc(fseRegionalSend.createdAt));
      if (!allowed(sends)) return null;
      const last = sends[0];
      const at = now();
      const createdAt =
        last && last.createdAt.getTime() >= at.getTime()
          ? new Date(last.createdAt.getTime() + 1)
          : at;
      const [row] = await tx
        .insert(fseRegionalSend)
        .values({ ...v, nextAttemptAt: usable(at), createdAt })
        .returning();
      return row!;
    },
    /** «Riprova» del medico (3.3): da capo, oppure l'esito di nuovo se era già preso in carico. */
    async retry(tx: Tx, row: SendRow) {
      await tx
        .update(fseRegionalSend)
        .set({
          status:
            row.temporaryId && row.operation !== 'update' && row.operation !== 'delete'
              ? 'waiting'
              : 'queued',
          attempts: 0,
          phase: 'ripetizione',
          queuedSince: null,
          nextAttemptAt: usable(now()),
        })
        .where(eq(fseRegionalSend.id, row.id));
    },
    /** Lavora subito i messaggi del documento (dopo il giro in corso, se c'è). */
    async process(documentId: string) {
      if (running) await running;
      await kick({ documentId });
    },
    kick,
    start(intervalMs: number) {
      timer = unrefTimer(setInterval(() => void kick(), intervalMs));
    },
    async stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
      if (running) await running;
    },
  };
}
