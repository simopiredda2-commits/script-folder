/**
 * Modelli dei certificati (tappa 13, D143): testo fisso con dei segnaposto. I dati del paziente e
 * del medico li mette il programma; i campi del modello li scrive il medico al rilascio. I modelli
 * ufficiali hanno il testo dell'atto, con la fonte; quelli dello studio li scrive il medico. Il
 * programma non decide niente di clinico: ogni dichiarazione è del medico (regola 3).
 */

/** Dati del paziente che il programma mette da solo, dalla cartella. */
export const PATIENT_PLACEHOLDERS = {
  cognome: 'Cognome',
  nome: 'Nome',
  sesso: 'Sesso',
  nato_a: 'Comune di nascita',
  nato_il: 'Data di nascita',
  codice_fiscale: 'Codice fiscale',
  residenza: 'Residenza',
} as const;
export type PatientPlaceholder = keyof typeof PATIENT_PLACEHOLDERS;

/** Dati del medico che firma, dal suo profilo. */
export const DOCTOR_PLACEHOLDERS = {
  nome_cognome: 'Nome e cognome del medico',
  codice_fiscale: 'Codice fiscale del medico',
  codice_regionale: 'Codice regionale del medico',
} as const;
export type DoctorPlaceholder = keyof typeof DOCTOR_PLACEHOLDERS;

/** Dati del rilascio. */
export const ISSUE_PLACEHOLDERS = {
  luogo: 'Luogo del rilascio',
  data: 'Data del rilascio',
} as const;
export type IssuePlaceholder = keyof typeof ISSUE_PLACEHOLDERS;

export const TEMPLATE_FIELD_TYPES = ['testo', 'testo_lungo', 'data', 'scelta', 'numero'] as const;
export type TemplateFieldType = (typeof TEMPLATE_FIELD_TYPES)[number];

/** Un campo che il medico compila al rilascio: nel testo è `{{campo.chiave}}`. */
export interface TemplateField {
  key: string;
  label: string;
  type: TemplateFieldType;
  required: boolean;
  /** Valori ammessi, per il tipo «scelta». */
  options?: string[];
  /** Spiegazione sotto il campo. */
  help?: string;
  /** Lunghezza massima del testo. */
  max?: number;
}

/** La fonte di un modello ufficiale. */
export interface TemplateSource {
  /** Atto, con articolo o allegato: «DM Salute 24/4/2013, allegato C». */
  act: string;
  /** Pubblicazione: «GU n. 169 del 20/7/2013». */
  publication?: string;
  url: string;
  /** Quando il testo è stato confrontato con la fonte (AAAA-MM-GG). */
  checkedOn: string;
  note?: string;
}

export interface CertificateTemplate {
  /** Chiave stabile: lettere minuscole, cifre e trattini. */
  key: string;
  title: string;
  /** Versione: la data dell'atto da cui viene il testo (AAAA-MM-GG). */
  version: string;
  /** I modelli ufficiali hanno la fonte; quelli dello studio no. */
  official: boolean;
  source: TemplateSource | null;
  /** Validità del certificato in mesi, se l'atto la fissa. */
  validityMonths: number | null;
  /** Note per il medico, non stampate: che cosa chiede l'atto prima del rilascio. */
  forDoctor: string[];
  fields: TemplateField[];
  /** Paragrafi del testo, con i segnaposto. */
  body: string[];
  /** Riga sotto lo spazio della firma. */
  signature: string;
}

/** I segnaposto di un testo: `{{paziente.cognome}}`, `{{campo.data_ecg}}`. */
const PLACEHOLDER = /\{\{\s*([a-z]+)\.([a-z0-9_]+)\s*\}\}/g;

export function placeholdersOf(text: string): { group: string; key: string }[] {
  return [...text.matchAll(PLACEHOLDER)].map((m) => ({ group: m[1]!, key: m[2]! }));
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const KEY = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const FIELD_KEY = /^[a-z][a-z0-9_]*$/;

/** Che cosa non va in un modello; vuoto se è usabile. */
export function templateIssues(t: CertificateTemplate): string[] {
  const out: string[] = [];
  // La chiave dei modelli dello studio la genera il programma; quella degli ufficiali è il nome del file.
  if (t.official && !KEY.test(t.key)) out.push(`Chiave del modello non valida: «${t.key}»`);
  if (!t.title.trim()) out.push('Il modello non ha un titolo');
  if (!ISO_DATE.test(t.version)) out.push('Versione del modello: serve la data AAAA-MM-GG');
  if (!t.body.length || t.body.some((p) => !p.trim())) out.push('Il testo ha paragrafi vuoti');
  if (t.official) {
    if (!t.source) out.push('Un modello ufficiale ha sempre la sua fonte');
    else {
      if (!t.source.act.trim()) out.push('Fonte: manca l’atto');
      if (!/^https:\/\//.test(t.source.url)) out.push('Fonte: serve l’indirizzo https dell’atto');
      if (!ISO_DATE.test(t.source.checkedOn))
        out.push('Fonte: manca la data del confronto con il testo');
    }
  }
  const keys = new Set<string>();
  for (const f of t.fields) {
    if (!FIELD_KEY.test(f.key)) out.push(`Campo con una chiave non valida: «${f.key}»`);
    if (keys.has(f.key)) out.push(`Campo ripetuto: «${f.key}»`);
    keys.add(f.key);
    if (f.type === 'scelta' && !f.options?.length)
      out.push(`Campo «${f.label}»: una scelta ha bisogno delle opzioni`);
  }
  const used = new Set<string>();
  for (const p of t.body.flatMap(placeholdersOf)) {
    if (p.group === 'campo') {
      used.add(p.key);
      if (!keys.has(p.key)) out.push(`Segnaposto di un campo che non c'è: {{campo.${p.key}}}`);
    } else if (
      !(p.group === 'paziente' && p.key in PATIENT_PLACEHOLDERS) &&
      !(p.group === 'medico' && p.key in DOCTOR_PLACEHOLDERS) &&
      !(p.group === 'rilascio' && p.key in ISSUE_PLACEHOLDERS)
    )
      out.push(`Segnaposto sconosciuto: {{${p.group}.${p.key}}}`);
  }
  for (const k of keys)
    if (!used.has(k)) out.push(`Campo «${k}» dichiarato ma non usato nel testo`);
  return out;
}

/** Che cosa manca o non va nei valori dei campi; vuoto se vanno bene. */
export function fieldIssues(t: CertificateTemplate, values: Record<string, string>): string[] {
  const out: string[] = [];
  for (const f of t.fields) {
    const v = (values[f.key] ?? '').trim();
    if (!v) {
      if (f.required) out.push(`${f.label}: da compilare`);
      continue;
    }
    if (f.max && v.length > f.max) out.push(`${f.label}: al massimo ${f.max} caratteri`);
    if (f.type === 'data' && !ISO_DATE.test(v)) out.push(`${f.label}: non è una data`);
    if (f.type === 'numero' && !/^\d+([.,]\d+)?$/.test(v)) out.push(`${f.label}: non è un numero`);
    if (f.type === 'scelta' && !f.options?.includes(v))
      out.push(`${f.label}: scegli uno dei valori proposti`);
  }
  for (const k of Object.keys(values))
    if (!t.fields.some((f) => f.key === k)) out.push(`Campo sconosciuto: «${k}»`);
  return out;
}

export interface TemplateContext {
  patient: Record<PatientPlaceholder, string>;
  doctor: Record<DoctorPlaceholder, string>;
  issue: Record<IssuePlaceholder, string>;
}

/** Data come la scrive un medico italiano: 2026-11-18 → 18/11/2026. */
export const italianDate = (iso: string) =>
  ISO_DATE.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : iso;

/** I dati della cartella o del profilo che servono al testo e mancano. */
export function missingData(t: CertificateTemplate, ctx: TemplateContext): string[] {
  const out = new Set<string>();
  for (const p of t.body.flatMap(placeholdersOf)) {
    if (p.group === 'paziente' && !ctx.patient[p.key as PatientPlaceholder]?.trim())
      out.add(`Paziente: manca ${PATIENT_PLACEHOLDERS[p.key as PatientPlaceholder].toLowerCase()}`);
    if (p.group === 'medico' && !ctx.doctor[p.key as DoctorPlaceholder]?.trim())
      out.add(`Medico: manca ${DOCTOR_PLACEHOLDERS[p.key as DoctorPlaceholder].toLowerCase()}`);
    if (p.group === 'rilascio' && !ctx.issue[p.key as IssuePlaceholder]?.trim())
      out.add(`Rilascio: manca ${ISSUE_PLACEHOLDERS[p.key as IssuePlaceholder].toLowerCase()}`);
  }
  return [...out];
}

/**
 * Il testo del certificato, con i segnaposto sostituiti. Le date dei campi si scrivono in italiano.
 * Si chiama dopo aver controllato i valori (`fieldIssues`) e i dati (`missingData`).
 */
export function fillTemplate(
  t: CertificateTemplate,
  ctx: TemplateContext,
  values: Record<string, string>,
): { title: string; paragraphs: string[] } {
  const field = new Map(t.fields.map((f) => [f.key, f]));
  const value = (group: string, key: string): string => {
    if (group === 'paziente') return ctx.patient[key as PatientPlaceholder] ?? '';
    if (group === 'medico') return ctx.doctor[key as DoctorPlaceholder] ?? '';
    if (group === 'rilascio') return ctx.issue[key as IssuePlaceholder] ?? '';
    const v = (values[key] ?? '').trim();
    return field.get(key)?.type === 'data' ? italianDate(v) : v;
  };
  return {
    title: t.title,
    paragraphs: t.body.map((p) =>
      p.replace(PLACEHOLDER, (_m, group: string, key: string) => value(group, key)),
    ),
  };
}

/* Impaginazione scelta dal medico -------------------------------------------------------------- */

/** Caratteri dei documenti stampati: i caratteri standard del PDF, senza licenze da rispettare. */
export const PRINT_FONTS = {
  sans: 'Senza grazie (Helvetica)',
  serif: 'Con grazie (Times)',
  mono: 'A spaziatura fissa (Courier)',
} as const;
export type PrintFont = keyof typeof PRINT_FONTS;

export const PRINT_LIMITS = {
  fontSize: { min: 9, max: 14 },
  marginMm: { min: 10, max: 40 },
  headerLines: 6,
  headerLineLength: 100,
} as const;

export interface PrintLayout {
  font: PrintFont;
  fontSize: number;
  /** Intestazione: righe in alto, una per riga. */
  header: string[];
  headerAlign: 'left' | 'center';
  marginMm: number;
  /** Luogo proposto per «luogo e data». */
  place: string;
  /** Testo del timbro, stampato sotto lo spazio della firma. */
  stamp: string;
}

export const DEFAULT_PRINT_LAYOUT: PrintLayout = {
  font: 'sans',
  fontSize: 11,
  header: [],
  headerAlign: 'left',
  marginMm: 20,
  place: '',
  stamp: '',
};

/** Che cosa non va in un'impaginazione; vuoto se va bene. */
export function layoutIssues(l: PrintLayout): string[] {
  const out: string[] = [];
  if (!(l.font in PRINT_FONTS)) out.push('Carattere: scegli uno di quelli proposti');
  const { fontSize, marginMm, headerLines, headerLineLength } = PRINT_LIMITS;
  if (!Number.isInteger(l.fontSize) || l.fontSize < fontSize.min || l.fontSize > fontSize.max)
    out.push(`Dimensione del testo: da ${fontSize.min} a ${fontSize.max} punti`);
  if (!Number.isInteger(l.marginMm) || l.marginMm < marginMm.min || l.marginMm > marginMm.max)
    out.push(`Margini: da ${marginMm.min} a ${marginMm.max} mm`);
  if (l.header.length > headerLines) out.push(`Intestazione: al massimo ${headerLines} righe`);
  if (l.header.some((r) => r.length > headerLineLength))
    out.push(`Intestazione: al massimo ${headerLineLength} caratteri per riga`);
  return out;
}
