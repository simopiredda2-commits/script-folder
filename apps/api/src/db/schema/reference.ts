import {
  bigint,
  boolean,
  date,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Banche dati pubbliche importate dall'output di sync/ (tappa 5). Ogni importazione è una
 * versione: non si modifica e non si cancella. Le regole usano la versione in vigore alla data
 * della ricetta (A5); le schermate mostrano la data della versione in uso (A6).
 */
export const referenceDataset = pgTable(
  'reference_dataset',
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Tipo di banca dati (packages/reference, KINDS). */
    kind: text().notNull(),
    /** Serie di versioni successive: l'id della mappatura, o la serie dichiarata nella trascrizione. */
    series: text().notNull(),
    /** Titolo della serie, per le schermate. */
    title: text().notNull(),
    mappingVersion: text().notNull(),
    /** «sync» o «trascrizione». */
    origin: text().notNull(),
    /** Fonte e chiave del file in sync (per le trascrizioni: del PDF trascritto, se c'è). */
    source: text(),
    fileKey: text(),
    originalName: text(),
    url: text(),
    /** Impronta del file importato (il CSV o l'XLSX, oppure il CSV della trascrizione). */
    sha256: text().notNull(),
    bytes: integer().notNull(),
    /** Per le trascrizioni: impronta del PDF d'origine, controllata con lo stato di sync. */
    originSha256: text(),
    downloadedAt: timestamp({ withTimezone: true }),
    /** Da quando valgono i dati. */
    validFrom: date().notNull(),
    /** «scaricamento» (il giorno del download) o «atto» (la data dichiarata nella trascrizione). */
    validFromBasis: text().notNull(),
    act: text(),
    transcribedBy: text(),
    transcribedOn: date(),
    checkedBy: text(),
    rows: integer().notNull(),
    /** Righe scartate perché non valide, solo se chi importa le ha accettate. */
    discardedRows: integer().notNull().default(0),
    importedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    /** Chi ha lanciato l'importazione (utente del sistema o del servizio). */
    importedBy: text().notNull(),
  },
  (t) => [unique().on(t.series, t.sha256), index().on(t.kind, t.validFrom)],
);

const datasetId = () =>
  uuid()
    .notNull()
    .references(() => referenceDataset.id);
const rowId = () => bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity();

export const refDrug = pgTable(
  'ref_drug',
  {
    id: rowId(),
    datasetId: datasetId(),
    aic: text().notNull(),
    name: text(),
    pack: text(),
    activeIngredient: text(),
    atc: text(),
    form: text(),
    supplyRegime: text(),
  },
  (t) => [index().on(t.datasetId, t.aic)],
);

export const refDrugClass = pgTable(
  'ref_drug_class',
  {
    id: rowId(),
    datasetId: datasetId(),
    aic: text().notNull(),
    drugClass: text().notNull(),
    activeIngredient: text(),
    price: numeric({ precision: 12, scale: 2 }),
    equivalenceGroup: text(),
    aifaNote: text(),
  },
  (t) => [index().on(t.datasetId, t.aic), index().on(t.datasetId, t.equivalenceGroup)],
);

export const refDpcDrug = pgTable(
  'ref_dpc_drug',
  {
    id: rowId(),
    datasetId: datasetId(),
    activeIngredient: text().notNull(),
    atc: text(),
    aifaNote: text(),
    planRequired: boolean(),
  },
  (t) => [index().on(t.datasetId)],
);

export const refMunicipality = pgTable(
  'ref_municipality',
  {
    id: rowId(),
    datasetId: datasetId(),
    istatCode: text().notNull(),
    name: text().notNull(),
    region: text(),
    provinceAbbr: text(),
    cadastralCode: text().notNull(),
  },
  (t) => [index().on(t.datasetId, t.cadastralCode)],
);

export const refService = pgTable(
  'ref_service',
  {
    id: rowId(),
    datasetId: datasetId(),
    regionalCode: text().notNull(),
    nationalCode: text(),
    description: text().notNull(),
    branch: text(),
    fee: numeric({ precision: 12, scale: 2 }),
    notes: text(),
  },
  (t) => [index().on(t.datasetId, t.regionalCode)],
);

export const refExemption = pgTable(
  'ref_exemption',
  {
    id: rowId(),
    datasetId: datasetId(),
    code: text().notNull(),
    description: text().notNull(),
  },
  (t) => [index().on(t.datasetId, t.code)],
);

export const refExemptionService = pgTable(
  'ref_exemption_service',
  {
    id: rowId(),
    datasetId: datasetId(),
    exemptionCode: text().notNull(),
    serviceCode: text().notNull(),
  },
  (t) => [index().on(t.datasetId, t.exemptionCode)],
);

/** Tabella dei dati di ogni tipo di banca dati. */
export const REFERENCE_TABLES = {
  farmaci: refDrug,
  farmaci_classe: refDrugClass,
  farmaci_dpc: refDpcDrug,
  comuni: refMunicipality,
  prestazioni: refService,
  esenzioni: refExemption,
  esenzioni_prestazioni: refExemptionService,
} as const;
