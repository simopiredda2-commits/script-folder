import { can, serviceGroup } from '@mmg/domain';
import { desc, eq } from 'drizzle-orm';
import type { Actor } from '../auth/service';
import type { Database } from '../db/client';
import { prescription, prescriptionLine, therapy } from '../db/schema';
import { guardPatient } from '../patients/access';
import {
  activeHistorical,
  historicalLine,
  historicalViews,
  pastCounts,
  visibleHistorical,
} from './historical';
import { studioDate } from './rules-check';
import {
  emptyTarget,
  isServiceLine,
  matchesTarget,
  therapyTarget,
  type HistoryTarget,
  type LineFields,
} from './history';

/**
 * Tutti i farmaci e tutte le prestazioni prescritti al paziente (D152): restano nella cartella,
 * ognuno con il suo storico. Le righe si raggruppano con le regole dello storico (D65, D66), così
 * il numero di ricette di una voce è quello che il suo storico mostra.
 *
 * Le ricette fatte con un altro programma (tappa 15) si raggruppano con le stesse regole, ma si
 * contano a parte («altroProgramma»): non sono ricette di questo programma, e i conti delle nostre
 * (inviate, in preparazione, ultimi 12 mesi) restano quelli dello storico.
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

/**
 * L'ultima ricetta di una voce, prescritta davvero (inviata o su carta), con le sue confezioni:
 * nell'elenco si legge a colpo d'occhio (richiesta di Simone del 23/11/2026). Conta anche una
 * ricetta fatta con un altro programma, se è la più recente.
 */
export interface LastPrescription {
  /** Il giorno della ricetta nello studio, AAAA-MM-GG. */
  il: string;
  /** Confezioni (o quantità) della voce in quella ricetta; null se la ricetta passata non le dice. */
  quantita: number | null;
  /** Fatta con un altro programma (tappa 15). */
  altroProgramma: boolean;
}

type PastRow = Awaited<ReturnType<typeof visibleHistorical>>[number];

function lastPrescription(rows: Row[], past: PastRow[]): LastPrescription | null {
  const prescribed = rows.filter(({ p }) => PRESCRIBED.has(p.status));
  const ours = prescribed.length ? latest(prescribed)!.p : null;
  const mine: LastPrescription | null = ours && {
    il: studioDate(when(ours)),
    // Più righe della stessa voce nella stessa ricetta: le confezioni si sommano.
    quantita: prescribed
      .filter(({ p }) => p.id === ours.id)
      .reduce((n, { line }) => n + line.quantity, 0),
    altroProgramma: false,
  };
  // Le ricette passate valide, già dalla più recente.
  const before = activeHistorical(past)[0];
  const theirs: LastPrescription | null = before
    ? { il: before.prescribedOn, quantita: before.quantity, altroProgramma: true }
    : null;
  // Nello stesso giorno vale la nostra: la ricetta passata non dice l'ora.
  if (!mine || !theirs) return mine ?? theirs;
  return theirs.il > mine.il ? theirs : mine;
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

/** La voce di un farmaco senza terapia: per AIC, per principio attivo o per nome (D152). */
function drugGroup(l: LineFields): [string, { storico: HistoryQuery; target: HistoryTarget }] {
  if (l.drugAic)
    return [
      `aic:${l.drugAic}`,
      { storico: { aic: l.drugAic }, target: { ...emptyTarget(), aic: l.drugAic } },
    ];
  if (l.activeIngredient)
    return [
      `principio:${lower(l.activeIngredient)}`,
      {
        storico: { principio: l.activeIngredient },
        target: { ...emptyTarget(), ingredient: l.activeIngredient },
      },
    ];
  return [
    `farmaco:${lower(l.drugName)}`,
    {
      storico: { farmaco: l.drugName ?? '' },
      target: { ...emptyTarget(), name: l.drugName },
    },
  ];
}

/** La voce di una prestazione: per codice regionale, o per descrizione se il codice manca. */
function serviceGroupKey(
  l: LineFields,
): [string, { storico: HistoryQuery; target: HistoryTarget }] {
  return l.serviceCode
    ? [
        l.serviceCode,
        {
          storico: { prestazione: l.serviceCode },
          target: { ...emptyTarget(), serviceCode: l.serviceCode },
        },
      ]
    : [
        `descrizione:${lower(l.serviceDescription)}`,
        {
          storico: { descrizione: l.serviceDescription ?? '' },
          target: { ...emptyTarget(), serviceDescription: l.serviceDescription },
        },
      ];
}

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
  const at = { ...context, now: now() };
  const reservedAllowed = can(actor, 'reserved.read', at).allowed;
  const therapies = await db.select().from(therapy).where(eq(therapy.patientId, patientId));
  // Le terapie riservate, e le loro righe, le vede solo chi può: come nello storico.
  const hidden = new Set(therapies.filter((t) => t.reserved && !reservedAllowed).map((t) => t.id));
  const rows = (await loadRows(db, patientId)).filter(
    ({ line }) => !isServiceLine(line) && !(line.therapyId && hidden.has(line.therapyId)),
  );
  // Ricette fatte con un altro programma: tutte nell'elenco a parte, le valide nei conti.
  const pastAll = (await visibleHistorical(db, patientId, reservedAllowed)).filter(
    (h) => h.kind === 'farmaco',
  );
  const past = activeHistorical(pastAll);
  const pastOf = (target: HistoryTarget) =>
    past.filter((h) => matchesTarget(target, historicalLine(h)));
  const since = sinceFor(now);

  const assigned = new Set<string>();
  const assignedPast = new Set<string>();
  const fromTherapies = therapies
    .filter((t) => !hidden.has(t.id))
    .map((t) => {
      const mine = rows.filter(({ line }) => matchesTarget(therapyTarget(t), line));
      for (const r of mine) assigned.add(r.line.id);
      const minePast = pastOf(therapyTarget(t));
      for (const h of minePast) assignedPast.add(h.id);
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
        ultimaPrescrizione: lastPrescription(mine, minePast),
        /** Ricette dello stesso farmaco fatte con un altro programma (tappa 15). */
        altroProgramma: pastCounts(minePast),
      };
    });

  // Righe senza una terapia che le prenda: una voce per AIC, o per principio, o per nome. Le
  // ricette fatte con un altro programma entrano con le stesse regole; un farmaco prescritto solo
  // con il programma di prima ha la sua voce.
  const groups = new Map<string, { storico: HistoryQuery; target: HistoryTarget }>();
  const addGroup = (l: LineFields) => {
    const [key, g] = drugGroup(l);
    if (!groups.has(key)) groups.set(key, g);
  };
  // Un farmaco senza terapia entra quando è stato prescritto davvero, qui o con un altro programma:
  // una bozza mai partita, o annullata, non è una prescrizione (audit, D259). Con la terapia la voce
  // c'è sempre, ed è la terapia.
  for (const { line, p } of rows)
    if (!assigned.has(line.id) && PRESCRIBED.has(p.status)) addGroup(line);
  for (const h of past) if (!assignedPast.has(h.id)) addGroup(historicalLine(h));
  const occasional = [...groups].map(([key, g]) => {
    const mine = rows.filter(({ line }) => matchesTarget(g.target, line));
    const minePast = pastOf(g.target);
    // Il nome dell'elenco: quello della nostra riga più recente, altrimenti della ricetta passata
    // più recente (le ricette passate sono già dalla più recente).
    const l: LineFields & { aifaNote?: string | null } = mine.length
      ? latest(mine)!.line
      : historicalLine(minePast[0]!);
    return {
      chiave: key,
      storico: g.storico,
      farmaco: l.drugName ?? l.activeIngredient ?? (l.drugAic ? `AIC ${l.drugAic}` : ''),
      principioAttivo: l.activeIngredient,
      aic: l.drugAic,
      notaAifa: l.aifaNote ?? null,
      /** Prescritto senza una terapia in cartella. */
      terapia: null,
      ...counts(mine, since),
      ultimaPrescrizione: lastPrescription(mine, minePast),
      altroProgramma: pastCounts(minePast),
    };
  });

  const byName = (a: { farmaco: string }, b: { farmaco: string }) =>
    a.farmaco.localeCompare(b.farmaco, 'it', { sensitivity: 'base' });
  // Dall'ultima ricetta più recente (richiesta di Simone del 23/11/2026); le voci mai prescritte
  // in fondo. A parità, per nome. L'interfaccia divide in gruppi e tiene quest'ordine.
  type Entry = { farmaco: string; ultimaPrescrizione: LastPrescription | null };
  const byLast = (a: Entry, b: Entry) => {
    const x = a.ultimaPrescrizione?.il ?? '';
    const y = b.ultimaPrescrizione?.il ?? '';
    return x === y ? byName(a, b) : x < y ? 1 : -1;
  };
  return {
    farmaci: [...fromTherapies.sort(byLast), ...occasional.sort(byLast)],
    /** Le ricette fatte con un altro programma, una per una, anche le annullate (tappa 15). */
    ricettePassate: await historicalViews(db, pastAll),
    /** Chi può registrarne o annullarne: il medico, come per le voci cliniche. */
    puoRegistrare: can(actor, 'clinical.write', at).allowed,
  };
}

export async function prescribedServices(
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
    'lettura_prestazioni_prescritte',
  );
  const at = { ...context, now: now() };
  const reservedAllowed = can(actor, 'reserved.read', at).allowed;
  const rows = (await loadRows(db, patientId)).filter(({ line }) => isServiceLine(line));
  // Ricette fatte con un altro programma: tutte nell'elenco a parte, le valide nei conti.
  const pastAll = (await visibleHistorical(db, patientId, reservedAllowed)).filter(
    (h) => h.kind === 'prestazione',
  );
  const past = activeHistorical(pastAll);
  const since = sinceFor(now);

  const groups = new Map<string, { storico: HistoryQuery; target: HistoryTarget }>();
  const addGroup = (l: LineFields) => {
    const [key, g] = serviceGroupKey(l);
    if (!groups.has(key)) groups.set(key, g);
  };
  for (const { line } of rows) addGroup(line);
  for (const h of past) addGroup(historicalLine(h));
  const prestazioni = [...groups].map(([key, g]) => {
    const mine = rows.filter(({ line }) => matchesTarget(g.target, line));
    const minePast = past.filter((h) => matchesTarget(g.target, historicalLine(h)));
    // Codice e descrizione della nostra riga più recente, altrimenti della ricetta passata.
    const l = mine.length ? latest(mine)!.line : historicalLine(minePast[0]!);
    const descrizione = l.serviceDescription ?? l.serviceCode ?? '';
    return {
      chiave: key,
      storico: g.storico,
      codice: l.serviceCode,
      descrizione,
      /** Visita o esame e altre prestazioni, dalla descrizione del catalogo (D152). */
      gruppo: serviceGroup(l.serviceDescription),
      ...counts(mine, since),
      /** Ricette della stessa prestazione fatte con un altro programma (tappa 15). */
      altroProgramma: pastCounts(minePast),
    };
  });
  prestazioni.sort((a, b) => a.descrizione.localeCompare(b.descrizione, 'it'));
  return {
    prestazioni,
    /** Le ricette fatte con un altro programma, una per una, anche le annullate (tappa 15). */
    ricettePassate: await historicalViews(db, pastAll),
    puoRegistrare: can(actor, 'clinical.write', at).allowed,
  };
}
