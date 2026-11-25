/**
 * Ricetta rossa in modalità DPCM (D270), come la vuole la Regione Piemonte quando la ricetta
 * dematerializzata non ha esito (SIRPED, «Cartelle cliniche MMG e PLS», V06 del 10/04/2026):
 *
 * - il medico stampa la ricetta sul modulo del Poligrafico e la cartella legge il numero del
 *   modulo (4.3.1, caso 4; 4.2.2);
 * - la ricetta ha un NRE nuovo del lotto del medico, stampato in chiaro e a barre accanto alla
 *   denominazione dell'ente (4.2.1 e 4.2.2);
 * - la cartella la manda al SAR in modalità DPCM entro 24 ore dalla compilazione, con «utente,
 *   password e PIN RUPAR», al più un file ogni 2 secondi (3.1.1, 3.4.2, 4.2.1);
 * - legge l'esito con l'elenco sintetico e l'elenco analitico (4.2.3);
 * - se la ricetta dematerializzata può essere arrivata (tempo scaduto, eccezione di sistema, invio
 *   interrotto), la annulla da sé (4.3.1, casi 4 e 5; 4.3.2).
 *
 * Invii, letture degli esiti e annullamenti stanno in una coda: si riprovano finché il SAR non
 * risponde, con attese crescenti, e ogni chiamata resta nel registro degli invii.
 */

import { parsePoligrafico, poligraficoProblem, type PoligraficoCode } from '@mmg/domain';
import {
  dpcmFileName,
  dpcmPrescriptionProblem,
  type DpcmAnalyticResult,
  type DpcmPrescription,
  type DpcmReceipt,
  type DpcmServices,
  type DpcmSummaryResult,
  type PrescriptionGateway,
  type PrescriptionMessage,
} from '@mmg/integrations';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  type SQL,
} from 'drizzle-orm';
import { z } from 'zod';
import type { Actor } from '../auth/service';
import type { createCredentialService } from '../credentials/service';
import type { Database } from '../db/client';
import {
  appUser,
  doctorProfile,
  dpcmPrescription,
  externalSubmission,
  patient,
  prescription,
} from '../db/schema';
import { withActor } from '../db/tx';
import { HttpError } from '../http/errors';
import { unrefTimer } from '../timers';
import type { NreLots } from './nre-lots';
import { studioDate } from './rules-check';

/** Doppione su un indice unico di Postgres (codice 23505), anche dentro l'errore di Drizzle. */
function uniqueViolation(e: unknown, constraint: string): boolean {
  const err = e as { code?: string; constraint?: string; cause?: unknown };
  const pg = (err.cause ?? err) as { code?: string; constraint?: string };
  return pg.code === '23505' && pg.constraint === constraint;
}

/** Attese prima di riprovare un invio, una lettura o un annullamento, in minuti. */
export const DPCM_RETRY_MINUTES = [1, 5, 15, 60] as const;
/** Ogni quanto si rilegge l'elenco sintetico finché la ricetta è «in attesa di elaborazione». */
export const DPCM_CHECK_MINUTES = 5;
/** Una riga presa dalla coda resta di chi la lavora per questo tempo. */
const LEASE_MINUTES = 5;
/** Fra due file dello stesso medico almeno 2 secondi (6.1.1; V06, 3.4.2). */
export const DPCM_MIN_INTERVAL_MS = 2000;
/**
 * Attesa della risposta del SAR per i servizi DPCM: l'invio non è sincrono come la ricetta
 * dematerializzata, che vuole qualche secondo (V06, 3.5.1). Scelta mia: 30 secondi.
 */
export const DPCM_TIMEOUT_MS = 30_000;
/** Il prescritto DPCM va mandato entro 24 ore dalla compilazione (V06, 3.4.2). */
export const DPCM_DEADLINE_HOURS = 24;

/** Per quanti giorni le ricette rosse chiuse restano nell'elenco del medico (scelta mia, D270). */
export const DPCM_LIST_DAYS = 30;

/** Le ricette rosse ancora in corso: da mandare, in attesa dell'esito o con l'annullamento da fare. */
const openRed = () =>
  or(
    inArray(dpcmPrescription.status, ['to_send', 'accepted']),
    eq(dpcmPrescription.dmCancelStatus, 'pending'),
  );

/**
 * Le ricette rosse che chiedono un'occhiata al medico (D270): un invio o una lettura non riusciti,
 * le 24 ore passate senza invio, un annullamento che non riesce; e, per 30 giorni, le scartate e
 * gli annullamenti rifiutati. Si contano in Oggi.
 */
export function redToFollow(at: Date): SQL {
  const since = new Date(at.getTime() - DPCM_LIST_DAYS * 86_400_000);
  const late = new Date(at.getTime() - DPCM_DEADLINE_HOURS * 3_600_000);
  return or(
    and(
      inArray(dpcmPrescription.status, ['to_send', 'accepted']),
      or(
        isNotNull(dpcmPrescription.lastError),
        and(eq(dpcmPrescription.status, 'to_send'), lt(dpcmPrescription.printedAt, late)),
      ),
    ),
    and(eq(dpcmPrescription.dmCancelStatus, 'pending'), isNotNull(dpcmPrescription.dmCancelError)),
    and(
      gte(dpcmPrescription.printedAt, since),
      or(eq(dpcmPrescription.status, 'discarded'), eq(dpcmPrescription.dmCancelStatus, 'failed')),
    ),
  )!;
}

/** Quante ricette rosse del medico chiedono un'occhiata (D270), per Oggi. */
export async function countRedToFollow(db: Database, doctorUserId: string, at: Date) {
  const [row] = await db
    .select({ n: count() })
    .from(dpcmPrescription)
    .where(and(eq(dpcmPrescription.doctorUserId, doctorUserId), redToFollow(at)));
  return row?.n ?? 0;
}

export const printRedSchema = z
  .object({
    /** Il numero del Poligrafico letto dal modulo nella stampante (codice a barre o a mano). */
    poligrafico: z.string().min(1).max(40),
    /** TipoVisita: A ambulatoriale (per difetto), D domiciliare. */
    tipoVisita: z.enum(['A', 'D']).optional(),
  })
  .strict();

/** «NON SOSTITUIBILE» sul modulo, con il codice della motivazione se c'è (D273). */
export const notSubstitutableText = (l: {
  notSubstitutable?: boolean;
  notSubstitutableCode?: string | null;
}) =>
  l.notSubstitutable
    ? ` - NON SOSTITUIBILE${l.notSubstitutableCode ? ` (motivazione ${l.notSubstitutableCode})` : ''}`
    : '';

/** Che cosa si stampa sul modulo: i dati della ricetta come erano alla stampa. */
export interface RedFormData {
  poligrafico: string;
  nre: string;
  compiledAt: string;
  kind: 'F' | 'P';
  patientName: string;
  patientAddress: string | null;
  patientFiscalCode: string;
  exemptionCode: string | null;
  notExempt: boolean;
  province: string | null;
  asl: string | null;
  lines: { text: string; quantity: number }[];
  aifaNotes: string[];
  diagnosis: string | null;
  totalPieces: number;
  priority: string | null;
  doctorName: string;
  doctorFiscalCode: string;
  doctorRegionalCode: string | null;
}

/** Contenuto conservato con la ricetta rossa: quello che va al SAR e quello che si stampa. */
export interface DpcmContent {
  ricetta: DpcmPrescription;
  stampa: RedFormData;
}

export interface DpcmDeps {
  db: Database;
  /** Il SAR: invio dei file DPCM e lettura degli esiti. */
  sar: DpcmServices;
  /** Il SAR per la ricetta dematerializzata: il suo annullamento (4.3.2). */
  dm: Pick<PrescriptionGateway, 'cancel'>;
  environment: string;
  credentials: Pick<ReturnType<typeof createCredentialService>, 'authFor' | 'authRefused'>;
  nreLots: NreLots;
  now: () => Date;
  /** Chi produce il programma, per il nome del file allegato (6.1.1). */
  producer: string;
  /** Fra due file dello stesso medico: 2 secondi per difetto; le prove possono abbassarlo. */
  minIntervalMs?: number;
  /** Codice del gruppo di equivalenza dei farmaci (DescrProdPrest della farmaceutica, 6.1.2). */
  equivalenceGroups?: (aics: string[], date: string) => Promise<Map<string, string | null>>;
  log?: (message: string, err?: unknown) => void;
  /** Dopo la stampa la coda parte da sé (per difetto). Le prove la fanno girare a mano. */
  auto?: boolean;
}

type DpcmRow = typeof dpcmPrescription.$inferSelect;
type PrescriptionRow = typeof prescription.$inferSelect;

const minutes = (n: number) => n * 60_000;
const retryAfter = (attempts: number) =>
  minutes(DPCM_RETRY_MINUTES[Math.min(attempts, DPCM_RETRY_MINUTES.length) - 1] ?? 60);

/** La provincia e l'ASL dell'assistito vanno nel file solo nella forma dello schema, insieme. */
function residenceCodes(p: { residenceProvince: string | null; asl: string | null }) {
  const province = (p.residenceProvince ?? '').trim().toUpperCase();
  const asl = (p.asl ?? '').trim();
  return /^[A-Z]{2}$/.test(province) && /^\d{3}$/.test(asl)
    ? { province, asl }
    : { province: null, asl: null };
}

/**
 * Prescrizione2 della specialistica (V06, 4.2.1): «CODCATPRESCR=<codice>$» per il codice del
 * catalogo regionale e «TIPOACC=<valore>$» per il tipo di accesso, senza spazi. Il tipo di accesso
 * con i valori del Sistema TS: 1 primo accesso, 0 altra tipologia (D79).
 */
export function prescription2(catalogCode: string | null | undefined, access: string | null) {
  const parts: string[] = [];
  if (catalogCode?.trim()) parts.push(`CODCATPRESCR=${catalogCode.trim().replace(/\s/g, '')}$`);
  if (access === 'first') parts.push('TIPOACC=1$');
  if (access === 'subsequent') parts.push('TIPOACC=0$');
  return parts.length ? parts.join('') : null;
}

export type DpcmService = ReturnType<typeof createDpcmService>;

export function createDpcmService(deps: DpcmDeps) {
  const { db, sar, nreLots, now } = deps;
  const minInterval = deps.minIntervalMs ?? DPCM_MIN_INTERVAL_MS;
  /** Ultimo file mandato da ogni medico, per i 2 secondi (6.1.1). */
  const lastSent = new Map<string, number>();
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function within<T>(call: Promise<T>, onTimeout: T): Promise<T> {
    let t: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        call,
        new Promise<T>((ok) => {
          t = setTimeout(() => ok(onTimeout), DPCM_TIMEOUT_MS);
        }),
      ]);
    } finally {
      clearTimeout(t);
    }
  }

  /** I dati del file e del modulo, dalla ricetta come parte con la firma (`message`). */
  async function contentOf(
    p: PrescriptionRow,
    message: PrescriptionMessage,
    input: { poligrafico: PoligraficoCode; visitType: 'A' | 'D'; compiledAt: string },
  ): Promise<DpcmContent> {
    const [pt] = await db.select().from(patient).where(eq(patient.id, p.patientId));
    const pharma = p.kind === 'pharma_ssn';
    const aics = message.lines.map((l) => l.drugAic).filter((x): x is string => !!x);
    const groups =
      pharma && deps.equivalenceGroups && aics.length
        ? await deps.equivalenceGroups(aics, input.compiledAt)
        : new Map<string, string | null>();
    const { province, asl } = residenceCodes(pt!);
    const ricetta: DpcmPrescription = {
      bar1: input.poligrafico.bar1,
      bar2: input.poligrafico.bar2,
      patientFiscalCode: message.patientFiscalCode,
      kind: pharma ? 'F' : 'P',
      exemptionCode: message.exemptionCode ?? null,
      notExempt: !message.exemptionCode,
      diagnosisText: pharma ? null : (message.diagnosticQuestion ?? null),
      compiledAt: input.compiledAt,
      visitType: input.visitType,
      patientProvince: province,
      patientAsl: asl,
      priority: pharma ? null : (message.priority ?? null),
      nre: '',
      doctorFiscalCode: message.doctor.fiscalCode ?? '',
      // Casi delle linee guida del Sistema TS per il principio attivo (3.1.4): per principio
      // attivo solo il gruppo di equivalenza (A1); con il nome anche l'AIC (A2); con la clausola
      // di non sostituibilità il codice della motivazione in Prescrizione1 (B, C; D273). Senza
      // il gruppo nella lista di trasparenza in vigore il caso A1 non si può scrivere: va l'AIC,
      // come per l'unico farmaco autorizzato (D), perché la riga dica quale farmaco.
      indication: pharma ? (message.prescriptionIndication ?? null) : null,
      lines: message.lines.map((l) => {
        const group = (l.drugAic && groups.get(l.drugAic)) || null;
        return pharma
          ? {
              productCode: l.byActiveIngredient && group ? null : (l.drugAic ?? null),
              description: group,
              aifaNote: l.aifaNote ?? null,
              quantity: l.quantity,
              prescription1: l.notSubstitutable ? (l.notSubstitutableCode ?? null) : null,
            }
          : {
              productCode: l.serviceNationalCode ?? null,
              description: l.serviceDescription ?? null,
              quantity: l.quantity,
              prescription2: prescription2(l.serviceCode, message.accessType ?? null),
            };
      }),
    };
    const address = [pt!.residenceStreet, pt!.residenceNumber].filter(Boolean).join(' ');
    const town = [pt!.residencePostalCode, pt!.residenceTown].filter(Boolean).join(' ');
    const stampa: RedFormData = {
      poligrafico: input.poligrafico.code,
      nre: '',
      compiledAt: input.compiledAt,
      kind: ricetta.kind,
      patientName: `${pt!.lastName} ${pt!.firstName}`.toUpperCase(),
      patientAddress: [address, town].filter(Boolean).join(', ') || null,
      patientFiscalCode: message.patientFiscalCode,
      exemptionCode: ricetta.exemptionCode ?? null,
      notExempt: !!ricetta.notExempt,
      province,
      asl,
      lines: message.lines.map((l) => ({
        text: pharma
          ? `${l.drugName ?? l.activeIngredient ?? ''}${notSubstitutableText(l)}`
          : `${l.serviceNationalCode ?? l.serviceCode ?? ''} ${l.serviceDescription ?? ''}`.trim(),
        quantity: l.quantity,
      })),
      aifaNotes: [
        ...new Set(message.lines.map((l) => l.aifaNote).filter((x): x is string => !!x)),
      ].slice(0, 2),
      diagnosis: ricetta.diagnosisText ?? null,
      totalPieces: message.lines.reduce((n, l) => n + l.quantity, 0),
      priority: ricetta.priority ?? null,
      doctorName: message.doctor.name,
      doctorFiscalCode: message.doctor.fiscalCode ?? '',
      doctorRegionalCode: message.doctor.regionalCode ?? null,
    };
    return { ricetta, stampa };
  }

  /**
   * Stampa della ricetta rossa: il medico ha messo il modulo nella stampante e ne legge il numero.
   * La ricetta passa a «ricetta rossa», con un NRE nuovo del lotto e il file DPCM in coda. Se la
   * ricetta dematerializzata può essere arrivata, la coda la annulla.
   */
  async function print(
    actor: Actor,
    p: PrescriptionRow,
    body: unknown,
    ctx: { message: PrescriptionMessage; interrupted: boolean },
  ) {
    const input = printRedSchema.parse(body ?? {});
    const regionCode = await nreLots.regionCodeOf(actor.studioId);
    const problem = poligraficoProblem(input.poligrafico, regionCode);
    if (problem) throw new HttpError(400, problem);
    const poligrafico = parsePoligrafico(input.poligrafico)!;
    const [used] = await db
      .select({ id: dpcmPrescription.id })
      .from(dpcmPrescription)
      .where(eq(dpcmPrescription.poligrafico, poligrafico.code));
    const usedForm = () =>
      new HttpError(
        409,
        `Il modulo ${poligrafico.code} è già stato usato per un’altra ricetta: metti nella stampante un modulo nuovo e leggi il suo numero`,
      );
    if (used) throw usedForm();
    if (!ctx.message.doctor.fiscalCode)
      throw new HttpError(
        409,
        'Manca il codice fiscale del medico: va nella ricetta DPCM (Ricetta2). Nessuna stampa fatta.',
      );
    const compiledAt = studioDate(now());
    const content = await contentOf(p, ctx.message, {
      poligrafico,
      visitType: input.tipoVisita ?? 'A',
      compiledAt,
    });
    // I controlli del file prima di stampare: un modulo non si spreca per un dato che manca.
    const shape = dpcmPrescriptionProblem({ ...content.ricetta, nre: 'X' });
    if (shape) throw new HttpError(422, `La ricetta rossa non si può mandare al SAR: ${shape}`);
    const lots = await nreLots.ensureNumbers(actor, p.id);
    // La ricetta dematerializzata può essere arrivata: tempo scaduto, eccezione o invio interrotto.
    const dmNre =
      p.assignedNre &&
      (p.lastErrorKind === 'timeout' || (p.status === 'sending' && ctx.interrupted))
        ? p.assignedNre
        : null;
    const at = now();
    let done: { nre: string; lotId: string };
    try {
      done = await withActor(db, actor.userId, async (tx) => {
        const taken = await nreLots.take(tx, actor.userId);
        if (!taken)
          throw new HttpError(
            409,
            'I numeri di ricetta (NRE) del medico sono finiti: la ricetta rossa ne vuole uno. Riprova quando il SAR dà il lotto nuovo',
          );
        const stored: DpcmContent = {
          ricetta: { ...content.ricetta, nre: taken.nre },
          stampa: { ...content.stampa, nre: taken.nre },
        };
        // Stessa ricetta e, se era «in invio», stesso invio. Il confronto si fa qui e non in SQL:
        // l'ora salvata può avere i microsecondi, che una data di JavaScript non porta.
        const [row] = await tx
          .select({ status: prescription.status, signedAt: prescription.signedAt })
          .from(prescription)
          .where(eq(prescription.id, p.id))
          .for('update', { of: prescription });
        const sameSend =
          p.status !== 'sending' || row?.signedAt?.getTime() === p.signedAt?.getTime();
        if (row?.status !== p.status || !sameSend)
          throw new HttpError(409, 'La ricetta è cambiata nel frattempo: ricarica la pagina');
        await tx
          .update(prescription)
          .set({
            status: 'paper',
            paperPrintedAt: at,
            paperPrintedBy: actor.userId,
            signedBy: actor.userId,
            signedAt: at,
            sendingSnapshot: null,
            updatedAt: at,
          })
          .where(eq(prescription.id, p.id));
        await tx.insert(dpcmPrescription).values({
          prescriptionId: p.id,
          doctorUserId: actor.userId,
          environment: deps.environment,
          poligrafico: poligrafico.code,
          nre: taken.nre,
          nreLotId: taken.lotId,
          printedAt: at,
          content: stored,
          dmNre,
          // L'annullamento a nome di chi aveva firmato la dematerializzata, con le sue credenziali.
          dmDoctorUserId: dmNre ? (p.signedBy ?? actor.userId) : null,
          dmCancelStatus: dmNre ? 'pending' : null,
        });
        return taken;
      });
    } catch (e) {
      // Due stampe nello stesso istante con lo stesso modulo: la seconda si ferma qui.
      if (uniqueViolation(e, 'dpcm_prescription_poligrafico_key')) throw usedForm();
      if (uniqueViolation(e, 'dpcm_prescription_prescription_key'))
        throw new HttpError(409, 'La ricetta è cambiata nel frattempo: ricarica la pagina');
      throw e;
    }
    if (deps.auto !== false) void kick();
    return {
      stato: 'paper' as const,
      nre: done.nre,
      poligrafico: poligrafico.code,
      pdf: `/api/ricette/${p.id}/ricetta-rossa.pdf`,
      annullamentoDematerializzata: dmNre ? ('da_fare' as const) : null,
      avviso: lots.warning,
    };
  }

  /** La riga della coda si prende: nessun altro giro la lavora nello stesso momento. */
  async function claim(id: string, column: 'next' | 'cancel', force: boolean) {
    const at = now();
    const col =
      column === 'next' ? dpcmPrescription.nextAttemptAt : dpcmPrescription.dmCancelNextAt;
    const due = force ? undefined : or(isNull(col), lte(col, at));
    const [row] = await db
      .update(dpcmPrescription)
      .set(
        column === 'next'
          ? { nextAttemptAt: new Date(at.getTime() + minutes(LEASE_MINUTES)) }
          : { dmCancelNextAt: new Date(at.getTime() + minutes(LEASE_MINUTES)) },
      )
      .where(and(eq(dpcmPrescription.id, id), due))
      .returning();
    return row ?? null;
  }

  async function record(
    row: DpcmRow,
    operation: string,
    request: unknown,
    result: { outcome: string; code?: string | null; message?: string | null; raw?: unknown },
    started: number,
    environment = deps.environment,
    userId = row.doctorUserId,
  ) {
    await withActor(db, userId, (tx) =>
      tx.insert(externalSubmission).values({
        system: 'sar',
        environment,
        operation,
        prescriptionId: row.prescriptionId,
        userId,
        request: request,
        response: result.raw ?? null,
        outcome: result.outcome,
        errorCode: result.code ?? null,
        errorMessage: result.message ?? null,
        durationMs: Date.now() - started,
      }),
    );
  }

  /** Nome, codice regionale e codice fiscale di un medico, come nel messaggio della ricetta. */
  async function doctorOf(userId: string) {
    const [d] = await db
      .select({
        name: appUser.displayName,
        regionalCode: doctorProfile.regionalCode,
        fiscalCode: doctorProfile.fiscalCode,
      })
      .from(appUser)
      .leftJoin(doctorProfile, eq(doctorProfile.userId, appUser.id))
      .where(eq(appUser.id, userId));
    return {
      userId,
      name: d?.name ?? '',
      regionalCode: d?.regionalCode ?? null,
      fiscalCode: d?.fiscalCode ?? null,
    };
  }

  /** Le credenziali per i servizi DPCM: se mancano, si annota e si riprova più tardi. */
  async function authOrError(userId: string, use: 'ricetta_dpcm' | 'ricetta_ssn') {
    try {
      return { auth: await deps.credentials.authFor(userId, use) };
    } catch (err) {
      if (err instanceof HttpError) return { error: err.message };
      throw err;
    }
  }

  async function sendOne(row: DpcmRow) {
    const content = row.content as DpcmContent;
    const got = await authOrError(row.doctorUserId, 'ricetta_dpcm');
    const attempts = row.attempts + 1;
    if ('error' in got) {
      await db
        .update(dpcmPrescription)
        .set({
          attempts,
          lastAttemptAt: now(),
          lastError: `Ricetta rossa non mandata: ${got.error ?? ''}`,
          nextAttemptAt: new Date(now().getTime() + retryAfter(attempts)),
        })
        .where(eq(dpcmPrescription.id, row.id));
      return;
    }
    // Al più un file ogni 2 secondi per medico (6.1.1).
    const wait = (lastSent.get(row.doctorUserId) ?? -Infinity) + minInterval - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const fileName = dpcmFileName(`ricetta${row.nre}`, deps.producer);
    const started = Date.now();
    let receipt: DpcmReceipt;
    try {
      receipt = await within(sar.sendDpcm({ prescription: content.ricetta, fileName }, got.auth), {
        outcome: 'timeout',
        message: 'Nessuna risposta dal SAR in tempo',
      });
    } catch (err) {
      receipt = { outcome: 'timeout', message: `Errore dell'adattatore: ${String(err)}` };
    }
    lastSent.set(row.doctorUserId, Date.now());
    await record(
      row,
      'dpcm_invio',
      { nomeFile: fileName, ricetta: content.ricetta },
      {
        outcome: receipt.outcome,
        code: receipt.outcome === 'rejected' ? receipt.code : null,
        message: receipt.outcome === 'accepted' ? null : receipt.message,
        raw: 'raw' in receipt ? receipt.raw : null,
      },
      started,
    );
    if (receipt.outcome === 'rejected' && receipt.authProblem)
      await deps.credentials.authRefused(
        { userId: row.doctorUserId },
        'ricetta_dpcm',
        receipt.authProblem,
        `${receipt.code}: ${receipt.message}`,
      );
    if (receipt.outcome === 'accepted') {
      await db
        .update(dpcmPrescription)
        .set({
          status: 'accepted',
          protocol: receipt.protocol,
          acceptedAt: new Date(receipt.acceptedAt),
          attempts,
          lastAttemptAt: now(),
          lastError: null,
          nextAttemptAt: new Date(now().getTime() + minutes(DPCM_CHECK_MINUTES)),
        })
        .where(eq(dpcmPrescription.id, row.id));
      return;
    }
    const reason =
      receipt.outcome === 'rejected'
        ? `il SAR non ha accolto il file (${receipt.code}: ${receipt.message})`
        : receipt.outcome === 'unreachable'
          ? `il SAR non è raggiungibile (${receipt.message})`
          : `il SAR non ha risposto in tempo (${receipt.message})`;
    await db
      .update(dpcmPrescription)
      .set({
        attempts,
        lastAttemptAt: now(),
        lastError: `Ricetta rossa non ancora mandata: ${reason}. Si riprova da sé.`,
        nextAttemptAt: new Date(now().getTime() + retryAfter(attempts)),
      })
      .where(eq(dpcmPrescription.id, row.id));
  }

  async function checkOne(row: DpcmRow) {
    const got = await authOrError(row.doctorUserId, 'ricetta_dpcm');
    // L'esito si rilegge ogni 5 minuti, anche dopo una lettura non riuscita: i tentativi
    // dell'invio non contano qui.
    const again = () => new Date(now().getTime() + minutes(DPCM_CHECK_MINUTES));
    if ('error' in got) {
      await db
        .update(dpcmPrescription)
        .set({
          lastError: `Esito della ricetta rossa non letto: ${got.error ?? ''}`,
          nextAttemptAt: again(),
        })
        .where(eq(dpcmPrescription.id, row.id));
      return;
    }
    const auth = got.auth;
    const started = Date.now();
    let summary: DpcmSummaryResult;
    try {
      summary = await within(sar.dpcmSummary({ protocol: row.protocol! }, auth), {
        outcome: 'timeout',
        message: 'Nessuna risposta dal SAR in tempo',
      });
    } catch (err) {
      summary = { outcome: 'timeout', message: `Errore dell'adattatore: ${String(err)}` };
    }
    await record(
      row,
      'dpcm_esito',
      { servizio: 'elencoSintetico', protocollo: row.protocol },
      {
        outcome: summary.outcome === 'ok' ? 'ok' : summary.outcome,
        code: summary.outcome === 'rejected' ? summary.code : null,
        message: summary.outcome === 'ok' ? null : summary.message,
        raw: 'raw' in summary ? summary.raw : null,
      },
      started,
    );
    if (summary.outcome !== 'ok') {
      await db
        .update(dpcmPrescription)
        .set({
          lastError: `Esito della ricetta rossa non ancora letto: ${summary.message}. Si riprova da sé.`,
          nextAttemptAt: again(),
        })
        .where(eq(dpcmPrescription.id, row.id));
      return;
    }
    if (summary.state === 1) {
      await db
        .update(dpcmPrescription)
        .set({
          sendState: 1,
          checkedAt: now(),
          lastError: null,
          nextAttemptAt: again(),
        })
        .where(eq(dpcmPrescription.id, row.id));
      return;
    }
    let messages: { code: string; description: string }[] = [];
    if (summary.state !== 2) {
      const analyticStarted = Date.now();
      let analytic: DpcmAnalyticResult;
      try {
        analytic = await within(sar.dpcmAnalytic({ protocol: row.protocol! }, auth), {
          outcome: 'timeout',
          message: 'Nessuna risposta dal SAR in tempo',
        });
      } catch (err) {
        analytic = { outcome: 'timeout', message: `Errore dell'adattatore: ${String(err)}` };
      }
      await record(
        row,
        'dpcm_esito',
        { servizio: 'elencoAnalitico', protocollo: row.protocol },
        {
          outcome: analytic.outcome === 'ok' ? 'ok' : analytic.outcome,
          code: analytic.outcome === 'rejected' ? analytic.code : null,
          message: analytic.outcome === 'ok' ? null : analytic.message,
          raw: 'raw' in analytic ? analytic.raw : null,
        },
        analyticStarted,
      );
      if (analytic.outcome !== 'ok') {
        await db
          .update(dpcmPrescription)
          .set({
            sendState: summary.state,
            lastError: `Messaggi dell’esito non ancora letti: ${analytic.message}. Si riprova da sé.`,
            nextAttemptAt: again(),
          })
          .where(eq(dpcmPrescription.id, row.id));
        return;
      }
      messages = analytic.records.flatMap((r) => r.errors);
    }
    await db
      .update(dpcmPrescription)
      .set({
        status: summary.state === 2 ? 'ok' : summary.state === 3 ? 'warnings' : 'discarded',
        sendState: summary.state,
        messages,
        checkedAt: now(),
        lastError: null,
        nextAttemptAt: null,
      })
      .where(eq(dpcmPrescription.id, row.id));
  }

  async function cancelDm(row: DpcmRow) {
    // La dematerializzata la annulla chi l'aveva firmata, a suo nome (4.3.2).
    const signer = row.dmDoctorUserId ?? row.doctorUserId;
    const got = await authOrError(signer, 'ricetta_ssn');
    const attempts = row.dmCancelAttempts + 1;
    if ('error' in got) {
      await db
        .update(dpcmPrescription)
        .set({
          dmCancelAttempts: attempts,
          dmCancelError: `Ricetta dematerializzata non ancora annullata: ${got.error ?? ''}`,
          dmCancelNextAt: new Date(now().getTime() + retryAfter(attempts)),
        })
        .where(eq(dpcmPrescription.id, row.id));
      return;
    }
    const doctor = await doctorOf(signer);
    const reason = 'Ricetta senza esito, rifatta come ricetta rossa (V06, 4.3.1)';
    const started = Date.now();
    let result: Awaited<ReturnType<PrescriptionGateway['cancel']>>;
    try {
      result = await within(deps.dm.cancel({ nre: row.dmNre!, reason, doctor }, got.auth), {
        outcome: 'timeout',
        message: 'Nessuna risposta dal SAR in tempo',
      });
    } catch (err) {
      result = { outcome: 'timeout', message: `Errore dell'adattatore: ${String(err)}` };
    }
    await record(
      row,
      'annullamento',
      { nre: row.dmNre, motivo: reason },
      {
        outcome: result.outcome,
        code: result.outcome === 'rejected' ? result.code : null,
        message: result.outcome === 'accepted' ? null : result.message,
        raw: 'raw' in result ? result.raw : null,
      },
      started,
      deps.environment,
      signer,
    );
    if (result.outcome === 'accepted') {
      await db
        .update(dpcmPrescription)
        .set({
          dmCancelStatus: 'done',
          dmCancelAttempts: attempts,
          dmCancelError: null,
          dmCancelNextAt: null,
          dmCancelledAt: now(),
        })
        .where(eq(dpcmPrescription.id, row.id));
      return;
    }
    if (result.outcome === 'rejected' && result.authProblem) {
      await deps.credentials.authRefused(
        { userId: signer },
        'ricetta_ssn',
        result.authProblem,
        `${result.code}: ${result.message}`,
      );
    }
    if (result.outcome === 'rejected' && !result.authProblem) {
      // Il SAR ha risposto e non l'ha annullata: per esempio non c'è perché non era arrivata.
      await db
        .update(dpcmPrescription)
        .set({
          dmCancelStatus: 'failed',
          dmCancelAttempts: attempts,
          dmCancelError: `Il SAR non ha annullato la ricetta dematerializzata ${row.dmNre} (${result.code}: ${result.message}). Se non era arrivata, non serve altro; altrimenti si annulla dal portale del SAR.`,
          dmCancelNextAt: null,
        })
        .where(eq(dpcmPrescription.id, row.id));
      return;
    }
    await db
      .update(dpcmPrescription)
      .set({
        dmCancelAttempts: attempts,
        dmCancelError: `Ricetta dematerializzata non ancora annullata: ${result.message}. Si riprova da sé.`,
        dmCancelNextAt: new Date(now().getTime() + retryAfter(attempts)),
      })
      .where(eq(dpcmPrescription.id, row.id));
  }

  /**
   * Un giro della coda: annullamenti, invii, letture degli esiti. Con `force` (il medico che preme
   * «Invia adesso») non aspetta l'ora del prossimo tentativo.
   */
  async function runOnce(filter: { doctorUserId?: string; force?: boolean } = {}) {
    const mine = (col: SQL | undefined) =>
      filter.doctorUserId ? and(col, eq(dpcmPrescription.doctorUserId, filter.doctorUserId)) : col;
    const cancels = await db
      .select({ id: dpcmPrescription.id })
      .from(dpcmPrescription)
      .where(mine(eq(dpcmPrescription.dmCancelStatus, 'pending')))
      .orderBy(asc(dpcmPrescription.printedAt));
    for (const { id } of cancels) {
      const row = await claim(id, 'cancel', !!filter.force);
      if (row) await guarded(() => cancelDm(row));
    }
    const queue = await db
      .select({ id: dpcmPrescription.id, status: dpcmPrescription.status })
      .from(dpcmPrescription)
      .where(
        mine(or(eq(dpcmPrescription.status, 'to_send'), eq(dpcmPrescription.status, 'accepted'))),
      )
      .orderBy(asc(dpcmPrescription.printedAt));
    for (const { id, status } of queue) {
      const row = await claim(id, 'next', !!filter.force);
      if (!row) continue;
      await guarded(() => (status === 'to_send' ? sendOne(row) : checkOne(row)));
    }
  }

  /** Un errore di una riga non ferma il giro: si scrive nel log e si va avanti. */
  async function guarded(fn: () => Promise<void>) {
    try {
      await fn();
    } catch (err) {
      deps.log?.('Coda della ricetta rossa: errore su una riga', err);
    }
  }

  /** Fa partire un giro, se non ce n'è già uno; restituisce il giro in corso. */
  function kick(filter?: { doctorUserId?: string; force?: boolean }): Promise<void> {
    running ??= runOnce(filter)
      .catch((err) => deps.log?.('Coda della ricetta rossa interrotta', err))
      .finally(() => {
        running = null;
      });
    return running;
  }

  /** «Invia adesso» del medico: aspetta il giro in corso, poi ne fa uno sulle sue ricette. */
  async function runNow(actor: Actor) {
    if (running) await running;
    await kick({ doctorUserId: actor.userId, force: true });
  }

  function start(intervalMs: number) {
    timer = unrefTimer(setInterval(() => void kick(), intervalMs));
  }

  async function stop() {
    if (timer) clearInterval(timer);
    timer = undefined;
    if (running) await running;
  }

  /** Le ricette rosse del medico, per la sua pagina e per Oggi. */
  async function list(actor: Actor) {
    // Quelle in corso sempre; quelle chiuse per 30 giorni, dalla più recente.
    const since = new Date(now().getTime() - DPCM_LIST_DAYS * 86_400_000);
    const rows = await db
      .select({
        d: dpcmPrescription,
        patientId: prescription.patientId,
        firstName: patient.firstName,
        lastName: patient.lastName,
      })
      .from(dpcmPrescription)
      .innerJoin(prescription, eq(prescription.id, dpcmPrescription.prescriptionId))
      .innerJoin(patient, eq(patient.id, prescription.patientId))
      .where(
        and(
          eq(dpcmPrescription.doctorUserId, actor.userId),
          or(openRed(), gte(dpcmPrescription.printedAt, since)),
        ),
      )
      .orderBy(desc(dpcmPrescription.printedAt), desc(dpcmPrescription.id));
    const follow = new Set(
      (
        await db
          .select({ id: dpcmPrescription.id })
          .from(dpcmPrescription)
          .where(and(eq(dpcmPrescription.doctorUserId, actor.userId), redToFollow(now())))
      ).map((r) => r.id),
    );
    return rows.map(({ d, patientId, firstName, lastName }) => ({
      ...view(d, patientId),
      nomePaziente: `${firstName} ${lastName}`,
      pdf: `/api/ricette/${d.prescriptionId}/ricetta-rossa.pdf`,
      daSeguire: follow.has(d.id),
    }));
  }

  function view(d: DpcmRow, patientId?: string) {
    const deadline = new Date(d.printedAt.getTime() + DPCM_DEADLINE_HOURS * 3_600_000);
    return {
      id: d.id,
      ricetta: d.prescriptionId,
      ...(patientId ? { paziente: patientId } : {}),
      poligrafico: d.poligrafico,
      nre: d.nre,
      stampataIl: d.printedAt.toISOString(),
      inviareEntro: deadline.toISOString(),
      stato: d.status,
      protocollo: d.protocol,
      accoltaIl: d.acceptedAt?.toISOString() ?? null,
      messaggi: (d.messages ?? []) as { code: string; description: string }[],
      errore: d.lastError,
      tentativi: d.attempts,
      prossimoTentativo: d.nextAttemptAt?.toISOString() ?? null,
      annullamentoDematerializzata: d.dmCancelStatus
        ? {
            nre: d.dmNre,
            stato: d.dmCancelStatus,
            errore: d.dmCancelError,
            annullataIl: d.dmCancelledAt?.toISOString() ?? null,
          }
        : null,
    };
  }

  async function forPrescription(prescriptionId: string) {
    const [d] = await db
      .select()
      .from(dpcmPrescription)
      .where(eq(dpcmPrescription.prescriptionId, prescriptionId));
    return d ?? null;
  }

  return { print, list, view, forPrescription, runOnce, kick, runNow, start, stop };
}
