import { z } from 'zod';

/**
 * Elenchi dello studio (tappa 14): medici suggeritori, posologie, pacchetti di prestazioni,
 * contatti utili, con i campi di ciascun tipo. Li scrivono i medici e l'amministratore
 * (`studio.lists`); li usa tutto lo studio, segreteria compresa: la scheda della terapia
 * (posologie e suggeritori), la ricetta specialistica (pacchetti), i recapiti (contatti).
 *
 * I nomi dei campi sono quelli delle API (italiano); nel database stanno in
 * `studio_list_item.data` (jsonb), controllati qui. Una voce non si cancella: si archivia, perché
 * una terapia o una ricetta può averla usata.
 */

export const STUDIO_LIST_KINDS = [
  { key: 'suggeritore', label: 'Medici suggeritori', item: 'medico suggeritore' },
  { key: 'posologia', label: 'Posologie', item: 'posologia' },
  { key: 'pacchetto', label: 'Pacchetti di prestazioni', item: 'pacchetto di prestazioni' },
  { key: 'contatto', label: 'Contatti utili', item: 'contatto utile' },
] as const;
export type StudioListKind = (typeof STUDIO_LIST_KINDS)[number]['key'];
export const STUDIO_LIST_KIND_KEYS = STUDIO_LIST_KINDS.map((k) => k.key) as [
  StudioListKind,
  ...StudioListKind[],
];

/** Tipi di contatto utile. */
export const CONTACT_KINDS = [
  { key: 'struttura', label: 'Struttura' },
  { key: 'specialista', label: 'Specialista' },
  { key: 'laboratorio', label: 'Laboratorio' },
  { key: 'altro', label: 'Altro' },
] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number]['key'];
export const CONTACT_KIND_KEYS = CONTACT_KINDS.map((k) => k.key) as [ContactKind, ...ContactKind[]];

/**
 * Lunghezze massime e numero di prestazioni di un pacchetto: controlli di buon senso contro gli
 * errori di battitura e i testi incollati per sbaglio, non valori di una norma. I codici del catalogo
 * regionale arrivano a 10 caratteri e le descrizioni a 248 (D.D. 590/2026, allegato A).
 */
export const STUDIO_LIST_LIMITS = {
  name: 120,
  facility: 160,
  specialty: 80,
  phone: 40,
  email: 200,
  address: 200,
  notes: 500,
  posologyText: 200,
  dose: 20,
  posologyPart: 60,
  serviceCode: 20,
  serviceDescription: 300,
  packageServices: 30,
} as const;

const L = STUDIO_LIST_LIMITS;

/** Testo obbligatorio, senza spazi ai bordi, con i messaggi del campo. */
const required = (label: string, max: number) =>
  z
    .string({
      error: (iss) =>
        iss.input === undefined || iss.input === null
          ? `${label}: campo obbligatorio`
          : `${label}: deve essere un testo`,
    })
    .trim()
    .min(1, `${label}: campo obbligatorio`)
    .max(max, `${label}: al massimo ${max} caratteri`);

/** Testo facoltativo: vuoto o assente diventa null. */
const optional = (label: string, max: number) =>
  z
    .string({ error: `${label}: deve essere un testo` })
    .trim()
    .max(max, `${label}: al massimo ${max} caratteri`)
    .nullable()
    .optional()
    .transform((v) => v || null);

const optionalEmail = z
  .string({ error: 'Email: deve essere un testo' })
  .trim()
  .max(L.email, `Email: al massimo ${L.email} caratteri`)
  .refine((v) => v === '' || z.email().safeParse(v).success, 'Email: indirizzo non valido')
  .nullable()
  .optional()
  .transform((v) => v || null);

/** Oggetto senza campi in più, con i messaggi in italiano anche senza la lingua del servizio. */
const record = <T extends z.ZodRawShape>(shape: T) =>
  z.strictObject(shape, {
    error: (iss) =>
      iss.code === 'unrecognized_keys'
        ? `Campi non previsti: ${iss.keys.join(', ')}`
        : iss.code === 'invalid_type'
          ? 'I dati della voce vanno scritti campo per campo'
          : undefined,
  });

/** Codice del catalogo regionale come si confronta: senza spazi ai bordi, in maiuscolo. */
export function normalizeServiceCode(code: string): string {
  return code.trim().toUpperCase();
}

/** Lettere e cifre separate da punti, come i codici del catalogo regionale (89.7, 45.30.1A). */
const SERVICE_CODE = /^[0-9A-Z]+(?:\.[0-9A-Z]+)*$/;

const serviceCode = required('Codice della prestazione', L.serviceCode)
  .transform(normalizeServiceCode)
  .refine(
    (v) => SERVICE_CODE.test(v),
    'Codice della prestazione: lettere e cifre separate da punti, come nel catalogo regionale',
  );

/** Medico suggeritore: lo specialista o il reparto da cui arriva una terapia (ricetta «S»). */
export const suggestorSchema = record({
  nome: required('Nome del medico', L.name),
  struttura: optional('Struttura', L.facility),
  specialita: optional('Specialità', L.specialty),
  telefono: optional('Telefono', L.phone),
});
export type Suggestor = z.output<typeof suggestorSchema>;

/**
 * Posologia dello studio. Il testo è come la legge il paziente; le parti (dose, unità, frequenza,
 * momento, via) sono facoltative e, se ci sono, riempiono gli stessi campi della scheda della
 * terapia, che alimentano il contatore delle confezioni (R11). Una posologia di solo testo serve
 * alle righe della ricetta.
 */
export const posologySchema = record({
  testo: required('Testo della posologia', L.posologyText),
  dose: optional('Dose', L.dose),
  unita: optional('Unità', L.posologyPart),
  frequenza: optional('Frequenza', L.posologyPart),
  momento: optional('Momento', L.posologyPart),
  via: optional('Via', L.posologyPart),
});
export type Posology = z.output<typeof posologySchema>;

/** Le parti della posologia che riempiono la scheda della terapia. */
export const POSOLOGY_PARTS = ['dose', 'unita', 'frequenza', 'momento', 'via'] as const;

export const packageServiceSchema = record({
  codice: serviceCode,
  descrizione: required('Descrizione della prestazione', L.serviceDescription),
});
export type PackageService = z.output<typeof packageServiceSchema>;

/**
 * Pacchetto di prestazioni: un gruppo salvato dallo studio (per esempio il controllo del diabete),
 * prescritto insieme con un clic. Si compone dal catalogo delle prestazioni, non si inventa: il
 * servizio controlla che ogni codice nuovo sia nel catalogo in vigore e ne prende la descrizione.
 */
export const servicePackageSchema = record({
  nome: required('Nome del pacchetto', L.name),
  prestazioni: z
    .array(packageServiceSchema, { error: 'Prestazioni: serve l’elenco delle prestazioni' })
    .min(1, 'Un pacchetto ha almeno una prestazione')
    .max(L.packageServices, `Un pacchetto ha al massimo ${L.packageServices} prestazioni`),
}).superRefine((p, ctx) => {
  const seen = new Set<string>();
  for (const s of p.prestazioni) {
    if (seen.has(s.codice))
      ctx.addIssue({
        code: 'custom',
        path: ['prestazioni'],
        message: `La prestazione ${s.codice} è due volte nel pacchetto`,
      });
    seen.add(s.codice);
  }
});
export type ServicePackage = z.output<typeof servicePackageSchema>;

/** Contatto utile dello studio: strutture, specialisti, laboratori e altri recapiti. */
export const usefulContactSchema = record({
  nome: required('Nome', L.name),
  tipo: z.enum(CONTACT_KIND_KEYS, {
    error: 'Tipo di contatto: struttura, specialista, laboratorio o altro',
  }),
  telefono: optional('Telefono', L.phone),
  email: optionalEmail,
  indirizzo: optional('Indirizzo', L.address),
  note: optional('Note', L.notes),
});
export type UsefulContact = z.output<typeof usefulContactSchema>;

export const STUDIO_LIST_SCHEMAS = {
  suggeritore: suggestorSchema,
  posologia: posologySchema,
  pacchetto: servicePackageSchema,
  contatto: usefulContactSchema,
} as const;

export interface StudioListData {
  suggeritore: Suggestor;
  posologia: Posology;
  pacchetto: ServicePackage;
  contatto: UsefulContact;
}

export type StudioListParse<K extends StudioListKind> =
  { ok: true; data: StudioListData[K] } | { ok: false; problems: string[] };

/** Controlla i dati di una voce: tutti i problemi insieme, ognuno detto in chiaro. */
export function parseStudioListData<K extends StudioListKind>(
  kind: K,
  raw: unknown,
): StudioListParse<K> {
  const r = STUDIO_LIST_SCHEMAS[kind].safeParse(raw ?? {});
  if (r.success) return { ok: true, data: r.data as StudioListData[K] };
  return { ok: false, problems: [...new Set(r.error.issues.map((i) => i.message))] };
}

const text = (v: unknown) => (typeof v === 'string' ? v : '');
/** Per i confronti: spazi ridotti, minuscole. */
const folded = (v: unknown) => text(v).trim().replace(/\s+/g, ' ').toLocaleLowerCase('it');

/**
 * Il nome della voce negli elenchi e nelle scelte (colonna `label`). Accetta anche dati salvati
 * prima di un controllo più severo: un campo che manca dà un nome vuoto, non un errore.
 */
export function studioListLabel(kind: StudioListKind, data: Record<string, unknown>): string {
  return text(kind === 'posologia' ? data.testo : data.nome).trim();
}

/**
 * Che cosa rende due voci attive dello stesso tipo la stessa voce: il medico con la stessa
 * struttura (gli omonimi di strutture diverse restano distinti), lo stesso testo di posologia, lo
 * stesso nome di pacchetto, lo stesso contatto con lo stesso tipo.
 */
export function studioListKey(kind: StudioListKind, data: Record<string, unknown>): string {
  switch (kind) {
    case 'suggeritore':
      return `${folded(data.nome)}|${folded(data.struttura)}`;
    case 'posologia':
      return folded(data.testo);
    case 'pacchetto':
      return folded(data.nome);
    case 'contatto':
      return `${folded(data.nome)}|${text(data.tipo)}`;
  }
}

/** Il messaggio quando una voce uguale c'è già tra le attive. */
export function studioListDuplicate(kind: StudioListKind, label: string): string {
  switch (kind) {
    case 'suggeritore':
      return `Nell’elenco c’è già il medico suggeritore «${label}» con la stessa struttura`;
    case 'posologia':
      return `Nell’elenco c’è già la posologia «${label}»`;
    case 'pacchetto':
      return `Nell’elenco c’è già un pacchetto «${label}»: scegli un altro nome o modifica quello`;
    case 'contatto':
      return `Nell’elenco c’è già il contatto «${label}» dello stesso tipo`;
  }
}

/**
 * Le prestazioni di un pacchetto salvato, lette con prudenza: solo le righe con un codice. Serve a
 * cercarle nel catalogo in vigore anche se i dati vengono da una versione precedente.
 */
export function packageServicesOf(data: Record<string, unknown>): PackageService[] {
  const list = Array.isArray(data.prestazioni) ? (data.prestazioni as unknown[]) : [];
  return list.flatMap((s) => {
    if (!s || typeof s !== 'object') return [];
    const r = s as Record<string, unknown>;
    const codice = text(r.codice).trim();
    return codice
      ? [{ codice: normalizeServiceCode(codice), descrizione: text(r.descrizione) }]
      : [];
  });
}
