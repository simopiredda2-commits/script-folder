/** Modelli dei certificati e impaginazione del medico (tappa 13). */
import { useApi } from './useApi';

export interface TemplateField {
  key: string;
  label: string;
  type: 'testo' | 'testo_lungo' | 'data' | 'scelta' | 'numero';
  required: boolean;
  options?: string[];
  help?: string;
  max?: number;
  /** Scelta stampata con le caselle del modello cartaceo: sullo schermo, una riga di pulsanti. */
  boxes?: boolean;
}

export interface TemplateSource {
  act: string;
  publication?: string;
  url: string;
  checkedOn: string;
  note?: string;
}

export interface Template {
  chiave: string;
  titolo: string;
  ufficiale: boolean;
  /** Modello proposto (D160): che cosa resta da verificare; null per gli altri. */
  proposto?: string | null;
  versione: string;
  fonte: TemplateSource | null;
  validitaMesi: number | null;
  perIlMedico: string[];
  campi: TemplateField[];
  testo: string[];
  firma: string;
  /** Solo per i modelli dello studio. */
  id?: string;
}

export interface Catalog {
  ufficiali: Template[];
  studio: Template[];
  puoGestire: boolean;
}

export function useTemplates() {
  return useApi<Catalog>('/api/modelli');
}

export interface Layout {
  carattere: 'sans' | 'serif' | 'mono';
  dimensione: number;
  intestazione: string[];
  allineamento: 'left' | 'center';
  margini: number;
  luogo: string;
  timbro: string;
}

export const FONT_LABELS: Record<Layout['carattere'], string> = {
  sans: 'Senza grazie (Helvetica)',
  serif: 'Con grazie (Times)',
  mono: 'A spaziatura fissa (Courier)',
};

/** Segnaposto che il programma riempie da solo, con il loro nome. */
export const PLACEHOLDERS: { code: string; label: string }[] = [
  { code: '{{paziente.cognome}}', label: 'Cognome del paziente' },
  { code: '{{paziente.nome}}', label: 'Nome del paziente' },
  { code: '{{paziente.sesso}}', label: 'Sesso' },
  { code: '{{paziente.nato_a}}', label: 'Comune di nascita' },
  { code: '{{paziente.nato_il}}', label: 'Data di nascita' },
  { code: '{{paziente.codice_fiscale}}', label: 'Codice fiscale' },
  { code: '{{paziente.residenza}}', label: 'Residenza' },
  { code: '{{medico.nome_cognome}}', label: 'Nome e cognome del medico' },
  { code: '{{medico.codice_fiscale}}', label: 'Codice fiscale del medico' },
  { code: '{{medico.codice_regionale}}', label: 'Codice regionale del medico' },
  { code: '{{rilascio.luogo}}', label: 'Luogo del rilascio' },
  { code: '{{rilascio.data}}', label: 'Data del rilascio' },
  { code: '{{campo.testo}}', label: 'Testo scritto al rilascio' },
];

export interface IssuedCertificate {
  id: string;
  modello: string;
  titolo: string;
  versione: string;
  ufficiale: boolean;
  fonte: TemplateSource | null;
  campi: { key: string; label: string; value: string }[];
  rilasciatoIl: string;
  validoFinoAl: string | null;
  annullatoIl: string | null;
  motivoAnnullamento: string | null;
}

/** Il testo di un modello dello studio: paragrafi separati da una riga vuota. */
export const paragraphsOf = (text: string) =>
  text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
