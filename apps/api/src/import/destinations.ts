import { createHash } from 'node:crypto';
import {
  birthCode,
  choiceValidity,
  doctorChoiceIssues,
  doctorChoicePeriodSchema,
  exemptionSchema,
  importDestination,
  nameCode,
  PATIENT_STATUSES,
  patientAdminIssues,
  periodsOverlap,
  patientAdminSchema,
  patientIdentitySchema,
  REMINDER_CHANNELS,
  surnameCode,
  type DoctorChoicePeriodInput,
  type ExemptionInput,
  type ImportDestinationKey,
  type PatientAdminInput,
  type PatientIdentityInput,
} from '@mmg/domain';
import { and, eq, inArray } from 'drizzle-orm';
import { z, type ZodError } from 'zod';
import { entryIssues, insertEntry, newEntryBody, type NewEntry } from '../clinical/entries';
import {
  allergyDetail,
  exemption,
  family,
  importOrigin,
  patient,
  patientChoice,
  therapy,
} from '../db/schema';
import type { Tx } from '../db/tx';
import {
  historicalIssues,
  insertHistorical,
  newHistoricalBody,
  type NewHistorical,
} from '../prescriptions/historical';
import { concludedTherapyIssues, therapyBody } from '../http/therapy-routes';
import type { FieldValue } from './transforms';

/**
 * Destinazioni dell'importazione con GLI STESSI CONTROLLI dell'inserimento a mano (tappa 15):
 * voci cliniche con `newEntryBody` ed `entryIssues`, scritte da `insertEntry`; terapie con
 * `therapyBody` e la stessa normalizzazione della rotta; dati del paziente ed esenzioni con gli
 * schemi comuni di `@mmg/domain` (patient-registry); vaccinazioni ed esami di laboratorio come
 * le altre voci; ricette fatte con altri programmi con `newHistoricalBody` e `historicalIssues`,
 * scritte da `insertHistorical`, come dalla rotta.
 *
 * Autore delle voci: il titolare che importa (come in ogni inserimento: authorUserId è l'utente
 * che scrive). La data clinica è quella del file: una voce senza data non entra.
 */

export type Values = Record<string, FieldValue>;

export interface PreparedItem<B> {
  body: B;
  /** Valori che riconoscono la stessa voce in un'altra importazione. */
  naturalKey: unknown[];
}
export type Prepared<B> =
  { ok: true; items: PreparedItem<B>[]; warnings: string[] } | { ok: false; errors: string[] };

export interface WriteContext {
  tx: Tx;
  userId: string;
  studioId: string;
  archiveId: string;
  batchId: string;
  today: string;
  now: Date;
  sourceProgram: string | null;
}

export interface EntryHandler<B> {
  /** Tabella della riga scritta, per la provenienza (import_origin). */
  table: string;
  prepare(v: Values, today: string): Prepared<B>;
  /** La stessa voce scritta a mano (o in altro modo) c'è già? */
  existing?(tx: Tx, patientId: string, body: B): Promise<boolean>;
  /**
   * Motivo per scartare la voce per quello che c'è già in cartella (per esempio un periodo già
   * coperto da un'altra scelta del medico), senza valori del paziente; null se si può scrivere.
   */
  conflict?(tx: Tx, patientId: string, body: B): Promise<string | null>;
  write(ctx: WriteContext, patientId: string, body: B): Promise<string>;
}

/** Solo i valori presenti: un campo vuoto è «non scritto», come nel modulo. */
function pick(v: Values, keys: readonly string[], rename: Record<string, string> = {}) {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    const value = v[k];
    if (value !== null && value !== undefined) out[rename[k] ?? k] = value;
  }
  return out;
}

/** Messaggi di zod con il nome del campo del catalogo, senza il valore. */
function zodMessages(err: ZodError, labelOf: (key: string) => string): string[] {
  return err.issues.map((i) => {
    const key = typeof i.path[0] === 'string' ? i.path[0] : '';
    return key ? `«${labelOf(key)}»: ${i.message}` : i.message;
  });
}

const fieldLabel = (dest: ImportDestinationKey, rename: Record<string, string> = {}) => {
  const d = importDestination(dest)!;
  const back = Object.fromEntries(Object.entries(rename).map(([k, v]) => [v, k]));
  return (key: string) => d.fields.find((f) => f.key === (back[key] ?? key))?.label ?? key;
};

const naturalKeyOf = (
  dest: ImportDestinationKey,
  body: Record<string, unknown>,
  rename: Record<string, string> = {},
) => importDestination(dest)!.naturalKey.map((k) => body[rename[k] ?? k] ?? null);

/* Voci cliniche ------------------------------------------------------------------------------ */

const COMMON_KEYS = ['data', 'note', 'riservata', 'oscurata'] as const;

const ENTRY_FIELDS = {
  problemi: {
    tipo: 'problema',
    keys: [
      'descrizione',
      'codice',
      'stato',
      'dal',
      'risoltoIl',
      'quesitoAperto',
      'cronico',
      'categoria',
    ],
  },
  allergie: {
    tipo: 'allergia',
    keys: ['sostanza', 'reazione', 'daFarmaco', 'natura', 'agente', 'codiceAgente', 'criticita'],
  },
  diario: { tipo: 'diario', keys: ['contatto', 'testo'] },
  anamnesi: { tipo: 'anamnesi', keys: ['sezione', 'testo', 'parente', 'codice', 'etaEsordio'] },
  stili_di_vita: { tipo: 'stile_di_vita', keys: ['fattore', 'valore'] },
  esame_obiettivo: { tipo: 'esame_obiettivo', keys: ['testo', 'scala', 'punteggio'] },
  capacita_motoria: { tipo: 'capacita_motoria', keys: ['capacita'] },
  vaccinazioni: { tipo: 'vaccinazione', keys: ['vaccino', 'lotto', 'dose', 'campagna'] },
  esami_laboratorio: {
    tipo: 'esame_laboratorio',
    keys: ['analita', 'valore', 'unita', 'minimo', 'massimo', 'riferimento', 'codicePrestazione'],
    // Nomi del catalogo dell'importazione → nomi del corpo della voce scritta a mano.
    rename: { analita: 'esame', riferimento: 'intervallo' },
  },
} as const;
type EntryDestination = keyof typeof ENTRY_FIELDS;
const renameOf = (dest: EntryDestination): Record<string, string> => {
  const def = ENTRY_FIELDS[dest];
  return 'rename' in def ? def.rename : {};
};

interface EntryBody {
  entry: NewEntry;
  /** Allergia non più attiva: si scrive con la voce, come farebbe la modifica dopo l'inserimento. */
  inactiveAllergy?: boolean;
}

/** Una voce: lo stesso corpo e gli stessi controlli della rotta POST /api/pazienti/:id/voci. */
function validateEntry(
  dest: ImportDestinationKey,
  raw: Record<string, unknown>,
  today: string,
  rename: Record<string, string> = {},
): { ok: true; entry: NewEntry } | { ok: false; errors: string[] } {
  const parsed = newEntryBody.safeParse(raw);
  if (!parsed.success)
    return { ok: false, errors: zodMessages(parsed.error, fieldLabel(dest, rename)) };
  const issues = entryIssues(parsed.data, today);
  if (issues.length) {
    // Il modulo del referto mette davanti il nome dell'esame; nel rapporto dell'importazione
    // nessun valore del file (D173): resta solo il motivo.
    const e = parsed.data;
    const prefix = e.tipo === 'esame_laboratorio' ? `${e.esame}: ` : null;
    return {
      ok: false,
      errors: issues.map((m) => (prefix && m.startsWith(prefix) ? m.slice(prefix.length) : m)),
    };
  }
  return { ok: true, entry: parsed.data };
}

function entryHandler(dest: EntryDestination): EntryHandler<EntryBody> {
  const def = ENTRY_FIELDS[dest];
  return {
    table: 'clinical_entry',
    prepare(v, today) {
      const rename = renameOf(dest);
      const raw = { tipo: def.tipo, ...pick(v, [...COMMON_KEYS, ...def.keys], rename) };
      const r = validateEntry(dest, raw, today, rename);
      if (!r.ok) return r;
      const inactive = dest === 'allergie' && v.attiva === false;
      return {
        ok: true,
        items: [
          {
            body: { entry: r.entry, ...(inactive ? { inactiveAllergy: true } : {}) },
            naturalKey: naturalKeyOf(dest, r.entry, rename),
          },
        ],
        warnings: [],
      };
    },
    async write(ctx, patientId, body) {
      const id = await insertEntry(ctx.tx, patientId, ctx.userId, body.entry);
      if (body.inactiveAllergy)
        await ctx.tx
          .update(allergyDetail)
          .set({ active: false })
          .where(eq(allergyDetail.entryId, id));
      return id;
    },
  };
}

/** Parametri: «parametro» con «valore», o una colonna per parametro (una voce per cella piena). */
const measurementsHandler: EntryHandler<EntryBody> = {
  table: 'clinical_entry',
  prepare(v, today) {
    const common = pick(v, COMMON_KEYS);
    const measures: { parametro: string; valore: unknown }[] = [];
    if (
      v.parametro !== null &&
      v.parametro !== undefined &&
      v.valore !== null &&
      v.valore !== undefined
    )
      measures.push({ parametro: String(v.parametro), valore: v.valore });
    else if ((v.parametro ?? null) !== null || (v.valore ?? null) !== null)
      return { ok: false, errors: ['«Parametro» e «Valore» vanno insieme: uno dei due è vuoto'] };
    for (const [k, value] of Object.entries(v))
      if (k.startsWith('valore_') && value !== null && value !== undefined)
        measures.push({ parametro: k.slice('valore_'.length), valore: value });
    if (measures.length === 0)
      return { ok: false, errors: ['Nella riga non c’è nessun parametro'] };
    const items: PreparedItem<EntryBody>[] = [];
    const errors: string[] = [];
    for (const m of measures) {
      const r = validateEntry(
        'parametri',
        { tipo: 'misura', ...common, ...m, valore: String(m.valore) },
        today,
      );
      if (!r.ok) errors.push(...r.errors);
      else
        items.push({
          body: { entry: r.entry },
          naturalKey: [r.entry.data, m.parametro, String(m.valore)],
        });
    }
    // Come il modulo dei parametri della stessa visita: un valore sbagliato li ferma tutti.
    if (errors.length) return { ok: false, errors };
    return { ok: true, items, warnings: [] };
  },
  write: (ctx, patientId, body) => insertEntry(ctx.tx, patientId, ctx.userId, body.entry),
};

/* Esenzioni ------------------------------------------------------------------------------------ */

export function exemptionsHandler(
  exemptionExists?: (code: string) => boolean | undefined,
): EntryHandler<ExemptionInput> {
  return {
    table: 'exemption',
    prepare(v) {
      const parsed = exemptionSchema.safeParse(pick(v, ['codice', 'dal', 'al', 'codiceRicetta']));
      if (!parsed.success)
        return { ok: false, errors: zodMessages(parsed.error, fieldLabel('esenzioni')) };
      const warnings =
        exemptionExists?.(parsed.data.codice) === false
          ? ['codice non presente nel catalogo delle esenzioni in vigore: controllalo']
          : [];
      return {
        ok: true,
        items: [{ body: parsed.data, naturalKey: [parsed.data.codice, parsed.data.dal] }],
        warnings,
      };
    },
    async existing(tx, patientId, b) {
      const [row] = await tx
        .select({ id: exemption.id })
        .from(exemption)
        .where(
          and(
            eq(exemption.patientId, patientId),
            eq(exemption.code, b.codice),
            eq(exemption.validFrom, b.dal),
          ),
        );
      return !!row;
    },
    async write(ctx, patientId, b) {
      const [row] = await ctx.tx
        .insert(exemption)
        .values({
          patientId,
          code: b.codice,
          validFrom: b.dal,
          validTo: b.al ?? null,
          prescriptionCode: b.codiceRicetta ?? null,
          // data_source non ha un valore «importato»: «manual» (inserito nello studio, non da AURA).
          source: 'manual',
        })
        .returning({ id: exemption.id });
      return row!.id;
    },
  };
}

/* Scelta del medico ---------------------------------------------------------------------------- */

const CHOICE_OVERLAP =
  'C’è già una scelta del medico che vale nello stesso periodo: registra prima la sua cessazione';

/**
 * Scelta del medico, con gli stessi controlli del pannello amministrativo (`addChoice`): il medico
 * è il titolare che importa, perché il programma conosce solo i medici dello studio e
 * l'importazione è sua, sul suo archivio.
 */
export const choicesHandler: EntryHandler<DoctorChoicePeriodInput> = {
  table: 'patient_choice',
  prepare(v, today) {
    const parsed = doctorChoicePeriodSchema.safeParse(
      pick(v, ['dal', 'scadenza', 'cessataIl', 'motivoCessazione']),
    );
    if (!parsed.success)
      return { ok: false, errors: zodMessages(parsed.error, fieldLabel('scelte')) };
    const issues = doctorChoiceIssues(parsed.data, today);
    if (issues.length) return { ok: false, errors: issues };
    return {
      ok: true,
      items: [{ body: parsed.data, naturalKey: [parsed.data.dal] }],
      warnings: [],
    };
  },
  async existing(tx, patientId, b) {
    const [row] = await tx
      .select({ id: patientChoice.id })
      .from(patientChoice)
      .where(and(eq(patientChoice.patientId, patientId), eq(patientChoice.chosenOn, b.dal)));
    return !!row;
  },
  async conflict(tx, patientId, b) {
    const rows = await tx
      .select({
        dal: patientChoice.chosenOn,
        scadenza: patientChoice.expiresOn,
        cessataIl: patientChoice.endedOn,
      })
      .from(patientChoice)
      .where(eq(patientChoice.patientId, patientId));
    const period = choiceValidity(b);
    return rows.some((r) => periodsOverlap(choiceValidity(r), period)) ? CHOICE_OVERLAP : null;
  },
  async write(ctx, patientId, b) {
    const [row] = await ctx.tx
      .insert(patientChoice)
      .values({
        patientId,
        doctorUserId: ctx.userId,
        chosenOn: b.dal,
        expiresOn: b.scadenza ?? null,
        endedOn: b.cessataIl ?? null,
        endReason: b.motivoCessazione ?? null,
        // data_source non ha un valore «importato»: «manual» (inserita nello studio, non da AURA).
        source: 'manual',
      })
      .returning({ id: patientChoice.id });
    return row!.id;
  },
};

/* Nucleo familiare ----------------------------------------------------------------------------- */

const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional();

const familyImportBody = z.object({ nucleo: text(100), nomeNucleo: optionalText(100) }).strict();
type FamilyImport = z.infer<typeof familyImportBody>;

/**
 * Chiave del nucleo del file, la stessa in importazioni diverse dello stesso archivio: un'impronta
 * del valore, mai il valore in chiaro (come ogni chiave d'origine).
 */
export const familySourceKey = (nucleo: string) =>
  `nucleo:famiglia:${createHash('sha256')
    .update(JSON.stringify([comparable(nucleo)]))
    .digest('hex')}`;

/** Il nucleo che un'importazione precedente (o questa) ha creato per quel valore del file. */
async function importedFamily(tx: Tx, archiveId: string, key: string) {
  const [row] = await tx
    .select({ id: importOrigin.rowId })
    .from(importOrigin)
    .where(
      and(
        eq(importOrigin.archiveId, archiveId),
        eq(importOrigin.tableName, 'family'),
        eq(importOrigin.sourceKey, key),
      ),
    );
  return row?.id ?? null;
}

const patientFamily = async (tx: Tx, patientId: string) =>
  (
    await tx
      .select({ familyId: patient.familyId, archiveId: patient.archiveId })
      .from(patient)
      .where(eq(patient.id, patientId))
  )[0];

/**
 * Nucleo familiare: le righe con lo stesso valore vanno nello stesso nucleo, anche in
 * importazioni diverse (la provenienza del nucleo lo ritrova). L'etichetta è quella del file, o
 * il valore stesso. Un paziente che è già in un altro nucleo resta nel suo: niente si sovrascrive.
 */
export const familyHandler: EntryHandler<FamilyImport> = {
  table: 'family',
  prepare(v) {
    const parsed = familyImportBody.safeParse(pick(v, ['nucleo', 'nomeNucleo']));
    if (!parsed.success)
      return { ok: false, errors: zodMessages(parsed.error, fieldLabel('nucleo')) };
    return {
      ok: true,
      items: [{ body: parsed.data, naturalKey: [parsed.data.nucleo] }],
      warnings: [],
    };
  },
  async existing(tx, patientId, b) {
    const p = await patientFamily(tx, patientId);
    if (!p?.familyId) return false;
    return (await importedFamily(tx, p.archiveId, familySourceKey(b.nucleo))) === p.familyId;
  },
  async conflict(tx, patientId) {
    const p = await patientFamily(tx, patientId);
    return p?.familyId ? 'Il paziente è già in un altro nucleo familiare: resta nel suo' : null;
  },
  async write(ctx, patientId, b) {
    const key = familySourceKey(b.nucleo);
    let familyId = await importedFamily(ctx.tx, ctx.archiveId, key);
    if (!familyId) {
      const [row] = await ctx.tx
        .insert(family)
        .values({ studioId: ctx.studioId, label: b.nomeNucleo ?? b.nucleo })
        .returning({ id: family.id });
      familyId = row!.id;
      await ctx.tx.insert(importOrigin).values({
        batchId: ctx.batchId,
        archiveId: ctx.archiveId,
        tableName: 'family',
        rowId: familyId,
        sourceKey: key,
      });
    }
    await ctx.tx
      .update(patient)
      .set({ familyId, updatedAt: ctx.now })
      .where(eq(patient.id, patientId));
    return familyId;
  },
};

/* Terapie -------------------------------------------------------------------------------------- */

const THERAPY_RENAME: Record<string, string> = {
  aic: 'drugAic',
  farmaco: 'drugName',
  principioAttivo: 'activeIngredient',
  atc: 'atc',
  dose: 'dose',
  unitaDose: 'doseUnit',
  frequenza: 'frequency',
  momento: 'timeOfDay',
  via: 'route',
  unitaAlGiorno: 'unitsPerDay',
  inizio: 'startOn',
  fine: 'endOn',
  confezioni: 'packsPerPrescription',
  esenzioneAbituale: 'habitualExemptionCode',
  notaAifa: 'aifaNote',
  istruzioni: 'patientInstructions',
  riservata: 'reserved',
  importante: 'important',
  nonSostituibile: 'notSubstitutable',
  motivoNonSostituibile: 'notSubstitutableReason',
};
const THERAPY_KIND = { cronica: 'chronic', al_bisogno: 'as_needed', ciclo: 'cycle' } as const;
const THERAPY_STATUS = { in_corso: 'active', conclusa: 'ended', sospesa: 'suspended' } as const;

type TherapyInput = z.infer<typeof therapyBody>;
interface TherapyImport {
  body: TherapyInput;
  status: 'active' | 'ended' | 'suspended';
  suspendedReason: string | null;
}

/** Come `normalize` della rotta delle terapie: gli spazi vuoti sono «non scritto». */
function normalizeTherapy(body: TherapyInput): TherapyInput {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) out[k] = v === '' ? null : v;
  if (typeof out.unitsPerDay === 'string') out.unitsPerDay = out.unitsPerDay.replace(',', '.');
  return out as TherapyInput;
}

const therapiesHandler: EntryHandler<TherapyImport> = {
  table: 'therapy',
  prepare(v, today) {
    const raw: Record<string, unknown> = pick(v, Object.keys(THERAPY_RENAME), THERAPY_RENAME);
    if (typeof v.tipo === 'string') raw.kind = THERAPY_KIND[v.tipo as keyof typeof THERAPY_KIND];
    const parsed = therapyBody.safeParse(raw);
    if (!parsed.success)
      return {
        ok: false,
        errors: zodMessages(parsed.error, (k) =>
          k === 'kind' ? 'Tipo di terapia' : fieldLabel('terapie', THERAPY_RENAME)(k),
        ),
      };
    const body = normalizeTherapy(parsed.data);
    const state = (
      typeof v.stato === 'string' ? v.stato : 'in_corso'
    ) as keyof typeof THERAPY_STATUS;
    const errors: string[] = [];
    const warnings: string[] = [];
    // Gli stessi controlli della terapia registrata già conclusa dalla scheda.
    if (state === 'conclusa') errors.push(...concludedTherapyIssues(body, today));
    const reason = typeof v.motivoSospensione === 'string' ? v.motivoSospensione : null;
    if (state === 'sospesa' && !reason)
      errors.push('Terapia sospesa: serve il motivo della sospensione, come nella cartella');
    if (state === 'in_corso' && body.endOn && body.endOn < today)
      warnings.push('terapia «in corso» con la data di fine già passata: controlla lo stato');
    if (errors.length) return { ok: false, errors };
    return {
      ok: true,
      items: [
        {
          body: {
            body,
            status: THERAPY_STATUS[state],
            suspendedReason: state === 'sospesa' ? reason : null,
          },
          naturalKey: [body.drugName, body.drugAic ?? null, body.startOn],
        },
      ],
      warnings,
    };
  },
  // Una terapia in corso o sospesa con lo stesso farmaco c'è già in cartella (scritta a mano o
  // importata prima): la riga non ne crea una seconda (dalla revisione del piano). Lo stesso AIC,
  // o senza AIC lo stesso nome; le terapie concluse sono storia e non contano.
  async conflict(tx, patientId, t) {
    if (t.status === 'ended') return null;
    const rows = await tx
      .select({ aic: therapy.drugAic, name: therapy.drugName })
      .from(therapy)
      .where(
        and(eq(therapy.patientId, patientId), inArray(therapy.status, ['active', 'suspended'])),
      );
    const name = t.body.drugName.trim().toLowerCase();
    const same = rows.some((r) =>
      t.body.drugAic && r.aic ? r.aic === t.body.drugAic : r.name.trim().toLowerCase() === name,
    );
    return same
      ? 'C’è già una terapia in corso o sospesa con lo stesso farmaco: si aggiorna quella, dalla cartella'
      : null;
  },
  async write(ctx, patientId, t) {
    const [row] = await ctx.tx
      .insert(therapy)
      .values({
        ...t.body,
        patientId,
        createdBy: ctx.userId,
        status: t.status,
        suspendedReason: t.suspendedReason,
      })
      .returning({ id: therapy.id });
    return row!.id;
  },
};

/* Ricette fatte con altri programmi ----------------------------------------------------------- */

/** Campi del catalogo per tipo di riga, e il loro nome nel corpo della rotta. */
const HISTORICAL_FIELDS = {
  farmaco: {
    aic: 'aic',
    farmaco: 'farmaco',
    principioAttivo: 'principioAttivo',
    atc: 'atc',
    posologia: 'posologia',
  },
  prestazione: { codicePrestazione: 'codice', descrizionePrestazione: 'descrizione' },
} as const;
const HISTORICAL_COMMON = ['data', 'quantita', 'nre', 'prescrittore', 'note'] as const;

/**
 * Ricette fatte con altri programmi: lo stesso corpo e gli stessi controlli della rotta
 * (`newHistoricalBody`, `historicalIssues`), scritte da `insertHistorical` con l'importazione. Una
 * riga con i campi dell'altro tipo (una prestazione su una riga di farmaco) si scarta: è un errore
 * di smistamento, non un valore da indovinare.
 */
const historicalHandler: EntryHandler<NewHistorical> = {
  table: 'historical_prescription',
  prepare(v, today) {
    const tipo = v.tipo;
    if (tipo !== 'farmaco' && tipo !== 'prestazione')
      return { ok: false, errors: ['«Tipo»: serve «farmaco» o «prestazione»'] };
    const other = HISTORICAL_FIELDS[tipo === 'farmaco' ? 'prestazione' : 'farmaco'];
    const wrong = Object.keys(other).filter((k) => v[k] !== null && v[k] !== undefined);
    if (wrong.length)
      return {
        ok: false,
        errors: [
          tipo === 'farmaco'
            ? 'Una riga di farmaco non ha codice o descrizione di una prestazione'
            : 'Una riga di prestazione non ha i dati di un farmaco',
        ],
      };
    const own: Record<string, string> = HISTORICAL_FIELDS[tipo];
    const raw = { tipo, ...pick(v, [...HISTORICAL_COMMON, ...Object.keys(own)], own) };
    const parsed = newHistoricalBody.safeParse(raw);
    if (!parsed.success)
      return {
        ok: false,
        errors: zodMessages(parsed.error, fieldLabel('ricette_passate', own)),
      };
    const issues = historicalIssues(parsed.data, today);
    if (issues.length) return { ok: false, errors: issues };
    return {
      ok: true,
      items: [
        {
          body: parsed.data,
          naturalKey: naturalKeyOf('ricette_passate', { ...v, ...parsed.data }),
        },
      ],
      warnings: [],
    };
  },
  write: (ctx, patientId, h) =>
    insertHistorical(
      ctx.tx,
      { patientId, archiveId: ctx.archiveId, recordedBy: ctx.userId, importBatchId: ctx.batchId },
      ctx.sourceProgram ? { ...h, programma: ctx.sourceProgram } : h,
    ),
};

/** Gestori delle destinazioni diverse dai pazienti. */
export function entryHandlers(
  exemptionExists?: (code: string) => boolean | undefined,
): Record<Exclude<ImportDestinationKey, 'pazienti'>, EntryHandler<unknown>> {
  return {
    esenzioni: exemptionsHandler(exemptionExists),
    scelte: choicesHandler,
    nucleo: familyHandler,
    problemi: entryHandler('problemi'),
    allergie: entryHandler('allergie'),
    diario: entryHandler('diario'),
    anamnesi: entryHandler('anamnesi'),
    stili_di_vita: entryHandler('stili_di_vita'),
    esame_obiettivo: entryHandler('esame_obiettivo'),
    capacita_motoria: entryHandler('capacita_motoria'),
    parametri: measurementsHandler,
    vaccinazioni: entryHandler('vaccinazioni'),
    esami_laboratorio: entryHandler('esami_laboratorio'),
    terapie: therapiesHandler,
    ricette_passate: historicalHandler,
  };
}

/* Pazienti ------------------------------------------------------------------------------------- */

const IDENTITY_KEYS = [
  'cognome',
  'nome',
  'sesso',
  'nascita',
  'luogoNascitaCodice',
  'luogoNascita',
  'codiceFiscale',
] as const;

/** Campi amministrativi → colonne del paziente. */
const ADMIN_COLUMNS = {
  telefono: 'phone',
  email: 'email',
  residenzaVia: 'residenceStreet',
  residenzaCivico: 'residenceNumber',
  residenzaCap: 'residencePostalCode',
  residenzaComune: 'residenceTown',
  residenzaProvincia: 'residenceProvince',
  domicilio: 'domicile',
  asl: 'asl',
  distretto: 'district',
  tipoAssistenza: 'assistanceType',
  decedutoIl: 'deceasedOn',
  causaDecesso: 'deathCauseIcd',
  tesseraTeam: 'foreignHealthCard',
  enteEstero: 'foreignInstitution',
  professione: 'occupation',
  condizioneProfessionale: 'employmentCondition',
  emailDatoreLavoro: 'employerEmail',
  recapitoPromemoria: 'reminderContact',
  canaleSceltoIl: 'reminderChannelChosenOn',
} as const satisfies Partial<Record<keyof PatientAdminInput, keyof typeof patient.$inferInsert>>;

const ADMIN_KEYS = [...Object.keys(ADMIN_COLUMNS), 'stato', 'canalePromemoria'] as const;

export interface PreparedPatient {
  identity: PatientIdentityInput;
  admin: PatientAdminInput;
  warnings: string[];
}

/** Cifre sostituite dalle lettere nei casi di omocodia (DM 23/12/1976, art. 6), come nel dominio. */
const OMOCODIA_LETTERS = 'LMNPQRSTUV';
const NUMERIC_POSITIONS = [6, 7, 9, 10, 12, 13, 14];
function decodeOmocodia(code: string): string {
  const chars = [...code];
  for (const p of NUMERIC_POSITIONS) {
    const idx = OMOCODIA_LETTERS.indexOf(chars[p]!);
    if (idx >= 0) chars[p] = String(idx);
  }
  return chars.join('');
}

/**
 * Coerenza del codice fiscale con cognome, nome, data di nascita, sesso e luogo: solo un avviso
 * (il codice valido è quello dell'Agenzia delle Entrate). Rivela anche giorno e mese scambiati.
 */
export function fiscalCodeCoherence(p: PatientIdentityInput): string[] {
  const cf = decodeOmocodia(p.codiceFiscale);
  const out: string[] = [];
  if (cf.slice(0, 3) !== surnameCode(p.cognome)) out.push('cognome');
  if (cf.slice(3, 6) !== nameCode(p.nome)) out.push('nome');
  if (cf.slice(6, 11) !== birthCode(p.nascita, p.sesso)) out.push('data di nascita o sesso');
  if (p.luogoNascitaCodice && cf.slice(11, 15) !== p.luogoNascitaCodice)
    out.push('luogo di nascita');
  return out.length
    ? [
        `il codice fiscale non corrisponde a: ${out.join(', ')}. Controlla i dati (giorno e mese scambiati?)`,
      ]
    : [];
}

export function preparePatient(
  v: Values,
  today: string,
): { ok: true; patient: PreparedPatient } | { ok: false; errors: string[] } {
  const label = fieldLabel('pazienti');
  const identity = patientIdentitySchema.safeParse(pick(v, IDENTITY_KEYS));
  const admin = patientAdminSchema.safeParse(pick(v, ADMIN_KEYS));
  const errors = [
    ...(identity.success ? [] : zodMessages(identity.error, label)),
    ...(admin.success ? [] : zodMessages(admin.error, label)),
  ];
  if (!identity.success || !admin.success) return { ok: false, errors };
  errors.push(...patientAdminIssues(admin.data, today));
  if (identity.data.nascita > today) errors.push('La data di nascita è nel futuro');
  if (admin.data.decedutoIl && admin.data.decedutoIl < identity.data.nascita)
    errors.push('La data del decesso viene prima della nascita');
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    patient: {
      identity: identity.data,
      admin: admin.data,
      warnings: fiscalCodeCoherence(identity.data),
    },
  };
}

const statusDb = (key: string | undefined) =>
  PATIENT_STATUSES.find((s) => s.key === key)?.db ?? 'active';
const channelDb = (key: string | null | undefined) =>
  key ? (REMINDER_CHANNELS.find((c) => c.key === key)?.db ?? null) : null;

/** Colonne del paziente amministrativo, solo quelle scritte nel file. */
function adminColumns(a: PatientAdminInput): Partial<typeof patient.$inferInsert> {
  const out: Record<string, unknown> = {};
  for (const [k, col] of Object.entries(ADMIN_COLUMNS)) {
    const value = a[k as keyof PatientAdminInput];
    if (value !== undefined && value !== null && value !== '') out[col] = value;
  }
  if (a.canalePromemoria) out.reminderChannel = channelDb(a.canalePromemoria);
  return out;
}

export async function insertPatient(ctx: WriteContext, p: PreparedPatient): Promise<string> {
  const [row] = await ctx.tx
    .insert(patient)
    .values({
      studioId: ctx.studioId,
      archiveId: ctx.archiveId,
      firstName: p.identity.nome,
      lastName: p.identity.cognome,
      sex: p.identity.sesso,
      birthDate: p.identity.nascita,
      birthPlaceCode: p.identity.luogoNascitaCodice ?? null,
      birthPlaceName: p.identity.luogoNascita ?? null,
      fiscalCode: p.identity.codiceFiscale,
      ...adminColumns(p.admin),
      status: statusDb(p.admin.stato),
    })
    .returning({ id: patient.id });
  return row!.id;
}

/** Valore confrontabile: testo senza maiuscole e spazi ai lati. */
export function comparable(v: unknown): string {
  if (v === null || v === undefined) return '';
  const t =
    typeof v === 'string'
      ? v
      : typeof v === 'number' || typeof v === 'boolean'
        ? String(v)
        : v instanceof Date
          ? v.toISOString()
          : (JSON.stringify(v) ?? '');
  return t.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Nome dei campi per colonna del paziente, per gli avvisi del completamento. */
const COLUMN_LABELS = (() => {
  const d = importDestination('pazienti')!;
  const byKey = Object.fromEntries(d.fields.map((f) => [f.key, f.label]));
  const columns: Record<string, string> = {
    ...ADMIN_COLUMNS,
    luogoNascitaCodice: 'birthPlaceCode',
    luogoNascita: 'birthPlaceName',
    canalePromemoria: 'reminderChannel',
  };
  return Object.fromEntries(
    Object.entries(columns).map(([k, col]) => [col, byKey[k] ?? k]),
  ) as Record<string, string>;
})();

/**
 * Paziente già in cartella: si completano solo i campi vuoti, mai si sovrascrive. Le differenze
 * sono avvisi con il nome del campo, senza i valori. Lo stato del paziente non si cambia da qui.
 */
export async function completePatient(
  ctx: WriteContext,
  existing: typeof patient.$inferSelect,
  p: PreparedPatient,
): Promise<{ completed: string[]; warnings: string[]; errors: string[] }> {
  const warnings: string[] = [];
  const identityDiff: string[] = [];
  if (existing.lastName.trim().toLowerCase() !== p.identity.cognome.toLowerCase())
    identityDiff.push('cognome');
  if (existing.firstName.trim().toLowerCase() !== p.identity.nome.toLowerCase())
    identityDiff.push('nome');
  if (existing.sex !== p.identity.sesso) identityDiff.push('sesso');
  if (existing.birthDate !== p.identity.nascita) identityDiff.push('data di nascita');
  if (identityDiff.length)
    warnings.push(
      `identità diversa da quella in cartella (${identityDiff.join(', ')}): non modificata, controllala`,
    );
  const wanted: Record<string, unknown> = {
    ...adminColumns(p.admin),
    ...(p.identity.luogoNascitaCodice ? { birthPlaceCode: p.identity.luogoNascitaCodice } : {}),
    ...(p.identity.luogoNascita ? { birthPlaceName: p.identity.luogoNascita } : {}),
  };
  const patch: Record<string, unknown> = {};
  const different: string[] = [];
  const current = existing as unknown as Record<string, unknown>;
  for (const [col, value] of Object.entries(wanted)) {
    const now = current[col];
    if (now === null || now === undefined || now === '') patch[col] = value;
    else if (comparable(now) !== comparable(value)) different.push(COLUMN_LABELS[col] ?? col);
  }
  if (p.admin.stato && statusDb(p.admin.stato) !== existing.status)
    different.push('Stato del paziente');
  if (different.length)
    warnings.push(`diverso da quanto in cartella, non sovrascritto: ${different.join(', ')}`);
  // I controlli di coerenza sul paziente come risulterebbe dopo il completamento, se il file tocca
  // i campi che li riguardano (decesso, canale del promemoria): un'incoerenza già in cartella e
  // non toccata dal file non ferma il completamento degli altri campi.
  const related = ['deceasedOn', 'reminderChannel', 'reminderContact', 'reminderChannelChosenOn'];
  const merged = { ...current, ...patch } as typeof patient.$inferSelect;
  const issues = Object.keys(patch).some((k) => related.includes(k))
    ? patientAdminIssues(
        {
          stato: PATIENT_STATUSES.find((s) => s.db === merged.status)?.key,
          decedutoIl: merged.deceasedOn,
          canalePromemoria:
            REMINDER_CHANNELS.find((c) => c.db === merged.reminderChannel)?.key ?? null,
          recapitoPromemoria: merged.reminderContact,
          canaleSceltoIl: merged.reminderChannelChosenOn,
        },
        ctx.today,
      )
    : [];
  if (issues.length) return { completed: [], warnings, errors: issues };
  const completed = Object.keys(patch).map((col) => COLUMN_LABELS[col] ?? col);
  if (completed.length)
    await ctx.tx
      .update(patient)
      .set({ ...patch, updatedAt: ctx.now })
      .where(eq(patient.id, existing.id));
  return { completed, warnings, errors: [] };
}
