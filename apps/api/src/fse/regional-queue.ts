import {
  FSE_ADMINISTRATIVE_REQUESTS,
  regimeOf,
  type RegionalAuthor,
  type RegionalFailure,
  type RegionalFsePublication,
  type RegionalOutcomeResult,
  type RegionalPssMetadata,
  type RegionalPublicationPolicy,
  type RegionalSearchResult,
  type RegionalSendResult,
  type RegionalSubmitResult,
  type ServiceAuth,
} from '@mmg/integrations';
import { and, asc, desc, eq, inArray, isNull, lt, lte, or } from 'drizzle-orm';
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
import type { RegionalChoice } from '../regions/integrations';
import { studioRegion } from '../regions/region';
import { unrefTimer } from '../timers';

/**
 * Coda degli invii al Fascicolo della regione dello studio del medico (D280, D297), con le
 * politiche di invio che la regione dà nel suo pacchetto (`RegionalPublicationPolicy`):
 * - niente invii nel fermo notturno del Fascicolo della regione, se ce n'è uno;
 * - in ordine di emissione, un messaggio alla volta, con l'intervallo della regione fra due invii;
 * - tempo scaduto, risposta senza un esito positivo, errori di sistema: si rimanda, prima con le
 *   ripetizioni ravvicinate della regione, poi un tentativo al giorno per i giorni che dice; poi il
 *   messaggio va segnalato a chi la regione indica;
 * - gli altri errori: si rimanda solo dopo la correzione; il medico chiede di rimandare il singolo
 *   messaggio quando vuole («Riprova»);
 * - invii sospesi dall'amministratore, per esempio su richiesta del supporto della regione;
 * - ogni messaggio e ogni risposta nel registro degli invii, senza credenziali.
 * Una regione senza la pubblicazione nel suo pacchetto non ne riceve: il messaggio resta da
 * correggere, con il motivo.
 */

/** Le credenziali del medico per i servizi della regione, senza secondo fattore (D280). */
export const REGIONAL_USE = 'profilo_sanitario' as const;
/** Quanto a lungo un giro tiene un messaggio prima che un altro giro lo possa riprendere. */
export const LEASE_MS = 5 * 60_000;

const DAY_MS = 86_400_000;

/** Quando la regione dello studio non ha, nel programma, la pubblicazione nel suo Fascicolo (D297). */
export const NO_REGIONAL_FSE_PUBLICATION =
  'La regione dello studio non ha ancora, nel programma, la pubblicazione del Profilo nel suo Fascicolo';

/** I regimi ammessi: quelli della regione; senza pubblicazione, quelli del Gateway (tabella 63). */
export const regimesOf = (publication: RegionalFsePublication | null) =>
  publication?.regimes ?? FSE_ADMINISTRATIVE_REQUESTS;

/** I regimi in breve, per i messaggi: «SSN, ricovero, privato…». */
export function regimeList(regimes: Readonly<Record<string, string>>): string {
  return Object.values(regimes)
    .map((name) => name.replace(/^Regime (?:di )?/, ''))
    .map((n) => (n === n.toUpperCase() ? n : n.charAt(0).toLowerCase() + n.slice(1)))
    .join(', ');
}

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

/** Dalla mezzanotte all'ora `untilHour` di Roma il Fascicolo della regione non riceve. */
export const inQuietHours = (d: Date, untilHour: number | null) =>
  untilHour !== null && romeParts(d).hour < untilHour;

/** L'ora `hour`, in punto, di Roma del giorno (di Roma) di `d`. */
export function romeHour(d: Date, hour: number): Date {
  const r = romeParts(d);
  const guess = Date.UTC(r.year, r.month - 1, r.day, hour) - r.offsetMinutes * 60_000;
  // Al cambio d'ora l'offset di quell'ora può essere diverso da quello di `d`.
  const at = romeParts(new Date(guess));
  return new Date(Date.UTC(r.year, r.month - 1, r.day, hour) - at.offsetMinutes * 60_000);
}

/** Il primo momento utile da `d`: se cade nel fermo notturno, la sua fine. */
export const outsideQuietHours = (d: Date, untilHour: number | null) =>
  untilHour !== null && inQuietHours(d, untilHour) ? romeHour(d, untilHour) : d;

export interface RetryState {
  attempts: number;
  phase: string;
  queuedSince: Date | null;
}

/**
 * Dopo un tentativo fallito che si può ripetere: il primo invio e le ripetizioni ravvicinate della
 * regione, poi un tentativo al giorno per i giorni che dice, poi «failed».
 */
export function nextAttempt(
  s: RetryState,
  now: Date,
  policy: RegionalPublicationPolicy,
  usable: (d: Date) => Date = (d) => outsideQuietHours(d, policy.quietUntilHour),
):
  | { attempts: number; phase: 'ripetizione' | 'coda'; queuedSince: Date | null; at: Date }
  | 'failed' {
  if (s.phase !== 'coda') {
    const attempts = s.attempts + 1;
    if (attempts <= policy.retries)
      return {
        attempts,
        phase: 'ripetizione',
        queuedSince: null,
        at: usable(new Date(now.getTime() + policy.retryDelayMs)),
      };
    return {
      attempts: 0,
      phase: 'coda',
      queuedSince: now,
      at: usable(new Date(now.getTime() + DAY_MS)),
    };
  }
  const attempts = s.attempts + 1;
  if (attempts >= policy.fallbackDays) return 'failed';
  return {
    attempts,
    phase: 'coda',
    queuedSince: s.queuedSince ?? now,
    at: usable(new Date(now.getTime() + DAY_MS)),
  };
}

/** Con «ELAB» si richiede l'esito: dopo 1 minuto, poi 2, 3… fino a un'ora. */
export const elabDelayMs = (polls: number) => Math.min(Math.max(polls, 1), 60) * 60_000;

/** Che cosa dire del fallimento, con i codici del servizio della regione. */
export function describeFailure(r: RegionalFailure): string {
  if (r.outcome !== 'rejected') return r.message;
  const parts = r.errors.map((e) => `${e.code}: ${e.message}`.trim()).filter(Boolean);
  return parts.length ? parts.join('; ') : `Esito ${r.esito || 'assente'}`;
}

type SendRow = typeof fseRegionalSend.$inferSelect;
type Tx = Parameters<Parameters<typeof withActor>[2]>[0];

export interface RegionalQueueDeps {
  db: Database;
  /** La pubblicazione nel Fascicolo della regione dello studio del medico (D297). */
  publication: RegionalChoice<RegionalFsePublication>;
  credentials: Pick<ReturnType<typeof createCredentialService>, 'authFor' | 'authRefused'>;
  now: () => Date;
  /** Per difetto quello della regione con il servizio vero, niente con il simulatore. */
  minIntervalMs?: number;
  /**
   * Il fermo notturno è del Fascicolo vero: per difetto vale con il servizio vero, non con il
   * simulatore (che non si ferma). Le prove lo accendono per provarlo con un'ora fissata.
   */
  quietHours?: boolean;
  log?: (message: string, err: unknown) => void;
}

/** Chi può leggere: il database o una transazione aperta. */
type Reader = Pick<Database, 'select'>;

export type RegionalQueue = ReturnType<typeof createRegionalQueue>;

export function createRegionalQueue(deps: RegionalQueueDeps) {
  const { db, now } = deps;
  const simulated = (p: RegionalFsePublication) => p.environment === 'simulator';
  /** L'ora di fine del fermo notturno della regione, se il fermo vale; null se non vale. */
  const quietOf = (p: RegionalFsePublication) =>
    (deps.quietHours ?? !simulated(p)) ? p.policy.quietUntilHour : null;
  /** Fuori dal fermo notturno della regione, se il fermo vale. */
  const usable = (p: RegionalFsePublication | null, d: Date) =>
    p ? outsideQuietHours(d, quietOf(p)) : d;
  /** L'ultimo invio a ogni servizio della regione, per l'intervallo fra due messaggi. */
  const lastSent = new Map<RegionalFsePublication, number>();
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

  /** La pubblicazione della regione dello studio del medico, o null se la regione non ce l'ha. */
  async function publicationOfDoctor(q: Reader, userId: string) {
    const [u] = await q
      .select({ studioId: appUser.studioId })
      .from(appUser)
      .where(eq(appUser.id, userId));
    return u ? deps.publication.for(await studioRegion(q, u.studioId)) : null;
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

  /** Un fallimento: si ripete secondo le politiche della regione, o si corregge. */
  async function failed(row: SendRow, r: RegionalFailure, publication: RegionalFsePublication) {
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
          ? `${message}. ${publication.texts.credentialsRefused}, poi «Riprova»`
          : message,
        r.errors,
      );
    }
    const next = nextAttempt(row, now(), publication.policy, (d) => usable(publication, d));
    if (next === 'failed')
      return update(row.id, {
        status: 'failed',
        lastAttemptAt: now(),
        lastError: `${message}. Dopo ${publication.policy.fallbackDays} giorni di tentativi il messaggio non è arrivato: va segnalato ${publication.texts.reportTo} con data e ora dell'invio, codice fiscale dell'assistito, tipo di messaggio e documento`,
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
    const publication = deps.publication.for(await studioRegion(db, u!.studioId));
    const p = u?.p;
    const issues: string[] = [];
    if (!publication) issues.push(NO_REGIONAL_FSE_PUBLICATION);
    // Che cosa vuole la regione dal medico autore (per esempio il codice dell'ASL).
    else issues.push(...publication.authorIssues({ aslCode: p?.aslCode ?? '' }));
    if (!p?.fiscalCode || !p.firstName || !p.lastName)
      issues.push('Medico: mancano codice fiscale, nome o cognome nel profilo');
    const regime = publication ? regimeOf(publication, s?.administrativeRequest) : null;
    if (publication && !regime)
      issues.push(
        `Impostazioni del Fascicolo: il regime va scelto fra quelli della Regione (${regimeList(publication.regimes)})`,
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
      regime: regime ?? '',
      publication,
      issues,
      suspended: s?.regionalSendingSuspended ?? false,
    };
  }

  async function authOf(
    userId: string,
    publication: RegionalFsePublication,
  ): Promise<ServiceAuth | { error: string }> {
    try {
      return await deps.credentials.authFor(userId, REGIONAL_USE);
    } catch (err) {
      if (err instanceof HttpError)
        return { error: `${err.message}. ${publication.texts.credentialsMissing}, poi «Riprova»` };
      throw err;
    }
  }

  /** Fra due messaggi allo stesso servizio, almeno l'intervallo della regione. */
  async function pace(publication: RegionalFsePublication) {
    const interval =
      deps.minIntervalMs ?? (simulated(publication) ? 0 : publication.policy.minIntervalMs);
    const wait = (lastSent.get(publication) ?? -Infinity) + interval - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastSent.set(publication, Date.now());
  }

  async function step(candidate: SendRow) {
    const t = now();
    const ctx = await contextOf(candidate);
    const quiet = ctx.publication ? quietOf(ctx.publication) : null;
    if (quiet !== null && inQuietHours(t, quiet)) {
      // Fino alla fine del fermo non parte niente; la riga di un giro ancora in corso resta sua.
      await db
        .update(fseRegionalSend)
        .set({ nextAttemptAt: romeHour(t, quiet) })
        .where(and(eq(fseRegionalSend.id, candidate.id), free(t)));
      return;
    }
    // In ordine: un messaggio aspetta quelli fatti prima per lo stesso documento.
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
    if (ctx.suspended) return;
    const row = await claim(candidate);
    if (!row) return;
    const publication = ctx.publication;
    if (ctx.issues.length || !publication) return toFix(row, ctx.issues.join('. '));
    const auth = await authOf(row.doctorUserId, publication);
    if ('error' in auth) return toFix(row, auth.error);
    const metadata = (confidentiality: 'N' | 'V'): RegionalPssMetadata => ({
      patientFiscalCode: ctx.patientFiscalCode,
      confidentiality,
      writtenAt: ctx.doc.validatedAt ?? ctx.doc.createdAt,
      regime: ctx.regime,
      signed: true,
    });
    if (row.status === 'waiting') return poll(row, ctx, publication, auth);
    if (row.operation === 'update') {
      await pace(publication);
      const r = await publication.update(
        {
          author: ctx.author,
          metadata: metadata(row.confidentiality === 'V' ? 'V' : 'N'),
          documentOid: ctx.doc.regionalOid!,
        },
        auth,
      );
      await record(row, 'regional_update', r, null, null);
      if (r.outcome !== 'accepted') return failed(row, r, publication);
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
      await pace(publication);
      const r = await publication.remove(
        {
          author: ctx.author,
          patientFiscalCode: ctx.patientFiscalCode,
          documentId: ctx.doc.regionalOid!,
        },
        auth,
      );
      await record(row, 'regional_delete', r, null, null);
      // Niente da cancellare dopo un tentativo senza risposta: è già cancellato.
      const gone =
        r.outcome === 'rejected' && row.lastAttemptAt !== null && r.nothingToDelete === true;
      if (r.outcome !== 'accepted' && !gone) return failed(row, r, publication);
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
    let r: RegionalSubmitResult;
    if (row.operation === 'replace') {
      const [previous] = await db
        .select()
        .from(pssDocument)
        .where(eq(pssDocument.id, ctx.doc.replacesId!));
      await pace(publication);
      const found = await publication.search(
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
          `La versione precedente del Profilo (${previous!.regionalOid}) non risulta nel Fascicolo regionale, e senza di lei la sostituzione non si può fare: va segnalato ${publication.texts.reportTo}; dopo la loro risposta, «Riprova»`,
          found.warnings,
        );
      if (found.outcome !== 'found') return failed(row, found, publication);
      await pace(publication);
      r = await publication.replace({ ...part, target: found.uuid }, auth);
      await record(row, 'regional_replace', r, signed.sha256, document.byteLength);
    } else {
      await pace(publication);
      r = await publication.create(part, auth);
      await record(row, 'regional_create', r, signed.sha256, document.byteLength);
    }
    if (r.outcome !== 'accepted') return failed(row, r, publication);
    const temporaryId = r.temporaryId;
    const accepted = now();
    await withActor(db, row.doctorUserId, async (tx) => {
      await updateIn(tx, row.id, {
        status: 'waiting',
        // L'esito si chiede subito, in questo giro: la riga resta sua.
        leaseUntil: new Date(accepted.getTime() + LEASE_MS),
        temporaryId,
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
    return poll(fresh!, ctx, publication, auth);
  }

  /** L'esito della pubblicazione: OK con l'OID, KO con la motivazione, ancora in elaborazione. */
  async function poll(
    row: SendRow,
    ctx: Awaited<ReturnType<typeof contextOf>>,
    publication: RegionalFsePublication,
    auth: ServiceAuth,
  ) {
    const accepted = row.acceptedAt ?? row.createdAt;
    await pace(publication);
    const r = await publication.outcome(
      {
        author: ctx.author,
        temporaryId: row.temporaryId!,
        from: new Date(accepted.getTime() - 3_600_000),
        to: now(),
      },
      auth,
    );
    await record(row, 'regional_outcome', r, null, null);
    if (r.outcome !== 'checked') return failed(row, r, publication);
    if (r.state === 'ELAB') {
      const polls = row.polls + 1;
      const days = publication.policy.fallbackDays;
      if (now().getTime() - accepted.getTime() > days * DAY_MS)
        return update(row.id, {
          status: 'failed',
          polls,
          lastAttemptAt: now(),
          lastError: `Dopo ${days} giorni il Fascicolo regionale dice ancora «in elaborazione»: va segnalato ${publication.texts.reportTo}`,
        });
      return update(row.id, {
        polls,
        lastAttemptAt: now(),
        lastError: null,
        nextAttemptAt: usable(publication, new Date(now().getTime() + elabDelayMs(polls))),
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
     * l'orologio fermo: l'ordine di invio e l'ultimo messaggio si leggono dall'ora di creazione.
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
      const publication = await publicationOfDoctor(tx, v.doctorUserId);
      const [row] = await tx
        .insert(fseRegionalSend)
        .values({ ...v, nextAttemptAt: usable(publication, at), createdAt })
        .returning();
      return row!;
    },
    /** «Riprova» del medico: da capo, oppure l'esito di nuovo se era già preso in carico. */
    async retry(tx: Tx, row: SendRow) {
      const publication = await publicationOfDoctor(tx, row.doctorUserId);
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
          nextAttemptAt: usable(publication, now()),
        })
        .where(eq(fseRegionalSend.id, row.id));
    },
    /** La pubblicazione della regione di uno studio (D297), o null se la regione non ce l'ha. */
    async publicationOfStudio(studioId: string) {
      return deps.publication.for(await studioRegion(db, studioId));
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
