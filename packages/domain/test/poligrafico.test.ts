import { describe, expect, it } from 'vitest';
import { parsePoligrafico, poligraficoProblem } from '../src';

/** Numeri inventati, nella forma del disciplinare del DM 17/3/2008 (2.3.1.2). */
describe('numero del Poligrafico della ricetta rossa (D270)', () => {
  it('si divide nelle due parti di Bar1 e Bar2', () => {
    expect(parsePoligrafico('01026 0001234 05 7')).toEqual({
      code: '010260001234057',
      bar1: '01026',
      bar2: '0001234057',
      regionCode: '010',
      year: '26',
      booklet: '0001234',
      sheet: '05',
    });
  });

  it('vuole 15 cifre, e il modulo della regione dello studio', () => {
    expect(poligraficoProblem('010260001234057', '010')).toBeNull();
    expect(poligraficoProblem('01026000123405')).toMatch(/15 cifre.*non 14/);
    expect(poligraficoProblem('01026000123405A')).toMatch(/solo cifre/);
    expect(poligraficoProblem('030260001234057', '010')).toMatch(/altro ente \(codice 030\)/);
    expect(parsePoligrafico('0102600012340577')).toBeNull();
  });
});
