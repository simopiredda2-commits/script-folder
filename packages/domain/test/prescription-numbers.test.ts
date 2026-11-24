import { describe, expect, it } from 'vitest';
import { normalizePrescriptionNumber, nrbeProblem, nreProblem } from '../src/prescription-numbers';

/**
 * Forma dei numeri di ricetta scritti a mano (audit D259): NRE dalle specifiche del Sistema TS del
 * 05/12/2024 (paragrafi 5 e 5.1), NRBE dal Disciplinare tecnico del DM 1/12/2022 (paragrafo 2.4).
 * Gli stessi casi sono nella prova della copia del web. Codice fiscale inventato.
 */
const CF = 'NVNPZN50A41X000X';

describe('NRE scritto a mano', () => {
  it('l’esempio delle specifiche, anche con gli spazi e in minuscolo', () => {
    expect(nreProblem('123A00456789012')).toBeNull();
    expect(nreProblem(' 123 a0 0 4567890 12 ')).toBeNull();
    expect(normalizePrescriptionNumber(' 123 a0 0 4567890 12 ')).toBe('123A00456789012');
    // Tutti i tipi di lotto, da 0 a 7.
    for (const c of '01234567') expect(nreProblem(`123A0${c}456789012`), c).toBeNull();
  });

  it('sempre 15 caratteri', () => {
    expect(nreProblem('ABC')).toBe(
      'L’NRE ha sempre 15 caratteri: qui ce ne sono 3. Rileggi il numero dato dall’ente.',
    );
    expect(nreProblem('X')).toMatch(/qui ce n’è 1\./);
    expect(nreProblem('123A004567890123')).toMatch(/qui ce ne sono 16/);
  });

  it('solo lettere e cifre; il sesto da 0 a 7; gli ultimi 9 cifre', () => {
    expect(nreProblem('123A0-456789012')).toMatch(/^L’NRE ha solo lettere e cifre/);
    expect(nreProblem('123A08456789012')).toMatch(/il sesto carattere è una cifra da 0 a 7/);
    expect(nreProblem('123A0A456789012')).toMatch(/il sesto carattere è una cifra da 0 a 7/);
    expect(nreProblem('MAN00000000000A')).toMatch(/gli ultimi 9 sono cifre/);
  });
});

describe('NRBE scritto a mano', () => {
  it('12 caratteri: una lettera, una lettera o una cifra, 10 cifre', () => {
    expect(nrbeProblem('A01234567890')).toBeNull();
    // Il secondo può essere una lettera: è il caso del paziente senza codice fiscale.
    expect(nrbeProblem('AB1234567890')).toBeNull();
    expect(nrbeProblem(' a0 1234567890 ')).toBeNull();
    expect(nrbeProblem('NRBE0001')).toBe(
      'L’NRBE ha sempre 12 caratteri: qui ce ne sono 8. Rileggi il numero dato dal Sistema TS.',
    );
    for (const bad of ['0A1234567890', 'NRBE00000001', 'A0123456789X', 'A-1234567890'])
      expect(nrbeProblem(bad), bad).toMatch(/il primo carattere è una lettera/);
  });

  it('con il codice fiscale: la lettera di controllo, poi una cifra', () => {
    expect(nrbeProblem('X01234567890', CF)).toBeNull();
    expect(nrbeProblem('x01234567890', CF.toLowerCase())).toBeNull();
    expect(nrbeProblem('A01234567890', CF)).toBe(
      'Per un paziente con il codice fiscale l’NRBE comincia con la lettera di controllo del codice fiscale (X) seguita da una cifra. Rileggi il numero dato dal Sistema TS.',
    );
    expect(nrbeProblem('XB1234567890', CF)).toMatch(/\(X\) seguita da una cifra/);
  });

  it('senza un codice fiscale di 16 caratteri la prima lettera non si controlla', () => {
    for (const cf of [null, undefined, '', '12345678901'])
      expect(nrbeProblem('AB1234567890', cf), String(cf)).toBeNull();
  });
});
