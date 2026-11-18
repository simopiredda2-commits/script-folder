/**
 * Segni del logo: il segno di oggi, le proposte e la scelta. Solo dati: li usano il generatore
 * (scripts/genera-proposte-logo.ts) e il segno del prodotto (mark.ts).
 */
import { previousMark } from './mark-previous';

/** Un segno: tracciati con linea continua, spessore costante, estremi arrotondati. */
export interface MarkDesign {
  id: string;
  title: string;
  idea: string;
  viewBox: number;
  stroke: number;
  /** Ogni elemento è un attributo `d` di <path>. */
  paths: string[];
}

/** Il segno di oggi, identico all'originale (viewBox 30). */
export const previousMarkDesign: MarkDesign = {
  id: 'segno-attuale',
  title: 'Segno di oggi',
  idea: 'Il tratto di ECG dei prototipi, accanto al nome.',
  viewBox: 30,
  stroke: previousMark.strokeWidth,
  paths: [`M${previousMark.points.split(' ').join(' L')}`],
};

/**
 * Proposte su griglia 32×32, spessore 3 (lo stesso rapporto del segno di oggi: 2,8 su 30).
 * Il ritmo del battito resta piatto–su–giù–piatto, con le proporzioni del tratto originale:
 * salita breve, discesa lunga, risalita breve.
 */
export const proposals: MarkDesign[] = [
  {
    id: 'proposta-a',
    title: 'A · Battito sulla cartella',
    idea: 'La sagoma della cartella con la linguetta; il battito la attraversa da un lato all’altro.',
    viewBox: 32,
    stroke: 3,
    paths: [
      'M5 26.5 V8 H12 L14.5 10.5 H27 V26.5 Z',
      'M5 18.5 H10 L12.5 13.5 L15.5 23.5 L17.5 18.5 H27',
    ],
  },
  {
    id: 'proposta-b',
    title: 'B · Linguetta a picco',
    idea: 'Una sola linea chiusa: la linguetta della cartella è il picco del battito.',
    viewBox: 32,
    stroke: 3,
    paths: ['M5 27 V13 H10 L12.5 5 L16 20 L18.5 13 H27 V27 Z'],
  },
  {
    id: 'proposta-c',
    title: 'C · Tratto che diventa cartella',
    idea: 'Il battito entra da sinistra come nel segno di oggi e prosegue disegnando la cartella.',
    viewBox: 32,
    stroke: 3,
    paths: ['M2.5 13 H8 L10.5 5.5 L14 20 L16.5 13 H28.5 V27 H6.5 V17.5'],
  },
];

/** Proposta scelta da Simone alla prima fermata (18/11/2026): B, linguetta a picco (D33). */
export const CHOSEN_PROPOSAL_ID = 'proposta-b';

export const chosenMarkDesign: MarkDesign = proposals.find((p) => p.id === CHOSEN_PROPOSAL_ID)!;
