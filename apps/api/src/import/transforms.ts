import { studioDate } from '../prescriptions/rules-check';
import {
  NO_VALUES,
  normalizeHeaderName,
  YES_VALUES,
  type ImportDateFormat,
  type ImportField,
} from '@mmg/domain';
import { serialToDate } from './xlsx';

/**
 * Trasformazioni dei valori di un file verso i campi della cartella (tappa 15). Sono un elenco
 * chiuso, senza espressioni scritte dall'utente: spazi, maiuscole, date (giorno/mese/anno,
 * AAAA-MM-GG, numeri seriali), numeri con la virgola o il punto, sì/no, valori ammessi, zeri
 * iniziali dei codici, tabelle di corrispondenza dei valori. I messaggi non riportano mai il
 * valore della cella: dicono che cosa non va, e il rapporto dice riga e colonna.
 */

export type FieldValue = string | number | boolean | null;

export type Converted =
  { ok: true; value: FieldValue; warning?: string } | { ok: false; error: string };

export interface FieldTransform {
  formatoData?: ImportDateFormat;
  /** Valore del file (senza maiuscole e spazi ai lati) → valore da usare; «» = nessun valore. */
  corrispondenze?: Record<string, string>;
}

const valid = (value: FieldValue, warning?: string): Converted =>
  warning ? { ok: true, value, warning } : { ok: true, value };
const invalid = (error: string): Converted => ({ ok: false, error });

/** Chiave di confronto per le tabelle di corrispondenza: senza spazi ai lati, minuscola. */
export const correspondenceKey = (s: string) => s.trim().toLowerCase();

function isoDate(y: number, m: number, d: number): string | null {
  if (y < 1 || m < 1 || m > 12 || d < 1) return null;
  if (d > new Date(Date.UTC(y, m, 0)).getUTCDate()) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Data dal testo: GG/MM/AAAA (con «/», «-» o «.»), oppure AAAA-MM-GG; l'eventuale ora si ignora. */
export function parseTextDate(text: string): { date: string } | { error: string } {
  const t = text.trim();
  let m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[ T]\d{1,2}[:.]\d{2}(?:[:.]\d{2})?)?$/.exec(t);
  if (m) {
    if (m[3]!.length !== 4)
      return { error: 'l’anno ha due cifre: il secolo non si indovina, scrivilo per intero' };
    const d = isoDate(Number(m[3]), Number(m[2]), Number(m[1]));
    return d ? { date: d } : { error: 'la data non esiste (giorno o mese fuori misura)' };
  }
  // Data e ora con il fuso (Z o +hh:mm), come nei file di molti programmi: il giorno è quello
  // italiano. «2026-05-11T23:30:00Z» è il 12 maggio a Roma (dalla revisione del piano).
  m =
    /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?\s*(Z|[+-]\d{2}:?\d{2})$/i.exec(
      t,
    );
  if (m) {
    const d = isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
    if (!d) return { error: 'la data non esiste (giorno o mese fuori misura)' };
    const zone = m[7]!.toUpperCase() === 'Z' ? 'Z' : m[7]!.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
    const at = new Date(`${d}T${m[4]!.padStart(2, '0')}:${m[5]}:${m[6] ?? '00'}${zone}`);
    if (Number.isNaN(at.getTime()) || Number(m[4]) > 23)
      return { error: 'l’ora non esiste (ore fino a 23, minuti fino a 59)' };
    return { date: studioDate(at) };
  }
  // Senza fuso, l'ora dopo la data si lascia: le voci hanno il giorno, non l'ora.
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T].*)?$/.exec(t);
  if (m) {
    const d = isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
    return d ? { date: d } : { error: 'la data non esiste (giorno o mese fuori misura)' };
  }
  return { error: 'non è una data nella forma GG/MM/AAAA o AAAA-MM-GG' };
}

/** Numero scritto come testo: decimali con la virgola o il punto, senza separatore delle migliaia. */
export function parseTextNumber(text: string): string | null {
  const t = text.trim().replace(/\s/g, '');
  if (!/^-?\d+(?:[.,]\d+)?$/.test(t)) return null;
  return String(Number(t.replace(',', '.')));
}

/** Data molto vecchia: spesso un segnaposto di un altro programma (per esempio 01/01/1900). */
const PLACEHOLDER_BEFORE = '1900-01-02';

export function convertValue(
  field: ImportField,
  raw: string,
  kind: string,
  transform: FieldTransform,
  ctx: { date1904: boolean },
): Converted {
  let text = raw;
  if (text.includes('\u0000')) return invalid('contiene un carattere non ammesso');
  if (transform.corrispondenze) {
    const key = correspondenceKey(text);
    const hit = Object.entries(transform.corrispondenze).find(
      ([from]) => correspondenceKey(from) === key,
    );
    if (hit) {
      text = hit[1];
      kind = 't';
    }
  }
  text = text.trim();
  if (text === '') return valid(null);

  switch (field.kind) {
    case 'text':
      // Un numero lungo in una cella numerica (un telefono) ha già perso gli zeri iniziali.
      return kind === 'n' && /^\d{6,}$/.test(text)
        ? valid(text, 'numero lungo letto da una cella numerica: controlla gli zeri iniziali')
        : valid(text);
    case 'fiscalCode':
      return valid(text.replace(/\s+/g, '').toUpperCase());
    case 'code': {
      const code = text.replace(/\s+/g, '').toUpperCase();
      if (field.digits && /^\d+$/.test(code) && code.length < field.digits)
        return valid(
          code.padStart(field.digits, '0'),
          `zeri iniziali aggiunti fino a ${field.digits} cifre (probabile cella numerica)`,
        );
      if (kind === 'n')
        return valid(
          code,
          'codice letto da una cella numerica: controlla che non abbia perso zeri iniziali o finali',
        );
      return valid(code);
    }
    case 'date': {
      let date: string;
      if (kind === 'd') date = text;
      else if (kind === 'o') return invalid('la cella contiene un orario, non una data');
      else if (kind === 'e') return invalid('la cella contiene un errore del foglio di calcolo');
      else if (transform.formatoData === 'seriale') {
        const n = Number(text.replace(',', '.'));
        if (!/^\d+(?:[.,]\d+)?$/.test(text) || !Number.isFinite(n))
          return invalid('non è un numero seriale di data');
        const d = serialToDate(n, ctx.date1904);
        if (!d) return invalid('il numero seriale non corrisponde a una data');
        date = d;
      } else if (kind === 'n')
        return invalid(
          'la cella è un numero, non una data: se le date sono numeri seriali, scegli quel formato',
        );
      else {
        const r = parseTextDate(text);
        if ('error' in r) return invalid(r.error);
        date = r.date;
      }
      return date < PLACEHOLDER_BEFORE
        ? valid(date, 'data molto vecchia: forse un segnaposto del programma d’origine')
        : valid(date);
    }
    case 'number': {
      const n = kind === 'n' ? String(Number(text)) : parseTextNumber(text);
      if (n === null || n === 'NaN')
        return invalid('non è un numero (decimali con la virgola o il punto, senza migliaia)');
      return valid(n);
    }
    case 'integer': {
      const t = text.replace(/\s/g, '');
      if (!/^-?\d+$/.test(t)) return invalid('non è un numero intero');
      return valid(Number(t));
    }
    case 'boolean': {
      const t = text.toLowerCase();
      if ((YES_VALUES as readonly string[]).includes(t)) return valid(true);
      if ((NO_VALUES as readonly string[]).includes(t)) return valid(false);
      return invalid('non si riconosce come sì o no: usa una tabella di corrispondenza');
    }
    case 'choice': {
      const n = normalizeHeaderName(text);
      const choice = (field.choices ?? []).find(
        (c) =>
          normalizeHeaderName(c.key) === n ||
          normalizeHeaderName(c.label) === n ||
          (c.aliases ?? []).some((a) => normalizeHeaderName(a) === n),
      );
      if (!choice)
        return invalid('valore non previsto per questo campo: usa una tabella di corrispondenza');
      return valid(choice.key);
    }
  }
}
