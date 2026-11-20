import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
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
    /** Ditta titolare dell'AIC (D151). */
    holder: text(),
    /** Stato amministrativo della confezione, come lo scrive AIFA («Autorizzata», «Sospesa»; D205). */
    adminState: text(),
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

/**
 * Lista di trasparenza AIFA (D202): prezzo di riferimento del SSN, prezzo al pubblico e
 * differenza per confezione. `remark` è la colonna «Nota» del file: un'annotazione in parole.
 */
export const refDrugTransparency = pgTable(
  'ref_drug_transparency',
  {
    id: rowId(),
    datasetId: datasetId(),
    aic: text().notNull(),
    activeIngredient: text(),
    referencePack: text(),
    atc: text(),
    name: text(),
    pack: text(),
    holder: text(),
    referencePrice: numeric({ precision: 12, scale: 2 }),
    publicPrice: numeric({ precision: 12, scale: 2 }),
    priceDifference: numeric({ precision: 12, scale: 2 }),
    remark: text(),
    equivalenceGroup: text(),
  },
  (t) => [index().on(t.datasetId, t.aic), index().on(t.datasetId, t.equivalenceGroup)],
);

/** Farmaci carenti (AIFA, D202): da quando, fine presunta, motivazione e indicazioni dell'AIFA. */
export const refDrugShortage = pgTable(
  'ref_drug_shortage',
  {
    id: rowId(),
    datasetId: datasetId(),
    aic: text().notNull(),
    name: text(),
    activeIngredient: text(),
    formStrength: text(),
    holder: text(),
    startOn: date(),
    expectedEndOn: date(),
    equivalentAvailable: boolean(),
    reason: text(),
    aifaAdvice: text(),
    aifaNote: text(),
    reimbursementClass: text(),
    atc: text(),
  },
  (t) => [index().on(t.datasetId, t.aic)],
);

/**
 * Registri di monitoraggio e piani terapeutici AIFA attivi (D206): una riga per farmaco e
 * indicazione, senza AIC. Si collegano ai farmaci per ATC.
 */
export const refDrugRegistry = pgTable(
  'ref_drug_registry',
  {
    id: rowId(),
    datasetId: datasetId(),
    name: text().notNull(),
    activeIngredient: text(),
    atc: text(),
    reimbursedIndication: text(),
    condition: text(),
    monitoringType: text(),
    monitoringState: text(),
    therapeuticArea: text(),
    monitoringStart: date(),
    sheetUrl: text(),
  },
  (t) => [index().on(t.datasetId, t.atc)],
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

/**
 * Diagnosi ICD-9-CM (D186): codice, titolo, padre (la gerarchia), termini inclusi, note di inclusione
 * ed esclusione, capitolo e sezione. Un codice con sottocodici è una categoria.
 */
export const refDiagnosis = pgTable(
  'ref_diagnosis',
  {
    id: rowId(),
    datasetId: datasetId(),
    code: text().notNull(),
    description: text().notNull(),
    parentCode: text(),
    includedTerms: text(),
    notes: text(),
    chapter: text(),
    section: text(),
  },
  (t) => [index().on(t.datasetId, t.code)],
);

/** Tabella dei dati di ogni tipo di banca dati. */
export const REFERENCE_TABLES = {
  farmaci: refDrug,
  farmaci_classe: refDrugClass,
  farmaci_dpc: refDpcDrug,
  farmaci_trasparenza: refDrugTransparency,
  farmaci_carenti: refDrugShortage,
  registri_aifa: refDrugRegistry,
  comuni: refMunicipality,
  prestazioni: refService,
  esenzioni: refExemption,
  esenzioni_prestazioni: refExemptionService,
  diagnosi: refDiagnosis,
} as const;

/**
 * Ogni aggiornamento delle banche dati (D156): sync, poi l'importazione con i suoi controlli. Il
 * registro dice quando, chi l'ha avviato, com'è andata e che cosa va controllato a mano; le
 * schermate ne ricavano se una versione in uso è più vecchia del previsto (A6).
 */
export const referenceUpdateRun = pgTable(
  'reference_update_run',
  {
    id: uuid().primaryKey().defaultRandom(),
    /** «comando» (riga di comando), «automatico» (ogni notte) o «pulsante» (dagli strumenti). */
    trigger: text().notNull(),
    requestedBy: text().notNull(),
    startedAt: timestamp({ withTimezone: true }).notNull(),
    finishedAt: timestamp({ withTimezone: true }),
    /** Vero finché l'aggiornamento è in corso, poi vuoto: ne gira uno solo alla volta. */
    running: boolean(),
    /** «ok», «da_verificare», «errore» o «interrotto». */
    outcome: text(),
    syncExitCode: integer(),
    /** Il rapporto di sync in JSON (ultimo-rapporto.json di quel giro). */
    syncReport: jsonb(),
    /** Il rapporto dell'importazione, file per file. */
    importReport: jsonb(),
    /** Stato di ogni serie in uso alla fine del giro: controllata, in attesa, da trascrivere. */
    seriesStatus: jsonb(),
    /** Che cosa è andato storto prima o fuori dai rapporti (sync che non parte, lucchetto). */
    message: text(),
    /** Ultima parte dell'output di sync, per chi deve capire un errore. */
    output: text(),
  },
  (t) => [unique().on(t.running), index().on(t.startedAt)],
);
