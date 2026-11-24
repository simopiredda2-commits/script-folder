import { describe, expect, it } from 'vitest';
import { packUnits, samePackUnit } from '../src';

describe('unità per confezione dalla descrizione AIFA (D252)', () => {
  it('compresse, capsule e bustine: il numero che apre l’ultima parte', () => {
    // Descrizioni dell'anagrafica AIFA delle confezioni, come nel file d'esempio.
    expect(packUnits('5 MG COMPRESSE- 28 COMPRESSE IN BLISTER AL/PVC/PVDC')).toEqual({
      count: 28,
      unit: 'compressa',
    });
    // Il trattino dentro il materiale del blister non separa le parti.
    expect(
      packUnits('20 MG COMPRESSE RIVESTITE CON FILM- 30 COMPRESSE IN BLISTER PVC-PE-PVDC/AL'),
    ).toEqual({ count: 30, unit: 'compressa' });
    expect(packUnits('20- 30 COMPRESSE 20 MG')).toEqual({ count: 30, unit: 'compressa' });
    expect(packUnits('20 MG CAPSULE RIGIDE- 14 CAPSULE')).toEqual({ count: 14, unit: 'capsula' });
    expect(packUnits('3 G GRANULATO- 10 BUSTINE')).toEqual({ count: 10, unit: 'bustina' });
  });

  it('penne, fiale, flaconi e confezioni multiple restano non note', () => {
    expect(
      packUnits(
        '1,5 MG  SOLUZIONE INIETTABILE - USO SOTTOCUTANEO - SIRINGA DI VETRO IN PENNA PRERIEMPITA - 4 PENNE',
      ),
    ).toBeNull();
    expect(
      packUnits(
        '1 G/10 ML POLVERE E SOLVENTE PER SOLUZIONE INIETTABILE PER USO ENDOVENOSO- 1 FLACONCINO POLVERE + 1 FIALA SOLVENTE DA 10 ML',
      ),
    ).toBeNull();
    expect(packUnits('10 MG/ML GOCCE ORALI, SOLUZIONE- FLACONE 20 ML')).toBeNull();
    expect(packUnits('5 MG COMPRESSE- 2 BLISTER DA 14 COMPRESSE')).toBeNull();
    expect(packUnits('5 MG COMPRESSE- 0 COMPRESSE')).toBeNull();
    expect(packUnits(null)).toBeNull();
    expect(packUnits('')).toBeNull();
  });

  it('la posologia nella stessa unità, al singolare o al plurale', () => {
    expect(samePackUnit('compressa', 'compressa')).toBe(true);
    expect(samePackUnit('Compresse', 'compressa')).toBe(true);
    expect(samePackUnit('capsula', 'compressa')).toBe(false);
    expect(samePackUnit('goccia', 'compressa')).toBe(false);
    expect(samePackUnit('unità', 'compressa')).toBe(false);
    expect(samePackUnit(null, 'compressa')).toBe(false);
  });
});
