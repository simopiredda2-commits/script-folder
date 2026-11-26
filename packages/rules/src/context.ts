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
  /**
   * La classe negli elenchi AIFA di classe A e H in vigore (R8, D261): `null` se gli elenchi in
   * vigore non hanno la confezione; assente se nessun elenco è in vigore. `null` non vuol dire «non
   * a carico del SSN» (D59): la R8 informa, non blocca.
   */
  listedClass?: string | null;
  /** Antibiotico iniettabile o soluzione per infusione (R3). */
  injectableAntibioticOrInfusion?: boolean;
  /** Unità posologiche per confezione (R4, R11). */
  unitsPerPack?: number;
  /**
   * L'unità di `unitsPerPack` quando viene dalla descrizione AIFA della confezione (D252), per
   * esempio «compressa»: conta solo con una posologia nella stessa unità.
   */
  packUnit?: string;
  /** Carenza secondo l'elenco AIFA dei farmaci carenti in vigore (R21); assente se non c'è. */
  shortage?: ShortageFacts;
  /**
   * Confezione «Sospesa» secondo l'anagrafica AIFA delle confezioni in vigore (R22, D210). Assente
   * se l'anagrafica non lo dice: la confezione «Autorizzata» o non trovata non è «sospesa».
   */
  suspended?: boolean;
  /**
   * Regime di fornitura AIFA «prescrizione medica speciale con Ricetta Ministeriale a Ricalco»:
   * stupefacente della sezione A della tabella dei medicinali (R23, D272). Assente se l'anagrafica
   * non lo dice.
   */
  ministerialPad?: boolean;
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
  /** Numero della nota del nomenclatore scritto sulla riga (numeroNota; R24, D276). */
  serviceNote?: string | null;
  /** Lettera della condizione o dell'indicazione della nota, se scelta (D276). */
  serviceNoteLetter?: string | null;
  /** Sedute del ciclo (numsedute; R10, D276). */
  sessions?: number | null;
  quantity: number;
  aifaNote: string | null;
  notSubstitutable: boolean;
  notSubstitutableReason: string | null;
  /**
   * Codice della motivazione di non sostituibilità (codMotivazione, e Prescrizione1 nella ricetta
   * rossa): uno di quelli delle linee guida del Sistema TS, nei dati di R13 (D273).
   */
  notSubstitutableCode?: string | null;
  /** «Per principio attivo»: in ricetta va il gruppo di equivalenza, non l'AIC (caso A1). */
  byActiveIngredient?: boolean;
  /** Posologia scritta nella riga: per gli stupefacenti va nella ricetta (R23, nota STUP). */
  posologyText?: string | null;
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

/** Una voce del catalogo regionale delle prestazioni in uso (R10, R18, R25; D154, D276). */
export interface ServiceCatalogEntry {
  nationalCode: string | null;
  /** La descrizione del catalogo: per le tabelle RAO, dove un codice vale per più discipline (D285). */
  description?: string;
  /** Le branche del codice nel catalogo: una voce può stare in più branche (R25). */
  branches?: readonly string[];
  /** Prestazione a ciclo di sedute (R10). */
  cycle?: boolean;
  /** Le sedute al più del ciclo (R10). */
  sessions?: number | null;
}

/** La nota del nomenclatore di un codice (DPCM LEA, allegati 4 e 4D; R24, D276). */
export interface ServiceNoteFacts {
  note: string;
  kind: 'condizione' | 'appropriatezza';
  text: string;
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
  serviceCatalog?: (code: string) => ServiceCatalogEntry | null;
  /**
   * Note del nomenclatore in vigore alla data (R24): la nota del codice del nomenclatore, o null se
   * non ne ha. Assente se l'elenco delle note non è in uso.
   */
  serviceNotes?: (nationalCode: string) => ServiceNoteFacts | null;
  /** Righe per cui il medico conferma che il paziente rientra nella nota AIFA (R7). */
  confirmedAifaNotes: ReadonlySet<string>;
  /** Motivi dati dal medico per procedere nonostante un avviso, per regola. */
  reasons: Readonly<Record<string, string>>;
  /**
   * Telefono del medico per le note della ricetta degli stupefacenti (R23, nota STUP): quello del
   * medico o, se manca, dello studio. Assente se non si sa: la R23 non lo chiede.
   */
  doctorPhone?: string | null;
}
