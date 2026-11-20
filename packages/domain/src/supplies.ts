/**
 * Presidi e assistenza integrativa (tappa 10), dalle fonti lette il 18/11/2026:
 *
 * - DPCM 12 gennaio 2017 sui LEA (GU n. 65 del 18/3/2017, S.O. n. 15), art. 10–14: dispositivi
 *   medici monouso (allegato 2), presidi per diabetici (allegato 3), prodotti dietetici. Le
 *   Regioni decidono modalità di fornitura e quantità massime (art. 13, c. 2; art. 14, c. 5).
 * - Vademecum per i malati cronici sul sito della Regione Piemonte (gennaio 2023, rivisto dalla
 *   Direzione Sanità), cap. 6: la prescrizione contiene il fabbisogno mensile; medicazioni
 *   avanzate e bendaggio specialistico: la prima volta lo specialista, poi il medico di famiglia
 *   per al massimo 6 mesi; per i diabetici il piano di automonitoraggio glicemico (PAG).
 *
 * Solo controlli formali. Il nomenclatore dell'allegato 3 è una banca dati trascritta (D218), in uso
 * dopo il controllo; quello dell'allegato 2 arriva con i file di Simone.
 */

export interface SupplyCategoryInfo {
  key: string;
  label: string;
  source: string | null;
  /** Allegato del DPCM con il nomenclatore della categoria, se c'è (D218). */
  annex?: string;
}

const LEA = 'DPCM 12/1/2017 (LEA)';
const VADEMECUM = 'Regione Piemonte, vademecum per i malati cronici (2023), cap. 6';

export const SUPPLY_CATEGORIES = [
  {
    key: 'monouso',
    label: 'Dispositivi medici monouso (stomie, cateteri, incontinenza, lesioni da decubito)',
    source: `${LEA}, art. 11 e allegato 2`,
    annex: '2',
  },
  {
    key: 'diabetici',
    label: 'Presidi per diabetici (autocontrollo della glicemia, somministrazione di insulina)',
    source: `${LEA}, art. 13 e allegato 3; ${VADEMECUM}: piano di automonitoraggio glicemico`,
    annex: '3',
  },
  {
    key: 'medicazione_tradizionale',
    label: 'Medicazioni tradizionali e bendaggio semplice',
    source: `${VADEMECUM}.5`,
  },
  {
    key: 'medicazione_avanzata',
    label: 'Medicazioni avanzate e bendaggio specialistico',
    source: `${VADEMECUM}.5: la prima volta lo specialista, poi il medico di famiglia per al massimo 6 mesi`,
  },
  {
    key: 'dietetici',
    label: 'Prodotti dietetici (senza glutine, aproteici, a fini medici speciali, addensanti)',
    source: `${LEA}, art. 14`,
  },
  { key: 'altro', label: 'Altro', source: null },
] as const satisfies readonly SupplyCategoryInfo[];
export type SupplyCategory = (typeof SUPPLY_CATEGORIES)[number]['key'];
export const SUPPLY_CATEGORY_KEYS = SUPPLY_CATEGORIES.map((c) => c.key) as [
  SupplyCategory,
  ...SupplyCategory[],
];

export function supplyCategory(key: string): SupplyCategoryInfo | undefined {
  return SUPPLY_CATEGORIES.find((c) => c.key === key);
}

/** Medicazioni avanzate: massimo di mesi per la prescrizione del medico di famiglia (vademecum). */
export const ADVANCED_DRESSING_MAX_MONTHS = 6;

/** Ultimo giorno coperto da una prescrizione di `months` mesi dal giorno `start` (compreso). */
export function supplyEndOn(start: string, months: number): string {
  const [y, m, d] = start.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  // Stesso giorno del mese, o l'ultimo se il mese è più corto; poi il giorno prima.
  const last = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  target.setUTCDate(target.getUTCDate() - 1);
  return target.toISOString().slice(0, 10);
}

export interface SupplyInput {
  category: SupplyCategory;
  months: number;
  prescriber: 'mmg' | 'specialista';
  firstSpecialist?: string | null;
  firstSpecialistOn?: string | null;
  startOn: string;
}

/** Controlli formali di una prescrizione di presidi; vuoto se va bene. */
export function supplyIssues(p: SupplyInput): string[] {
  const out: string[] = [];
  if (p.firstSpecialistOn && p.firstSpecialistOn > p.startOn)
    out.push('La prima prescrizione dello specialista non può venire dopo l’inizio');
  if (p.category === 'medicazione_avanzata' && p.prescriber === 'mmg') {
    if (!p.firstSpecialist || !p.firstSpecialistOn)
      out.push(
        'Medicazioni avanzate: la prima prescrizione è dello specialista; indica chi e quando',
      );
    if (p.months > ADVANCED_DRESSING_MAX_MONTHS)
      out.push(
        `Medicazioni avanzate: il medico di famiglia le prescrive per al massimo ${ADVANCED_DRESSING_MAX_MONTHS} mesi`,
      );
  }
  return out;
}

/** Stato alla data: in corso, da rinnovare (finita), annullata. */
export function supplyState(
  s: { status: 'active' | 'ended' | 'annulled'; endOn: string },
  today: string,
): 'in_corso' | 'scaduta' | 'conclusa' | 'annullata' {
  if (s.status === 'annulled') return 'annullata';
  if (s.status === 'ended') return 'conclusa';
  return s.endOn < today ? 'scaduta' : 'in_corso';
}

/** Referti e documenti allegati: tipi ammessi e dimensione massima. */
export const ATTACHMENT_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const;
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

/** Il tipo dichiarato è quello vero? Si guarda la firma dei primi byte del file. */
export function sniffAttachmentType(bytes: Uint8Array): (typeof ATTACHMENT_TYPES)[number] | null {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return 'application/pdf'; // %PDF-
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png';
  return null;
}
