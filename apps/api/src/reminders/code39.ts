/**
 * Codice a barre «3-of-9» (Code 39) per il promemoria: NRE e codice fiscale (DM 2 novembre 2011,
 * allegato 2, campi 2 e 3 bis). Il decreto rimanda alla norma ANSI MH10.8M-1983 e fissa: barre
 * alte almeno 7,5 mm; barre e spazi stretti (il modulo M) di almeno 0,240 mm; larghi S = 2,5 M;
 * spazio tra i caratteri al più 1,2 mm; asterisco di apertura e di chiusura; colore nero.
 *
 * La tabella dei caratteri viene da Barcode Writer in Pure PostScript (file barcode.ps del pacchetto
 * bwip-js 4.11.4, licenza MIT): per ogni carattere, nove elementi alternati barra/spazio a partire
 * da una barra (1 = stretto, 3 = largo) e lo spazio tra i caratteri. Qui il largo vale 2,5 moduli,
 * come chiede il decreto. Le prove confrontano il risultato con il disegno di bwip-js.
 */

export const CODE39_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%';

const ENCODINGS = [
  '1113313111',
  '3113111131',
  '1133111131',
  '3133111111',
  '1113311131',
  '3113311111',
  '1133311111',
  '1113113131',
  '3113113111',
  '1133113111',
  '3111131131',
  '1131131131',
  '3131131111',
  '1111331131',
  '3111331111',
  '1131331111',
  '1111133131',
  '3111133111',
  '1131133111',
  '1111333111',
  '3111111331',
  '1131111331',
  '3131111311',
  '1111311331',
  '3111311311',
  '1131311311',
  '1111113331',
  '3111113311',
  '1131113311',
  '1111313311',
  '3311111131',
  '1331111131',
  '3331111111',
  '1311311131',
  '3311311111',
  '1331311111',
  '1311113131',
  '3311113111',
  '1331113111',
  '1313131111',
  '1313111311',
  '1311131311',
  '1113131311',
] as const;
/** Asterisco di apertura e di chiusura. */
const START_STOP = '1311313111';

/** Rapporto tra elemento largo e stretto fissato dal decreto. */
export const CODE39_RATIO = 2.5;

export interface Code39Element {
  bar: boolean;
  wide: boolean;
}

/** Caratteri accettati dal Code 39: cifre, lettere maiuscole, spazio e «-.$/+%». */
export function isCode39Text(text: string): boolean {
  return text.length > 0 && [...text].every((c) => CODE39_CHARS.includes(c));
}

/**
 * Gli elementi del simbolo, asterischi compresi: barre e spazi alternati, ciascuno stretto o
 * largo, con uno spazio stretto tra un carattere e l'altro.
 */
export function code39Elements(text: string): Code39Element[] {
  if (!isCode39Text(text)) throw new Error(`Carattere non ammesso nel Code 39: «${text}»`);
  const codes = [
    START_STOP,
    ...[...text].map((c) => ENCODINGS[CODE39_CHARS.indexOf(c)]!),
    START_STOP,
  ];
  const out: Code39Element[] = [];
  codes.forEach((code, i) => {
    // Nove elementi del carattere; il decimo è lo spazio tra i caratteri, non dopo l'ultimo.
    const widths = i === codes.length - 1 ? code.slice(0, 9) : code;
    [...widths].forEach((w, j) => out.push({ bar: j % 2 === 0, wide: w === '3' }));
  });
  return out;
}

export interface Code39Bar {
  /** Distanza dal bordo sinistro del simbolo. */
  x: number;
  width: number;
}

/** Le barre da disegnare, con il modulo dato (nell'unità che si vuole: punti, millimetri). */
export function code39Bars(text: string, module: number): { bars: Code39Bar[]; width: number } {
  const bars: Code39Bar[] = [];
  let x = 0;
  for (const e of code39Elements(text)) {
    const w = e.wide ? module * CODE39_RATIO : module;
    if (e.bar) bars.push({ x, width: w });
    x += w;
  }
  return { bars, width: x };
}
