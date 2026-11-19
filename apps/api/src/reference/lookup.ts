import {
  type DatasetKind,
  diagnosisByCode,
  type DiagnosisHit,
  type DiagnosisIndex,
  exemptionFamily,
  indexDiagnoses,
  indexServices,
  KINDS,
  loadServiceSearchData,
  type MappingSet,
  SERVICE_SEARCH_DATA,
  searchDiagnoses,
  searchServices,
  type ServiceIndex,
} from '@mmg/reference';
import type { DrugFacts } from '@mmg/rules';
import { and, desc, eq, ilike, inArray, isNotNull, lte, or, type SQL } from 'drizzle-orm';
import type { Database } from '../db/client';
import {
  refDiagnosis,
  refDpcDrug,
  refDrug,
  refDrugClass,
  refExemption,
  refExemptionService,
  refMunicipality,
  refService,
  referenceDataset,
  referenceUpdateRun,
} from '../db/schema';
import type { SeriesStatus } from './update';

/** Versione di una banca dati, come la vedono le schermate (A6). */
export interface DatasetVersion {
  kind: DatasetKind;
  kindLabel: string;
  series: string;
  title: string;
  validFrom: string;
  validFromBasis: string;
  downloadedAt: string | null;
  importedAt: string;
  rows: number;
  act: string | null;
  origin: string;
  /** Oltre quanti giorni la versione è più vecchia del previsto; null = nessuna soglia d'età. */
  staleAfterDays: number | null;
  /**
   * Vero se più vecchia del previsto (A6, D156): la sua fonte non è stata controllata nell'ultimo
   * aggiornamento, l'aggiornamento di stanotte manca, una versione più nuova aspetta qualcuno, o è
   * oltre la soglia d'età. Null se non si sa nulla (nessun aggiornamento registrato e nessuna
   * soglia). Non blocca nulla: il controllo finale resta del SAC.
   */
  stale: boolean | null;
  /** Perché è più vecchia del previsto, in parole. */
  staleReasons: string[];
  /** Ultimo controllo riuscito della sua fonte, se si sa. */
  checkedAt: string | null;
}

/** Da dove la consultazione sa se le versioni sono aggiornate (D156). */
export interface Freshness {
  now: () => Date;
  /** Da quando dovrebbe esserci un aggiornamento nuovo; null senza aggiornamento automatico. */
  expectedSince: (at: Date) => Date | null;
}

const dayIt = (d: Date | string) =>
  new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome' }).format(new Date(d));

export interface DrugInfo {
  aic: string;
  name: string | null;
  pack: string | null;
  activeIngredient: string | null;
  atc: string | null;
  form: string | null;
  supplyRegime: string | null;
  /** Ditta titolare dell'AIC: per i generici, il fornitore (D151). */
  holder: string | null;
  drugClass: string | null;
  price: string | null;
  equivalenceGroup: string | null;
  aifaNote: string | null;
  dpc: boolean;
  planRequired: boolean | null;
  /** I fatti che le regole guardano; i campi senza una fonte restano assenti (= non noti). */
  facts: DrugFacts;
}

const SEARCH_LIMIT = 30;

/** Sinonimi e sigle dei materiali (D153), letti una volta. */
const SERVICE_SEARCH = loadServiceSearchData(SERVICE_SEARCH_DATA);

interface ServiceRow {
  regionalCode: string;
  nationalCode: string | null;
  description: string;
  branch: string | null;
  fee: string | null;
  notes: string | null;
}

/**
 * Indici della ricerca delle prestazioni, per versione del catalogo. Una versione importata non
 * cambia più (A2): l'indice non va mai rifatto, e una versione nuova ha il suo.
 */
const SERVICE_INDEXES = new Map<string, ServiceIndex<ServiceRow>>();
const MAX_SERVICE_INDEXES = 8;

/** Indici delle diagnosi ICD-9-CM, per versione del catalogo, come quelli delle prestazioni. */
const DIAGNOSIS_INDEXES = new Map<string, DiagnosisIndex>();
const MAX_DIAGNOSIS_INDEXES = 4;
/** Quante diagnosi mostra al più una ricerca: oltre, si precisa la domanda. */
const DIAGNOSIS_SEARCH_LIMIT = 50;
const MS_PER_DAY = 86_400_000;

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / MS_PER_DAY);
}

/** Testo da cercare, senza i caratteri jolly di LIKE. */
function likeText(q: string): string {
  return q.replace(/[\\%_]/g, (c) => `\\${c}`);
}

const lower = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

/** Ordine degli equivalenti: prima il prezzo; a parità, nome e AIC, lo stesso a ogni ricerca. */
export function compareEquivalents(
  a: Pick<DrugInfo, 'aic' | 'name' | 'price'>,
  b: Pick<DrugInfo, 'aic' | 'name' | 'price'>,
): number {
  return (
    (a.price ?? '').localeCompare(b.price ?? '', 'it', { numeric: true }) ||
    lower(a.name).localeCompare(lower(b.name)) ||
    a.aic.localeCompare(b.aic)
  );
}

/**
 * Banche dati alla data: per ogni serie vale la versione con la data di inizio più recente non
 * successiva alla data chiesta; a parità di data, l'ultima importata (A5).
 */
export class ReferenceData {
  constructor(
    private readonly db: Database,
    private readonly mappings?: MappingSet,
    private readonly freshness?: Freshness,
  ) {}

  /** Stato delle serie dopo l'ultimo aggiornamento finito, e se quello di stanotte manca. */
  private async updateState() {
    const [last] = await this.db
      .select({
        startedAt: referenceUpdateRun.startedAt,
        seriesStatus: referenceUpdateRun.seriesStatus,
      })
      .from(referenceUpdateRun)
      .where(isNotNull(referenceUpdateRun.finishedAt))
      .orderBy(desc(referenceUpdateRun.startedAt))
      .limit(1);
    const [started] = await this.db
      .select({ startedAt: referenceUpdateRun.startedAt })
      .from(referenceUpdateRun)
      .orderBy(desc(referenceUpdateRun.startedAt))
      .limit(1);
    const series = new Map(
      ((last?.seriesStatus as SeriesStatus[] | null) ?? []).map((x) => [x.series, x]),
    );
    const expected = this.freshness ? this.freshness.expectedSince(this.freshness.now()) : null;
    const late =
      expected && (!started || started.startedAt.getTime() < expected.getTime())
        ? `l’aggiornamento di ogni notte manca dal ${dayIt(expected)}`
        : null;
    return { series, last: last ?? null, late, scheduled: expected !== null };
  }

  async inEffect(kind: DatasetKind, date: string) {
    return this.db
      .selectDistinctOn([referenceDataset.series])
      .from(referenceDataset)
      .where(and(eq(referenceDataset.kind, kind), lte(referenceDataset.validFrom, date)))
      .orderBy(
        referenceDataset.series,
        desc(referenceDataset.validFrom),
        desc(referenceDataset.importedAt),
        desc(referenceDataset.id),
      );
  }

  private async ids(kind: DatasetKind, date: string): Promise<string[]> {
    return (await this.inEffect(kind, date)).map((d) => d.id);
  }

  private staleAfter(series: string, kind: DatasetKind): number | null {
    const m =
      this.mappings?.mappings.find((x) => x.id === series) ??
      this.mappings?.mappings.find((x) => x.origine === 'trascrizione' && x.tipo === kind);
    return m?.vecchiaDopoGiorni ?? null;
  }

  /** Le versioni in uso alla data, per tipo (A6). */
  async versions(
    date: string,
    kinds: readonly DatasetKind[] = Object.keys(KINDS) as DatasetKind[],
  ) {
    const out: DatasetVersion[] = [];
    const state = await this.updateState();
    for (const kind of kinds) {
      for (const d of await this.inEffect(kind, date)) {
        const staleAfterDays = this.staleAfter(d.series, kind);
        const reference = d.downloadedAt
          ? new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome' }).format(d.downloadedAt)
          : d.validFrom;
        const status = state.series.get(d.series);
        // Una versione che sync non aggiorna (trascrizione senza PDF scaricato) non dipende dalla notte.
        const updatable = d.origin === 'sync' || !!d.source;
        const reasons: string[] = [...(status?.pending ?? [])];
        if (status?.checkFailed && state.last) {
          reasons.push(
            `l’aggiornamento del ${dayIt(state.last.startedAt)} non è riuscito a controllare la fonte`,
          );
        }
        if (state.late && updatable) reasons.push(state.late);
        const tooOld = staleAfterDays !== null && daysBetween(reference, date) > staleAfterDays;
        if (tooOld) reasons.push(`scaricata da più di ${staleAfterDays} giorni`);
        const known =
          status !== undefined || staleAfterDays !== null || (state.scheduled && updatable);
        out.push({
          kind,
          kindLabel: KINDS[kind].label,
          series: d.series,
          title: d.title,
          validFrom: d.validFrom,
          validFromBasis: d.validFromBasis,
          downloadedAt: d.downloadedAt?.toISOString() ?? null,
          importedAt: d.importedAt.toISOString(),
          rows: d.rows,
          act: d.act,
          origin: d.origin,
          staleAfterDays,
          stale: reasons.length > 0 ? true : known ? false : null,
          staleReasons: reasons,
          checkedAt: status?.checkedAt ?? null,
        });
      }
    }
    return out;
  }

  /** Farmaci per AIC alla data, con i fatti per le regole. */
  async drugs(aics: readonly string[], date: string): Promise<Map<string, DrugInfo>> {
    const out = new Map<string, DrugInfo>();
    const wanted = [...new Set(aics.filter(Boolean))];
    if (!wanted.length) return out;
    const [drugIds, classIds, dpcIds] = await Promise.all([
      this.ids('farmaci', date),
      this.ids('farmaci_classe', date),
      this.ids('farmaci_dpc', date),
    ]);
    const drugs = drugIds.length
      ? await this.db
          .select()
          .from(refDrug)
          .where(and(inArray(refDrug.datasetId, drugIds), inArray(refDrug.aic, wanted)))
      : [];
    const classes = classIds.length
      ? await this.db
          .select()
          .from(refDrugClass)
          .where(and(inArray(refDrugClass.datasetId, classIds), inArray(refDrugClass.aic, wanted)))
      : [];
    const dpc = dpcIds.length
      ? await this.db.select().from(refDpcDrug).where(inArray(refDpcDrug.datasetId, dpcIds))
      : [];
    for (const aic of wanted) {
      const d = drugs.filter((x) => x.aic === aic);
      const c = classes.filter((x) => x.aic === aic);
      if (!d.length && !c.length) continue;
      const pick = <T>(values: (T | null)[]) =>
        values.find((v) => v !== null && v !== undefined) ?? null;
      const activeIngredient = pick([
        ...d.map((x) => x.activeIngredient),
        ...c.map((x) => x.activeIngredient),
      ]);
      const atc = pick(d.map((x) => x.atc));
      const inDpc = dpc.find(
        (x) =>
          (atc !== null && x.atc !== null && x.atc === atc) ||
          (activeIngredient !== null && lower(x.activeIngredient) === lower(activeIngredient)),
      );
      const classA = c.find((x) => x.drugClass === 'A');
      const aifaNote = pick([...c.map((x) => x.aifaNote), inDpc?.aifaNote ?? null]);
      const facts: DrugFacts = {};
      // Classe A: a carico del SSN (classificazione AIFA). Le altre classi non dicono da sole
      // se il farmaco è prescrivibile dal medico di medicina generale: restano non note.
      if (classA) facts.reimbursableSsn = true;
      if (aifaNote) facts.aifaNote = aifaNote;
      // L'elenco DPC dice quando il piano serve; quando non c'è, non dice che non serve.
      if (inDpc?.planRequired === true) facts.requiresPlan = true;
      out.set(aic, {
        aic,
        name: pick(d.map((x) => x.name)),
        pack: pick(d.map((x) => x.pack)),
        activeIngredient,
        atc,
        form: pick(d.map((x) => x.form)),
        supplyRegime: pick(d.map((x) => x.supplyRegime)),
        holder: pick(d.map((x) => x.holder)),
        drugClass: classA ? 'A' : pick(c.map((x) => x.drugClass)),
        price: pick((classA ? [classA] : c).map((x) => x.price)),
        equivalenceGroup: pick(c.map((x) => x.equivalenceGroup)),
        aifaNote,
        dpc: !!inDpc,
        planRequired: inDpc?.planRequired ?? null,
        facts,
      });
    }
    return out;
  }

  /** Ricerca per nome commerciale, principio attivo, AIC o ATC. */
  async searchDrugs(q: string, date: string, limit = SEARCH_LIMIT): Promise<DrugInfo[]> {
    const text = q.trim();
    if (!text) return [];
    const like = `%${likeText(text)}%`;
    const prefix = `${likeText(text)}%`;
    const [drugIds, classIds] = await Promise.all([
      this.ids('farmaci', date),
      this.ids('farmaci_classe', date),
    ]);
    const aics = new Set<string>();
    if (drugIds.length) {
      const match: SQL = or(
        ilike(refDrug.aic, prefix),
        ilike(refDrug.atc, prefix),
        ilike(refDrug.name, like),
        ilike(refDrug.activeIngredient, like),
      )!;
      for (const r of await this.db
        .selectDistinct({ aic: refDrug.aic, name: refDrug.name })
        .from(refDrug)
        .where(and(inArray(refDrug.datasetId, drugIds), match))
        .orderBy(refDrug.name, refDrug.aic)
        .limit(limit))
        aics.add(r.aic);
    }
    if (classIds.length && aics.size < limit) {
      for (const r of await this.db
        .selectDistinct({ aic: refDrugClass.aic })
        .from(refDrugClass)
        .where(
          and(
            inArray(refDrugClass.datasetId, classIds),
            or(ilike(refDrugClass.aic, prefix), ilike(refDrugClass.activeIngredient, like)),
          ),
        )
        .orderBy(refDrugClass.aic)
        .limit(limit))
        aics.add(r.aic);
    }
    const found = await this.drugs([...aics].slice(0, limit), date);
    return [...found.values()].sort(
      (a, b) => lower(a.name).localeCompare(lower(b.name)) || a.aic.localeCompare(b.aic),
    );
  }

  /** Farmaci dello stesso gruppo di equivalenza (liste AIFA), escluso quello di partenza. */
  async equivalents(aic: string, date: string): Promise<DrugInfo[]> {
    const own = (await this.drugs([aic], date)).get(aic);
    if (!own?.equivalenceGroup) return [];
    const classIds = await this.ids('farmaci_classe', date);
    const rows = await this.db
      .selectDistinct({ aic: refDrugClass.aic })
      .from(refDrugClass)
      .where(
        and(
          inArray(refDrugClass.datasetId, classIds),
          eq(refDrugClass.equivalenceGroup, own.equivalenceGroup),
        ),
      );
    const found = await this.drugs(
      rows.map((r) => r.aic).filter((x) => x !== aic),
      date,
    );
    return [...found.values()].sort(compareEquivalents);
  }

  /**
   * Catalogo regionale per parole chiave (D153): parole in qualunque ordine, sinonimi, sigle dei
   * materiali per esteso, codice del catalogo o del nomenclatore. Le varianti dello stesso codice
   * del nomenclatore restano vicine.
   */
  async searchServices(q: string, date: string, limit = SEARCH_LIMIT) {
    const ids = await this.ids('prestazioni', date);
    if (!q.trim() || !ids.length) return [];
    const index = await this.serviceIndex(ids);
    return searchServices(index, q, limit).map((h) => ({
      ...h.item,
      /** Il materiale tra quadre, per esteso se la sigla è nota. */
      material: h.material,
    }));
  }

  /**
   * Il catalogo delle prestazioni in uso alla data, per le regole e per la ricetta (D154): la voce
   * del codice del catalogo, o null se il codice non c'è; undefined se nessun catalogo è importato.
   */
  async serviceLookup(
    date: string,
  ): Promise<((code: string) => { nationalCode: string | null } | null) | undefined> {
    const ids = await this.ids('prestazioni', date);
    if (!ids.length) return undefined;
    const index = await this.serviceIndex(ids);
    const byCode = new Map(
      index.entries.map((e) => [e.item.regionalCode.trim().toUpperCase(), e.item.nationalCode]),
    );
    return (code) => {
      const key = code.trim().toUpperCase();
      return byCode.has(key) ? { nationalCode: byCode.get(key) ?? null } : null;
    };
  }

  private async serviceIndex(ids: string[]) {
    const key = [...ids].sort().join(',');
    const cached = SERVICE_INDEXES.get(key);
    if (cached) return cached;
    const rows = await this.db
      .select({
        regionalCode: refService.regionalCode,
        nationalCode: refService.nationalCode,
        description: refService.description,
        branch: refService.branch,
        fee: refService.fee,
        notes: refService.notes,
      })
      .from(refService)
      .where(inArray(refService.datasetId, ids));
    const index = indexServices(rows, SERVICE_SEARCH);
    if (SERVICE_INDEXES.size >= MAX_SERVICE_INDEXES) {
      SERVICE_INDEXES.delete(SERVICE_INDEXES.keys().next().value!);
    }
    SERVICE_INDEXES.set(key, index);
    return index;
  }

  /**
   * Diagnosi ICD-9-CM per descrizione o per codice (D186), nel catalogo in vigore alla data. Senza
   * catalogo in uso (per esempio una trascrizione ancora da controllare) nessun risultato.
   */
  async searchDiagnoses(
    q: string,
    date: string,
    limit = DIAGNOSIS_SEARCH_LIMIT,
  ): Promise<{ hits: DiagnosisHit[]; total: number }> {
    const index = await this.diagnosisIndex(date);
    if (!index || !q.trim()) return { hits: [], total: 0 };
    return searchDiagnoses(index, q, limit);
  }

  /**
   * La voce del catalogo ICD-9-CM in vigore alla data per un codice: null se il codice non c'è,
   * undefined se nessun catalogo è in uso.
   */
  async diagnosis(code: string, date: string): Promise<DiagnosisHit | null | undefined> {
    const index = await this.diagnosisIndex(date);
    return index ? diagnosisByCode(index, code) : undefined;
  }

  private async diagnosisIndex(date: string): Promise<DiagnosisIndex | undefined> {
    const ids = await this.ids('diagnosi', date);
    if (!ids.length) return undefined;
    const key = [...ids].sort().join(',');
    const cached = DIAGNOSIS_INDEXES.get(key);
    if (cached) return cached;
    const rows = await this.db
      .select({
        code: refDiagnosis.code,
        description: refDiagnosis.description,
        parentCode: refDiagnosis.parentCode,
        includedTerms: refDiagnosis.includedTerms,
        notes: refDiagnosis.notes,
        chapter: refDiagnosis.chapter,
        section: refDiagnosis.section,
      })
      .from(refDiagnosis)
      .where(inArray(refDiagnosis.datasetId, ids));
    const index = indexDiagnoses(rows);
    if (DIAGNOSIS_INDEXES.size >= MAX_DIAGNOSIS_INDEXES) {
      DIAGNOSIS_INDEXES.delete(DIAGNOSIS_INDEXES.keys().next().value!);
    }
    DIAGNOSIS_INDEXES.set(key, index);
    return index;
  }

  async searchExemptions(q: string, date: string, limit = SEARCH_LIMIT) {
    const text = q.trim();
    const ids = await this.ids('esenzioni', date);
    if (!text || !ids.length) return [];
    return this.db
      .select({ code: refExemption.code, description: refExemption.description })
      .from(refExemption)
      .where(
        and(
          inArray(refExemption.datasetId, ids),
          or(
            ilike(refExemption.code, `${likeText(text)}%`),
            ilike(refExemption.description, `%${likeText(text)}%`),
          ),
        ),
      )
      .orderBy(refExemption.code)
      .limit(limit);
  }

  async municipality(cadastralCode: string, date: string) {
    const ids = await this.ids('comuni', date);
    if (!ids.length) return undefined;
    const [m] = await this.db
      .select({
        istatCode: refMunicipality.istatCode,
        name: refMunicipality.name,
        region: refMunicipality.region,
        provinceAbbr: refMunicipality.provinceAbbr,
        cadastralCode: refMunicipality.cadastralCode,
      })
      .from(refMunicipality)
      .where(
        and(
          inArray(refMunicipality.datasetId, ids),
          eq(refMunicipality.cadastralCode, cadastralCode.toUpperCase()),
        ),
      );
    return m ?? null;
  }

  /**
   * Catalogo delle esenzioni e associazioni esenzione–prestazioni alla data, come funzioni
   * sincrone per le regole. Senza la banca dati le funzioni restituiscono undefined (= non noto).
   */
  async exemptionLookups(date: string): Promise<{
    /** C'è un catalogo delle esenzioni in vigore alla data. */
    catalogLoaded: boolean;
    exemptionExists: (code: string) => boolean | undefined;
    exemptionServices: (code: string) => ReadonlySet<string> | undefined;
  }> {
    const [catalogIds, serviceIds] = await Promise.all([
      this.ids('esenzioni', date),
      this.ids('esenzioni_prestazioni', date),
    ]);
    const codes = catalogIds.length
      ? new Set(
          (
            await this.db
              .select({ code: refExemption.code })
              .from(refExemption)
              .where(inArray(refExemption.datasetId, catalogIds))
          ).map((r) => r.code),
        )
      : null;
    const services = new Map<string, Set<string>>();
    if (serviceIds.length) {
      for (const r of await this.db
        .select()
        .from(refExemptionService)
        .where(inArray(refExemptionService.datasetId, serviceIds))) {
        let set = services.get(r.exemptionCode);
        if (!set) services.set(r.exemptionCode, (set = new Set()));
        set.add(r.serviceCode);
      }
    }
    // Un codice assente è inesistente solo se il catalogo copre la sua famiglia (D190).
    const families = codes ? new Set([...codes].map(exemptionFamily)) : null;
    return {
      catalogLoaded: codes !== null,
      exemptionExists: (code) =>
        !codes || !families
          ? undefined
          : codes.has(code)
            ? true
            : families.has(exemptionFamily(code))
              ? false
              : undefined,
      // Un'esenzione senza prestazioni nell'elenco non è «nessuna prestazione»: è non nota.
      exemptionServices: (code) => services.get(code),
    };
  }
}
