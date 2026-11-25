/**
 * Lotti di NRE del medico (D269). La cartella numera da sé le ricette che vanno al SAR: chiede al
 * SAR un lotto di 1000 NRE legato al codice fiscale del medico e genera gli NRE agendo solo sul
 * progressivo (SIRPED, «Cartelle cliniche MMG e PLS», V06 del 10/04/2026, 3.2 e 4.1).
 *
 * - La richiesta usa «esclusivamente» utente, password e PIN RUPAR, senza secondo fattore e senza
 *   il token dell'accesso con SPID o CIE (3.1.1).
 * - Il lotto si chiede alla firma, quando al medico restano meno di NRE_LOT_RESERVE numeri: con i
 *   numeri che restano la ricetta parte anche se il SAR non risponde. Senza numeri e senza lotto
 *   la ricetta non parte, e l'errore dice perché.
 * - Ogni richiesta resta nel registro degli invii, con la ricetta che l'ha fatta partire.
 * - Il numero si prende nella transazione che porta la ricetta «in invio»: due firme insieme non
 *   hanno mai lo stesso NRE, e la ricetta lo tiene anche dopo un rifiuto (4.3.1, caso 3).
 */

import {
  composeNre,
  healthUnitsOfRegion,
  NRE_LOT_REQUEST_TYPE,
  NRE_LOT_SIZE,
  nreLotPrefix,
  nreLotProblem,
} from '@mmg/domain';
import type { LotResult, SarRegionalServices } from '@mmg/integrations';
import { and, asc, eq, inArray, lt, sql } from 'drizzle-orm';
import { secondsText } from '../admin/studio-service';
import type { Actor } from '../auth/service';
import type { Database } from '../db/client';
import { doctorProfile, externalSubmission, nreLot, studio } from '../db/schema';
import { withActor, type Tx } from '../db/tx';
import { HttpError } from '../http/errors';
import type { createCredentialService } from '../credentials/service';

/**
 * Sotto questi numeri liberi, alla firma si chiede il lotto successivo (D269): un decimo del lotto,
 * perché la ricetta rossa e l'invio dopo un guasto hanno ancora un NRE quando il SAR non risponde.
 * Le fonti lette non danno una soglia.
 */
export const NRE_LOT_RESERVE = 100;

export interface NreLotDeps {
  db: Database;
  /** Il SAR che dà i lotti: il simulatore, finché non c'è l'adattatore vero (regola 7). */
  sar: SarRegionalServices;
  /** «simulator», «test» o «production»: quello del SAR che riceve le ricette. */
  environment: string;
  credentials: Pick<ReturnType<typeof createCredentialService>, 'authFor' | 'authRefused'>;
  /** Tempo massimo di attesa della risposta, lo stesso dell'invio della ricetta. */
  timeoutMs: (studioId: string) => Promise<number>;
}

export type NreLots = ReturnType<typeof createNreLots>;

export function createNreLots(deps: NreLotDeps) {
  const { db, sar, environment, credentials } = deps;

  /** Numeri ancora da dare nei lotti del medico, in questo ambiente. */
  async function freeNumbers(doctorUserId: string, q: Database | Tx = db): Promise<number> {
    const [row] = await q
      .select({
        free: sql<number>`coalesce(sum(${nreLot.size} - ${nreLot.nextProgressive}), 0)::int`,
      })
      .from(nreLot)
      .where(and(eq(nreLot.doctorUserId, doctorUserId), eq(nreLot.environment, environment)));
    return Number(row?.free ?? 0);
  }

  /** Il codice fiscale del medico: il SAR gli lega il lotto. */
  async function doctorFiscalCodeOf(userId: string): Promise<string> {
    const [row] = await db
      .select({ fiscalCode: doctorProfile.fiscalCode })
      .from(doctorProfile)
      .where(eq(doctorProfile.userId, userId));
    if (!row?.fiscalCode)
      throw new HttpError(
        422,
        'Manca il codice fiscale del medico: il SAR lo vuole per dare i numeri di ricetta (lotto di NRE). Lo scrive l’amministratore nei dati del medico, in Strumenti › Utenti e ruoli',
        { codice: 'CODICE_FISCALE_MEDICO_MANCANTE', servizio: 'rupar' },
      );
    return row.fiscalCode;
  }

  /** Il codice della regione dello studio, dall'elenco delle aziende sanitarie (D267). */
  async function regionCodeOf(studioId: string): Promise<string> {
    const [row] = await db
      .select({ region: studio.regionName })
      .from(studio)
      .where(eq(studio.id, studioId));
    const units = healthUnitsOfRegion(row?.region);
    if (!units)
      throw new HttpError(
        422,
        'Manca la regione dello studio, o non è fra quelle dell’elenco delle aziende sanitarie del Ministero della Salute: il SAR la vuole per dare i numeri di ricetta (lotto di NRE). La scrive l’amministratore in Strumenti › Studio, «Dati dello studio»',
        { codice: 'REGIONE_MANCANTE', servizio: 'rupar' },
      );
    return units[0]!.regionCode;
  }

  /** Le credenziali per il lotto: solo utente, password e PIN RUPAR (V06, 3.1.1). */
  async function authOf(userId: string) {
    try {
      return await credentials.authFor(userId, 'lotto_nre');
    } catch (err) {
      const details = err instanceof HttpError ? (err.details as { codice?: string }) : null;
      if (details?.codice === 'CREDENZIALI_MANCANTI')
        throw new HttpError(
          422,
          'Per chiedere al SAR i numeri di ricetta (lotto di NRE) servono utente, password e PIN RUPAR del medico, anche con l’accesso con SPID o CIE (SIRPED, V06, 3.1.1): inseriscili in «Credenziali dei servizi»',
          details,
        );
      throw err;
    }
  }

  /** Chiede un lotto al SAR e lo conserva. L'errore dice che cosa non va. */
  async function requestLot(actor: Actor, prescriptionId: string): Promise<void> {
    const doctorFiscalCode = await doctorFiscalCodeOf(actor.userId);
    const regionCode = await regionCodeOf(actor.studioId);
    const auth = await authOf(actor.userId);
    const input = { regionCode, lotType: NRE_LOT_REQUEST_TYPE, doctorFiscalCode };
    const timeoutMs = await deps.timeoutMs(actor.studioId);
    const started = Date.now();
    let result: LotResult;
    let timer: NodeJS.Timeout | undefined;
    try {
      result = await Promise.race([
        sar.requestLot(input, auth),
        new Promise<LotResult>((ok) => {
          timer = setTimeout(
            () =>
              ok({
                outcome: 'timeout',
                message: `Nessuna risposta entro ${secondsText(timeoutMs)}`,
              }),
            timeoutMs,
          );
        }),
      ]);
    } catch (err) {
      result = { outcome: 'timeout', message: `Errore dell'adattatore: ${String(err)}` };
    } finally {
      clearTimeout(timer);
    }
    // Un lotto che non dà 1000 NRE di 15 caratteri, o di un'altra regione, non si usa.
    if (result.outcome === 'assigned') {
      const problem =
        nreLotProblem(result.lot) ??
        (result.lot.regionCode !== regionCode
          ? `il codice della regione è ${result.lot.regionCode}, non ${regionCode}`
          : null);
      if (problem)
        result = {
          outcome: 'rejected',
          code: 'LOTTO_NON_VALIDO',
          message: `Il SAR ha dato un lotto che non si può usare: ${problem}`,
          raw: result.raw,
        };
    }
    if (result.outcome === 'rejected' && result.authProblem)
      await credentials.authRefused(
        actor,
        'lotto_nre',
        result.authProblem,
        `${result.code}: ${result.message}`,
      );
    const final = result;
    const stored = await withActor(db, actor.userId, async (tx) => {
      await tx.insert(externalSubmission).values({
        system: 'sar',
        environment,
        operation: 'lotto_nre',
        prescriptionId,
        userId: actor.userId,
        request: input,
        response: 'raw' in final ? final.raw : null,
        outcome: final.outcome,
        errorCode: final.outcome === 'rejected' ? final.code : null,
        errorMessage: final.outcome === 'assigned' ? null : final.message,
        durationMs: Date.now() - started,
      });
      if (final.outcome !== 'assigned') return false;
      const rows = await tx
        .insert(nreLot)
        .values({
          doctorUserId: actor.userId,
          doctorFiscalCode,
          environment,
          ...final.lot,
          prefix: nreLotPrefix(final.lot),
          size: NRE_LOT_SIZE,
          response: final.raw,
        })
        .onConflictDoNothing()
        .returning({ id: nreLot.id });
      return rows.length > 0;
    });
    if (stored) return;
    if (final.outcome === 'assigned')
      throw new HttpError(
        502,
        `Il SAR ha dato di nuovo un lotto già ricevuto (${nreLotPrefix(final.lot)}): i suoi numeri non si possono dare due volte. Riprova; se si ripete, va segnalato al CSI Piemonte`,
      );
    const reason =
      final.outcome === 'rejected'
        ? `il SAR ha rifiutato la richiesta (${final.code}: ${final.message})`
        : final.outcome === 'unreachable'
          ? `il SAR non è raggiungibile (${final.message})`
          : `il SAR non ha risposto in tempo (${final.message})`;
    throw new HttpError(
      final.outcome === 'rejected' ? 422 : 502,
      `Non si è potuto avere il lotto di numeri di ricetta (NRE): ${reason}`,
      { codice: 'LOTTO_NRE', esito: final.outcome },
    );
  }

  /**
   * Prima della firma di una ricetta che va al SAR: se i numeri liberi sono pochi, si chiede il
   * lotto successivo. Se non ne restano e il lotto non arriva, la firma si ferma con il motivo; se
   * ne restano, si va avanti e il motivo torna come avviso.
   */
  async function ensureNumbers(
    actor: Actor,
    prescriptionId: string,
  ): Promise<{ warning: string | null }> {
    const free = await freeNumbers(actor.userId);
    if (free >= NRE_LOT_RESERVE) return { warning: null };
    try {
      await requestLot(actor, prescriptionId);
      return { warning: null };
    } catch (err) {
      if (free > 0 && err instanceof HttpError)
        return {
          warning: `Restano ${free} numeri di ricetta (NRE) del medico. ${err.message}: si richiede alla prossima firma.`,
        };
      throw err;
    }
  }

  /**
   * Il prossimo NRE del medico, dentro la transazione della firma: il progressivo cresce nella
   * stessa scrittura che lo legge, quindi due firme insieme non ne hanno mai uno uguale. Null se
   * i numeri sono finiti.
   */
  async function take(
    tx: Tx,
    doctorUserId: string,
  ): Promise<{ nre: string; lotId: string } | null> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const oldest = tx
        .select({ id: nreLot.id })
        .from(nreLot)
        .where(
          and(
            eq(nreLot.doctorUserId, doctorUserId),
            eq(nreLot.environment, environment),
            lt(nreLot.nextProgressive, nreLot.size),
          ),
        )
        .orderBy(asc(nreLot.receivedAt), asc(nreLot.id))
        .limit(1);
      const [row] = await tx
        .update(nreLot)
        .set({ nextProgressive: sql`${nreLot.nextProgressive} + 1` })
        .where(and(inArray(nreLot.id, oldest), lt(nreLot.nextProgressive, nreLot.size)))
        .returning({
          id: nreLot.id,
          regionCode: nreLot.regionCode,
          groupCode: nreLot.groupCode,
          lotType: nreLot.lotType,
          lotCode: nreLot.lotCode,
          next: nreLot.nextProgressive,
        });
      if (row) return { lotId: row.id, nre: composeNre(row, row.next - 1) };
      // Un'altra firma ha preso l'ultimo numero di quel lotto: se ne restano altrove, si riprova.
      if ((await freeNumbers(doctorUserId, tx)) === 0) return null;
    }
    return null;
  }

  /** I lotti del medico, per l'esportazione e per vedere quanti numeri restano. */
  async function lotsOf(doctorUserId: string) {
    return db
      .select()
      .from(nreLot)
      .where(and(eq(nreLot.doctorUserId, doctorUserId), eq(nreLot.environment, environment)))
      .orderBy(asc(nreLot.receivedAt), asc(nreLot.id));
  }

  return { environment, freeNumbers, ensureNumbers, take, requestLot, lotsOf, regionCodeOf };
}
