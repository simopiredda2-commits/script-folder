import bwipjs from 'bwip-js/node';
import { describe, expect, it } from 'vitest';
import {
  CODE39_CHARS,
  CODE39_RATIO,
  code39Bars,
  code39Elements,
  isCode39Text,
} from '../src/reminders/code39';

/** Barre disegnate da bwip-js (rapporto 3:1), lette dal suo SVG: un'implementazione indipendente. */
function oracle(text: string) {
  const svg = bwipjs.toSVG({ bcid: 'code39', text, scale: 1, height: 5, includetext: false });
  const bars: { x: number; width: number }[] = [];
  for (const m of svg.matchAll(/stroke-width="(\d+)" d="([^"]+)"/g)) {
    const w = Number(m[1]);
    for (const x of m[2]!.matchAll(/M([\d.]+) /g)) bars.push({ x: Number(x[1]) - w / 2, width: w });
  }
  return bars.sort((a, b) => a.x - b.x);
}

/** Le nostre barre con lo stesso rapporto di bwip-js, per confrontarle una a una. */
function ours(text: string) {
  let x = 0;
  const bars: { x: number; width: number }[] = [];
  for (const e of code39Elements(text)) {
    const w = e.wide ? 3 : 1;
    if (e.bar) bars.push({ x, width: w });
    x += w;
  }
  return bars;
}

describe('Code 39 del promemoria (DM 2 novembre 2011, allegato 2)', () => {
  it('ogni carattere ammesso dà le stesse barre di bwip-js', () => {
    for (const text of [
      '0123456789',
      'ABCDEFGHIJKLM',
      'NOPQRSTUVWXYZ',
      '-. $/+%',
      'SIMR000000000001',
      'RSSMRA80A01H501U',
    ]) {
      expect(ours(text), text).toEqual(oracle(text));
    }
    expect(CODE39_CHARS).toHaveLength(43);
  });

  it('largo = 2,5 volte lo stretto, come chiede il decreto; tre elementi larghi su nove', () => {
    expect(CODE39_RATIO).toBe(2.5);
    const { bars } = code39Bars('A', 1);
    expect(new Set(bars.map((b) => b.width))).toEqual(new Set([1, 2.5]));
    const elements = code39Elements('A');
    // Asterisco, «A», asterisco: 9 + 1 + 9 + 1 + 9 elementi.
    expect(elements).toHaveLength(29);
    expect(elements.slice(10, 19).filter((e) => e.wide)).toHaveLength(3);
  });

  it('caratteri non ammessi: nessun simbolo sbagliato, un errore', () => {
    expect(isCode39Text('abc')).toBe(false);
    expect(isCode39Text('')).toBe(false);
    expect(isCode39Text('NRE 123')).toBe(true);
    expect(() => code39Elements('à')).toThrow(/non ammesso/);
  });
});
