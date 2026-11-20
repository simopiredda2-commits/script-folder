/**
 * Voci cliniche scritte dall'interfaccia (tappa 9), dal paragrafo «Cartella del paziente» di
 * docs/requisiti.md: problemi e diagnosi, allergie e reazioni avverse, diario clinico, parametri,
 * anamnesi, stili di vita e fattori di rischio, esame obiettivo e valutazioni. Dalla tappa 15
 * anche vaccinazioni ed esami di laboratorio, che si scrivono a mano e arrivano dall'importazione.
 *
 * Solo controlli formali (regola 3): nessun giudizio sui valori, nessun calcolo clinico (R12).
 * Le voci non si cancellano: si annullano con un motivo, e lo storico resta.
 */

/** Tipi di voce che si scrivono dalla cartella, con il nome usato dall'interfaccia. */
export const ENTRY_TYPES = [
  'problema',
  'diario',
  'misura',
  'anamnesi',
  'allergia',
  'stile_di_vita',
  'esame_obiettivo',
  'capacita_motoria',
  'vaccinazione',
  'esame_laboratorio',
] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

/** Tipo della voce nel database (`clinical_entry.kind`). */
export const ENTRY_KIND = {
  problema: 'problem',
  diario: 'diary',
  misura: 'measurement',
  anamnesi: 'anamnesis',
  allergia: 'allergy',
  stile_di_vita: 'risk_factor',
  esame_obiettivo: 'examination',
  capacita_motoria: 'functional_status',
  vaccinazione: 'vaccination',
  esame_laboratorio: 'lab_result',
} as const satisfies Record<EntryType, string>;
export type EntryKind = (typeof ENTRY_KIND)[EntryType];

/** Il tipo dell'interfaccia dal tipo del database; undefined per le voci di altre tappe. */
export function entryTypeOf(kind: string): EntryType | undefined {
  return ENTRY_TYPES.find((t) => ENTRY_KIND[t] === kind);
}

export const ENTRY_TYPE_LABELS: Record<EntryType, string> = {
  problema: 'Problema o diagnosi',
  diario: 'Nota del diario clinico',
  misura: 'Parametro',
  anamnesi: 'Anamnesi',
  allergia: 'Allergia o reazione avversa',
  stile_di_vita: 'Stile di vita o fattore di rischio',
  esame_obiettivo: 'Esame obiettivo o valutazione',
  capacita_motoria: 'Capacità motoria',
  vaccinazione: 'Vaccinazione',
  esame_laboratorio: 'Esame di laboratorio',
};

/** Tipo di contatto del diario: studio, domicilio, telefono, televisita. */
export const CONTACT_TYPES = ['studio', 'domicilio', 'telefono', 'televisita'] as const;
export type ContactType = (typeof CONTACT_TYPES)[number];
export const CONTACT_KIND = {
  studio: 'office',
  domicilio: 'home',
  telefono: 'phone',
  televisita: 'televisit',
} as const satisfies Record<ContactType, string>;
export const CONTACT_LABELS: Record<ContactType, string> = {
  studio: 'In studio',
  domicilio: 'A domicilio',
  telefono: 'Al telefono',
  televisita: 'Televisita',
};

/** Sezioni dell'anamnesi: familiare, fisiologica, patologica remota, gravidanze. */
export const ANAMNESIS_SECTIONS = [
  'familiare',
  'fisiologica',
  'patologica_remota',
  'gravidanze',
] as const;
export type AnamnesisSection = (typeof ANAMNESIS_SECTIONS)[number];
export const ANAMNESIS_KIND = {
  familiare: 'family',
  fisiologica: 'physiological',
  patologica_remota: 'remote_pathological',
  gravidanze: 'pregnancies',
} as const satisfies Record<AnamnesisSection, string>;
export const ANAMNESIS_LABELS: Record<AnamnesisSection, string> = {
  familiare: 'Familiare',
  fisiologica: 'Fisiologica',
  patologica_remota: 'Patologica remota',
  gravidanze: 'Gravidanze',
};

/** Dal valore del database alla chiave dell'interfaccia. */
export function keyOf<K extends string, V extends string>(
  map: Record<K, V>,
  value: string,
): K | undefined {
  return (Object.keys(map) as K[]).find((k) => map[k] === value);
}

export interface MeasureDefinition {
  key: string;
  label: string;
  unit: string;
  /** Limite fisico del valore, se c'è (una percentuale non supera 100). */
  max?: number;
}

/**
 * I parametri dei requisiti («Parametri e misure»: pressione, peso, altezza, BMI, glicemia,
 * saturazione), con l'unità in cui si scrivono. La pressione ha due valori. Il BMI si scrive
 * come valore misurato: il programma non lo calcola, perché i calcoli clinici restano fuori dalla
 * prima versione (requisiti, R12; scelta di oggi confermata alla fermata dopo la tappa 15, D181).
 */
export const MEASURES = [
  { key: 'pressione_sistolica', label: 'Pressione sistolica', unit: 'mmHg' },
  { key: 'pressione_diastolica', label: 'Pressione diastolica', unit: 'mmHg' },
  { key: 'peso', label: 'Peso', unit: 'kg' },
  { key: 'altezza', label: 'Altezza', unit: 'cm' },
  { key: 'bmi', label: 'BMI', unit: 'kg/m²' },
  { key: 'glicemia', label: 'Glicemia', unit: 'mg/dL' },
  { key: 'saturazione', label: 'Saturazione', unit: '%', max: 100 },
] as const satisfies readonly MeasureDefinition[];
export type MeasureKey = (typeof MEASURES)[number]['key'];
export const MEASURE_KEYS = MEASURES.map((m) => m.key) as [MeasureKey, ...MeasureKey[]];

export function measureByKey(key: string): MeasureDefinition | undefined {
  return MEASURES.find((m) => m.key === key);
}

/** Fattori proposti dai requisiti («Stili di vita e fattori di rischio»); si può scriverne altri. */
export const LIFESTYLE_FACTORS = ['Fumo', 'Alcol', 'Attività fisica'] as const;

/**
 * Valore di un parametro scritto a mano: numero positivo, con la virgola o il punto, al più
 * due decimali. Restituisce il numero come testo con il punto, o un messaggio d'errore.
 */
export function parseMeasureValue(
  raw: string,
  def: MeasureDefinition,
): { value: string } | { error: string } {
  const text = raw.trim().replace(',', '.');
  if (!/^\d{1,4}(?:\.\d{1,2})?$/.test(text))
    return { error: `${def.label}: scrivi un numero, al più con due decimali` };
  const n = Number(text);
  if (n <= 0) return { error: `${def.label}: il valore dev’essere maggiore di zero` };
  if (def.max !== undefined && n > def.max)
    return { error: `${def.label}: il valore non può superare ${def.max} ${def.unit}` };
  return { value: String(n) };
}

/** Problema: stato con le date, come nei requisiti («attivi o risolti, con date»). */
export interface ProblemDates {
  state: 'attivo' | 'risolto';
  onsetOn?: string | null;
  resolvedOn?: string | null;
}

/** Messaggi sulle date di un problema; vuoto se va bene. */
export function checkProblemDates(p: ProblemDates, today: string): string[] {
  const out: string[] = [];
  if (p.onsetOn && p.onsetOn > today) out.push('Inizio del problema: la data è nel futuro');
  if (p.state === 'risolto' && !p.resolvedOn)
    out.push('Problema risolto: manca la data di risoluzione');
  if (p.state === 'attivo' && p.resolvedOn)
    out.push('Problema attivo: la data di risoluzione va solo sui problemi risolti');
  if (p.resolvedOn && p.resolvedOn > today) out.push('Risoluzione: la data è nel futuro');
  if (p.onsetOn && p.resolvedOn && p.resolvedOn < p.onsetOn)
    out.push('La risoluzione non può venire prima dell’inizio');
  return out;
}

/* Vaccinazioni (tappa 15) ------------------------------------------------------------------- */

/**
 * Numero della dose: limite tecnico a due cifre, non una regola clinica. Il vaccino si scrive con
 * il suo nome: un elenco ufficiale dei vaccini non è ancora tra le banche dati (fonte da
 * individuare), quindi il nome è libero e non si controlla.
 */
export const VACCINE_DOSE_MAX = 99;

/* Esami di laboratorio (tappa 15) ----------------------------------------------------------- */

/**
 * Risultati di un referto scritti insieme: limite tecnico per una richiesta sola. Un referto
 * completo ha qualche decina di esami; oltre, si registra in più volte.
 */
export const LAB_RESULTS_MAX = 100;

/**
 * Estremo dell'intervallo di riferimento come lo stampa il laboratorio: un numero, con il segno
 * se serve (alcuni intervalli sono negativi), la virgola o il punto. Un intervallo scritto in
 * altro modo («< 200», «negativo») va nel testo.
 */
const LAB_BOUND = /^[-+]?\d+(?:[.,]\d+)*$/;
/** Con un separatore solo il numero si legge senza dubbi (la virgola o il punto come decimali). */
const LAB_BOUND_SIMPLE = /^[-+]?\d+(?:[.,]\d+)?$/;

/** Intervallo di riferimento di un esame: minimo e massimo, o il testo stampato sul referto. */
export interface LabReference {
  minimo?: string | null;
  massimo?: string | null;
}

/**
 * Controlli formali sull'intervallo di riferimento: minimo e massimo sono numeri e il minimo non
 * supera il massimo. Il valore dell'esame non si confronta con l'intervallo (regola 3, D71): il
 * confronto automatico va prima validato con il consulente regolatorio.
 */
export function checkLabReference(r: LabReference): string[] {
  const out: string[] = [];
  const min = r.minimo?.trim() || null;
  const max = r.massimo?.trim() || null;
  if (min && !LAB_BOUND.test(min))
    out.push(
      'Minimo dell’intervallo: scrivi un numero; un intervallo scritto in altro modo va nel testo',
    );
  if (max && !LAB_BOUND.test(max))
    out.push(
      'Massimo dell’intervallo: scrivi un numero; un intervallo scritto in altro modo va nel testo',
    );
  if (min && max && LAB_BOUND_SIMPLE.test(min) && LAB_BOUND_SIMPLE.test(max)) {
    const n = (s: string) => Number(s.replace(',', '.'));
    if (n(min) > n(max)) out.push('Intervallo: il minimo è più grande del massimo');
  }
  return out;
}
