import { describe, expect, it } from 'vitest';
import {
  composeNre,
  NRE_LOT_SIZE,
  nreLotPrefix,
  nreLotProblem,
  nreProblem,
  splitNre,
  type NreLotCode,
} from '../src';

/** L'esempio della V06 del SAR (4.1, p. 10–11): lotto «010 A0 4 000000». */
const V06: NreLotCode = { regionCode: '010', groupCode: 'A0', lotType: '4', lotCode: '000000' };

describe('lotti di NRE della Regione Piemonte (D269)', () => {
  it('dal lotto dell’esempio della V06 la cartella genera da …000 a …999', () => {
    expect(NRE_LOT_SIZE).toBe(1000);
    expect(nreLotPrefix(V06)).toBe('010A04000000');
    expect(composeNre(V06, 0)).toBe('010A04000000000');
    expect(composeNre(V06, 999)).toBe('010A04000000999');
    expect(composeNre(V06, 42)).toBe('010A04000000042');
    for (const n of [0, 1, 500, 999]) expect(nreProblem(composeNre(V06, n))).toBeNull();
  });

  it('fuori dal lotto non si genera niente', () => {
    expect(() => composeNre(V06, 1000)).toThrow(/Progressivo fuori dal lotto: 1000/);
    expect(() => composeNre(V06, -1)).toThrow(/Progressivo fuori dal lotto/);
    expect(() => composeNre(V06, 1.5)).toThrow(/Progressivo fuori dal lotto/);
  });

  it('un lotto in un’altra forma si rifiuta, con il motivo', () => {
    expect(nreLotProblem(V06)).toBeNull();
    expect(nreLotProblem({ ...V06, regionCode: '10' })).toMatch(/regione/);
    expect(nreLotProblem({ ...V06, groupCode: 'a0' })).toMatch(/raggruppamento/);
    expect(nreLotProblem({ ...V06, lotType: '8' })).toMatch(/identificativo del lotto/);
    // Un codice di 5 o 7 cifre non è quello di un lotto da 1000: gli NRE non tornerebbero di 15.
    expect(nreLotProblem({ ...V06, lotCode: '00000' })).toMatch(/6 cifre/);
    expect(nreLotProblem({ ...V06, lotCode: '0000000' })).toMatch(/6 cifre/);
    expect(() => composeNre({ ...V06, lotCode: '12345' }, 0)).toThrow(/6 cifre/);
  });

  it('dall’NRE si torna al lotto e al progressivo', () => {
    expect(splitNre('010A04000000042')).toEqual({ prefix: '010A04000000', progressive: 42 });
    expect(splitNre('010A0400000004X')).toBeNull();
    expect(splitNre('010A0400000004')).toBeNull();
  });
});
