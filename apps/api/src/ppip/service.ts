import type {
  AdditionalServiceLine,
  AdditionalServicesPortal,
  AdditionalServicesReport,
} from '@mmg/integrations';
import { and, asc, desc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client';
import { appUser, archive, doctorProfile, patient, ppipRecord, ppipReport } from '../db/schema';
import { withActor, type Tx } from '../db/tx';
import { HttpError } from '../http/errors';
import type { AdditionalServiceItem, ReferenceData } from '../reference/lookup';

/**
 * Prestazioni aggiuntive (PPIP, D212). Fonti: ACN della medicina generale 2022-2024, allegato 6
 * (prestazioni, compensi, distinta del comma 4, autorizzazione del comma 5); AIR del Piemonte 2024
 * (art. 35, comma 4: trasfusioni in ADI; art. 30: rendicontazione su supporto digitale, il cui
 * modo diranno Regione e ASL). I controlli sono solo formali (regola 3): la voce deve
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

/** La voce del catalogo in vigore il giorno dell'esecuzione, con i controlli formali. */
export async function catalogItem(
  reference: ReferenceData,
  body: PpipBody,
  today: string,
  deceasedOn: string | null,
): Promise<AdditionalServiceItem> {
  if (body.data > today) throw new HttpError(400, 'La data dell’esecuzione è nel futuro');
  if (deceasedOn && body.data > deceasedOn)
    throw new HttpError(
      400,
      `La data dell’esecuzione viene dopo il decesso del paziente (${dayIt(deceasedOn)})`,
    );
  const catalog = await reference.additionalServices(body.data);
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

export async function insertPpip(
  tx: Tx,
  patientId: string,
  userId: string,
  body: PpipBody,
  item: AdditionalServiceItem,
) {
  const [row] = await tx
    .insert(ppipRecord)
    .values({
      patientId,
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

/** La prestazione del paziente; altrimenti 404. */
export async function loadPpip(db: Database | Tx, patientId: string, recordId: string) {
  const [r] = await db
    .select()
    .from(ppipRecord)
    .where(and(eq(ppipRecord.id, recordId), eq(ppipRecord.patientId, patientId)));
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
  await tx
    .update(ppipRecord)
    .set({ status: 'annulled', annulledAt: at, annulledBy: userId, annulReason: reason })
    .where(eq(ppipRecord.id, r.id));
}

const money = (v: string | null) => (v === null ? null : Number(v));
const amount = (unit: number | null, qty: number) =>
  unit === null ? null : Math.round(unit * qty * 100) / 100;

export async function listPpip(db: Database, patientId: string) {
  const rows = await db
    .select({ r: ppipRecord, by: appUser.displayName, protocol: ppipReport.protocol })
    .from(ppipRecord)
    .innerJoin(appUser, eq(appUser.id, ppipRecord.createdBy))
    .leftJoin(ppipReport, eq(ppipReport.id, ppipRecord.reportId))
    .where(eq(ppipRecord.patientId, patientId))
    .orderBy(desc(ppipRecord.performedOn), desc(ppipRecord.createdAt));
  return rows.map(({ r, by, protocol }) => ({
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
    protocolloInvio: protocol,
    registrataDa: by,
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
  protocolloInvio: string | null;
}

/** Le prestazioni registrate (non annullate) del mese, per i pazienti dell'archivio. */
export async function monthRows(db: Database, archiveId: string, month: string) {
  const { from, to } = monthBounds(month);
  const rows = await db
    .select({ r: ppipRecord, pt: patient, protocol: ppipReport.protocol })
    .from(ppipRecord)
    .innerJoin(patient, eq(patient.id, ppipRecord.patientId))
    .leftJoin(ppipReport, eq(ppipReport.id, ppipRecord.reportId))
    .where(
      and(
        eq(patient.archiveId, archiveId),
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
    );
  return rows.map(({ r, pt, protocol }): DistintaRow => ({
    id: r.id,
    patientId: pt.id,
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
    .orderBy(desc(ppipReport.sentAt));
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
 * Manda all'ASL le prestazioni del mese non ancora partite. Il mese dev'essere finito (la
 * distinta è delle prestazioni «eseguite nel corso del mese precedente»). Con il simulatore in
 * produzione non parte nulla: il collegamento vero è da completare con Regione e ASL (D212).
 */
export async function sendMonth(params: {
  db: Database;
  portal: AdditionalServicesPortal;
  environment: 'prova' | 'produzione';
  archiveId: string;
  month: string;
  today: string;
  userId: string;
  at: Date;
}) {
  const { db, portal, environment, archiveId, month, today, userId, at } = params;
  if (portal.environment === 'simulator' && environment === 'produzione')
    throw new HttpError(
      409,
      'L’invio della distinta all’ASL non è ancora collegato: si completa quando Regione e ASL diranno come (D212)',
    );
  if (monthBounds(month).to >= today)
    throw new HttpError(
      409,
      'Il mese non è finito: la distinta si manda dal primo giorno del mese dopo',
    );
  const pending = (await monthRows(db, archiveId, month)).filter((r) => !r.inviata);
  if (!pending.length) throw new HttpError(409, 'Nessuna prestazione da inviare per il mese');

  const [doc] = await db
    .select({ name: appUser.displayName, profile: doctorProfile })
    .from(archive)
    .innerJoin(appUser, eq(appUser.id, archive.ownerUserId))
    .leftJoin(doctorProfile, eq(doctorProfile.userId, archive.ownerUserId))
    .where(eq(archive.id, archiveId));
  const lines: AdditionalServiceLine[] = pending.map((r) => ({
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
  const report: AdditionalServicesReport = {
    month,
    doctor: {
      fiscalCode: doc?.profile?.fiscalCode ?? null,
      regionalCode: doc?.profile?.regionalCode ?? null,
      name: doc?.name ?? '',
    },
    lines,
    total: totalOf(pending),
  };
  const result = await portal.submit(report);
  // A nome di chi manda: il segno dell'invio sulle prestazioni va nello storico delle modifiche.
  return withActor(db, userId, async (tx) => {
    const [rep] = await tx
      .insert(ppipReport)
      .values({
        archiveId,
        month,
        outcome: result.outcome,
        protocol: result.outcome === 'accepted' ? result.protocol : null,
        message: result.outcome === 'accepted' ? null : result.message,
        environment: portal.environment,
        lines: lines.length,
        total: report.total === null ? null : report.total.toFixed(2),
        content: report,
        sentBy: userId,
        sentAt: at,
      })
      .returning({ id: ppipReport.id });
    if (result.outcome === 'accepted') {
      await tx
        .update(ppipRecord)
        .set({ reportId: rep!.id })
        .where(
          and(
            inArray(
              ppipRecord.id,
              pending.map((r) => r.id),
            ),
            isNull(ppipRecord.reportId),
            eq(ppipRecord.status, 'active'),
          ),
        );
    }
    return {
      id: rep!.id,
      esito: result.outcome,
      protocollo: result.outcome === 'accepted' ? result.protocol : null,
      messaggio: result.outcome === 'accepted' ? null : result.message,
      righe: lines.length,
      totale: report.total,
      pazienti: [...new Set(pending.map((r) => r.patientId))],
    };
  });
}
