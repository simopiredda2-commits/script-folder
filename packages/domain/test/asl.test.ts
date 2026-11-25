import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ASL_CODE,
  ASL_LIST,
  ASL_SOURCE,
  findHealthUnit,
  healthUnitLabel,
  healthUnitsOfRegion,
} from '../src';

/**
 * Elenco delle ASL dal dataset del Ministero della Salute (D267): è il controllo del codice ASL
 * del medico, che entra nel `client_id` e in `X-Gestionale` della Regione Piemonte (REL-STC-01
 * V08, 4.3.1 e 4.2.5).
 */
describe('elenco delle ASL del Ministero (D267)', () => {
  it('il Piemonte ha le dodici aziende del 2026, con la 301 dell’esempio della V08', () => {
    const piemonte = healthUnitsOfRegion('PIEMONTE')!;
    expect(piemonte.map((a) => a.code)).toEqual([
      '203',
      '204',
      '205',
      '206',
      '207',
      '208',
      '209',
      '210',
      '211',
      '212',
      '213',
      '301',
    ]);
    expect(findHealthUnit('301', 'PIEMONTE')?.name).toBe("ASL CITTA' DI TORINO");
    expect(healthUnitLabel(findHealthUnit('301', 'Piemonte')!)).toBe("301 – ASL CITTA' DI TORINO");
    // TO1 e TO2 sono nel file del Ministero fino al 2016; dal 2017 c'è la 301.
    expect(findHealthUnit('201', 'PIEMONTE')).toBeNull();
    expect(findHealthUnit('202', 'PIEMONTE')).toBeNull();
  });

  it('codici di tre cifre, unici dentro ogni regione', () => {
    expect(ASL_LIST.length).toBe(106);
    const seen = new Set<string>();
    for (const a of ASL_LIST) {
      expect(a.code, a.name).toMatch(ASL_CODE);
      expect(a.regionCode, a.regionName).toMatch(/^\d{3}$/);
      const key = `${a.regionCode}-${a.code}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
  });

  it('la regione si riconosce dal nome scritto nei dati dello studio', () => {
    expect(healthUnitsOfRegion('piemonte ')).toHaveLength(12);
    expect(healthUnitsOfRegion('Valle d’Aosta')).toHaveLength(1);
    expect(healthUnitsOfRegion("VALLE D'AOSTA")).toHaveLength(1);
    expect(healthUnitsOfRegion('Emilia-Romagna')).toHaveLength(8);
    expect(healthUnitsOfRegion('Atlantide')).toBeNull();
    expect(healthUnitsOfRegion(null)).toBeNull();
    // Lo stesso codice cambia significato da una regione all'altra: senza regione vale il primo.
    expect(findHealthUnit('301', 'LOMBARDIA')).toBeNull();
    expect(findHealthUnit('321', 'LOMBARDIA')?.regionName).toBe('LOMBARDIA');
    expect(findHealthUnit('301')?.regionName).toBe('PIEMONTE');
    expect(findHealthUnit('999')).toBeNull();
  });

  it('l’impronta del file del Ministero è quella registrata in docs/provenienze.md', () => {
    const doc = readFileSync(
      join(import.meta.dirname, '..', '..', '..', 'docs', 'provenienze.md'),
      'utf8',
    );
    const row = doc.split('\n').find((l) => l.includes('ASL_2010-2026.csv'));
    expect(row, 'riga del dataset delle ASL in docs/provenienze.md').toBeDefined();
    expect(row).toContain(ASL_SOURCE.sha256);
    expect(row).toContain(ASL_SOURCE.bytes.toLocaleString('it-IT'));
    expect(ASL_SOURCE.year).toBe(2026);
  });
});
