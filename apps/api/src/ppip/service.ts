import type {
  AdditionalServiceLine,
  AdditionalServicesPortal,
  AdditionalServicesReport,
  AdditionalServicesResult,
} from '@mmg/integrations';
import { INTERRUPTED_SEND_AFTER_MINUTES } from '@mmg/domain';
import { and, asc, desc, eq, gte, inArray, isNotNull, lte } from 'drizzle-orm';
import { z } from 'zod';
import { logAccessForPatients } from '../audit/access-log';
import type { Actor } from '../auth/service';
import type { Database } from '../db/client';
import {
  appUser,
  archive,
  doctorProfile,
  patient,
  ppipRecord,
  ppipReport,
  ppipSending,
  studio,
} from '../db/schema';
import { secondsText } from '../admin/studio-service';
import { withActor, type Tx } from '../db/tx';
import { HttpError } from '../http/errors';
import type { AdditionalServiceItem, ReferenceData, ReferenceScope } from '../reference/lookup';

/**
 * Prestazioni aggiuntive (PPIP, D212). Fonti: ACN della medicina generale 2022-2024, allegato 6
 * (prestazioni, compensi, distinta del comma 4, autorizzazione del comma 5); AIR del Piemonte 2024
 * (art. 35, comma 4: trasfusioni in ADI; artt. 30 e 36: rendicontazione su supporto digitale, il
 * cui modo diranno Regione e ASL). I controlli sono solo formali (regola 3): la voce deve
 * essere nel catalogo in vigore il giorno dell'esecuzione, la sezione B vuole gli estremi
 * dell'autorizzazione, la data non è futura né dopo il decesso.
 */

const isoDate = z.iso.date();
const optionalText = (max: number) => z.string().trim().max(max).optional();

export const PLACE_LABELS = { studio: 'In studio', home: 'A domicilio' } as const;
const PLACES = { studio: 'studio', domicilio: 'home' } as const;

export const ppipBody = z
  .object({
    /** Data di effettuazione. */
    data: isoDate,
    codice: z.string().trim().min(1).max(30),
    /** Limite di formato, come D93: le regole sulle quantità non sono nell'allegato 6. */
    quantita: z.number().int().min(1).max(99).default(1),
    luogo: z.enum(['studio', 'domicilio']),
    autorizzazione: optionalText(200),
    note: optionalText(500),
  })
  .strict();
export type PpipBody = z.infer<typeof ppipBody>;

/** Mese AAAA-MM vero. */
export const monthSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Il mese va scritto come AAAA-MM');

export const monthBounds = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(last).padStart(2, '0')}` };
};

/** Il giorno 15 del mese dopo: entro questo giorno si manda la distinta (allegato 6, comma 4). */
export function reportDeadline(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
  return `${next}-15`;
}

const dayIt = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

/**
 * La regione dello studio e l'ASL del titolare dell'archivio: dove valgono l'accordo regionale e
 * quello aziendale (D232).
 */
export async function archiveScope(db: Database, archiveId: string): Promise<ReferenceScope> {
  const [row] = await db
    .select({ region: studio.regionName, asl: doctorProfile.asl })
    .from(archive)
    .innerJoin(studio, eq(studio.id, archive.studioId))
    .leftJoin(doctorProfile, eq(doctorProfile.userId, archive.ownerUserId))
    .where(eq(archive.id, archiveId));
  return { region: row?.region ?? null, asl: row?.asl ?? null };
}

/** La voce del catalogo in vigore il giorno dell'esecuzione, con i controlli formali. */
export async function catalogItem(
  reference: ReferenceData,
  body: PpipBody,
  today: string,
  deceasedOn: string | null,
  scope: ReferenceScope,
): Promise<AdditionalServiceItem> {
  if (body.data > today) throw new HttpError(400, 'La data dell’esecuzione è nel futuro');
  if (deceasedOn && body.data > deceasedOn)
    throw new HttpError(
      400,
      `La data dell’esecuzione viene dopo il decesso del paziente (${dayIt(deceasedOn)})`,
    );
  const catalog = await reference.additionalServices(body.data, scope);
  if (!catalog.length)
    throw new HttpError(
      409,
      `Nessun catalogo delle prestazioni aggiuntive in vigore il ${dayIt(body.data)}: va importato con le banche dati`,
    );
  const item = catalog.find((c) => c.code === body.codice);
  if (!item)
    throw new HttpError(
      400,
      `La prestazione ${body.codice} non è nel catalogo delle prestazioni aggiuntive in vigore il ${dayIt(body.data)}`,
    );
  if (item.authorization && !body.autorizzazione)
    throw new HttpError(
      400,
      `La prestazione ${item.code} è soggetta ad autorizzazione: servono gli estremi, da mandare con la distinta (ACN, allegato 6, comma 5)`,
    );
  return item;
}

/**
 * La prestazione nasce nell'archivio dove il paziente sta quando la si registra, e lì resta: la
 * distinta è del titolare di quell'archivio anche se poi il paziente cambia medico (D232).
 */
export async function insertPpip(
  tx: Tx,
  target: { patientId: string; archiveId: string },
  userId: string,
  body: PpipBody,
  item: AdditionalServiceItem,
) {
  const [row] = await tx
    .insert(ppipRecord)
    .values({
      patientId: target.patientId,
      archiveId: target.archiveId,
      performedOn: body.data,
      code: item.code,
      section: item.section,
      description: item.description,
      authorizationRequired: item.authorization,
      unitCompensation: item.compensation === null ? null : item.compensation.toFixed(2),
      datasetId: item.datasetId,
      quantity: body.quantita,
      place: PLACES[body.luogo],
      authorizationRef: body.autorizzazione || null,
      notes: body.note || null,
      createdBy: userId,
    })
    .returning({ id: ppipRecord.id });
  return row!.id;
}

/**
 * La prestazione, bloccata fino alla fine della transazione: un annullamento e un invio della
 * distinta non si incrociano, e due annullamenti nemmeno (D232). Altrimenti 404.
 */
export async function lockPpip(
  tx: Tx,
  recordId: string,
  where: { patientId: string } | { archiveId: string },
) {
  const [r] = await tx
    .select()
    .from(ppipRecord)
    .where(
      and(
        eq(ppipRecord.id, recordId),
        'patientId' in where
          ? eq(ppipRecord.patientId, where.patientId)
          : eq(ppipRecord.archiveId, where.archiveId),
      ),
    )
    .for('update');
  if (!r) throw new HttpError(404, 'Prestazione non trovata');
  return r;
}

export async function annulPpip(
  tx: Tx,
  r: typeof ppipRecord.$inferSelect,
  userId: string,
  reason: string,
  at: Date,
) {
  if (r.status === 'annulled') throw new HttpError(409, 'La prestazione è già annullata');
  if (r.reportId) {
    const [rep] = await tx
      .select({ sentAt: ppipReport.sentAt, protocol: ppipReport.protocol })
      .from(ppipReport)
      .where(eq(ppipReport.id, r.reportId));
    throw new HttpError(
      409,
      `La prestazione è già partita con la distinta${rep?.protocol ? ` ${rep.protocol}` : ''}: la correzione si chiede all’ASL`,
    );
  }
  if (r.sendingSince)
    throw new HttpError(
      409,
      'La prestazione sta partendo con la distinta: si annulla solo se l’invio non va a buon fine',
    );
  await tx
    .update(ppipRecord)
    .set({ status: 'annulled', annulledAt: at, annulledBy: userId, annulReason: reason })
    .where(eq(ppipRecord.id, r.id));
}

const money = (v: string | null) => (v === null ? null : Number(v));
const amount = (unit: number | null, qty: number) =>
  unit === null ? null : Math.round(unit * qty * 100) / 100;

/**
 * Le prestazioni del paziente. Quelle registrate in un altro archivio, prima che il paziente
 * cambiasse medico, restano nella distinta di quell'archivio: qui si leggono e basta (D232).
 */
export async function listPpip(db: Database, patientId: string, currentArchiveId: string) {
  const rows = await db
    .select({
      r: ppipRecord,
      by: appUser.displayName,
      protocol: ppipReport.protocol,
      archiveName: archive.name,
    })
    .from(ppipRecord)
    .innerJoin(appUser, eq(appUser.id, ppipRecord.createdBy))
    .innerJoin(archive, eq(archive.id, ppipRecord.archiveId))
    .leftJoin(ppipReport, eq(ppipReport.id, ppipRecord.reportId))
    .where(eq(ppipRecord.patientId, patientId))
    .orderBy(desc(ppipRecord.performedOn), desc(ppipRecord.createdAt));
  return rows.map(({ r, by, protocol, archiveName }) => ({
    id: r.id,
    data: r.performedOn,
    codice: r.code,
    sezione: r.section,
    descrizione: r.description,
    quantita: r.quantity,
    luogo: r.place === 'home' ? 'domicilio' : 'studio',
    nomeLuogo: PLACE_LABELS[r.place],
    autorizzazione: r.authorizationRef,
    compensoUnitario: money(r.unitCompensation),
    importo: amount(money(r.unitCompensation), r.quantity),
    note: r.notes,
    stato: r.status === 'annulled' ? 'annullata' : 'registrata',
    motivoAnnullamento: r.annulReason,
    inviata: r.reportId !== null,
    inInvio: r.sendingSince !== null,
    protocolloInvio: protocol,
    registrataDa: by,
    /** Il nome dell'archivio solo se non è quello di adesso: la prestazione è nella sua distinta. */
    altroArchivio: r.archiveId === currentArchiveId ? null : archiveName,
  }));
}

/** Indirizzo di residenza come sul promemoria (via e civico, CAP, comune, provincia). */
export function residenceAddress(pt: typeof patient.$inferSelect): string | null {
  const text = [
    [pt.residenceStreet, pt.residenceNumber].filter(Boolean).join(' '),
    [pt.residencePostalCode, pt.residenceTown, pt.residenceProvince && `(${pt.residenceProvince})`]
      .filter(Boolean)
      .join(' '),
  ]
    .filter(Boolean)
    .join(', ');
  return text || null;
}

export interface DistintaRow {
  id: string;
  patientId: string;
  /** Il paziente sta ancora in questo archivio: altrimenti la sua cartella è di un altro medico. */
  pazienteNellArchivio: boolean;
  data: string;
  cognome: string;
  nome: string;
  indirizzo: string | null;
  codiceFiscale: string;
  codice: string;
  sezione: string;
  descrizione: string;
  quantita: number;
  luogo: string;
  autorizzazione: string | null;
  compensoUnitario: number | null;
  importo: number | null;
  inviata: boolean;
  /** Da quando la prestazione sta partendo con un invio della distinta (D232). */
  inInvioDal: string | null;
  protocolloInvio: string | null;
}

/**
 * Le prestazioni registrate (non annullate) del mese nell'archivio, cioè quelle registrate lì,
 * anche di pazienti passati poi a un altro medico (D232). Con `lock` restano bloccate fino alla
 * fine della transazione.
 */
export async function monthRows(
  db: Database | Tx,
  archiveId: string,
  month: string,
  opts: { lock?: boolean } = {},
) {
  const { from, to } = monthBounds(month);
  const query = db
    .select({ r: ppipRecord, pt: patient, protocol: ppipReport.protocol })
    .from(ppipRecord)
    .innerJoin(patient, eq(patient.id, ppipRecord.patientId))
    .leftJoin(ppipReport, eq(ppipReport.id, ppipRecord.reportId))
    .where(
      and(
        eq(ppipRecord.archiveId, archiveId),
        eq(ppipRecord.status, 'active'),
        gte(ppipRecord.performedOn, from),
        lte(ppipRecord.performedOn, to),
      ),
    )
    .orderBy(
      asc(ppipRecord.performedOn),
      asc(patient.lastName),
      asc(patient.firstName),
      asc(ppipRecord.createdAt),
      asc(ppipRecord.id),
    );
  const rows = await (opts.lock ? query.for('update', { of: ppipRecord }) : query);
  return rows.map(({ r, pt, protocol }): DistintaRow => ({
    id: r.id,
    patientId: pt.id,
    pazienteNellArchivio: pt.archiveId === archiveId,
    data: r.performedOn,
    cognome: pt.lastName,
    nome: pt.firstName,
    indirizzo: residenceAddress(pt),
    codiceFiscale: pt.fiscalCode,
    codice: r.code,
    sezione: r.section,
    descrizione: r.description,
    quantita: r.quantity,
    luogo: PLACE_LABELS[r.place],
    autorizzazione: r.authorizationRef,
    compensoUnitario: money(r.unitCompensation),
    importo: amount(money(r.unitCompensation), r.quantity),
    inviata: r.reportId !== null,
    inInvioDal: r.sendingSince ? r.sendingSince.toISOString() : null,
    protocolloInvio: protocol,
  }));
}

/** Somma degli importi; vuota se una riga non ha il compenso (non si inventa). */
export function totalOf(rows: readonly { importo: number | null }[]): number | null {
  if (rows.some((r) => r.importo === null)) return null;
  return Math.round(rows.reduce((s, r) => s + (r.importo ?? 0), 0) * 100) / 100;
}

/** Prestazioni per voce, con quantità e importo. */
export function byService(rows: readonly DistintaRow[]) {
  const map = new Map<
    string,
    { codice: string; descrizione: string; quantita: number; importo: number | null }
  >();
  for (const r of rows) {
    const cur = map.get(r.codice) ?? {
      codice: r.codice,
      descrizione: r.descrizione,
      quantita: 0,
      importo: 0,
    };
    cur.quantita += r.quantita;
    cur.importo = cur.importo === null || r.importo === null ? null : cur.importo + r.importo;
    if (cur.importo !== null) cur.importo = Math.round(cur.importo * 100) / 100;
    map.set(r.codice, cur);
  }
  return [...map.values()].sort((a, b) =>
    a.codice.localeCompare(b.codice, 'it', { numeric: true }),
  );
}

export async function reportsOf(db: Database, archiveId: string, month: string) {
  const rows = await db
    .select({ r: ppipReport, by: appUser.displayName })
    .from(ppipReport)
    .innerJoin(appUser, eq(appUser.id, ppipReport.sentBy))
    .where(and(eq(ppipReport.archiveId, archiveId), eq(ppipReport.month, month)))
    .orderBy(desc(ppipReport.sentAt), desc(ppipReport.id));
  return rows.map(({ r, by }) => ({
    id: r.id,
    esito: r.outcome,
    protocollo: r.protocol,
    messaggio: r.message,
    ambiente: r.environment,
    righe: r.lines,
    totale: money(r.total),
    inviataIl: r.sentAt.toISOString(),
    inviataDa: by,
  }));
}

/**
 * Dopo quanto un invio senza risposta si considera interrotto: il servizio si è fermato a metà, o
 * il portale non ha risposto in modo chiaro. Prima, l'invio potrebbe essere ancora in corso.
 */
export const INTERRUPTED_AFTER_MINUTES = INTERRUPTED_SEND_AFTER_MINUTES;

/** Ambiente degli esiti segnati dal titolare: consegna fuori dal programma o esito chiesto all'ASL. */
export const MANUAL_ENVIRONMENT = 'manuale';

/** L'invio dal programma c'è: con il simulatore, in produzione, no (D212). */
export const sendingAvailable = (
  portal: AdditionalServicesPortal,
  environment: 'prova' | 'produzione',
) => !(portal.environment === 'simulator' && environment === 'produzione');

/** Le stesse prestazioni, ognuna una volta sola. */
const sameIds = (a: readonly string[], b: readonly string[]) => {
  const set = new Set(a);
  return (
    a.length === b.length &&
    set.size === a.length &&
    new Set(b).size === b.length &&
    b.every((x) => set.has(x))
  );
};

const patientsOf = (rows: readonly DistintaRow[]) => [...new Set(rows.map((r) => r.patientId))];

/** La distinta come parte: il mese, il medico titolare dell'archivio, le righe, il totale. */
async function reportOf(
  tx: Tx,
  archiveId: string,
  month: string,
  rows: readonly DistintaRow[],
): Promise<AdditionalServicesReport> {
  const [doc] = await tx
    .select({ name: appUser.displayName, profile: doctorProfile })
    .from(archive)
    .innerJoin(appUser, eq(appUser.id, archive.ownerUserId))
    .leftJoin(doctorProfile, eq(doctorProfile.userId, archive.ownerUserId))
    .where(eq(archive.id, archiveId));
  const lines: AdditionalServiceLine[] = rows.map((r) => ({
    performedOn: r.data,
    patient: {
      fiscalCode: r.codiceFiscale,
      lastName: r.cognome,
      firstName: r.nome,
      address: r.indirizzo,
    },
    code: r.codice,
    description: r.descrizione,
    quantity: r.quantita,
    place: r.luogo === PLACE_LABELS.home ? 'home' : 'studio',
    authorizationRef: r.autorizzazione,
    unitCompensation: r.compensoUnitario,
  }));
  return {
    month,
    doctor: {
      fiscalCode: doc?.profile?.fiscalCode ?? null,
      regionalCode: doc?.profile?.regionalCode ?? null,
      name: doc?.name ?? '',
    },
    lines,
    total: totalOf(rows),
  };
}

async function insertReport(
  tx: Tx,
  v: {
    archiveId: string;
    month: string;
    result: AdditionalServicesResult;
    environment: string;
    report: AdditionalServicesReport;
    userId: string;
    at: Date;
    /** La risposta del portale è arrivata dopo l'esito segnato a mano: resta, e lo dice (D239). */
    late?: boolean;
  },
) {
  const late = v.late
    ? 'Risposta del portale arrivata dopo l’esito segnato a mano: le prestazioni restano come segnate. Chiedi all’ASL prima di mandarle di nuovo'
    : null;
  const [rep] = await tx
    .insert(ppipReport)
    .values({
      archiveId: v.archiveId,
      month: v.month,
      outcome: v.result.outcome,
      protocol: v.result.outcome === 'accepted' ? v.result.protocol || null : null,
      message:
        v.result.outcome === 'accepted'
          ? late
          : [v.result.message, late].filter(Boolean).join('. '),
      environment: v.environment,
      lines: v.report.lines.length,
      total: v.report.total === null ? null : v.report.total.toFixed(2),
      content: v.report,
      sentBy: v.userId,
      sentAt: v.at,
    })
    .returning({ id: ppipReport.id });
  return rep!.id;
}

/**
 * Le prestazioni da inviare del mese, bloccate fino alla fine della transazione. Devono essere
 * proprio quelle che il titolare ha controllato: se nel frattempo se n'è aggiunta o annullata
 * una, la distinta va ricontrollata (regola 5, D232). Con un invio in corso non se ne comincia un
 * altro: le prestazioni partirebbero due volte.
 */
async function lockPending(tx: Tx, archiveId: string, month: string, seen: readonly string[]) {
  const rows = await monthRows(tx, archiveId, month, { lock: true });
  if (rows.some((r) => r.inInvioDal))
    throw new HttpError(
      409,
      'Un invio della distinta del mese è già in corso, o è rimasto senza risposta: aspetta l’esito, o segnalo nella distinta',
    );
  const pending = rows.filter((r) => !r.inviata);
  if (
    !sameIds(
      pending.map((r) => r.id),
      seen,
    )
  )
    throw new HttpError(
      409,
      'La distinta è cambiata dopo il controllo: ricontrollala prima di mandarla',
    );
  if (!pending.length) throw new HttpError(409, 'Nessuna prestazione da inviare per il mese');
  return pending;
}

function monthEnded(month: string, today: string) {
  if (monthBounds(month).to >= today)
    throw new HttpError(
      409,
      'Il mese non è finito: la distinta si manda dal primo giorno del mese dopo',
    );
}

interface MonthAction {
  db: Database;
  actor: Actor;
  archiveId: string;
  month: string;
  at: Date;
}

/**
 * Manda all'ASL le prestazioni del mese non ancora partite, quelle che il titolare ha controllato
 * (`seen`). Il mese dev'essere finito (la distinta è delle prestazioni «eseguite nel corso del
 * mese precedente»). Con il simulatore in produzione non parte nulla: il collegamento vero è da
 * completare con Regione e ASL (D212).
 *
 * Tre passi (D232): le prestazioni passano «in invio», tutte insieme, e nessun altro invio o
 * annullamento le tocca; il portale, fuori da ogni transazione; l'esito, il segno sulle
 * prestazioni e il registro degli accessi, insieme. Se il servizio si ferma a metà, le prestazioni
 * restano «in invio» e l'esito lo segna il titolare, dopo averlo chiesto all'ASL: rimandarle da
 * sole potrebbe farle arrivare due volte.
 */
export async function sendMonth(
  params: MonthAction & {
    portal: AdditionalServicesPortal;
    environment: 'prova' | 'produzione';
    seen: readonly string[];
    today: string;
    /** Quanto si aspetta il portale (D239): poi l'esito è incerto, come senza risposta. */
    timeoutMs: number;
  },
) {
  const { db, portal, environment, actor, archiveId, month, seen, today, at, timeoutMs } = params;
  if (!sendingAvailable(portal, environment))
    throw new HttpError(
      409,
      'L’invio della distinta all’ASL non è ancora collegato: si completa quando Regione e ASL diranno come',
    );
  monthEnded(month, today);
  const { pending, report } = await withActor(db, actor.userId, async (tx) => {
    const pending = await lockPending(tx, archiveId, month, seen);
    await tx
      .update(ppipRecord)
      .set({ sendingSince: at, sendingBy: actor.userId })
      .where(
        inArray(
          ppipRecord.id,
          pending.map((r) => r.id),
        ),
      );
    // La distinta come parte: resta finché l'invio non ha un esito, per quello segnato a mano se
    // il servizio si ferma o il portale non risponde (D239).
    const report = await reportOf(tx, archiveId, month, pending);
    await tx.insert(ppipSending).values({
      archiveId,
      month,
      startedAt: at,
      startedBy: actor.userId,
      content: report,
    });
    return { pending, report };
  });
  const entry = {
    studioId: actor.studioId,
    userId: actor.userId,
    action: 'invio_distinta_ppip' as const,
    workstation: actor.workstation,
  };

  let result: AdditionalServicesResult;
  let timer: NodeJS.Timeout | undefined;
  try {
    result = await Promise.race([
      portal.submit(report),
      new Promise<never>((_, fail) => {
        timer = setTimeout(
          () => fail(new Error(`Nessuna risposta entro ${secondsText(timeoutMs)}`)),
          timeoutMs,
        );
      }),
    ]);
  } catch {
    // Non si sa se la distinta è arrivata: le prestazioni restano «in invio». I dati sono forse
    // partiti, quindi restano nel registro.
    await withActor(db, actor.userId, (tx) =>
      logAccessForPatients(tx, patientsOf(pending), {
        ...entry,
        outcome: 'fallito',
        details: {
          archivio: archiveId,
          mese: month,
          esito: 'senza_risposta',
          righe: pending.length,
        },
      }),
    );
    throw new HttpError(
      502,
      'Il portale non ha risposto in modo chiaro: le prestazioni restano «in invio». Chiedi all’ASL se la distinta è arrivata, poi segna l’esito nella distinta',
    );
  } finally {
    clearTimeout(timer);
  }

  const done = await withActor(db, actor.userId, async (tx) => {
    // Se intanto il titolare ha segnato l'esito a mano, quello vale: la risposta arrivata ora resta
    // fra gli invii, con il suo esito, e non cambia le prestazioni (D233, D239).
    const sending = await tx
      .delete(ppipSending)
      .where(
        and(
          eq(ppipSending.archiveId, archiveId),
          eq(ppipSending.month, month),
          eq(ppipSending.startedAt, at),
          eq(ppipSending.startedBy, actor.userId),
        ),
      )
      .returning({ id: ppipSending.id });
    const late = sending.length === 0;
    const id = await insertReport(tx, {
      archiveId,
      month,
      result,
      environment: portal.environment,
      report,
      userId: actor.userId,
      at,
      late,
    });
    if (!late)
      await tx
        .update(ppipRecord)
        .set({
          sendingSince: null,
          sendingBy: null,
          ...(result.outcome === 'accepted' ? { reportId: id } : {}),
        })
        .where(
          and(
            inArray(
              ppipRecord.id,
              pending.map((r) => r.id),
            ),
            eq(ppipRecord.sendingSince, at),
            eq(ppipRecord.sendingBy, actor.userId),
          ),
        );
    await logAccessForPatients(tx, patientsOf(pending), {
      ...entry,
      outcome: result.outcome === 'accepted' && !late ? 'riuscito' : 'fallito',
      details: {
        archivio: archiveId,
        mese: month,
        esito: late ? 'risposta_dopo_esito_a_mano' : result.outcome,
        righe: pending.length,
      },
    });
    if (late) return null;
    return {
      id,
      esito: result.outcome,
      protocollo: result.outcome === 'accepted' ? result.protocol : null,
      messaggio: result.outcome === 'accepted' ? null : result.message,
      righe: pending.length,
      totale: report.total,
    };
  });
  if (!done)
    throw new HttpError(
      409,
      'Nel frattempo l’esito di questo invio è stato segnato a mano: la risposta del portale arrivata ora resta fra gli invii della distinta. Ricarica la pagina',
    );
  return done;
}

/**
 * La distinta consegnata all'ASL fuori dal programma, per esempio con il CSV sul portale o nello
 * strumento dell'ASL: le prestazioni controllate (`seen`) risultano partite, con il riferimento
 * della consegna se c'è, e non si annullano più (D232). È la strada di oggi in produzione.
 */
export async function deliverMonth(
  params: MonthAction & { seen: readonly string[]; reference: string | null; today: string },
) {
  const { db, actor, archiveId, month, seen, reference, today, at } = params;
  monthEnded(month, today);
  return withActor(db, actor.userId, async (tx) => {
    const pending = await lockPending(tx, archiveId, month, seen);
    const report = await reportOf(tx, archiveId, month, pending);
    const id = await insertReport(tx, {
      archiveId,
      month,
      result: { outcome: 'accepted', protocol: reference ?? '' },
      environment: MANUAL_ENVIRONMENT,
      report,
      userId: actor.userId,
      at,
    });
    await tx
      .update(ppipRecord)
      .set({ reportId: id })
      .where(
        inArray(
          ppipRecord.id,
          pending.map((r) => r.id),
        ),
      );
    await logAccessForPatients(tx, patientsOf(pending), {
      studioId: actor.studioId,
      userId: actor.userId,
      action: 'consegna_distinta_ppip',
      outcome: 'riuscito',
      workstation: actor.workstation,
      details: { archivio: archiveId, mese: month, righe: pending.length },
    });
    return { id, righe: pending.length, totale: report.total };
  });
}

/**
 * L'esito di un invio rimasto senza risposta, segnato dal titolare dopo averlo chiesto all'ASL
 * (D232): arrivata, e le prestazioni risultano partite; non arrivata, e tornano da inviare. Non
 * prima di INTERRUPTED_AFTER_MINUTES dall'inizio: l'invio potrebbe essere ancora in corso.
 */
export async function settleInterrupted(
  params: MonthAction & { arrived: boolean; reference: string | null },
) {
  const { db, actor, archiveId, month, arrived, reference, at } = params;
  return withActor(db, actor.userId, async (tx) => {
    const rows = await monthRows(tx, archiveId, month, { lock: true });
    const sending = rows.filter((r) => r.inInvioDal);
    if (!sending.length) throw new HttpError(409, 'Nessun invio senza risposta per il mese');
    const since = Math.max(...sending.map((r) => Date.parse(r.inInvioDal!)));
    if (at.getTime() - since < INTERRUPTED_AFTER_MINUTES * 60_000)
      throw new HttpError(
        409,
        `L’invio è cominciato da meno di ${INTERRUPTED_AFTER_MINUTES} minuti: potrebbe essere ancora in corso`,
      );
    // La distinta come è partita con quell'invio (D239); per un invio cominciato prima della
    // fotografia, com'è adesso.
    const [started] = await tx
      .delete(ppipSending)
      .where(
        and(
          eq(ppipSending.archiveId, archiveId),
          eq(ppipSending.month, month),
          eq(ppipSending.startedAt, new Date(since)),
        ),
      )
      .returning({ content: ppipSending.content });
    const report =
      (started?.content as AdditionalServicesReport | undefined) ??
      (await reportOf(tx, archiveId, month, sending));
    const id = await insertReport(tx, {
      archiveId,
      month,
      result: arrived
        ? { outcome: 'accepted', protocol: reference ?? '' }
        : {
            outcome: 'unreachable',
            message: 'Non arrivata all’ASL, secondo l’ASL: le prestazioni tornano da inviare',
          },
      environment: MANUAL_ENVIRONMENT,
      report,
      userId: actor.userId,
      at,
    });
    await tx
      .update(ppipRecord)
      .set({ sendingSince: null, sendingBy: null, ...(arrived ? { reportId: id } : {}) })
      .where(
        and(
          inArray(
            ppipRecord.id,
            sending.map((r) => r.id),
          ),
          isNotNull(ppipRecord.sendingSince),
        ),
      );
    await logAccessForPatients(tx, patientsOf(sending), {
      studioId: actor.studioId,
      userId: actor.userId,
      action: 'esito_distinta_ppip',
      outcome: 'riuscito',
      workstation: actor.workstation,
      details: {
        archivio: archiveId,
        mese: month,
        esito: arrived ? 'arrivata' : 'non_arrivata',
        righe: sending.length,
      },
    });
    return { id, righe: sending.length, esito: arrived ? 'arrivata' : 'non_arrivata' };
  });
}
