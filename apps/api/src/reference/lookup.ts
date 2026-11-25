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
  packUnits,
  SERVICE_SEARCH_DATA,
  searchDiagnoses,
  scopeKey,
  searchServices,
  type ServiceIndex,
} from '@mmg/reference';
import { shortageText, type DrugFacts } from '@mmg/rules';
import { and, desc, eq, ilike, inArray, isNotNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../db/client';
import {
  refDiagnosis,
  refDpcDrug,
  refDrug,
  refDrugClass,
  refDrugRegistry,
  refDrugShortage,
  refDrugTransparency,
  refAdditionalService,
  refSupply,
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
  /**
   * Lista di trasparenza AIFA (D202): prezzo di riferimento del SSN e differenza fra il prezzo al
   * pubblico e quello di riferimento, che paga l'assistito se non accetta l'equivalente.
   */
  referencePrice: string | null;
  priceDifference: string | null;
  /** Annotazione della lista di trasparenza, in parole (non è la nota AIFA numerata). */
  transparencyRemark: string | null;
  /** Carenza secondo l'elenco AIFA in vigore (D202); null se il farmaco non c'è. */
  shortage: DrugShortage | null;
  /**
   * Stato amministrativo della confezione nell'anagrafica AIFA in vigore («Autorizzata»,
   * «Sospesa»; D205); null se l'anagrafica non lo dice.
   */
  adminState: string | null;
  /**
   * Registri di monitoraggio e piani terapeutici AIFA attivi per lo stesso ATC (D206): il file non
   * ha l'AIC. Vuoto se l'elenco non è importato o non ne ha.
   */
  registries: DrugRegistry[];
  /** I fatti che le regole guardano; i campi senza una fonte restano assenti (= non noti). */
  facts: DrugFacts;
}

/** Una carenza come la dice l'elenco AIFA dei farmaci carenti (D202). */
export interface DrugShortage {
  since: string | null;
  expectedEnd: string | null;
  equivalentAvailable: boolean | null;
  reason: string | null;
  /** «Suggerimenti/Indicazioni AIFA» dell'elenco. */
  aifaAdvice: string | null;
  /** «Nota AIFA» dell'elenco: un testo in parole, non il numero di una nota AIFA. */
  aifaNote: string | null;
  /** La carenza in parole alla data della consultazione, come nella R21. */
  text: string;
}

/** Un registro o un piano terapeutico AIFA, come lo dice l'elenco dei registri attivi (D206). */
export interface DrugRegistry {
  name: string;
  activeIngredient: string | null;
  atc: string | null;
  /** «Tipologia di Monitoraggio» dell'elenco: Registro, Piano Terapeutico, Registro semplificato… */
  type: string | null;
  state: string | null;
  condition: string | null;
  /** «Indicazione rimborsata», con le parole dell'elenco. */
  indication: string | null;
  since: string | null;
  /** La scheda sul sito di AIFA; null se l'indirizzo dell'elenco non è in https su aifa.gov.it. */
  sheetUrl: string | null;
}

/**
 * L'indirizzo di una scheda AIFA, solo se è in https su aifa.gov.it o un suo sottodominio: un
 * collegamento in una pagina del programma non porta altrove, anche se un file importato lo
 * dicesse (D206). Gli spazi e gli a capo intorno si tolgono; il resto resta com'è.
 */
export function safeAifaUrl(raw: string | null | undefined): string | null {
  const text = (raw ?? '').trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && (host === 'aifa.gov.it' || host.endsWith('.aifa.gov.it'))
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Una terapia come la guarda A7: il farmaco e i fatti che la scheda ha registrato (D205). */
export interface TherapyFacts {
  id: string;
  drugAic: string | null;
  drugClass: string | null;
  aifaNote: string | null;
  activeIngredient: string | null;
  atc: string | null;
  /** La scheda ha un piano terapeutico collegato. */
  hasPlan: boolean;
}

/** Una variazione AIFA su un farmaco in terapia (A7, D205). */
export interface AifaChange {
  kind: 'sospesa' | 'anagrafica' | 'classe' | 'nota' | 'piano';
  /** La data della versione che la mostra. */
  since: string;
  /** In parole, con la fonte e la versione. */
  text: string;
}

type ShortageRow = typeof refDrugShortage.$inferSelect;

/** La riga dell'elenco come carenza, con il testo alla data. */
function toShortage(row: ShortageRow, date: string): DrugShortage {
  const facts = {
    since: row.startOn,
    expectedEnd: row.expectedEndOn,
    equivalentAvailable: row.equivalentAvailable,
    reason: row.reason,
  };
  return {
    ...facts,
    aifaAdvice: row.aifaAdvice,
    aifaNote: row.aifaNote,
    text: shortageText(facts, date),
  };
}

/** Quanti farmaci mostra al più una ricerca: oltre, si precisa la ricerca (audit, D259). */
export const SEARCH_LIMIT = 30;

/**
 * Quanto un farmaco risponde alla ricerca (audit, D259): prima AIC e ATC; poi le confezioni con il
 * solo principio attivo cercato (un generico, o un marchio come LIPITOR per l'atorvastatina); poi i
 * nomi che cominciano con il testo; poi il resto, con le associazioni (A/B) in fondo. Così i primi
 * trenta non sono le associazioni che vengono prima in ordine alfabetico.
 */
export function drugRank(
  d: { aic: string; atc?: string | null; name: string | null; activeIngredient: string | null },
  q: string,
): number {
  const text = q.trim().toLowerCase();
  const ingredient = (d.activeIngredient ?? '').trim().toLowerCase();
  const single = !/[/+,]/.test(ingredient);
  if (d.aic.startsWith(text) || (d.atc ?? '').toLowerCase().startsWith(text)) return 0;
  if (single && ingredient.startsWith(text)) return 1;
  if ((d.name ?? '').toLowerCase().startsWith(text)) return 2;
  return single ? 3 : 4;
}

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

/**
 * Il regime di fornitura AIFA dice «Ricetta Ministeriale a Ricalco»: stupefacente della sezione A
 * della tabella dei medicinali (R23, D272).
 */
export const ministerialPad = (supplyRegime: string | null | undefined) =>
  /ricetta ministeriale a ricalco/.test(lower(supplyRegime));

/** Ordine degli equivalenti: prima il prezzo; a parità, nome e AIC, lo stesso a ogni ricerca. */
/**
 * La carenza che vale alla data, fra quelle dell'elenco per lo stesso AIC (tre AIC compaiono due
 * volte nell'elenco del 17/11/2026): quella cominciata più di recente; se nessuna è cominciata,
 * la prima prevista (D202).
 */
export function shortageAt<T extends { startOn: string | null }>(
  rows: readonly T[],
  date: string,
): T | null {
  const started = rows
    .filter((r) => r.startOn === null || r.startOn <= date)
    .sort((a, b) => (b.startOn ?? '').localeCompare(a.startOn ?? ''));
  if (started.length) return started[0]!;
  return [...rows].sort((a, b) => (a.startOn ?? '').localeCompare(b.startOn ?? ''))[0] ?? null;
}

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
/** Una voce del catalogo delle prestazioni aggiuntive (PPIP) in vigore a una data (D212). */
export interface AdditionalServiceItem {
  code: string;
  section: string;
  description: string;
  /** Soggetta ad autorizzazione (sezione B dell'allegato 6): servono gli estremi. */
  authorization: boolean;
  /** Compenso in euro, se l'atto lo dice. */
  compensation: number | null;
  notes: string | null;
  datasetId: string;
  series: string;
  /** L'atto da cui viene la voce, come lo dice la trascrizione. */
  act: string | null;
  validFrom: string;
}

/**
 * Dove si guarda una banca dati che può valere solo in una regione o in un'ASL (D232): la regione
 * dello studio e l'ASL del titolare dell'archivio. Senza, valgono solo le serie di tutta Italia.
 */
export interface ReferenceScope {
  region?: string | null;
  asl?: string | null;
}

/** La versione vale dove la si guarda: nessun ambito, oppure la stessa regione e la stessa ASL. */
function inScope(
  d: { scopeRegion: string | null; scopeAsl: string | null },
  scope: ReferenceScope,
) {
  if (d.scopeRegion && scopeKey(d.scopeRegion) !== scopeKey(scope.region)) return false;
  if (d.scopeAsl && scopeKey(d.scopeAsl) !== scopeKey(scope.asl)) return false;
  return true;
}

const specificity = (d: { scopeRegion: string | null; scopeAsl: string | null }) =>
  d.scopeAsl ? 2 : d.scopeRegion ? 1 : 0;

/**
 * Per lo stesso codice in due serie: vale l'atto più recente; con la stessa data quello più
 * vicino (ASL, poi regione, poi Italia); poi l'ultimo importato. Mai l'ordine delle righe (D232).
 */
function wins(
  d: {
    validFrom: string;
    scopeRegion: string | null;
    scopeAsl: string | null;
    importedAt: Date;
    id: string;
  },
  prev: {
    validFrom: string;
    scopeRegion: string | null;
    scopeAsl: string | null;
    importedAt: Date;
    id: string;
  },
) {
  if (d.validFrom !== prev.validFrom) return d.validFrom > prev.validFrom;
  if (specificity(d) !== specificity(prev)) return specificity(d) > specificity(prev);
  if (d.importedAt.getTime() !== prev.importedAt.getTime())
    return d.importedAt.getTime() > prev.importedAt.getTime();
  return d.id > prev.id;
}

/** Una voce del nomenclatore dei presidi del DPCM LEA (D218). */
export interface SupplyCatalogItem {
  /** Un presidio con il suo codice, o una malattia rara che dà diritto ai presidi dell'allegato. */
  entryType: 'presidio' | 'malattia_rara';
  code: string;
  description: string;
  group: string;
  /** Allegato del DPCM: «2» o «3». */
  annex: string;
  /** La quantità stampata nell'allegato e l'intestazione della sua colonna, se ci sono (D237). */
  quantity: string | null;
  quantityHeading: string | null;
  series: string;
  act: string | null;
  validFrom: string;
}

/** Sezioni del nomenclatore prima (A, B), poi gli accordi che aggiungono voci; i numeri in ordine. */
const sectionRank = (section: string) => (section === 'A' ? 0 : section === 'B' ? 1 : 2);
export const compareAdditionalServices = (a: AdditionalServiceItem, b: AdditionalServiceItem) =>
  sectionRank(a.section) - sectionRank(b.section) ||
  a.code.localeCompare(b.code, 'it', { numeric: true });

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
    const [drugIds, classIds, dpcIds, transparencyIds, shortageIds] = await Promise.all([
      this.ids('farmaci', date),
      this.ids('farmaci_classe', date),
      this.ids('farmaci_dpc', date),
      this.ids('farmaci_trasparenza', date),
      this.ids('farmaci_carenti', date),
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
    const transparency = transparencyIds.length
      ? await this.db
          .select()
          .from(refDrugTransparency)
          .where(
            and(
              inArray(refDrugTransparency.datasetId, transparencyIds),
              inArray(refDrugTransparency.aic, wanted),
            ),
          )
      : [];
    const shortages = shortageIds.length
      ? await this.db
          .select()
          .from(refDrugShortage)
          .where(
            and(
              inArray(refDrugShortage.datasetId, shortageIds),
              inArray(refDrugShortage.aic, wanted),
            ),
          )
      : [];
    for (const aic of wanted) {
      const d = drugs.filter((x) => x.aic === aic);
      const c = classes.filter((x) => x.aic === aic);
      const t = transparency.filter((x) => x.aic === aic);
      const s = shortages.filter((x) => x.aic === aic);
      if (!d.length && !c.length && !t.length && !s.length) continue;
      const shortage = shortageAt(s, date);
      const pick = <T>(values: (T | null)[]) =>
        values.find((v) => v !== null && v !== undefined) ?? null;
      const activeIngredient = pick([
        ...d.map((x) => x.activeIngredient),
        ...c.map((x) => x.activeIngredient),
        ...t.map((x) => x.activeIngredient),
        ...s.map((x) => x.activeIngredient),
      ]);
      const atc = pick([...d.map((x) => x.atc), ...t.map((x) => x.atc), ...s.map((x) => x.atc)]);
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
      // La classe degli elenchi in vigore, o null se non hanno la confezione: la R8 lo dice senza
      // dedurne «non a carico» (D59, D261). Senza elenchi in vigore resta non nota.
      if (classIds.length) facts.listedClass = classA ? 'A' : pick(c.map((x) => x.drugClass));
      if (aifaNote) facts.aifaNote = aifaNote;
      // L'elenco DPC dice quando il piano serve; quando non c'è, non dice che non serve.
      if (inDpc?.planRequired === true) facts.requiresPlan = true;
      // L'elenco dei carenti dice che il farmaco è carente; quando non c'è, la R21 tace (D202).
      if (shortage) {
        facts.shortage = {
          since: shortage.startOn,
          expectedEnd: shortage.expectedEndOn,
          equivalentAvailable: shortage.equivalentAvailable,
          reason: shortage.reason,
        };
      }
      // L'anagrafica in vigore dice «Sospesa»: la R22 informa (D210). «Autorizzata», nessuno stato
      // o nessuna riga non sono una sospensione, come nelle variazioni sui farmaci in terapia.
      if (d.some((x) => lower(x.adminState) === 'sospesa')) facts.suspended = true;
      // Regime «prescrizione medica speciale con Ricetta Ministeriale a Ricalco»: stupefacente
      // della sezione A della tabella dei medicinali (R23, D272).
      if (d.some((x) => ministerialPad(x.supplyRegime))) facts.ministerialPad = true;
      // Unità per confezione dalla descrizione dell'anagrafica AIFA (D252): «- 28 COMPRESSE».
      // Solo compresse, capsule e bustine; il resto resta non noto.
      const units = packUnits(pick(d.map((x) => x.pack)));
      if (units) {
        facts.unitsPerPack = units.count;
        facts.packUnit = units.unit;
      }
      out.set(aic, {
        aic,
        name: pick([...d.map((x) => x.name), ...t.map((x) => x.name), ...s.map((x) => x.name)]),
        pack: pick([...d.map((x) => x.pack), ...t.map((x) => x.pack)]),
        activeIngredient,
        atc,
        form: pick(d.map((x) => x.form)),
        supplyRegime: pick(d.map((x) => x.supplyRegime)),
        holder: pick([
          ...d.map((x) => x.holder),
          ...t.map((x) => x.holder),
          ...s.map((x) => x.holder),
        ]),
        drugClass: classA ? 'A' : pick(c.map((x) => x.drugClass)),
        // Il prezzo al pubblico della lista di trasparenza è il più recente (esce ogni mese, il 15):
        // vale prima di quello delle liste di classe (D202).
        price: pick([
          ...t.map((x) => x.publicPrice),
          ...(classA ? [classA] : c).map((x) => x.price),
        ]),
        equivalenceGroup: pick([
          ...c.map((x) => x.equivalenceGroup),
          ...t.map((x) => x.equivalenceGroup),
        ]),
        aifaNote,
        dpc: !!inDpc,
        planRequired: inDpc?.planRequired ?? null,
        referencePrice: pick(t.map((x) => x.referencePrice)),
        priceDifference: pick(t.map((x) => x.priceDifference)),
        transparencyRemark: pick(t.map((x) => x.remark)),
        shortage: shortage ? toShortage(shortage, date) : null,
        adminState: pick(d.map((x) => x.adminState)),
        registries: [],
        facts,
      });
    }
    await this.attachRegistries(out, date);
    return out;
  }

  /**
   * I registri AIFA in vigore alla data, per ATC (D206). Il collegamento è per ATC e non per
   * principio attivo: l'ATC dell'elenco è un codice, il nome del principio attivo è scritto in
   * modi diversi nei file AIFA («Sacubitril e Valsartan», «VALSARTAN/SACUBITRIL»).
   */
  private async attachRegistries(drugs: Map<string, DrugInfo>, date: string) {
    const atcs = [
      ...new Set([...drugs.values()].map((d) => d.atc?.trim().toUpperCase()).filter(Boolean)),
    ] as string[];
    if (!atcs.length) return;
    const ids = await this.ids('registri_aifa', date);
    if (!ids.length) return;
    const rows = await this.db
      .select()
      .from(refDrugRegistry)
      .where(and(inArray(refDrugRegistry.datasetId, ids), inArray(refDrugRegistry.atc, atcs)))
      // I più recenti prima; a parità di data, per nome e patologia: lo stesso ordine ogni volta.
      .orderBy(
        sql`${refDrugRegistry.monitoringStart} desc nulls last`,
        refDrugRegistry.name,
        refDrugRegistry.condition,
        refDrugRegistry.id,
      );
    for (const info of drugs.values()) {
      const atc = info.atc?.trim().toUpperCase();
      info.registries = rows
        .filter((r) => r.atc === atc)
        .map((r) => ({
          name: r.name,
          activeIngredient: r.activeIngredient,
          atc: r.atc,
          type: r.monitoringType,
          state: r.monitoringState,
          condition: r.condition,
          indication: r.reimbursedIndication,
          since: r.monitoringStart,
          sheetUrl: safeAifaUrl(r.sheetUrl),
        }));
    }
  }

  /**
   * Le carenze alla data per gli AIC dati (D202), una per AIC come nella R21: per le terapie in
   * corso e per la pagina Oggi. Senza l'elenco importato, nessuna carenza.
   */
  async shortages(aics: readonly string[], date: string): Promise<Map<string, DrugShortage>> {
    const wanted = [...new Set(aics)];
    const out = new Map<string, DrugShortage>();
    if (!wanted.length) return out;
    const ids = await this.ids('farmaci_carenti', date);
    if (!ids.length) return out;
    const rows = await this.db
      .select()
      .from(refDrugShortage)
      .where(and(inArray(refDrugShortage.datasetId, ids), inArray(refDrugShortage.aic, wanted)));
    for (const aic of wanted) {
      const row = shortageAt(
        rows.filter((r) => r.aic === aic),
        date,
      );
      if (row) out.set(aic, toShortage(row, date));
    }
    return out;
  }

  /** Le versioni di un tipo superate alla data: in vigore prima, o importate prima nello stesso giorno. */
  private async superseded(kind: DatasetKind, date: string, current: readonly { id: string }[]) {
    const now = new Set(current.map((d) => d.id));
    const all = await this.db
      .select({
        id: referenceDataset.id,
        series: referenceDataset.series,
        validFrom: referenceDataset.validFrom,
      })
      .from(referenceDataset)
      .where(and(eq(referenceDataset.kind, kind), lte(referenceDataset.validFrom, date)));
    return all.filter((d) => !now.has(d.id));
  }

  /**
   * Le variazioni AIFA che toccano i farmaci in terapia alla data (A7, D205): la confezione sospesa
   * o uscita dall'anagrafica, la classe, la nota e il piano. Classe e nota si confrontano con quelle
   * che la scheda della terapia ha registrato dalla banca dati: c'è una variazione se i dati in
   * vigore dicono altro e quelli registrati si ritrovano in una versione superata (così non si
   * scambia per una variazione una scheda scritta a mano). Il piano: l'elenco DPC in vigore lo
   * chiede, la terapia non ne ha uno e una versione superata dell'elenco non lo chiedeva. Mai un
   * «no» per assenza (D59): una confezione che non c'è più è «uscita dall'anagrafica», non
   * «revocata». Senza le versioni che servono, nessuna variazione.
   */
  async aifaChanges(
    therapies: readonly TherapyFacts[],
    date: string,
  ): Promise<Map<string, AifaChange[]>> {
    const out = new Map<string, AifaChange[]>();
    const add = (id: string, change: AifaChange) => out.set(id, [...(out.get(id) ?? []), change]);
    const aics = [...new Set(therapies.map((t) => t.drugAic).filter((a): a is string => !!a))];
    if (!aics.length) return out;
    const [drugNow, classNow, dpcNow] = await Promise.all([
      this.inEffect('farmaci', date),
      this.inEffect('farmaci_classe', date),
      this.inEffect('farmaci_dpc', date),
    ]);
    const [drugOld, classOld, dpcOld] = await Promise.all([
      this.superseded('farmaci', date, drugNow),
      this.superseded('farmaci_classe', date, classNow),
      this.superseded('farmaci_dpc', date, dpcNow),
    ]);
    const validFrom = new Map(
      [...drugNow, ...drugOld, ...classNow, ...classOld, ...dpcNow, ...dpcOld].map((d) => [
        d.id,
        d.validFrom,
      ]),
    );
    const day = (datasetId: string) => dayIt(validFrom.get(datasetId)!);
    const latest = (ids: readonly string[]) =>
      ids.reduce((a, b) => (validFrom.get(b)! > validFrom.get(a)! ? b : a));

    // Le righe si leggono una volta e si indicizzano per AIC (o per ATC e principio attivo): con
    // migliaia di terapie e una versione nuova dell'anagrafica quasi ogni giorno, il calcolo
    // non cresce con il numero delle versioni superate (D209).
    const group = <T, K>(rows: readonly T[], key: (r: T) => K) => {
      const m = new Map<K, T[]>();
      for (const r of rows) {
        const k = key(r);
        const list = m.get(k);
        if (list) list.push(r);
        else m.set(k, [r]);
      }
      return m;
    };

    // Anagrafica delle confezioni: sospesa, o non più presente.
    const drugsNow = drugNow.length
      ? await this.db
          .select({
            aic: refDrug.aic,
            datasetId: refDrug.datasetId,
            adminState: refDrug.adminState,
          })
          .from(refDrug)
          .where(
            and(
              inArray(
                refDrug.datasetId,
                drugNow.map((d) => d.id),
              ),
              inArray(refDrug.aic, aics),
            ),
          )
      : [];
    const drugsNowBy = group(drugsNow, (r) => r.aic);
    const missing = drugNow.length ? aics.filter((a) => !drugsNowBy.has(a)) : [];
    // Per gli AIC che non ci sono più: l'ultima versione superata che li aveva, una riga per AIC.
    const lastSeen =
      missing.length && drugOld.length
        ? await this.db
            .select({
              aic: refDrug.aic,
              last: sql<string>`max(${referenceDataset.validFrom})::text`,
            })
            .from(refDrug)
            .innerJoin(referenceDataset, eq(referenceDataset.id, refDrug.datasetId))
            .where(
              and(
                inArray(
                  refDrug.datasetId,
                  drugOld.map((d) => d.id),
                ),
                inArray(refDrug.aic, missing),
              ),
            )
            .groupBy(refDrug.aic)
        : [];
    const lastSeenBy = new Map(lastSeen.map((r) => [r.aic, r.last]));

    // Classe: le righe in vigore per gli AIC in terapia; delle versioni superate, solo quali
    // classi e serie li avevano, una riga per AIC, classe e serie.
    const classesNow = classNow.length
      ? await this.db
          .select({ aic: refDrugClass.aic, drugClass: refDrugClass.drugClass })
          .from(refDrugClass)
          .where(
            and(
              inArray(
                refDrugClass.datasetId,
                classNow.map((d) => d.id),
              ),
              inArray(refDrugClass.aic, aics),
            ),
          )
      : [];
    const classesNowBy = group(classesNow, (r) => r.aic);
    const classesOld = classOld.length
      ? await this.db
          .selectDistinct({
            aic: refDrugClass.aic,
            drugClass: refDrugClass.drugClass,
            series: referenceDataset.series,
          })
          .from(refDrugClass)
          .innerJoin(referenceDataset, eq(referenceDataset.id, refDrugClass.datasetId))
          .where(
            and(
              inArray(
                refDrugClass.datasetId,
                classOld.map((d) => d.id),
              ),
              inArray(refDrugClass.aic, aics),
            ),
          )
      : [];
    const classesOldBy = group(classesOld, (r) => r.aic);

    // Elenco DPC: per principio attivo o ATC, come nei dati del farmaco. Le righe in vigore con il
    // loro ordine (vale la prima che corrisponde); delle versioni superate, le note per ATC e per
    // principio attivo, e per ogni versione dove chiedeva il piano.
    const dpcRows = (ids: string[]) =>
      ids.length
        ? this.db.select().from(refDpcDrug).where(inArray(refDpcDrug.datasetId, ids))
        : Promise.resolve([]);
    const dpcsNow = (await dpcRows(dpcNow.map((d) => d.id))).map((r, index) => ({ ...r, index }));
    const dpcsOld = await dpcRows(dpcOld.map((d) => d.id));
    const keysOf = (r: { activeIngredient: string | null; atc: string | null }) => [
      ...(r.atc !== null ? [`atc:${r.atc}`] : []),
      ...(r.activeIngredient !== null ? [`ing:${lower(r.activeIngredient)}`] : []),
    ];
    const dpcsNowBy = new Map<string, typeof dpcsNow>();
    for (const r of dpcsNow)
      for (const k of keysOf(r)) dpcsNowBy.set(k, [...(dpcsNowBy.get(k) ?? []), r]);
    const note = (v: string | null | undefined) => (v ?? '').trim() || null;
    const oldNotes = new Map<string, Set<string | null>>();
    const oldPlans = new Map<string, Set<string>>();
    for (const r of dpcsOld) {
      for (const k of keysOf(r)) {
        oldNotes.set(k, (oldNotes.get(k) ?? new Set()).add(note(r.aifaNote)));
        if (r.planRequired === true)
          oldPlans.set(r.datasetId, (oldPlans.get(r.datasetId) ?? new Set()).add(k));
      }
    }

    for (const t of therapies) {
      if (!t.drugAic) continue;
      const aic = t.drugAic;
      const mine = drugsNowBy.get(aic) ?? [];
      const suspended = mine.find((r) => lower(r.adminState) === 'sospesa');
      if (suspended) {
        add(t.id, {
          kind: 'sospesa',
          since: validFrom.get(suspended.datasetId)!,
          text: `confezione sospesa secondo l’anagrafica AIFA delle confezioni (versione del ${day(suspended.datasetId)})`,
        });
      } else if (!mine.length && drugNow.length) {
        const last = lastSeenBy.get(aic);
        if (last) {
          const now = latest(drugNow.map((d) => d.id));
          add(t.id, {
            kind: 'anagrafica',
            since: validFrom.get(now)!,
            text: `non è più nell’anagrafica AIFA delle confezioni (versione del ${day(now)}); c’era in quella del ${dayIt(last)}`,
          });
        }
      }

      const recorded = (t.drugClass ?? '').trim().toUpperCase();
      if (recorded === 'A' || recorded === 'H') {
        const now = classesNowBy.get(aic) ?? [];
        const before = (classesOldBy.get(aic) ?? []).filter((r) => r.drugClass === recorded);
        if (before.length && !now.some((r) => r.drugClass === recorded)) {
          // La versione in vigore della stessa serie, che non lo ha più in quella classe.
          const series = new Set(before.map((r) => r.series));
          const nowIds = classNow.filter((d) => series.has(d.series)).map((d) => d.id);
          const other = now.find((r) => r.drugClass !== recorded)?.drugClass ?? null;
          if (nowIds.length) {
            const v = latest(nowIds);
            add(t.id, {
              kind: 'classe',
              since: validFrom.get(v)!,
              text: other
                ? `negli elenchi AIFA è passato dalla classe ${recorded} alla classe ${other} (versione del ${day(v)}); nella terapia è segnato in classe ${recorded}`
                : `non è più nell’elenco AIFA dei farmaci di classe ${recorded} (versione del ${day(v)}); nella terapia è segnato in classe ${recorded}`,
            });
          }
        }
      }

      // Le chiavi della terapia nell'elenco DPC: l'ATC e il principio attivo che la scheda ha.
      const keys = keysOf(t);
      const firstNow = (ok: (r: (typeof dpcsNow)[number]) => boolean) =>
        keys
          .flatMap((k) => dpcsNowBy.get(k) ?? [])
          .filter(ok)
          .sort((a, b) => a.index - b.index)[0];
      const dpcNowRow = firstNow(() => true);
      const recordedNote = note(t.aifaNote);
      if (recordedNote && dpcNowRow && note(dpcNowRow.aifaNote) !== recordedNote) {
        const before = keys.some((k) => oldNotes.get(k)?.has(recordedNote));
        if (before) {
          const current = note(dpcNowRow.aifaNote);
          add(t.id, {
            kind: 'nota',
            since: validFrom.get(dpcNowRow.datasetId)!,
            text: current
              ? `nell’elenco DPC la nota AIFA è ora la ${current} (versione del ${day(dpcNowRow.datasetId)}); nella terapia è segnata la ${recordedNote}`
              : `nell’elenco DPC la nota AIFA non c’è più (versione del ${day(dpcNowRow.datasetId)}); nella terapia è segnata la ${recordedNote}`,
          });
        }
      }
      const planNow = firstNow((r) => r.planRequired === true);
      if (planNow && !t.hasPlan) {
        // Una versione superata dell'elenco che non lo chiedeva: con il farmaco senza piano, o senza
        // il farmaco.
        const before = dpcOld.some((d) => !keys.some((k) => oldPlans.get(d.id)?.has(k)));
        if (before) {
          add(t.id, {
            kind: 'piano',
            since: validFrom.get(planNow.datasetId)!,
            text: `l’elenco DPC chiede il piano terapeutico (versione del ${day(planNow.datasetId)}); la terapia non ha un piano collegato`,
          });
        }
      }
    }
    return out;
  }

  /** Ricerca per nome commerciale, principio attivo, AIC o ATC. */
  async searchDrugs(q: string, date: string, limit = SEARCH_LIMIT): Promise<DrugInfo[]> {
    const text = q.trim();
    if (!text) return [];
    const like = `%${likeText(text)}%`;
    const prefix = `${likeText(text)}%`;
    const [drugIds, classIds, transparencyIds] = await Promise.all([
      this.ids('farmaci', date),
      this.ids('farmaci_classe', date),
      this.ids('farmaci_trasparenza', date),
    ]);
    const aics = new Set<string>();
    if (drugIds.length) {
      const match: SQL = or(
        ilike(refDrug.aic, prefix),
        ilike(refDrug.atc, prefix),
        ilike(refDrug.name, like),
        ilike(refDrug.activeIngredient, like),
      )!;
      // Lo stesso ordine di drugRank, prima del taglio: le confezioni che rispondono meglio entrano
      // nei primi, non quelle che vengono prima nell'alfabeto (audit, D259).
      const single = sql`(${refDrug.activeIngredient} !~ '[/+,]')`;
      const rank = sql<number>`case
        when ${refDrug.aic} ilike ${prefix} or ${refDrug.atc} ilike ${prefix} then 0
        when ${single} and ${refDrug.activeIngredient} ilike ${prefix} then 1
        when ${refDrug.name} ilike ${prefix} then 2
        when ${single} then 3
        else 4 end`;
      // Senza DISTINCT: con l'ordine calcolato Postgres non lo accetta. Lo stesso AIC in due
      // versioni dell'anagrafica si conta una volta, qui.
      for (const r of await this.db
        .select({ aic: refDrug.aic })
        .from(refDrug)
        .where(and(inArray(refDrug.datasetId, drugIds), match))
        .orderBy(rank, refDrug.name, refDrug.aic)
        .limit(limit * drugIds.length)) {
        if (aics.size >= limit) break;
        aics.add(r.aic);
      }
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
    // La lista di trasparenza ha nome, AIC, ATC e principio attivo (D202).
    if (transparencyIds.length && aics.size < limit) {
      for (const r of await this.db
        .selectDistinct({ aic: refDrugTransparency.aic, name: refDrugTransparency.name })
        .from(refDrugTransparency)
        .where(
          and(
            inArray(refDrugTransparency.datasetId, transparencyIds),
            or(
              ilike(refDrugTransparency.aic, prefix),
              ilike(refDrugTransparency.atc, prefix),
              ilike(refDrugTransparency.name, like),
              ilike(refDrugTransparency.activeIngredient, like),
            ),
          ),
        )
        .orderBy(refDrugTransparency.name, refDrugTransparency.aic)
        .limit(limit))
        aics.add(r.aic);
    }
    const found = await this.drugs([...aics].slice(0, limit), date);
    return [...found.values()].sort(
      (a, b) =>
        drugRank(a, text) - drugRank(b, text) ||
        lower(a.name).localeCompare(lower(b.name)) ||
        a.aic.localeCompare(b.aic),
    );
  }

  /**
   * Farmaci dello stesso gruppo di equivalenza (liste AIFA), escluso quello di partenza: dalle
   * liste di classe e dalla lista di trasparenza, che usano gli stessi codici di gruppo (D202).
   */
  async equivalents(aic: string, date: string): Promise<DrugInfo[]> {
    const own = (await this.drugs([aic], date)).get(aic);
    if (!own?.equivalenceGroup) return [];
    const [classIds, transparencyIds] = await Promise.all([
      this.ids('farmaci_classe', date),
      this.ids('farmaci_trasparenza', date),
    ]);
    const inClass = classIds.length
      ? await this.db
          .selectDistinct({ aic: refDrugClass.aic })
          .from(refDrugClass)
          .where(
            and(
              inArray(refDrugClass.datasetId, classIds),
              eq(refDrugClass.equivalenceGroup, own.equivalenceGroup),
            ),
          )
      : [];
    const inTransparency = transparencyIds.length
      ? await this.db
          .selectDistinct({ aic: refDrugTransparency.aic })
          .from(refDrugTransparency)
          .where(
            and(
              inArray(refDrugTransparency.datasetId, transparencyIds),
              eq(refDrugTransparency.equivalenceGroup, own.equivalenceGroup),
            ),
          )
      : [];
    const found = await this.drugs(
      [...new Set([...inClass, ...inTransparency].map((r) => r.aic))].filter((x) => x !== aic),
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

  /**
   * Le descrizioni delle esenzioni dal catalogo in vigore alla data, per codice (D244). Un codice
   * che il catalogo non ha, o un catalogo che non c'è, resta senza descrizione: non se ne inventa
   * una.
   */
  async exemptionDescriptions(codes: readonly string[], date: string) {
    const out = new Map<string, string>();
    const wanted = [...new Set(codes.map((c) => c.trim()).filter(Boolean))];
    if (!wanted.length) return out;
    const ids = await this.ids('esenzioni', date);
    if (!ids.length) return out;
    for (const r of await this.db
      .select({ code: refExemption.code, description: refExemption.description })
      .from(refExemption)
      .where(and(inArray(refExemption.datasetId, ids), inArray(refExemption.code, wanted))))
      if (!out.has(r.code)) out.set(r.code, r.description);
    return out;
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
  /**
   * Le prestazioni aggiuntive in vigore alla data, di tutte le serie che valgono per l'archivio:
   * l'accordo nazionale, quello regionale della regione dello studio e, quando ci sarà, quello
   * aziendale dell'ASL del titolare (D212, D232). Se lo stesso codice è in più serie vale l'atto
   * più recente; con la stessa data, quello più vicino (l'ASL prima della regione, la regione prima
   * dell'Italia), poi l'ultimo importato.
   */
  async additionalServices(
    date: string,
    scope: ReferenceScope = {},
  ): Promise<AdditionalServiceItem[]> {
    const sets = (await this.inEffect('prestazioni_aggiuntive', date)).filter((d) =>
      inScope(d, scope),
    );
    if (!sets.length) return [];
    const byId = new Map(sets.map((d) => [d.id, d]));
    const rows = await this.db
      .select()
      .from(refAdditionalService)
      .where(inArray(refAdditionalService.datasetId, [...byId.keys()]));
    const best = new Map<string, AdditionalServiceItem>();
    for (const r of rows) {
      const d = byId.get(r.datasetId)!;
      const item: AdditionalServiceItem = {
        code: r.code,
        section: r.section,
        description: r.description,
        authorization: r.authorization,
        compensation: r.compensation === null ? null : Number(r.compensation),
        notes: r.notes,
        datasetId: r.datasetId,
        series: d.series,
        act: d.act,
        validFrom: d.validFrom,
      };
      const prev = best.get(r.code);
      if (!prev || wins(d, byId.get(prev.datasetId)!)) best.set(r.code, item);
    }
    return [...best.values()].sort(compareAdditionalServices);
  }

  /**
   * Il nomenclatore dei presidi in vigore alla data (D218): presidi e malattie rare dell'allegato 3,
   * poi quelli degli altri allegati che verranno trascritti. Una voce è uguale in due serie se ha lo
   * stesso tipo, codice e descrizione: vale la serie più recente. Ordine dell'allegato.
   */
  async supplyCatalog(date: string): Promise<SupplyCatalogItem[]> {
    const sets = await this.inEffect('presidi', date);
    if (!sets.length) return [];
    const byId = new Map(sets.map((d) => [d.id, d]));
    const rows = await this.db
      .select()
      .from(refSupply)
      .where(inArray(refSupply.datasetId, [...byId.keys()]))
      .orderBy(refSupply.id);
    const best = new Map<string, SupplyCatalogItem>();
    for (const r of rows) {
      const d = byId.get(r.datasetId)!;
      const item: SupplyCatalogItem = {
        entryType: r.entryType === 'malattia_rara' ? 'malattia_rara' : 'presidio',
        code: r.code,
        description: r.description,
        group: r.group,
        annex: r.annex,
        quantity: r.quantity || null,
        quantityHeading: r.quantityHeading || null,
        series: d.series,
        act: d.act,
        validFrom: d.validFrom,
      };
      const key = `${item.entryType}|${item.code}|${item.description}`;
      const prev = best.get(key);
      if (!prev || prev.validFrom < item.validFrom) best.set(key, item);
    }
    return [...best.values()];
  }

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
