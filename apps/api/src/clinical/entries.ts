import {
  ALLERGY_AGENT_DB,
  ALLERGY_AGENTS,
  ALLERGY_CRITICALITIES,
  ALLERGY_CRITICALITY_DB,
  ALLERGY_KIND_DB,
  ALLERGY_KINDS,
  ANAMNESIS_KIND,
  ANAMNESIS_SECTIONS,
  AIC_PATTERN,
  ATC_PATTERN,
  CONTACT_KIND,
  CONTACT_TYPES,
  ENTRY_KIND,
  ENTRY_TYPES,
  ICD9_DIAGNOSIS_PATTERN,
  LAB_RESULTS_MAX,
  MEASURE_KEYS,
  MOTOR_CAPACITIES,
  MOTOR_CAPACITY_KEYS,
  PROBLEM_CATEGORIES,
  PROBLEM_CATEGORY_KIND,
  RELATIVE_KEYS,
  VACCINE_DOSE_MAX,
  checkLabReference,
  checkProblemDates,
  entryTypeOf,
  keyOf,
  measureByKey,
  motorCapacityByKey,
  parseMeasureValue,
  relativeByCode,
  relativeByKey,
  type EntryType,
} from '@mmg/domain';
import { FSE_DICTIONARIES, fseDictionaryEntry } from '@mmg/integrations';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client';
import {
  allergyDetail,
  anamnesisDetail,
  appUser,
  clinicalEntry,
  diaryDetail,
  examinationDetail,
  functionalStatusDetail,
  labResultDetail,
  measurementDetail,
  problemDetail,
  riskFactorDetail,
  vaccinationDetail,
} from '../db/schema';
import type { Tx } from '../db/tx';
import { HttpError } from '../http/errors';

const isoDate = z.iso.date();
const longText = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional();

/** Campi comuni a ogni voce: data, note, riservata, oscurata, promemoria. */
const common = {
  data: isoDate,
  note: optionalText(2000),
  /** Visibile solo al medico. */
  riservata: z.boolean().optional(),
  /** Oscurata su richiesta del paziente: non esce verso il Fascicolo né verso i colleghi. */
  oscurata: z.boolean().optional(),
  /** Promemoria collegato alla voce, tra le scadenze della cartella. */
  promemoria: isoDate.optional(),
};

const problem = z
  .object({
    tipo: z.literal('problema'),
    ...common,
    descrizione: longText(300),
    /** ICD-9-CM 2007, nel formato dello schema del Sistema TS (codiceDiagnosi). */
    codice: z.string().trim().toUpperCase().max(10).optional(),
    stato: z.enum(['attivo', 'risolto']).default('attivo'),
    dal: isoDate.optional(),
    risoltoIl: isoDate.optional(),
    quesitoAperto: z.boolean().optional(),
    /** Patologia cronica: entra nel Profilo Sanitario Sintetico. */
    cronico: z.boolean().optional(),
    /** Organo mancante, trapianto, malformazione: dati obbligatori del Profilo. */
    categoria: z.enum(PROBLEM_CATEGORIES).default('diagnosi'),
  })
  .strict();

const diary = z
  .object({
    tipo: z.literal('diario'),
    ...common,
    contatto: z.enum(CONTACT_TYPES),
    testo: longText(10000),
  })
  .strict();

const measure = z
  .object({
    tipo: z.literal('misura'),
    ...common,
    parametro: z.enum(MEASURE_KEYS),
    valore: z.string().max(20),
  })
  .strict();

const anamnesis = z
  .object({
    tipo: z.literal('anamnesi'),
    ...common,
    sezione: z.enum(ANAMNESIS_SECTIONS),
    testo: longText(5000),
    /** Solo per l'anamnesi familiare: parente, patologia in ICD-9-CM, età all'esordio. */
    parente: z.enum(RELATIVE_KEYS).optional(),
    codice: z.string().trim().toUpperCase().max(10).optional(),
    etaEsordio: z.number().int().min(0).max(130).optional(),
  })
  .strict();

const allergy = z
  .object({
    tipo: z.literal('allergia'),
    ...common,
    sostanza: longText(200),
    reazione: optionalText(500),
    daFarmaco: z.boolean().optional(),
    /** Per il Profilo: allergia o intolleranza, agente, codice dell'agente, criticità. */
    natura: z.enum(ALLERGY_KINDS).default('allergia'),
    agente: z.enum(ALLERGY_AGENTS).optional(),
    codiceAgente: z.string().trim().toUpperCase().max(20).optional(),
    criticita: z.enum(ALLERGY_CRITICALITIES).optional(),
  })
  .strict();

const motorCapacity = z
  .object({
    tipo: z.literal('capacita_motoria'),
    ...common,
    capacita: z.enum(MOTOR_CAPACITY_KEYS),
  })
  .strict();

const lifestyle = z
  .object({
    tipo: z.literal('stile_di_vita'),
    ...common,
    fattore: longText(100),
    valore: longText(300),
  })
  .strict();

const examination = z
  .object({
    tipo: z.literal('esame_obiettivo'),
    ...common,
    testo: longText(5000),
    /** Nome della scheda o della scala di valutazione (es. le schede UVG). */
    scala: optionalText(100),
    punteggio: optionalText(50),
  })
  .strict();

/**
 * Vaccinazione (tappa 15): vaccino, lotto, numero della dose, campagna; la data è quella della
 * somministrazione. Il vaccino ha un nome libero: l'elenco ufficiale dei vaccini non è ancora tra
 * le banche dati (fonte da individuare). Il promemoria serve per la dose successiva.
 */
const vaccination = z
  .object({
    tipo: z.literal('vaccinazione'),
    ...common,
    vaccino: longText(200),
    lotto: optionalText(50),
    dose: z.number().int().min(1).max(VACCINE_DOSE_MAX).optional(),
    campagna: optionalText(200),
  })
  .strict();

/** I campi di un risultato di laboratorio, uguali da soli e dentro un referto con più esami. */
const labFields = {
  esame: longText(200),
  /** Il valore come lo scrive il referto: un numero o un testo («negativo», «assente»). */
  valore: longText(100),
  unita: optionalText(30),
  /** Intervallo di riferimento: minimo e massimo, oppure il testo stampato sul referto. */
  minimo: optionalText(20),
  massimo: optionalText(20),
  intervallo: optionalText(200),
  /** Codice della prestazione nel catalogo regionale, se il referto lo riporta. */
  codicePrestazione: z.string().trim().toUpperCase().max(40).optional(),
};

/** Risultato di un esame di laboratorio, con la data del referto (tappa 15). */
const labResult = z
  .object({ tipo: z.literal('esame_laboratorio'), ...common, ...labFields })
  .strict();

export const newEntryBody = z.discriminatedUnion('tipo', [
  problem,
  diary,
  measure,
  anamnesis,
  allergy,
  lifestyle,
  examination,
  motorCapacity,
  vaccination,
  labResult,
]);
export type NewEntry = z.infer<typeof newEntryBody>;

/**
 * Più risultati dello stesso referto insieme: una voce per esame, scritte in una transazione
 * sola (come i parametri della stessa visita, D112): un risultato sbagliato li ferma tutti.
 */
export const newLabResultsBody = z
  .object({
    data: isoDate,
    note: optionalText(2000),
    riservata: z.boolean().optional(),
    oscurata: z.boolean().optional(),
    risultati: z.array(z.object(labFields).strict()).min(1).max(LAB_RESULTS_MAX),
  })
  .strict();

/** Le voci di un referto con più esami, una per risultato, pronte per `entryIssues`. */
export function labResultEntries(body: z.infer<typeof newLabResultsBody>): NewEntry[] {
  return body.risultati.map((r) => ({
    tipo: 'esame_laboratorio' as const,
    data: body.data,
    note: body.note,
    riservata: body.riservata,
    oscurata: body.oscurata,
    ...r,
  }));
}

/** Più parametri della stessa visita insieme: pressione, peso, altezza e gli altri. */
export const newMeasurementsBody = z
  .object({
    data: isoDate,
    note: optionalText(2000),
    riservata: z.boolean().optional(),
    misure: z
      .array(z.object({ parametro: z.enum(MEASURE_KEYS), valore: z.string().max(20) }).strict())
      .min(1)
      .max(MEASURE_KEYS.length)
      .refine((m) => new Set(m.map((x) => x.parametro)).size === m.length, {
        message: 'Ogni parametro una volta sola',
      }),
  })
  .strict();

export const entryPatchBody = z
  .object({
    riservata: z.boolean().optional(),
    oscurata: z.boolean().optional(),
    promemoria: isoDate.nullable().optional(),
    stato: z.enum(['attivo', 'risolto']).optional(),
    risoltoIl: isoDate.nullable().optional(),
    quesitoAperto: z.boolean().optional(),
    /** Problema cronico o no (per il Profilo Sanitario Sintetico). */
    cronico: z.boolean().optional(),
    /** Allergia ancora attiva o no. */
    allergiaAttiva: z.boolean().optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: 'Nessun campo da modificare' });

export const annulBody = z.object({ motivo: longText(500) }).strict();

export const listQuery = z
  .object({
    tipo: z.enum(ENTRY_TYPES).optional(),
    /** Anche le voci annullate, con il motivo. */
    annullate: z.enum(['si', 'no']).default('si'),
  })
  .strict();

/** Errori formali di una voce nuova, in italiano; vuoto se va bene. */
export function entryIssues(e: NewEntry, today: string): string[] {
  const out: string[] = [];
  if (e.data > today) out.push('Data della voce: è nel futuro');
  if (e.promemoria && e.promemoria < e.data)
    out.push('Promemoria: la data viene prima di quella della voce');
  if (e.tipo === 'problema') {
    if (e.categoria === 'organo_mancante') {
      if (!e.codice) out.push('Organo mancante: scegli il codice dall’elenco ufficiale');
      else if (!fseDictionaryEntry(FSE_DICTIONARIES.missingOrgans, e.codice))
        out.push('Organo mancante: il codice non è nell’elenco ufficiale «Organi mancanti»');
    } else if (e.codice && !ICD9_DIAGNOSIS_PATTERN.test(e.codice))
      out.push('Codice: non è nel formato ICD-9-CM (es. 401.9, 250.00, V17.3)');
    out.push(
      ...checkProblemDates({ state: e.stato, onsetOn: e.dal, resolvedOn: e.risoltoIl }, today),
    );
  }
  if (e.tipo === 'anamnesi') {
    const family = e.parente !== undefined || e.codice !== undefined || e.etaEsordio !== undefined;
    if (family && e.sezione !== 'familiare')
      out.push('Parente, codice ed età all’esordio valgono solo per l’anamnesi familiare');
    if (e.codice && !ICD9_DIAGNOSIS_PATTERN.test(e.codice))
      out.push('Codice: non è nel formato ICD-9-CM (es. 401.9, 250.00, V17.3)');
  }
  if (e.tipo === 'allergia') {
    if (e.daFarmaco && e.agente && e.agente !== 'farmaco')
      out.push('Allergia da farmaco: l’agente dev’essere un farmaco');
    const agent = e.agente ?? (e.daFarmaco ? 'farmaco' : undefined);
    if (e.codiceAgente) {
      if (!agent) out.push('Codice dell’agente: indica prima di che agente si tratta');
      else if (agent === 'farmaco') {
        if (!AIC_PATTERN.test(e.codiceAgente) && !ATC_PATTERN.test(e.codiceAgente))
          out.push('Codice del farmaco: scrivi l’AIC (9 cifre) o l’ATC (per esempio J01CA04)');
      } else if (!fseDictionaryEntry(FSE_DICTIONARIES.allergens, e.codiceAgente))
        out.push('Codice dell’agente: non è nell’elenco ufficiale degli allergeni');
    }
  }
  if (e.tipo === 'misura') {
    const r = parseMeasureValue(e.valore, measureByKey(e.parametro)!);
    if ('error' in r) out.push(r.error);
  }
  if (e.tipo === 'esame_laboratorio')
    out.push(
      ...checkLabReference({ minimo: e.minimo, massimo: e.massimo }).map((m) => `${e.esame}: ${m}`),
    );
  return out;
}

export function assertNoIssues(issues: string[]): void {
  if (issues.length) throw new HttpError(400, issues.join('. '), { problemi: issues });
}

/** Scrive la voce e il suo dettaglio, nella transazione dell'utente (storico). */
export async function insertEntry(
  tx: Tx,
  patientId: string,
  authorUserId: string,
  e: NewEntry,
): Promise<string> {
  const [row] = await tx
    .insert(clinicalEntry)
    .values({
      patientId,
      kind: ENTRY_KIND[e.tipo],
      occurredOn: e.data,
      authorUserId,
      notes: e.note || null,
      reserved: e.riservata ?? false,
      obscured: e.oscurata ?? false,
      reminderOn: e.promemoria ?? null,
    })
    .returning({ id: clinicalEntry.id });
  const entryId = row!.id;
  switch (e.tipo) {
    case 'problema':
      await tx.insert(problemDetail).values({
        entryId,
        icdCode: e.codice || null,
        icdSystem: e.categoria === 'organo_mancante' ? MISSING_ORGANS_SYSTEM : 'ICD-9-CM',
        description: e.descrizione,
        state: e.stato === 'risolto' ? 'resolved' : 'active',
        onsetOn: e.dal ?? null,
        resolvedOn: e.risoltoIl ?? null,
        openQuestion: e.quesitoAperto ?? false,
        chronic: e.cronico ?? false,
        category: PROBLEM_CATEGORY_KIND[e.categoria],
      });
      break;
    case 'diario':
      await tx
        .insert(diaryDetail)
        .values({ entryId, contactType: CONTACT_KIND[e.contatto], text: e.testo });
      break;
    case 'misura': {
      const def = measureByKey(e.parametro)!;
      const parsed = parseMeasureValue(e.valore, def);
      if ('error' in parsed) throw new HttpError(400, parsed.error);
      await tx
        .insert(measurementDetail)
        .values({ entryId, measure: def.label, value: parsed.value, unit: def.unit });
      break;
    }
    case 'anamnesi':
      await tx.insert(anamnesisDetail).values({
        entryId,
        section: ANAMNESIS_KIND[e.sezione],
        text: e.testo,
        relativeCode: e.parente ? relativeByKey(e.parente)!.code : null,
        icdCode: e.codice || null,
        onsetAge: e.etaEsordio ?? null,
      });
      break;
    case 'allergia': {
      const agent = e.agente ?? (e.daFarmaco ? 'farmaco' : undefined);
      await tx.insert(allergyDetail).values({
        entryId,
        substance: e.sostanza,
        reaction: e.reazione || null,
        drugRelated: e.daFarmaco ?? agent === 'farmaco',
        kind: ALLERGY_KIND_DB[e.natura],
        agentCategory: agent ? ALLERGY_AGENT_DB[agent] : null,
        agentCode: e.codiceAgente || null,
        agentSystem: e.codiceAgente
          ? agent === 'farmaco'
            ? AIC_PATTERN.test(e.codiceAgente)
              ? 'AIC'
              : 'ATC'
            : 'ALLERGENI'
          : null,
        criticality: e.criticita ? ALLERGY_CRITICALITY_DB[e.criticita] : null,
      });
      break;
    }
    case 'capacita_motoria':
      await tx
        .insert(functionalStatusDetail)
        .values({ entryId, motorCapacity: motorCapacityByKey(e.capacita)!.code });
      break;
    case 'stile_di_vita':
      await tx.insert(riskFactorDetail).values({ entryId, factor: e.fattore, value: e.valore });
      break;
    case 'esame_obiettivo':
      await tx.insert(examinationDetail).values({
        entryId,
        text: e.testo,
        scale: e.scala || null,
        score: e.punteggio || null,
      });
      break;
    case 'vaccinazione':
      await tx.insert(vaccinationDetail).values({
        entryId,
        vaccine: e.vaccino,
        lot: e.lotto || null,
        doseNumber: e.dose ?? null,
        campaign: e.campagna || null,
      });
      break;
    case 'esame_laboratorio':
      // Il valore e gli estremi si conservano come li scrive il referto, senza conversioni.
      await tx.insert(labResultDetail).values({
        entryId,
        analyte: e.esame,
        value: e.valore,
        unit: e.unita || null,
        referenceLow: e.minimo || null,
        referenceHigh: e.massimo || null,
        referenceText: e.intervallo || null,
        serviceCode: e.codicePrestazione || null,
      });
      break;
  }
  return entryId;
}

/** Sistema dei codici degli organi mancanti nel dettaglio del problema. */
export const MISSING_ORGANS_SYSTEM = 'Organi mancanti (ICD-10)';

/** Dettaglio di una voce nell'interfaccia, con le parole dei requisiti. */
export type EntryDetail =
  | {
      descrizione: string;
      codice: string | null;
      sistema: string;
      stato: 'attivo' | 'risolto';
      dal: string | null;
      risoltoIl: string | null;
      quesitoAperto: boolean;
      cronico: boolean;
      categoria: string | undefined;
    }
  | { contatto: string | undefined; testo: string }
  | { parametro: string; valore: string; unita: string }
  | {
      sezione: string | undefined;
      testo: string;
      parente: string | null;
      codice: string | null;
      etaEsordio: number | null;
    }
  | {
      sostanza: string;
      reazione: string | null;
      daFarmaco: boolean;
      natura: string | undefined;
      agente: string | null;
      codiceAgente: string | null;
      sistemaAgente: string | null;
      criticita: string | null;
      attiva: boolean;
    }
  | { fattore: string; valore: string }
  | { testo: string; scala: string | null; punteggio: string | null }
  | { capacita: string | null; codice: string }
  | { vaccino: string; lotto: string | null; dose: number | null; campagna: string | null }
  | {
      esame: string;
      valore: string;
      unita: string | null;
      minimo: string | null;
      massimo: string | null;
      intervallo: string | null;
      codicePrestazione: string | null;
    };

/** I dettagli delle voci, per id. */
async function loadDetails(db: Database | Tx, ids: string[]) {
  const out = new Map<string, EntryDetail>();
  if (!ids.length) return out;
  for (const r of await db.select().from(problemDetail).where(inArray(problemDetail.entryId, ids)))
    out.set(r.entryId, {
      descrizione: r.description,
      codice: r.icdCode,
      sistema: r.icdSystem,
      stato: r.state === 'resolved' ? 'risolto' : 'attivo',
      dal: r.onsetOn,
      risoltoIl: r.resolvedOn,
      quesitoAperto: r.openQuestion,
      cronico: r.chronic,
      categoria: keyOf(PROBLEM_CATEGORY_KIND, r.category),
    });
  for (const r of await db.select().from(diaryDetail).where(inArray(diaryDetail.entryId, ids)))
    out.set(r.entryId, { contatto: keyOf(CONTACT_KIND, r.contactType), testo: r.text });
  for (const r of await db
    .select()
    .from(measurementDetail)
    .where(inArray(measurementDetail.entryId, ids)))
    out.set(r.entryId, { parametro: r.measure, valore: r.value, unita: r.unit });
  for (const r of await db
    .select()
    .from(anamnesisDetail)
    .where(inArray(anamnesisDetail.entryId, ids)))
    out.set(r.entryId, {
      sezione: keyOf(ANAMNESIS_KIND, r.section),
      testo: r.text,
      parente: r.relativeCode ? (relativeByCode(r.relativeCode)?.key ?? null) : null,
      codice: r.icdCode,
      etaEsordio: r.onsetAge,
    });
  for (const r of await db.select().from(allergyDetail).where(inArray(allergyDetail.entryId, ids)))
    out.set(r.entryId, {
      sostanza: r.substance,
      reazione: r.reaction,
      daFarmaco: r.drugRelated,
      natura: keyOf(ALLERGY_KIND_DB, r.kind),
      agente: r.agentCategory ? (keyOf(ALLERGY_AGENT_DB, r.agentCategory) ?? null) : null,
      codiceAgente: r.agentCode,
      sistemaAgente: r.agentSystem,
      criticita: r.criticality ? (keyOf(ALLERGY_CRITICALITY_DB, r.criticality) ?? null) : null,
      attiva: r.active,
    });
  for (const r of await db
    .select()
    .from(functionalStatusDetail)
    .where(inArray(functionalStatusDetail.entryId, ids)))
    out.set(r.entryId, {
      capacita: MOTOR_CAPACITIES.find((m) => m.code === r.motorCapacity)?.key ?? null,
      codice: r.motorCapacity,
    });
  for (const r of await db
    .select()
    .from(riskFactorDetail)
    .where(inArray(riskFactorDetail.entryId, ids)))
    out.set(r.entryId, { fattore: r.factor, valore: r.value });
  for (const r of await db
    .select()
    .from(examinationDetail)
    .where(inArray(examinationDetail.entryId, ids)))
    out.set(r.entryId, { testo: r.text, scala: r.scale, punteggio: r.score });
  for (const r of await db
    .select()
    .from(vaccinationDetail)
    .where(inArray(vaccinationDetail.entryId, ids)))
    out.set(r.entryId, {
      vaccino: r.vaccine,
      lotto: r.lot,
      dose: r.doseNumber,
      campagna: r.campaign,
    });
  for (const r of await db
    .select()
    .from(labResultDetail)
    .where(inArray(labResultDetail.entryId, ids)))
    out.set(r.entryId, {
      esame: r.analyte,
      valore: r.value,
      unita: r.unit,
      minimo: r.referenceLow,
      massimo: r.referenceHigh,
      intervallo: r.referenceText,
      codicePrestazione: r.serviceCode,
    });
  return out;
}

export interface EntryView {
  id: string;
  tipo: EntryType;
  data: string;
  autore: string;
  note: string | null;
  riservata: boolean;
  oscurata: boolean;
  promemoria: string | null;
  stato: 'attiva' | 'annullata';
  annullataIl: Date | null;
  motivoAnnullamento: string | null;
  dettaglio: EntryDetail | null;
}

/** Le voci scritte dalla cartella, dalla più recente; le riservate solo a chi può leggerle. */
export async function listEntries(
  db: Database,
  patientId: string,
  opts: { tipo?: EntryType; reservedAllowed: boolean; includeAnnulled: boolean },
): Promise<EntryView[]> {
  const kinds = opts.tipo ? [ENTRY_KIND[opts.tipo]] : ENTRY_TYPES.map((t) => ENTRY_KIND[t]);
  const rows = await db
    .select({ e: clinicalEntry, autore: appUser.displayName })
    .from(clinicalEntry)
    .innerJoin(appUser, eq(appUser.id, clinicalEntry.authorUserId))
    .where(
      and(
        eq(clinicalEntry.patientId, patientId),
        inArray(clinicalEntry.kind, kinds),
        opts.reservedAllowed ? undefined : eq(clinicalEntry.reserved, false),
        opts.includeAnnulled ? undefined : eq(clinicalEntry.status, 'active'),
      ),
    )
    .orderBy(desc(clinicalEntry.occurredOn), desc(clinicalEntry.createdAt));
  const details = await loadDetails(
    db,
    rows.map((r) => r.e.id),
  );
  return rows.map(({ e, autore }) => ({
    id: e.id,
    tipo: entryTypeOf(e.kind)!,
    data: e.occurredOn,
    autore,
    note: e.notes,
    riservata: e.reserved,
    oscurata: e.obscured,
    promemoria: e.reminderOn,
    stato: e.status === 'annulled' ? 'annullata' : 'attiva',
    annullataIl: e.annulledAt,
    motivoAnnullamento: e.annulReason,
    dettaglio: details.get(e.id) ?? null,
  }));
}

/** Andamento dei parametri nel tempo: una serie per parametro, dalla data più vecchia. */
export async function measurementSeries(db: Database, patientId: string, reservedAllowed: boolean) {
  const rows = await db
    .select({
      id: clinicalEntry.id,
      data: clinicalEntry.occurredOn,
      parametro: measurementDetail.measure,
      valore: measurementDetail.value,
      unita: measurementDetail.unit,
    })
    .from(measurementDetail)
    .innerJoin(clinicalEntry, eq(clinicalEntry.id, measurementDetail.entryId))
    .where(
      and(
        eq(clinicalEntry.patientId, patientId),
        eq(clinicalEntry.status, 'active'),
        reservedAllowed ? undefined : eq(clinicalEntry.reserved, false),
      ),
    )
    .orderBy(asc(clinicalEntry.occurredOn), asc(clinicalEntry.createdAt));
  const series = new Map<
    string,
    { parametro: string; unita: string; valori: { id: string; data: string; valore: string }[] }
  >();
  for (const r of rows) {
    // Stesso parametro con unità diverse: serie diverse, per non mescolare le scale.
    const key = `${r.parametro}\u0000${r.unita}`;
    const s = series.get(key) ?? { parametro: r.parametro, unita: r.unita, valori: [] };
    s.valori.push({ id: r.id, data: r.data, valore: r.valore });
    series.set(key, s);
  }
  return [...series.values()];
}

/** La voce del paziente, se chi la chiede può vederla; altrimenti 404. */
export async function loadEntry(
  db: Database | Tx,
  patientId: string,
  entryId: string,
  reservedAllowed: boolean,
) {
  const [e] = await db
    .select()
    .from(clinicalEntry)
    .where(and(eq(clinicalEntry.id, entryId), eq(clinicalEntry.patientId, patientId)));
  if (!e || (e.reserved && !reservedAllowed)) throw new HttpError(404, 'Voce non trovata');
  return e;
}

/** Modifica ammessa: riservata, oscurata, promemoria; per i problemi stato e quesito. */
export async function patchEntry(
  tx: Tx,
  entry: typeof clinicalEntry.$inferSelect,
  patch: z.infer<typeof entryPatchBody>,
  today: string,
): Promise<void> {
  if (entry.status === 'annulled') throw new HttpError(409, 'La voce è annullata: non si modifica');
  const problemFields =
    patch.stato !== undefined ||
    patch.risoltoIl !== undefined ||
    patch.quesitoAperto !== undefined ||
    patch.cronico !== undefined;
  if (problemFields && entry.kind !== 'problem')
    throw new HttpError(
      400,
      'Stato, risoluzione, quesito aperto e cronicità valgono solo per i problemi',
    );
  if (patch.allergiaAttiva !== undefined) {
    if (entry.kind !== 'allergy')
      throw new HttpError(400, 'Attiva o non più attiva vale solo per le allergie');
    await tx
      .update(allergyDetail)
      .set({ active: patch.allergiaAttiva })
      .where(eq(allergyDetail.entryId, entry.id));
  }
  if (patch.promemoria && patch.promemoria < entry.occurredOn)
    throw new HttpError(400, 'Promemoria: la data viene prima di quella della voce');
  const common: Partial<typeof clinicalEntry.$inferInsert> = {};
  if (patch.riservata !== undefined) common.reserved = patch.riservata;
  if (patch.oscurata !== undefined) common.obscured = patch.oscurata;
  if (patch.promemoria !== undefined) common.reminderOn = patch.promemoria;
  if (Object.keys(common).length)
    await tx.update(clinicalEntry).set(common).where(eq(clinicalEntry.id, entry.id));
  if (!problemFields) return;
  const [current] = await tx
    .select()
    .from(problemDetail)
    .where(eq(problemDetail.entryId, entry.id));
  if (!current) throw new HttpError(409, 'Problema senza dettaglio');
  const state = patch.stato ?? (current.state === 'resolved' ? 'risolto' : 'attivo');
  // Tornando attivo, la data di risoluzione si toglie se non se ne indica un'altra.
  const resolvedOn =
    patch.risoltoIl !== undefined
      ? patch.risoltoIl
      : state === 'attivo'
        ? null
        : current.resolvedOn;
  assertNoIssues(checkProblemDates({ state, onsetOn: current.onsetOn, resolvedOn }, today));
  await tx
    .update(problemDetail)
    .set({
      state: state === 'risolto' ? 'resolved' : 'active',
      resolvedOn,
      ...(patch.quesitoAperto !== undefined ? { openQuestion: patch.quesitoAperto } : {}),
      ...(patch.cronico !== undefined ? { chronic: patch.cronico } : {}),
    })
    .where(eq(problemDetail.entryId, entry.id));
}

/** Annullamento con motivo: la voce resta, con chi e quando l'ha annullata. */
export async function annulEntry(
  tx: Tx,
  entry: typeof clinicalEntry.$inferSelect,
  userId: string,
  reason: string,
  at: Date,
): Promise<void> {
  if (entry.status === 'annulled') throw new HttpError(409, 'La voce è già annullata');
  await tx
    .update(clinicalEntry)
    .set({ status: 'annulled', annulledAt: at, annulledBy: userId, annulReason: reason })
    .where(eq(clinicalEntry.id, entry.id));
}
