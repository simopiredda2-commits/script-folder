import { can, serviceGroup } from '@mmg/domain';
import { desc, eq } from 'drizzle-orm';
import type { Actor } from '../auth/service';
import type { Database } from '../db/client';
import { prescription, prescriptionLine, therapy } from '../db/schema';
import { guardPatient } from '../patients/access';
import {
  emptyTarget,
  isServiceLine,
  matchesTarget,
  therapyTarget,
  type HistoryTarget,
} from './history';

/**
 * Tutti i farmaci e tutte le prestazioni prescritti al paziente (D152): restano nella cartella,
 * ognuno con il suo storico. Le righe si raggruppano con le regole dello storico (D65, D66), così
 * il numero di ricette di una voce è quello che il suo storico mostra.
 */

type Row = {
  line: typeof prescriptionLine.$inferSelect;
  p: typeof prescription.$inferSelect;
};

/** Stati in cui la ricetta è stata prescritta davvero: inviata o stampata su carta. */
const PRESCRIBED = new Set(['sent', 'paper']);
/** Stati prima dell'invio, o dopo un invio non riuscito. */
const IN_PROGRESS = new Set(['draft', 'to_sign', 'sending', 'error']);
const MONTHS_FOR_TOTAL = 12;

const lower = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();
const when = (p: Row['p']) => p.sentAt ?? p.paperPrintedAt ?? p.preparedAt;

/** Le chiavi per aprire lo storico: le stesse della rotta dello storico. */
export type HistoryQuery =
  | { terapia: string }
  | { aic: string }
  | { principio: string }
  | { farmaco: string }
  | { prestazione: string }
  | { descrizione: string };

function counts(rows: Row[], since: Date) {
  const byPrescription = new Map<string, Row['p']>();
  for (const r of rows) byPrescription.set(r.p.id, r.p);
  const list = [...byPrescription.values()].sort((a, b) => when(b).getTime() - when(a).getTime());
  const last = list[0];
  return {
    /** Ricette che contengono la voce, in qualunque stato. */
    ricette: list.length,
    /** Di queste, inviate o stampate su carta. */
    prescritte: list.filter((p) => PRESCRIBED.has(p.status)).length,
    /** In bozza, da firmare, in invio o con l'invio non riuscito. */
    inPreparazione: list.filter((p) => IN_PROGRESS.has(p.status)).length,
    annullate: list.filter((p) => p.status === 'cancelled').length,
    ultimaIl: last ? when(last) : null,
    ultimoStato: last?.status ?? null,
    /** Confezioni (o quantità) negli ultimi 12 mesi, ricette inviate o su carta: come lo storico. */
    ultimi12Mesi: rows
      .filter(({ p }) => PRESCRIBED.has(p.status) && when(p) >= since)
      .reduce((n, { line }) => n + line.quantity, 0),
  };
}

async function loadRows(db: Database, patientId: string): Promise<Row[]> {
  return db
    .select({ line: prescriptionLine, p: prescription })
    .from(prescriptionLine)
    .innerJoin(prescription, eq(prescription.id, prescriptionLine.prescriptionId))
    .where(eq(prescription.patientId, patientId))
    .orderBy(desc(prescription.preparedAt));
}

function sinceFor(now: () => Date) {
  const since = new Date(now());
  since.setMonth(since.getMonth() - MONTHS_FOR_TOTAL);
  return since;
}

/** Il nome per l'elenco: quello della riga più recente. */
const latest = (rows: Row[]) =>
  [...rows].sort((a, b) => when(b.p).getTime() - when(a.p).getTime())[0];

export async function prescribedDrugs(
  db: Database,
  now: () => Date,
  actor: Actor,
  patientId: string,
) {
  const { context } = await guardPatient(
    db,
    actor,
    patientId,
    'therapy.read',
    'lettura_farmaci_prescritti',
  );
  const reservedAllowed = can(actor, 'reserved.read', { ...context, now: now() }).allowed;
  const therapies = await db.select().from(therapy).where(eq(therapy.patientId, patientId));
  // Le terapie riservate, e le loro righe, le vede solo chi può: come nello storico.
  const hidden = new Set(therapies.filter((t) => t.reserved && !reservedAllowed).map((t) => t.id));
  const rows = (await loadRows(db, patientId)).filter(
    ({ line }) => !isServiceLine(line) && !(line.therapyId && hidden.has(line.therapyId)),
  );
  const since = sinceFor(now);

  const assigned = new Set<string>();
  const fromTherapies = therapies
    .filter((t) => !hidden.has(t.id))
    .map((t) => {
      const mine = rows.filter(({ line }) => matchesTarget(therapyTarget(t), line));
      for (const r of mine) assigned.add(r.line.id);
      return {
        chiave: `terapia:${t.id}`,
        storico: { terapia: t.id },
        farmaco: t.drugName,
        principioAttivo: t.activeIngredient,
        aic: t.drugAic,
        notaAifa: t.aifaNote,
        terapia: {
          id: t.id,
          tipo: t.kind,
          stato: t.status,
          /** Tipologia sulla ricetta: S suggerita, H ricovero (D152). */
          tipologia: t.suggestedS ? ('S' as const) : t.hospitalH ? ('H' as const) : null,
          riservata: t.reserved,
          fine: t.endOn,
          motivoSospensione: t.suspendedReason,
        },
        ...counts(mine, since),
      };
    });

  // Righe senza una terapia che le prenda: una voce per AIC, o per principio, o per nome.
  const groups = new Map<string, { storico: HistoryQuery; target: HistoryTarget }>();
  for (const { line } of rows) {
    if (assigned.has(line.id)) continue;
    const key = line.drugAic
      ? `aic:${line.drugAic}`
      : line.activeIngredient
        ? `principio:${lower(line.activeIngredient)}`
        : `farmaco:${lower(line.drugName)}`;
    if (groups.has(key)) continue;
    groups.set(
      key,
      line.drugAic
        ? { storico: { aic: line.drugAic }, target: { ...emptyTarget(), aic: line.drugAic } }
        : line.activeIngredient
          ? {
              storico: { principio: line.activeIngredient },
              target: { ...emptyTarget(), ingredient: line.activeIngredient },
            }
          : {
              storico: { farmaco: line.drugName ?? '' },
              target: { ...emptyTarget(), name: line.drugName },
            },
    );
  }
  const occasional = [...groups].map(([key, g]) => {
    const mine = rows.filter(({ line }) => matchesTarget(g.target, line));
    const l = latest(mine)!.line;
    return {
      chiave: key,
      storico: g.storico,
      farmaco: l.drugName ?? l.activeIngredient ?? '',
      principioAttivo: l.activeIngredient,
      aic: l.drugAic,
      notaAifa: l.aifaNote,
      /** Prescritto senza una terapia in cartella. */
      terapia: null,
      ...counts(mine, since),
    };
  });

  const byName = (a: { farmaco: string }, b: { farmaco: string }) =>
    a.farmaco.localeCompare(b.farmaco, 'it', { sensitivity: 'base' });
  return { farmaci: [...fromTherapies.sort(byName), ...occasional.sort(byName)] };
}

export async function prescribedServices(
  db: Database,
  now: () => Date,
  actor: Actor,
  patientId: string,
) {
  await guardPatient(db, actor, patientId, 'therapy.read', 'lettura_prestazioni_prescritte');
  const rows = (await loadRows(db, patientId)).filter(({ line }) => isServiceLine(line));
  const since = sinceFor(now);

  const groups = new Map<string, { storico: HistoryQuery; target: HistoryTarget }>();
  for (const { line } of rows) {
    const key = line.serviceCode ?? `descrizione:${lower(line.serviceDescription)}`;
    if (groups.has(key)) continue;
    groups.set(
      key,
      line.serviceCode
        ? {
            storico: { prestazione: line.serviceCode },
            target: { ...emptyTarget(), serviceCode: line.serviceCode },
          }
        : {
            storico: { descrizione: line.serviceDescription ?? '' },
            target: { ...emptyTarget(), serviceDescription: line.serviceDescription },
          },
    );
  }
  const prestazioni = [...groups].map(([key, g]) => {
    const mine = rows.filter(({ line }) => matchesTarget(g.target, line));
    const l = latest(mine)!.line;
    const descrizione = l.serviceDescription ?? l.serviceCode ?? '';
    return {
      chiave: key,
      storico: g.storico,
      codice: l.serviceCode,
      descrizione,
      /** Visita o esame e altre prestazioni, dalla descrizione del catalogo (D152). */
      gruppo: serviceGroup(l.serviceDescription),
      ...counts(mine, since),
    };
  });
  prestazioni.sort((a, b) => a.descrizione.localeCompare(b.descrizione, 'it'));
  return { prestazioni };
}
