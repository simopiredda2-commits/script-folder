/**
 * Tutto ciò che le regole guardano. Il servizio applicativo lo costruisce dal database; le prove
 * lo scrivono a mano. Le date sono AAAA-MM-GG.
 */

/** Fatti del farmaco dalla banca dati (tappa 5). Assenti = non noti: la regola lo dice. */
export interface DrugFacts {
  /** Il farmaco richiede un piano terapeutico (R5). */
  requiresPlan?: boolean;
  /** Nota AIFA collegata al farmaco (R7). */
  aifaNote?: string | null;
  /** A carico del SSN (classe A o H dispensabile) (R8). */
  reimbursableSsn?: boolean;
  /** Prescrivibile dal medico di medicina generale (R8). */
  mmgPrescribable?: boolean;
  /** Antibiotico iniettabile o soluzione per infusione (R3). */
  injectableAntibioticOrInfusion?: boolean;
  /** Unità posologiche per confezione (R4, R11). */
  unitsPerPack?: number;
  /** Carenza secondo l'elenco AIFA dei farmaci carenti in vigore (R21); assente se non c'è. */
  shortage?: ShortageFacts;
}

/** Una carenza come la dice l'elenco AIFA dei farmaci carenti (D202). */
export interface ShortageFacts {
  /** Data di inizio della carenza; può essere dopo la data della ricetta (carenza prevista). */
  since: string | null;
  /** «Fine presunta» dell'elenco. */
  expectedEnd: string | null;
  /** Colonna «Equivalente» dell'elenco: sì, no, o non detto. */
  equivalentAvailable: boolean | null;
  /** «Motivazioni» dell'elenco. */
  reason: string | null;
}

export interface TherapyContext {
  id: string;
  kind: 'chronic' | 'as_needed' | 'cycle';
  startOn: string;
  /** Unità al giorno della posologia, se scritte come numero. */
  unitsPerDay: number | null;
  /** Opzione «Multiprescrizione» della scheda della terapia. */
  multiPrescription: boolean;
  therapeuticPlanId: string | null;
}

export interface LineContext {
  id: string;
  drugAic: string | null;
  drugName: string | null;
  activeIngredient: string | null;
  /** Codice del catalogo regionale (codCatalogoPrescr). */
  serviceCode: string | null;
  /** Codice del nomenclatore («codice DM», codProdPrest), se scritto sulla riga. */
  serviceNationalCode?: string | null;
  quantity: number;
  aifaNote: string | null;
  notSubstitutable: boolean;
  notSubstitutableReason: string | null;
  therapy: TherapyContext | null;
}

export interface PlanContext {
  id: string;
  drugAic: string | null;
  activeIngredient: string | null;
  grantedOn: string;
  expiresOn: string;
  packsAuthorized: number | null;
}

/** Riga di una ricetta già inviata, per il contatore (R11) e i piani (R6). */
export interface SentLineContext {
  therapyId: string | null;
  drugAic: string | null;
  activeIngredient: string | null;
  /** Confezioni. Null solo per una ricetta fatta con un altro programma che non le dice. */
  quantity: number | null;
  sentOn: string;
  /**
   * Ricetta fatta con un altro programma e importata (D176): non è collegata a una terapia.
   * R6 e R11 la contano dalle versioni delle regole che lo dicono (D181).
   */
  otherProgram?: { name: string | null };
}

export interface RuleContext {
  /** Data di compilazione della ricetta. */
  date: string;
  prescription: {
    id: string;
    kind: 'pharma_ssn' | 'specialist_ssn' | 'white' | 'devices';
    exemptionCode: string | null;
    priority: string | null;
    accessType: 'first' | 'subsequent' | null;
    diagnosticQuestion: string | null;
    reminderChannel: string | null;
    reminderContact: string | null;
    lines: LineContext[];
  };
  patient: {
    fiscalCode: string;
    email: string | null;
    phone: string | null;
    reminderChannel: string | null;
    reminderContact: string | null;
    reminderChannelChosenOn: string | null;
    /** Stato nella cartella (R19, R20; D199). Assente nelle prove che non lo guardano. */
    status?: 'active' | 'revoked' | 'deceased' | 'temporary';
    /** Data del decesso, se il paziente risulta deceduto. */
    deceasedOn?: string | null;
  };
  /**
   * Scelte del medico del paziente, non annullate, a mano o da AURA (R20; D199): conta se ce n'è una
   * in corso alla data della ricetta.
   */
  choices?: { chosenOn: string; expiresOn: string | null; endedOn: string | null }[];
  exemptions: { code: string; validFrom: string; validTo: string | null }[];
  delegations: {
    email: string | null;
    phone: string | null;
    validFrom: string;
    validTo: string | null;
    revokedOn: string | null;
  }[];
  plans: PlanContext[];
  sentLines: SentLineContext[];
  /** Banca dati farmaci; restituisce undefined se il farmaco non è noto. */
  drugFacts: (aic: string | null) => DrugFacts | undefined;
  /** Catalogo delle esenzioni (tappa 5); undefined se il catalogo non c'è. */
  exemptionExists?: (code: string) => boolean | undefined;
  /** Elenco regionale esenzione → prestazioni (R17); undefined se non noto. */
  exemptionServices?: (code: string) => ReadonlySet<string> | undefined;
  /**
   * Catalogo regionale delle prestazioni in uso alla data (R10, R18): la voce del codice, o null se
   * il codice non c'è. Assente se nessun catalogo è importato.
   */
  serviceCatalog?: (code: string) => { nationalCode: string | null } | null;
  /** Righe per cui il medico conferma che il paziente rientra nella nota AIFA (R7). */
  confirmedAifaNotes: ReadonlySet<string>;
  /** Motivi dati dal medico per procedere nonostante un avviso, per regola. */
  reasons: Readonly<Record<string, string>>;
}
