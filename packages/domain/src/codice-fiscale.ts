/**
 * Codice fiscale delle persone fisiche: costruzione e controllo formale.
 *
 * Fonte: DM Finanze 23/12/1976 n. 13813 (GU n. 345 del 29/12/1976), artt. 2, 3, 4, 5 e 7,
 * testo letto su def.finanze.it il 18/11/2026. È solo un controllo formale della trascrizione:
 * l'unico codice valido è quello attribuito dall'Agenzia delle Entrate. Il codice dei casi di
 * omocodia (art. 6) è riconosciuto dal controllo ma non è generato.
 */

export type Sex = 'M' | 'F';

/** Art. 5: lettere dei mesi, da gennaio a dicembre. */
export const MONTH_LETTERS = ['A', 'B', 'C', 'D', 'E', 'H', 'L', 'M', 'P', 'R', 'S', 'T'] as const;

// prettier-ignore
/** Art. 7, punto 2: valori dei caratteri in posizione dispari (A o zero = 1, B o 1 = 0, …). */
export const ODD_VALUES: Record<string, number> = {
  A: 1, B: 0, C: 5, D: 7, E: 9, F: 13, G: 15, H: 17, I: 19, J: 21, K: 2, L: 4, M: 18,
  N: 20, O: 11, P: 3, Q: 6, R: 8, S: 12, T: 14, U: 16, V: 10, W: 22, X: 25, Y: 24, Z: 23,
};

/** Art. 7: le cifre valgono come le lettere da A a J (zero = A, 1 = B, …, 9 = J). */
const DIGIT_AS_LETTER = 'ABCDEFGHIJ';

/** Art. 6: lettere che sostituiscono le cifre nei casi di omocodia (0 = L, 1 = M, …, 9 = V). */
const OMOCODIA_LETTERS = 'LMNPQRSTUV';

/** Posizioni (da 0) dei sette caratteri numerici, sostituibili per omocodia (art. 6). */
const NUMERIC_POSITIONS = [6, 7, 9, 10, 12, 13, 14];

const VOWELS = new Set(['A', 'E', 'I', 'O', 'U']);

function normalizeLetters(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '');
}

function split(s: string): { consonants: string[]; vowels: string[] } {
  const letters = [...normalizeLetters(s)];
  return {
    consonants: letters.filter((c) => !VOWELS.has(c)),
    vowels: letters.filter((c) => VOWELS.has(c)),
  };
}

/** Art. 3: tre caratteri del cognome (consonanti, poi vocali, poi X). */
export function surnameCode(surname: string): string {
  const { consonants, vowels } = split(surname);
  return [...consonants, ...vowels, 'X', 'X', 'X'].slice(0, 3).join('');
}

/** Art. 4: tre caratteri del nome; con quattro o più consonanti, la prima, la terza e la quarta. */
export function nameCode(name: string): string {
  const { consonants, vowels } = split(name);
  if (consonants.length >= 4) return [consonants[0], consonants[2], consonants[3]].join('');
  return [...consonants, ...vowels, 'X', 'X', 'X'].slice(0, 3).join('');
}

/** Art. 5: anno, mese e giorno (aumentato di 40 per i soggetti di sesso femminile). */
export function birthCode(birthDate: string, sex: Sex): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(birthDate);
  if (!m) throw new Error(`Data di nascita non valida: ${birthDate}`);
  const [, year, month, day] = m;
  const monthIndex = Number(month) - 1;
  const letter = MONTH_LETTERS[monthIndex];
  if (!letter) throw new Error(`Mese non valido: ${birthDate}`);
  const d = Number(day) + (sex === 'F' ? 40 : 0);
  return `${year!.slice(2)}${letter}${String(d).padStart(2, '0')}`;
}

/** Art. 7: carattere di controllo dei primi quindici caratteri. */
export function checkCharacter(first15: string): string {
  if (!/^[A-Z0-9]{15}$/.test(first15)) throw new Error('Servono 15 caratteri alfanumerici');
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    const raw = first15[i]!;
    const c = /\d/.test(raw) ? DIGIT_AS_LETTER[Number(raw)]! : raw;
    // Le posizioni si contano da 1: la prima è dispari.
    sum += (i + 1) % 2 === 1 ? ODD_VALUES[c]! : c.charCodeAt(0) - 65;
  }
  return String.fromCharCode(65 + (sum % 26));
}

export interface FiscalCodeInput {
  surname: string;
  name: string;
  birthDate: string;
  sex: Sex;
  /** Codice del comune o dello Stato estero di nascita: una lettera e tre cifre. */
  placeCode: string;
}

export function buildFiscalCode(input: FiscalCodeInput): string {
  if (!/^[A-Z]\d{3}$/.test(input.placeCode)) {
    throw new Error(`Codice del luogo di nascita non valido: ${input.placeCode}`);
  }
  const first15 =
    surnameCode(input.surname) +
    nameCode(input.name) +
    birthCode(input.birthDate, input.sex) +
    input.placeCode;
  return first15 + checkCharacter(first15);
}

const STRUCTURE =
  /^[A-Z]{6}[0-9LMNPQRSTUV]{2}[ABCDEHLMPRST][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$/;

/** Riporta le cifre sostituite per omocodia (art. 6) alla forma numerica. */
function decodeOmocodia(code: string): string {
  const chars = [...code];
  for (const p of NUMERIC_POSITIONS) {
    const idx = OMOCODIA_LETTERS.indexOf(chars[p]!);
    if (idx >= 0) chars[p] = String(idx);
  }
  return chars.join('');
}

export type FiscalCodeProblem = 'lunghezza' | 'struttura' | 'giorno' | 'controllo';

/** Controllo formale: struttura, giorno di nascita ammesso, carattere di controllo. */
export function checkFiscalCode(raw: string): { valid: boolean; problem?: FiscalCodeProblem } {
  const code = raw.trim().toUpperCase();
  if (code.length !== 16) return { valid: false, problem: 'lunghezza' };
  if (!STRUCTURE.test(code)) return { valid: false, problem: 'struttura' };
  const day = Number(decodeOmocodia(code).slice(9, 11));
  if (!((day >= 1 && day <= 31) || (day >= 41 && day <= 71))) {
    return { valid: false, problem: 'giorno' };
  }
  if (checkCharacter(code.slice(0, 15)) !== code[15]) return { valid: false, problem: 'controllo' };
  return { valid: true };
}
